// ════════════════════════════════════════════════════════════
// FOCUSBRO — ACCOUNTABILITY CORE  (Contender track, issue #10, Phase A)
// ════════════════════════════════════════════════════════════
// "The bro who calls to make sure you did the thing."
//
// You give your word (a commitment). At the moment you said, FocusBro checks
// in. You tell it how it went. Keeping your word builds a streak; a miss is
// met with "no problem — when do you want to try again?" and never a scold.
//
// Mechanic transplanted from wordis-bond: a parent definition (test_suites →
// commitments) + scheduled resolution rows with a resolved outcome
// (test_runs → commitment_checkins) + streak tracking on top. Engine-
// independent: the check-in channel is push/text now; the voice call
// (Phase B) rides the shared @latimer-woods-tech/voice-agent engine later.
//
// THE DESIGN LAW (non-negotiable): never shame. Every string this module can
// emit is an ally glad you showed up — never a boss tallying misses. Any copy
// that counts failures back to the user is a defect. Enforced by
// accountability.test.js (banned-word + no-"AI" + no-clinical-claim assertions).
// ════════════════════════════════════════════════════════════

import { generateUUID } from './middleware.js';
import { buildMomentum, describePeakDay, MOMENTUM_WINDOW_DAYS } from './momentum.js';
import { recordEvent, outcomeEvent, EVENTS } from './events.js';

/** Check-in delivery channels available in Phase A. Voice is Phase B (engine-gated). */
export const CHANNELS = ['push', 'text'];

/** Configurable companion persona. Both are warm; neither ever shames. */
export const PERSONAS = ['ally', 'hype'];

/** Resolution outcomes for a check-in. */
export const OUTCOMES = ['kept', 'missed', 'reschedule'];

/**
 * Check-in cadence. `none` = a one-shot commitment (the original behavior);
 * `daily`/`weekdays` = "the bro who calls you every day at the same time" — the
 * heart of the accountability product. Mechanic reused from wordis-bond's
 * scheduled-run cadence (a cadence on the parent + materialized child rows),
 * adapted to D1 and anchored to a recipient-local wall-clock time so it is
 * DST-correct.
 */
export const RECURRENCES = ['none', 'daily', 'weekdays'];

/**
 * "I'm on it" snooze bounds. A real accountability friend has a third answer
 * between "done" and "move the whole thing" — "check back in a bit." These bound
 * how far out a snooze pushes the next nudge: a sensible default, a floor so it
 * stays a nudge (not a disappearance), and a ceiling so it can't quietly become
 * a reschedule. Minutes.
 */
export const SNOOZE_DEFAULT_MIN = 15;
export const SNOOZE_MIN_MIN = 5;
export const SNOOZE_MAX_MIN = 180;

/**
 * Clamp a requested snooze to the allowed window. Missing/garbage → the default;
 * out-of-range → the nearest bound. Always returns a whole number of minutes.
 * @param {*} v requested minutes (may be undefined)
 * @returns {number}
 */
export function clampSnoozeMinutes(v) {
  if (v == null) return SNOOZE_DEFAULT_MIN; // not provided → default
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return SNOOZE_DEFAULT_MIN;
  return Math.min(SNOOZE_MAX_MIN, Math.max(SNOOZE_MIN_MIN, n));
}

const MAX_TITLE = 200;
const MAX_DETAILS = 2000;
const DEFAULT_CHECKIN_OFFSET_MS = 60 * 60 * 1000; // check back ~1h after start by default

/** Normalize a persona value to a known persona, defaulting to the calm ally. */
export function pickPersona(p) {
  return PERSONAS.includes(p) ? p : 'ally';
}

/** Normalize a recurrence value to a known cadence, defaulting to a one-shot. */
export function pickRecurrence(r) {
  return RECURRENCES.includes(r) ? r : 'none';
}

/** Parse an 'HH:MM' wall-clock string into {h, m}, or null if unusable. */
export function parseLocalTime(v) {
  if (typeof v !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return { h, m: mi };
}

/** Render {h,m} → zero-padded 'HH:MM'. */
function fmtLocalTime(h, m) {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * The recipient-local wall-clock fields of an instant in a given IANA zone.
 * Uses Intl (Workers + Node support IANA zones); no Node built-ins. Returns
 * null if the zone/instant is unusable so callers can fall back to UTC.
 */
function tzParts(dateMs, timeZone) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    const map = {};
    for (const p of dtf.formatToParts(new Date(dateMs))) map[p.type] = p.value;
    return map;
  } catch {
    return null;
  }
}

/** Offset (ms) such that localWallAsUTC = instant + offset, at `dateMs` in `timeZone`. */
function tzOffsetMs(dateMs, timeZone) {
  const m = tzParts(dateMs, timeZone);
  if (!m) return 0;
  let hour = +m.hour;
  if (hour === 24) hour = 0; // some ICU builds render midnight as 24 under h23
  const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, hour, +m.minute, +m.second);
  return asUTC - dateMs;
}

/**
 * The UTC instant (ms) of a wall-clock Y-M-D H:M in `timeZone`. DST-correct:
 * we guess, read the zone offset at the guess, correct, then re-read once to
 * settle spring-forward / fall-back edges.
 */
function zonedWallToUtcMs(y, mo, d, h, mi, timeZone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const utc1 = guess - tzOffsetMs(guess, timeZone);
  const utc2 = guess - tzOffsetMs(utc1, timeZone);
  return utc2;
}

/**
 * The next occurrence of a recurring check-in, strictly after `afterISO`, at
 * `localTime` wall-clock in `timezone`, honoring the weekday filter for
 * 'weekdays'. Pure + DST-correct. Returns an ISO string, or null for a
 * one-shot ('none') or unusable input.
 *
 * @param {object} p { recurrence, timezone, localTime, afterISO }
 * @returns {string|null}
 */
export function nextOccurrenceISO({ recurrence, timezone, localTime, afterISO } = {}) {
  const rec = pickRecurrence(recurrence);
  if (rec === 'none') return null;
  const t = parseLocalTime(localTime);
  if (!t) return null;
  const tz = (typeof timezone === 'string' && timezone.trim()) ? timezone.trim() : 'UTC';
  const after = new Date(afterISO);
  if (Number.isNaN(after.getTime())) return null;

  const start = tzParts(after.getTime(), tz);
  if (!start) return null;
  let y = +start.year, mo = +start.month, d = +start.day;

  for (let i = 0; i < 14; i++) {
    const cand = zonedWallToUtcMs(y, mo, d, t.h, t.m, tz);
    if (cand > after.getTime()) {
      const wd = (tzParts(cand, tz) || {}).weekday;
      const isWeekend = wd === 'Sat' || wd === 'Sun';
      if (!(rec === 'weekdays' && isWeekend)) return new Date(cand).toISOString();
    }
    // Advance one calendar day (label arithmetic; the wall instant is recomputed above).
    const nextLabel = new Date(Date.UTC(y, mo - 1, d) + 24 * 60 * 60 * 1000);
    y = nextLabel.getUTCFullYear(); mo = nextLabel.getUTCMonth() + 1; d = nextLabel.getUTCDate();
  }
  return null;
}

/**
 * Pull the FIRST occurrence of a recurring commitment onto a day the recurrence
 * actually allows. The derive-from-local-time path already runs through
 * `nextOccurrenceISO` (which honors the weekday filter), but an EXPLICIT
 * `start_at` bypasses that filter — so a 'weekdays' word handed a weekend start
 * (e.g. the in-app "9am" parsed on a Saturday) would otherwise fire its very
 * first check-in on the weekend, contradicting the choice the person made.
 *
 * A start already on an allowed day is returned UNCHANGED (a Monday 9am stays
 * Monday 9am — we never push a valid start forward); only an excluded day is
 * advanced to the next allowed occurrence at the same recipient-local time.
 * Idempotent, DST-correct (delegates to `nextOccurrenceISO`), and a no-op for
 * one-shots and 'daily' (which excludes no day).
 *
 * @param {string} startISO the resolved first-occurrence instant
 * @param {string} recurrence
 * @param {string} timezone
 * @param {string} localTime  the HH:MM wall-clock anchor (must match startISO)
 * @returns {string} the aligned ISO instant (or startISO unchanged)
 */
export function alignStartToRecurrence(startISO, recurrence, timezone, localTime) {
  const rec = pickRecurrence(recurrence);
  if (rec === 'none' || rec === 'daily') return startISO;
  const ms = new Date(startISO).getTime();
  if (Number.isNaN(ms)) return startISO;
  const tz = (typeof timezone === 'string' && timezone.trim()) ? timezone.trim() : 'UTC';
  const wd = (tzParts(ms, tz) || {}).weekday;
  const excluded = rec === 'weekdays' && (wd === 'Sat' || wd === 'Sun');
  if (!excluded) return startISO;
  // The start's day is excluded — advance to the next allowed occurrence at the
  // same local time. afterISO=startISO makes the search strictly forward from it.
  return nextOccurrenceISO({ recurrence: rec, timezone: tz, localTime, afterISO: startISO }) || startISO;
}

/** Convert a clock regex match [full, hh, mm?, meridiem?] to [h, m] 24h; [null,null] if impossible. */
function clockTo24(m) {
  const hh = parseInt(m[1], 10);
  const mm = m[2] ? parseInt(m[2], 10) : 0;
  const mer = m[3];
  if (mm > 59) return [null, null];
  if (mer) {
    if (hh < 1 || hh > 12) return [null, null];
    return [mer === 'pm' ? (hh % 12) + 12 : (hh % 12), mm];
  }
  if (hh > 23) return [null, null];
  return [hh, mm];
}

/**
 * Turn a natural-language "when do you want to try again?" SMS reply into a
 * future ISO instant, DST-correct in the recipient's timezone. Returns null when
 * no concrete time is found so the caller can re-ask — we NEVER assume a time,
 * and (per the design LAW) never assume a miss. Only invoked in the
 * conversational-reschedule context, where the person was just asked for a time;
 * that context is what lets a bare "3" safely mean 3 o'clock.
 *
 * Understood: "in 20", "in 20 min", "in 2 hours", "in an hour", "in half an
 * hour"; "3pm", "3:30 pm", "9am", "14:00", "noon", "midnight", bare "3"/"8"
 * (soonest future); "tonight", "this afternoon", "this morning", "in the
 * morning", "in the afternoon", "in the evening" (a bare part of day today,
 * rolling to the same part of day tomorrow if it's already past);
 * "tomorrow", "tomorrow 9am", "tomorrow morning";
 * a named weekday within the next two weeks — "monday", "mon 3pm", "saturday
 * morning", "next friday" (bare = soonest future; "next X" = the following week);
 * an explicit calendar date within the horizon — "the 20th", "jul 20", "july
 * 20th", "20 july", "jul 20 3pm" (a bare day-of-month requires an ordinal so a
 * plain hour is never read as a date); a numeric MM/DD date — "7/20", "07-08",
 * "7/8 3pm" (a "/" or "-" separator is required so a lone number stays a clock,
 * and an out-of-horizon numeric date falls through to the clock reading rather
 * than re-asking).
 *
 * @param {object} p { nowISO, timezone, defaultTime }  defaultTime='HH:MM' usual check-in time
 * @returns {string|null}
 */
export function parseWhenReply(text, { nowISO, timezone, defaultTime } = {}) {
  const tz = (typeof timezone === 'string' && timezone.trim()) ? timezone.trim() : 'UTC';
  const nowMs = nowISO && !Number.isNaN(Date.parse(nowISO)) ? Date.parse(nowISO) : Date.now();
  const MIN_MS = 60 * 1000;
  const HORIZON_MS = 14 * 24 * 60 * 60 * 1000;
  const soonest = nowMs + MIN_MS - 1; // must land at least ~a minute out

  let t = String(text == null ? '' : text).toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9:\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  t = t.replace(/\bat\b/g, ' ').replace(/\s+/g, ' ').trim(); // "at 3pm" → "3pm"

  // A second, separator-preserving normalization: the pass above strips "/" and
  // "-" (so "7/20" collapses to "7 20"), but a numeric MM/DD date needs the
  // separator to be readable. Keep it here for the numeric-date branch only.
  const tSep = String(text == null ? '' : text).toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9:/\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const inRange = (ms) => (ms != null && ms > soonest && ms <= nowMs + HORIZON_MS) ? new Date(ms).toISOString() : null;

  // ── Relative: "in ..." ── minutes/hours AND days/weeks. A bare "in 2 days"
  // used to fall through to the numeric branch with no unit and land 2 *minutes*
  // out (the bro showing up seconds later, not in two days) — a nag, the opposite
  // of the anti-shame LAW on the two-way text channel that is the moat while voice
  // is gated. Day/week units are now first-class; anything past the 14-day
  // reschedule horizon (e.g. "in 3 weeks") still falls through to the warm ask.
  if (/^in\b/.test(t)) {
    let mins = null;
    if (/\bhalf(\s+an?)?\s+hour\b/.test(t)) mins = 30;
    else if (/\ban?\s+hour\b/.test(t)) mins = 60;
    else if (/\ban?\s+day\b/.test(t)) mins = 24 * 60;
    else if (/\ban?\s+week\b/.test(t)) mins = 7 * 24 * 60;
    else {
      const m = t.match(/^in\s+(\d{1,4})\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks)?\b/);
      if (m) {
        const n = parseInt(m[1], 10);
        const u = m[2] || 'm';
        mins = /^w/.test(u) ? n * 7 * 24 * 60
          : /^d/.test(u) ? n * 24 * 60
          : /^h/.test(u) ? n * 60
          : n;
      }
    }
    if (mins > 0) return inRange(nowMs + Math.round(mins) * MIN_MS);
    // No quantity found — but "in the morning / in the afternoon / in the evening"
    // is a natural reschedule answer whose part-of-day the branch below reads
    // cleanly. Fall through to it instead of the hard re-ask this branch used to
    // do: a common casual answer going unread is a quiet "he didn't get me" on the
    // exact two-way text channel that is the moat while voice is gated. Anything
    // else vague after "in" ("in a bit", "in a while") carries no concrete time,
    // so it still falls to the warm "when do you want to try again?" ask.
    if (!/\b(morning|afternoon|evening|night)\b/.test(t)) return null;
    // else: fall through to the part-of-day / tomorrow / weekday branches below.
  }

  // Local calendar anchor for "today" in the recipient's zone.
  const p = tzParts(nowMs, tz);
  if (!p) return null;
  const y0 = +p.year, mo0 = +p.month, d0 = +p.day;
  const addDay = (y, mo, d, n) => {
    const dt = new Date(Date.UTC(y, mo - 1, d) + n * 24 * 60 * 60 * 1000);
    return [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
  };
  const at = (y, mo, d, h, mi) => zonedWallToUtcMs(y, mo, d, h, mi, tz);
  const [ty, tm, td] = addDay(y0, mo0, d0, 1);

  if (/\bmidnight\b/.test(t)) return inRange(at(ty, tm, td, 0, 0));
  if (/\bnoon\b/.test(t) && !/\btomorrow\b/.test(t)) {
    return inRange(at(y0, mo0, d0, 12, 0)) || inRange(at(ty, tm, td, 12, 0));
  }

  // "day after tomorrow" CONTAINS "tomorrow" but means +2 days. Detect it first
  // so the tomorrow branch below can land it two days out instead of one — a
  // reschedule for the day-after must never arrive a full day early on the exact
  // two-way text channel that is the moat (showing up a day early reads as a nag,
  // the opposite of the anti-shame design LAW).
  const wantsDayAfterTomorrow = /\bday after (tomorrow|tmrw|tmr)\b/.test(t);
  const wantsTomorrow = /\b(tomorrow|tmrw|tmr)\b/.test(t);
  const wantsTonight = /\b(tonight|this evening)\b/.test(t);
  const partOfDay = /\bmorning\b/.test(t) ? [9, 0]
    : /\bafternoon\b/.test(t) ? [14, 0]
    : /\b(evening|night)\b/.test(t) ? [19, 0]
    : null;
  const clock = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);

  if (wantsTonight && !clock) {
    return inRange(at(y0, mo0, d0, 20, 0)) || inRange(at(ty, tm, td, 20, 0));
  }

  if (wantsTomorrow) {
    // "day after tomorrow" is two days out; a plain "tomorrow" is one. Time-of-
    // day reads exactly the same either way.
    const [dy, dmo, dd] = wantsDayAfterTomorrow ? addDay(y0, mo0, d0, 2) : [ty, tm, td];
    let h, mi;
    if (clock) {
      const [ch, cm] = clockTo24(clock);
      if (ch == null) return null;
      // A bare small hour "tomorrow 3" reads as afternoon; "tomorrow 9" as morning.
      h = (!clock[3] && !clock[2] && ch >= 1 && ch <= 6) ? ch + 12 : ch;
      mi = cm;
    } else if (partOfDay) { [h, mi] = partOfDay; }
    else { const dt = parseLocalTime(defaultTime) || { h: 9, m: 0 }; h = dt.h; mi = dt.m; }
    return inRange(at(dy, dmo, dd, h, mi));
  }

  // ── A named weekday: "monday", "mon 3pm", "next friday", "saturday morning" ──
  // Within the 14-day horizon a weekday name is a natural way to reschedule
  // ("let's do saturday"). Bare form = the soonest future occurrence of that
  // day; "next X" forces the following week. Time-of-day reuses the SAME clock /
  // part-of-day / default-time reading as the tomorrow branch, so "mon 3" and
  // "tomorrow 3" behave alike. "weekend" reads as Saturday.
  const wdMatch = t.match(
    /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|weekend|sun|mon|tues|tue|weds|wed|thurs|thur|thu|fri|sat)\b/
  );
  if (wdMatch) {
    const WD = {
      sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tues: 2, tue: 2,
      wednesday: 3, weds: 3, wed: 3, thursday: 4, thurs: 4, thur: 4, thu: 4,
      friday: 5, fri: 5, saturday: 6, sat: 6, weekend: 6,
    };
    const WD_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const targetWd = WD[wdMatch[1]];
    const todayWd = WD_INDEX[p.weekday];
    if (targetWd == null || todayWd == null) return null;

    let h, mi;
    if (clock) {
      const [ch, cm] = clockTo24(clock);
      if (ch == null) return null;
      // A bare small hour "monday 3" reads as afternoon; "monday 9" as morning.
      h = (!clock[3] && !clock[2] && ch >= 1 && ch <= 6) ? ch + 12 : ch;
      mi = cm;
    } else if (partOfDay) { [h, mi] = partOfDay; }
    else { const dt = parseLocalTime(defaultTime) || { h: 9, m: 0 }; h = dt.h; mi = dt.m; }

    const base = (targetWd - todayWd + 7) % 7; // 0..6 days ahead (0 = today)
    const offsets = /\bnext\b/.test(t) ? [base + 7] : [base, base + 7];
    const cands = [];
    for (const off of offsets) {
      const [yy, mm2, dd] = addDay(y0, mo0, d0, off);
      cands.push(at(yy, mm2, dd, h, mi));
    }
    const future = cands
      .filter((ms) => ms > soonest && ms <= nowMs + HORIZON_MS)
      .sort((a, b) => a - b);
    return future.length ? new Date(future[0]).toISOString() : null;
  }

  // ── An explicit calendar date: "the 20th", "jul 20", "july 20th", "20 july" ──
  // Naming a date is a natural way to move a word ("let's do the 20th", "jul
  // 20") that a weekday name can't express when someone knows the date but not
  // the day-of-week. Stays inside the SAME ≤14-day reschedule horizon as every
  // branch (the horizon bound is applied below), reuses the SAME clock / part-of-
  // day / default-time reading, and — like every branch here — can only turn a
  // previously-unreadable reply into a landed reschedule, never a miss.
  const MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  };
  const MON_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sept|sep|oct|nov|dec)[a-z]*';
  const ORD = '(?:st|nd|rd|th)';
  let dateMonth = null, dateDay = null, dateSpan = null;
  const md = t.match(new RegExp(`\\b${MON_RE}\\s+(\\d{1,2})${ORD}?\\b`))
          || t.match(new RegExp(`\\b(\\d{1,2})${ORD}?\\s+${MON_RE}\\b`));
  if (md) {
    if (MONTHS[md[1]] != null) { dateMonth = MONTHS[md[1]]; dateDay = parseInt(md[2], 10); }
    else { dateMonth = MONTHS[md[2]]; dateDay = parseInt(md[1], 10); }
    dateSpan = md[0];
  } else {
    // A bare day-of-month MUST carry an ordinal ("the 20th", "25th") so a plain
    // hour ("20", "3") is never mistaken for a date and stays with the clock branch.
    const ord = t.match(new RegExp(`\\b(?:the\\s+)?(\\d{1,2})${ORD}\\b`));
    if (ord) { dateDay = parseInt(ord[1], 10); dateSpan = ord[0]; }
  }
  if (dateDay != null && dateDay >= 1 && dateDay <= 31) {
    // Time-of-day from the message with the date tokens stripped, so "jul 20
    // 3pm" reads 3pm — not 20:00 from the day number.
    const rest = t.replace(dateSpan, ' ').replace(/\s+/g, ' ').trim();
    const clock2 = rest.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
    let h, mi;
    if (clock2) {
      const [ch, cm] = clockTo24(clock2);
      if (ch == null) return null;
      // A bare small hour "the 20th 3" reads as afternoon; "9" as morning.
      h = (!clock2[3] && !clock2[2] && ch >= 1 && ch <= 6) ? ch + 12 : ch;
      mi = cm;
    } else if (partOfDay) { [h, mi] = partOfDay; }
    else { const dt = parseLocalTime(defaultTime) || { h: 9, m: 0 }; h = dt.h; mi = dt.m; }

    // Named month → that day this year, else next year. Bare day → this month,
    // else next month. A day that overflows its month (e.g. "feb 30") is dropped,
    // never rolled forward. The horizon filter then keeps only a candidate inside
    // the reschedule window — an explicit date beyond it re-asks warmly, as ever.
    const nextMo = mo0 === 12 ? 1 : mo0 + 1;
    const nextY = mo0 === 12 ? y0 + 1 : y0;
    const tryMonths = dateMonth != null
      ? [[y0, dateMonth], [y0 + 1, dateMonth]]
      : [[y0, mo0], [nextY, nextMo]];
    const cands = [];
    for (const [yy, mm2] of tryMonths) {
      const ms = at(yy, mm2, dateDay, h, mi);
      const chk = tzParts(ms, tz);
      if (chk && +chk.day === dateDay && +chk.month === mm2) cands.push(ms);
    }
    const future = cands
      .filter((ms) => ms > soonest && ms <= nowMs + HORIZON_MS)
      .sort((a, b) => a - b);
    return future.length ? new Date(future[0]).toISOString() : null;
  }

  // ── A numeric calendar date: "7/20", "07-08", "7 / 20" ──
  // A slash or dash between two 1–2 digit numbers is the last date shape the
  // parser couldn't read. REQUIRING the separator is exactly the guard that
  // keeps a lone number ("20", "3") a clock — the bare-number reading is
  // untouched. Read US month-first. A meridiem right after the pair ("3-4pm")
  // is a time range, not a date, so it's excluded. Unlike the named-date branch
  // above, this one only *commits* when it lands inside the horizon: an
  // out-of-window ("3/4" in July) or invalid pair falls THROUGH to the clock
  // reading, so a reply that already parsed never regresses to a re-ask —
  // strictly upgrade-only, per the design LAW.
  const numDate = tSep.match(/\b(\d{1,2})\s*[/-]\s*(\d{1,2})\b(?!\s*(?:am|pm))/);
  if (numDate) {
    const nm = parseInt(numDate[1], 10);
    const nd = parseInt(numDate[2], 10);
    if (nm >= 1 && nm <= 12 && nd >= 1 && nd <= 31) {
      // Time-of-day from the message with the date pair stripped, so "7/20 3pm"
      // reads 3pm — not 20:00 from the day number. Bare pair → usual/default time.
      const rest = t.replace(`${numDate[1]} ${numDate[2]}`, ' ').replace(/\s+/g, ' ').trim();
      const clockN = rest.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
      let h = null, mi = 0;
      if (clockN) {
        const [ch, cm] = clockTo24(clockN);
        if (ch != null) {
          // A bare small hour "7/20 3" reads as afternoon; "9" as morning.
          h = (!clockN[3] && !clockN[2] && ch >= 1 && ch <= 6) ? ch + 12 : ch;
          mi = cm;
        }
      }
      if (h == null) {
        if (partOfDay) { [h, mi] = partOfDay; }
        else { const dt = parseLocalTime(defaultTime) || { h: 9, m: 0 }; h = dt.h; mi = dt.m; }
      }
      // The named month → that day this year, else next year. A day that
      // overflows its month ("2/30") is dropped via a tzParts match, never
      // rolled. The horizon filter then keeps only an in-window instant.
      const cands = [];
      for (const yy of [y0, y0 + 1]) {
        const ms = at(yy, nm, nd, h, mi);
        const chk = tzParts(ms, tz);
        if (chk && +chk.day === nd && +chk.month === nm) cands.push(ms);
      }
      const future = cands
        .filter((ms) => ms > soonest && ms <= nowMs + HORIZON_MS)
        .sort((a, b) => a - b);
      if (future.length) return new Date(future[0]).toISOString();
      // else: not consumed — fall through to the clock branch (no regression).
    }
  }

  // ── A bare part-of-day today ("this afternoon", "this morning") ──
  // "tonight"/"this evening" already land above; the OTHER parts of day, said on
  // their own about today, deserve the same graceful read instead of falling
  // through to "I didn't catch a time" — a natural reschedule answer ("this
  // afternoon") going unread is a quiet "he didn't get me" on the exact two-way
  // text channel that is the moat while voice is gated. Mirror the tonight
  // branch: try today at that part-of-day hour, else the SAME part-of-day
  // tomorrow (inRange enforces never-past + within-horizon, and the confirmation
  // reads the concrete time back, so a rolled-forward "morning" is never a silent
  // wrong assumption). Only when there's no clock (a clock is more specific and
  // is handled below) and no weekday/date already consumed it above.
  if (partOfDay && !clock) {
    const [ph, pmin] = partOfDay;
    return inRange(at(y0, mo0, d0, ph, pmin)) || inRange(at(ty, tm, td, ph, pmin));
  }

  // ── Clock time today (roll to tomorrow if already past) ──
  if (clock) {
    const hasMeridiem = !!clock[3];
    const hh = parseInt(clock[1], 10);
    const mm = clock[2] ? parseInt(clock[2], 10) : 0;
    if (mm > 59) return null;
    if (hasMeridiem) {
      const [h] = clockTo24(clock);
      if (h == null) return null;
      return inRange(at(y0, mo0, d0, h, mm)) || inRange(at(ty, tm, td, h, mm));
    }
    if (hh > 23) return null;
    if (hh >= 13 || clock[2]) {
      // 24h reading ("14:00", "15") or explicit :mm — literal, roll if past.
      return inRange(at(y0, mo0, d0, hh, mm)) || inRange(at(ty, tm, td, hh, mm));
    }
    // Ambiguous 0..12 with no minutes → soonest future among AM/PM, today or tomorrow.
    const amH = hh % 12, pmH = (hh % 12) + 12;
    const cands = [];
    for (const [yy, mm2, dd] of [[y0, mo0, d0], [ty, tm, td]]) {
      cands.push(at(yy, mm2, dd, amH, mm), at(yy, mm2, dd, pmH, mm));
    }
    const future = cands.filter((ms) => ms > soonest && ms <= nowMs + HORIZON_MS).sort((a, b) => a - b);
    return future.length ? new Date(future[0]).toISOString() : null;
  }

  return null;
}

/**
 * A warm, recipient-local rendering of an instant for SMS confirmations —
 * "at 3:00 PM", "tomorrow at 8:40 AM", "Sat at 9:00 AM". A target 7+ days out
 * names the calendar date too ("Mon Jul 20 at 3:00 PM") so a bare weekday can't
 * be misheard as the nearer same-weekday inside the 14-day reschedule horizon.
 * Falls back to a plain UTC stamp if Intl or the zone is unusable. Pure; pass
 * nowISO for a stable today/tomorrow prefix.
 */
export function formatWhenLocal(iso, timezone, nowISO) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const tz = (typeof timezone === 'string' && timezone.trim()) ? timezone.trim() : 'UTC';
  try {
    const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
    const nowMs = nowISO && !Number.isNaN(Date.parse(nowISO)) ? Date.parse(nowISO) : Date.now();
    const dp = tzParts(d.getTime(), tz), np = tzParts(nowMs, tz);
    if (dp && np) {
      if (`${dp.year}-${dp.month}-${dp.day}` === `${np.year}-${np.month}-${np.day}`) return `at ${time}`;
      const nx = new Date(Date.UTC(+np.year, +np.month - 1, +np.day) + 24 * 60 * 60 * 1000);
      if (+dp.year === nx.getUTCFullYear() && +dp.month === nx.getUTCMonth() + 1 && +dp.day === nx.getUTCDate()) {
        return `tomorrow at ${time}`;
      }
      const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d);
      // A bare weekday name is only unambiguous within this week. The reschedule
      // horizon runs 14 days (parseWhenReply), so a target 7+ days out shares its
      // weekday with a nearer day and a read-back like "Mon at 3:00 PM" reads as
      // the CLOSER Monday when the real one is 11 days away — a quiet "he didn't
      // get me" on the exact loop the reschedule parser feeds. Name the calendar
      // date past the 6-day mark so the confirmation can't be misheard.
      const DAY_MS = 24 * 60 * 60 * 1000;
      const diffDays = Math.round(
        (Date.UTC(+dp.year, +dp.month - 1, +dp.day) - Date.UTC(+np.year, +np.month - 1, +np.day)) / DAY_MS
      );
      if (diffDays >= 2 && diffDays <= 6) return `${wd} at ${time}`;
      const md = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(d);
      return `${wd} ${md} at ${time}`;
    }
    return `at ${time}`;
  } catch {
    return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }
}

/**
 * A warm, human phrase for a commitment's cadence — the rhythm the bro shows
 * up on. Momentum-only framing: cadence describes when someone asked to be met,
 * never a miss tally. Pure + deterministic so every surface (`/me/`, the coach
 * view) reads the same rhythm. The timezone, if any, is surfaced separately by
 * callers; this label stays a compact "what/when".
 * @param {object} p { recurrence, localTime }
 * @returns {string}  e.g. "Every day at 08:40", "Weekdays", "One-time"
 */
export function describeCadence({ recurrence, localTime } = {}) {
  const rec = pickRecurrence(recurrence);
  const t = parseLocalTime(localTime);
  const at = t ? ` at ${fmtLocalTime(t.h, t.m)}` : '';
  if (rec === 'daily') return `Every day${at}`;
  if (rec === 'weekdays') return `Weekdays${at}`;
  return 'One-time';
}

/** Derive an 'HH:MM' local-time anchor from an ISO instant in a zone. */
export function localTimeFromISO(iso, timezone) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const m = tzParts(d.getTime(), (typeof timezone === 'string' && timezone.trim()) ? timezone.trim() : 'UTC');
  if (!m) return '';
  let hour = +m.hour;
  if (hour === 24) hour = 0;
  return fmtLocalTime(hour, +m.minute);
}

/**
 * Validate + normalize the body of a create-commitment request.
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function validateCommitmentInput(body, nowISO) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'A commitment needs at least a title and a start time.' };
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return { ok: false, error: 'What are you going to do? Give it a title.' };
  if (title.length > MAX_TITLE) return { ok: false, error: `Keep the title under ${MAX_TITLE} characters.` };

  const details = typeof body.details === 'string' ? body.details.trim().slice(0, MAX_DETAILS) : '';

  const timezone = typeof body.timezone === 'string' && body.timezone.trim() ? body.timezone.trim() : 'UTC';
  const recurrence = pickRecurrence(body.recurrence);
  const localTimeIn = parseLocalTime(body.local_time);

  // A recurring commitment can either be given an explicit first `start_at` or
  // derive it from the local time-of-day anchor (the way the /me/ "repeat" UI
  // sends it). Either way the check-in IS that moment — no +1h default.
  let startAt = parseWhen(body.start_at);
  if (!startAt && recurrence !== 'none' && localTimeIn) {
    startAt = nextOccurrenceISO({
      recurrence, timezone,
      localTime: fmtLocalTime(localTimeIn.h, localTimeIn.m),
      afterISO: nowISO || new Date().toISOString(),
    });
  }
  if (!startAt) {
    return {
      ok: false,
      error: recurrence !== 'none'
        ? 'For a repeating check-in, tell me the time of day and pick daily or weekdays.'
        : 'When do you want to start? Give a valid start time.',
    };
  }

  // For a recurring commitment the cron needs a local-time anchor to compute
  // each next occurrence; derive it from the start instant when not given.
  const localTime = recurrence === 'none'
    ? ''
    : (localTimeIn ? fmtLocalTime(localTimeIn.h, localTimeIn.m) : localTimeFromISO(startAt, timezone));

  // Pull the FIRST occurrence onto a day the recurrence allows. An explicit
  // start_at bypasses the derive-path's weekday filter, so a 'weekdays' word
  // given a weekend start would otherwise fire its first check-in on the weekend.
  if (recurrence !== 'none' && localTime) {
    startAt = alignStartToRecurrence(startAt, recurrence, timezone, localTime);
  }

  let checkinAt = parseWhen(body.checkin_at);
  if (!checkinAt) {
    checkinAt = recurrence !== 'none'
      ? startAt // the recurring check-in fires at the moment itself
      : new Date(new Date(startAt).getTime() + DEFAULT_CHECKIN_OFFSET_MS).toISOString();
  }

  const channel = typeof body.channel === 'string' ? body.channel.toLowerCase() : 'push';
  if (channel === 'voice') {
    return { ok: false, error: 'Voice check-ins are coming soon — for now pick push or text and I’ll still show up.' };
  }
  if (!CHANNELS.includes(channel)) {
    return { ok: false, error: `Check-in channel must be one of: ${CHANNELS.join(', ')}.` };
  }

  const persona = pickPersona(body.persona);

  return { ok: true, value: { title, details, startAt, checkinAt, channel, persona, timezone, recurrence, localTime } };
}

/**
 * Validate + normalize an EDIT of an existing commitment (change it in place).
 *
 * The whole point: a small change — a reworded title, a different time, "make
 * this daily" — must never cost you the streak, which is exactly what happens
 * when the only way to change a word is to set it down and give a fresh one.
 * This merges the provided fields over the existing row and returns the full
 * normalized set to persist, plus a `scheduleChanged` flag so the route knows
 * whether the check-in needs re-queuing. Only the fields actually present in
 * `body` change; everything else is carried over untouched. Pure + testable —
 * no DB, no streak (an edit is never a resolution).
 *
 * @param {object} existing the current commitment row
 * @param {object} body the edit request (any subset of the mutable fields)
 * @param {string} [nowISO] the reference instant for recomputing a recurrence
 * @returns {{ ok: true, value: object, scheduleChanged: boolean } | { ok: false, error: string }}
 */
export function buildCommitmentEdit(existing, body, nowISO) {
  if (!existing) return { ok: false, error: 'Not found' };
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Nothing to change — tell me what to update.' };
  }

  const out = {
    title: existing.title,
    details: existing.details || '',
    channel: existing.channel || 'push',
    persona: pickPersona(existing.persona),
    timezone: existing.timezone || 'UTC',
    recurrence: pickRecurrence(existing.recurrence),
    localTime: existing.local_time || '',
    startAt: existing.start_at,
    checkinAt: existing.checkin_at,
  };
  let touched = false;
  let scheduleChanged = false;

  if (body.title !== undefined) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return { ok: false, error: 'What are you going to do? Give it a title.' };
    if (title.length > MAX_TITLE) return { ok: false, error: `Keep the title under ${MAX_TITLE} characters.` };
    out.title = title; touched = true;
  }

  if (body.details !== undefined) {
    out.details = typeof body.details === 'string' ? body.details.trim().slice(0, MAX_DETAILS) : '';
    touched = true;
  }

  if (body.persona !== undefined) { out.persona = pickPersona(body.persona); touched = true; }

  if (body.channel !== undefined) {
    const channel = typeof body.channel === 'string' ? body.channel.toLowerCase() : '';
    if (channel === 'voice') {
      return { ok: false, error: 'Voice check-ins are coming soon — for now pick push or text and I’ll still show up.' };
    }
    if (!CHANNELS.includes(channel)) {
      return { ok: false, error: `Check-in channel must be one of: ${CHANNELS.join(', ')}.` };
    }
    out.channel = channel; touched = true;
  }

  // Anything that moves WHEN the bro shows up needs the check-in re-queued.
  const wantsTimezone = body.timezone !== undefined;
  const wantsRecurrence = body.recurrence !== undefined;
  const wantsLocalTime = body.local_time !== undefined;
  const wantsStartAt = body.start_at !== undefined;
  const wantsCheckinAt = body.checkin_at !== undefined;

  if (wantsTimezone) {
    out.timezone = (typeof body.timezone === 'string' && body.timezone.trim()) ? body.timezone.trim() : 'UTC';
    touched = true;
  }
  if (wantsRecurrence) { out.recurrence = pickRecurrence(body.recurrence); touched = true; }

  if (wantsTimezone || wantsRecurrence || wantsLocalTime || wantsStartAt || wantsCheckinAt) {
    scheduleChanged = true; touched = true;
    const now = nowISO || new Date().toISOString();

    if (out.recurrence !== 'none') {
      // A rhythm needs a local time-of-day anchor. Prefer the one given, then the
      // one already stored, then derive it from the existing start instant — so
      // "make this daily" keeps the same time of day without asking again.
      let lt = wantsLocalTime ? parseLocalTime(body.local_time)
        : (existing.local_time ? parseLocalTime(existing.local_time) : null);
      if (!lt && existing.start_at) {
        const derived = localTimeFromISO(existing.start_at, out.timezone);
        if (derived) lt = parseLocalTime(derived);
      }
      if (!lt) {
        return { ok: false, error: 'For a repeating check-in, tell me the time of day (HH:MM) and pick daily or weekdays.' };
      }
      out.localTime = fmtLocalTime(lt.h, lt.m);
      const nextISO = nextOccurrenceISO({
        recurrence: out.recurrence, timezone: out.timezone, localTime: out.localTime, afterISO: now,
      });
      if (!nextISO) {
        return { ok: false, error: 'For a repeating check-in, tell me the time of day and pick daily or weekdays.' };
      }
      out.startAt = nextISO;
      out.checkinAt = nextISO; // the recurring check-in IS the moment itself
    } else {
      // A one-time word. Keep it simple: take the new start (or the existing one)
      // and check in ~1h later unless an explicit check-in time is given.
      out.localTime = '';
      const startAt = wantsStartAt ? parseWhen(body.start_at) : existing.start_at;
      if (!startAt) return { ok: false, error: 'When do you want to start? Give a valid start time.' };
      out.startAt = startAt;
      let checkinAt = wantsCheckinAt ? parseWhen(body.checkin_at) : null;
      if (!checkinAt) checkinAt = new Date(new Date(startAt).getTime() + DEFAULT_CHECKIN_OFFSET_MS).toISOString();
      out.checkinAt = checkinAt;
    }
  }

  if (!touched) return { ok: false, error: 'Nothing to change — tell me what to update.' };
  return { ok: true, value: out, scheduleChanged };
}

/** Parse a when-value into an ISO string, or null if unusable. */
function parseWhen(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Pure kept-word-streak transition.
 *
 * - kept       → +1 to the current streak, +1 total kept, longest tracked.
 * - reschedule → streak PROTECTED (unchanged): rescheduling is the no-shame
 *                path, so it never breaks the chain.
 * - missed     → current streak silently resets to 0. We keep NO miss tally —
 *                counting failures is a defect under the design LAW.
 *
 * @param {object} prev  { current_streak, longest_streak, total_kept, last_kept_date }
 * @param {'kept'|'missed'|'reschedule'} outcome
 * @param {string} [today] ISO date (YYYY-MM-DD) the kept happened on
 */
export function computeStreakAfter(prev, outcome, today) {
  const s = {
    current_streak: Number(prev?.current_streak) || 0,
    longest_streak: Number(prev?.longest_streak) || 0,
    total_kept: Number(prev?.total_kept) || 0,
    last_kept_date: prev?.last_kept_date || null,
  };

  if (outcome === 'kept') {
    s.current_streak += 1;
    s.total_kept += 1;
    if (s.current_streak > s.longest_streak) s.longest_streak = s.current_streak;
    if (today) s.last_kept_date = today;
  } else if (outcome === 'missed') {
    s.current_streak = 0; // no-shame reset; no miss counter, ever
  }
  // 'reschedule' → protected, no change
  return s;
}

// ── COPY ENGINE ──────────────────────────────────────────────
// Every string below is an ally. Warm, gender-neutral, no shame, no "AI",
// no clinical claim. Persona shifts the energy (calm vs. hype), never the care.

/** The nudge sent at check-in time: "you said, I'm here, let's go." */
export function checkinPromptCopy({ title, persona } = {}) {
  const what = (title || 'the thing').toString();
  if (pickPersona(persona) === 'hype') {
    return `Yo — you called it: ${what}. Let’s get it. I’m right here with you. 🔥`;
  }
  return `You said you’d ${startsWithVerbish(what) ? '' : 'do '}${what}. I’m here — ready to go? We’ve got this.`;
}

/**
 * The one-line reply hint appended to a TEXT check-in (only). Text has no action
 * buttons, so the nudge itself makes the two-way loop discoverable: DONE keeps
 * the word; LATER opens the "when do you want to try again?" conversation. Never
 * a scold — LATER is offered as warmly as DONE.
 */
export function checkinReplyHint(persona) {
  return pickPersona(persona) === 'hype'
    ? 'Reply DONE when it’s handled — or LATER and I’ll ask when you want to try again. 💪'
    : 'Reply DONE when it’s done — or LATER, and I’ll ask when you want to try again.';
}

/**
 * The ONE follow-up when a delivered check-in has gone quiet (Wingspan W1,
 * the escalation ladder: push → SMS, exactly once, consent-gated). ADHD brains
 * swipe a push away by reflex; a text lands differently. The LAW carries
 * through hardest here — an escalation is an ally knocking once more, never a
 * scold, never a tally, and it always offers the warm exit ("pick a better
 * time") as readily as the start.
 */
export function escalationCopy({ title, persona } = {}) {
  const what = (title || 'the thing').toString();
  if (pickPersona(persona) === 'hype') {
    return `Still right here — ${what} is ready when you are. One tiny step together? 🔥`;
  }
  return `No rush — I’m still here about ${what}. Want to start small together, or pick a better time?`;
}

/**
 * The gentle RETURN nudge (Wingspan W4 / L3, #40): the escalation ladder applied
 * to *returning*, not just starting. When someone who has given words before has
 * gone quiet across the whole app — with nothing already in flight to reach them
 * — the bro reaches out exactly ONCE per dormancy episode, warmly, with zero
 * agenda. The LAW is at its sharpest here: this is the most shame-prone moment in
 * the product (the abandoned to-do app's "you disappeared"), so the copy NEVER
 * names the absence, never a streak-at-risk, never a "you missed" — it is an ally
 * glad they exist, holding the door open. Opt-in by channel (push is subscribed;
 * text is TCPA consent-gated). Persona shifts the energy, never the care.
 */
export function returnNudgeCopy({ persona } = {}) {
  if (pickPersona(persona) === 'hype') {
    return 'Yo — no agenda, just in your corner. 💪 Whenever you want to line something up, I’m right here. Want to give a word for today?';
  }
  return 'Hey — no pressure at all, just checking in. I’m still here whenever you want to pick something back up. Want to give a word for today?';
}

/** After a kept word: celebrate the person, name the streak, mean it. */
export function keptCopy({ persona, streak } = {}) {
  const n = Number(streak) || 0;
  const run = n > 1 ? ` That’s ${n} in a row — your word’s good.` : ' Your word’s good with me.';
  if (pickPersona(persona) === 'hype') {
    return `LET’S GO — you did the thing!${n > 1 ? ` ${n} in a row, that’s all you.` : ''} 💪`;
  }
  return `You did the thing. Proud of you.${run}`;
}

/** After a miss: NEVER a scold. Meet them with warmth and an open door. */
export function missRescheduleCopy({ persona } = {}) {
  if (pickPersona(persona) === 'hype') {
    return 'All good — no stress at all. Life happens. We just pick a new time. When works for you?';
  }
  return 'No problem at all — life happens, and I’m still on your side. When do you want to try again?';
}

/** Confirming a reschedule: the word still counts; the chain is intact. */
export function rescheduleConfirmCopy({ persona, when } = {}) {
  const at = when ? ` for ${formatWhen(when)}` : '';
  if (pickPersona(persona) === 'hype') {
    return `Locked in${at}. I got you — nothing broken, we just go again. 💪`;
  }
  return `Got it — I’ll check back${at}. Your word’s still good with me; we just pick it back up.`;
}

/**
 * Confirming a release ("set it down"): a person's plans change, and choosing
 * NOT to carry a word forward has to be as warm and blameless as keeping it.
 * Setting a commitment down is not a miss — the streak is untouched, the door
 * stays open, and the copy is glad they told us, never disappointed.
 */
export function releaseConfirmCopy({ persona } = {}) {
  if (pickPersona(persona) === 'hype') {
    return 'Set it down — no stress at all. Clearing this one off your plate. Your streak’s untouched; start a fresh word whenever you’re ready. 💪';
  }
  return 'Consider it set down — no problem at all. I’ve cleared it, and your streak stays right where it is. Give a new word whenever you’re ready.';
}

/**
 * Confirming a snooze ("I'm on it"): the person is mid-thing and wants the bro
 * to check back shortly — not a resolution, not a reschedule, not a miss. The
 * copy is glad they're on it and promises to come back, never "don't forget,"
 * never pressure. Names the interval so the return is concrete.
 */
export function snoozeConfirmCopy({ persona, minutes } = {}) {
  const m = clampSnoozeMinutes(minutes);
  if (pickPersona(persona) === 'hype') {
    return `Love it — you’re on it! I’ll swing back in ${m} minutes. Right here cheering you on. 🔥`;
  }
  return `You got it — I’ll check back in ${m} minutes. No rush at all; I’m right here.`;
}

/**
 * Confirming a pause ("take a break"): the recurring rhythm is set aside on
 * purpose — not ended, not missed. Pausing is the "life happens" flex for a
 * repeating check-in: someone going away shouldn't have to set the whole word
 * down (release) or absorb a pile of nudges they can't answer. The kept-word
 * streak is untouched, the door stays wide open, and the copy is glad they told
 * us and ready whenever they're back — never disappointed, never a countdown.
 */
export function pauseConfirmCopy({ persona } = {}) {
  if (pickPersona(persona) === 'hype') {
    return 'Paused — go live your life! Your streak’s locked in right where it is. Say the word whenever you’re back and we’re rolling again. 🔥';
  }
  return 'Paused — take all the time you need. Your streak stays exactly where it is, and I’ll be right here when you’re back. Just say the word to pick the rhythm back up.';
}

/**
 * Confirming a resume ("welcome back"): the rhythm is on again after a pause.
 * Warm, glad they're back, and concrete about when the next check-in lands so
 * the return is real. Never a word about the time away — a pause was always
 * allowed, so there is nothing to make up for.
 */
export function resumeConfirmCopy({ persona, when } = {}) {
  const at = when ? ` Next check-in ${formatWhen(when)}.` : '';
  if (pickPersona(persona) === 'hype') {
    return `Back in action — let’s GO!${at} So glad you’re here; we’re rolling again. 💪`;
  }
  return `Welcome back — we’re on again.${at} Good to have you; let’s keep the rhythm going.`;
}

/**
 * Confirming an edit ("got the change"): a person adjusted a word in place —
 * a reworded title, a new time, a different rhythm — instead of setting it down
 * and starting over. The whole reason this exists is that a small change must
 * never cost the streak, so the copy says exactly that: the change landed, the
 * streak stays put, we pick up from here. When the schedule moved, it names the
 * next check-in so the new rhythm is concrete. Never a word about what changed
 * being a step back — adjusting a plan is not a miss.
 * @param {object} p { persona, scheduleChanged, when }
 * @returns {string}
 */
export function editConfirmCopy({ persona, scheduleChanged, when } = {}) {
  const at = (scheduleChanged && when) ? ` Next check-in ${formatWhen(when)}.` : '';
  if (pickPersona(persona) === 'hype') {
    return scheduleChanged
      ? `Updated — got the new plan!${at} Your streak’s locked right where it is; we just keep rolling. 🔥`
      : 'Updated — got it! Your streak’s right where it is; we just keep rolling. 💪';
  }
  return scheduleChanged
    ? `All set — I’ve got the change.${at} Your streak stays right where it is; we just pick it up from here.`
    : 'All set — I’ve got the change. Your streak stays right where it is; nothing else moves.';
}

/**
 * A warm one-liner over the kept-word log — the record of every word a person
 * kept. Momentum-only by construction: it counts kept words, never the ones set
 * down or moved. On an empty record it's an open invitation, never "you've done
 * nothing." The list itself is drawn separately; this is the header line.
 * @param {object} p { total, persona }
 * @returns {string}
 */
export function keptLogCopy({ total, persona } = {}) {
  const n = Number(total) || 0;
  if (n === 0) {
    if (pickPersona(persona) === 'hype') {
      return 'Blank page, big future — the first word you keep lands right here. 🔥';
    }
    return 'This is where your kept words gather. The first one lands here whenever you’re ready.';
  }
  const word = n === 1 ? 'word' : 'words';
  if (pickPersona(persona) === 'hype') {
    return `${n} ${word} kept — that’s all you. Look at this list and keep stacking. 💪`;
  }
  return `${n} ${word} you’ve kept. This is the record of you showing up — every one counts.`;
}

// ── KEPT-WORD MOMENTUM (the person's own view) ───────────────
// The coach detail view shows a client's kept-word momentum sparkline; these
// supply the first-person voice for the same shape on the person's own /me/
// view. The math is the shared ./momentum.js engine; the words live here with
// the API that emits them. DESIGN LAW: momentum reads KEPT instants only, so a
// quiet day is a short bar — the absence of a win, never a surfaced miss.

/** Heading over the person's own momentum sparkline. */
export function momentumSelfHeadingCopy() {
  return 'Your momentum';
}

/** Intro under the momentum heading — a momentum chart, first person. */
export function momentumSelfIntroCopy() {
  return 'Words you kept, day by day. Quiet days are just quiet — this only ever counts your wins.';
}

/**
 * Warm one-line summary of your kept-word window, first person. Momentum-only:
 * it names how many words you kept and your best single day, and on a quiet
 * window it reads as a fresh page — never a tally of what you didn't do.
 * @param {object} p { total, days, peak }
 * @returns {string}
 */
export function momentumSelfSummaryCopy({ total, days = MOMENTUM_WINDOW_DAYS, peak } = {}) {
  const kept = Number(total) || 0;
  const span = Number(days) || MOMENTUM_WINDOW_DAYS;
  if (kept === 0) {
    return `A clean page over the last ${span} days — every window is a fresh start, and your next kept word lands right here.`;
  }
  const best = Number(peak && peak.count) || 0;
  const bestPart = best > 1 ? ` Your best day: ${best} kept.` : '';
  return `You kept ${kept} word${kept === 1 ? '' : 's'} over the last ${span} days.${bestPart}`;
}

/** Heading over a single word's own momentum sparkline in its detail panel. */
export function detailMomentumHeadingCopy() {
  return 'Momentum on this word';
}

/** Intro under the per-word momentum heading — this one word's shape, first person. */
export function detailMomentumIntroCopy() {
  return 'This word, day by day — only the times you kept it. Quiet days are just quiet.';
}

/**
 * Warm one-line summary of a single word's kept-word window, first person.
 * Momentum-only: it names how many times you kept THIS word and your best single
 * day for it, and on a quiet window it reads as a fresh page — never a tally of
 * what you didn't do.
 * @param {object} p { total, days, peak }
 * @returns {string}
 */
export function detailMomentumSummaryCopy({ total, days = MOMENTUM_WINDOW_DAYS, peak } = {}) {
  const kept = Number(total) || 0;
  const span = Number(days) || MOMENTUM_WINDOW_DAYS;
  if (kept === 0) {
    return `Nothing kept on this one in the last ${span} days — a clean stretch, and the next time you keep it lands right here.`;
  }
  const best = Number(peak && peak.count) || 0;
  const bestPart = best > 1 ? ` Your best day: ${best}.` : '';
  return `You kept this word ${kept} time${kept === 1 ? '' : 's'} over the last ${span} days.${bestPart}`;
}

/**
 * A warm "best day" callout for a single word's momentum — the piece the
 * sparkline can't say: WHICH day it peaked, and how many times you kept it then.
 * Shown only for a genuine standout (a day with 2+ kept), so a word whose kept
 * days are all singles never gets an arbitrary "best day". Anti-shame by
 * construction: it celebrates a high point and never sets it against now —
 * "so far" frames the mark as still open to being beaten, never "you were
 * better before". Returns '' when there is no standout to name.
 * @param {object} p { count, whenPhrase }
 * @returns {string}
 */
export function detailPeakDayCopy({ count, whenPhrase } = {}) {
  const n = Number(count) || 0;
  const when = typeof whenPhrase === 'string' ? whenPhrase.trim() : '';
  if (n < 2 || !when) return '';
  return `Your best day on this word so far: ${when} — ${n} kept. 🔥`;
}

/**
 * Header line over a single word's detail view. Momentum-only, by the design LAW:
 * it names how many times this word was kept and never how many times it wasn't —
 * the detail view carries a kept timeline, never a miss list.
 */
export function commitmentDetailCopy({ persona, keptCount } = {}) {
  const n = Number(keptCount) || 0;
  const hype = pickPersona(persona) === 'hype';
  if (n === 0) {
    return hype
      ? 'No history on this one yet — this is where every win on it will stack. 🔥'
      : 'No kept check-ins on this one yet. The first one lands here whenever you’re ready.';
  }
  const word = n === 1 ? 'time' : 'times';
  return hype
    ? `Kept ${n} ${word} on this one — that’s momentum. Keep it rolling. 💪`
    : `You’ve kept this word ${n} ${word}. Here’s the record for it — every check-in you showed up for.`;
}

/** A streak summary. On zero, it's a fresh start — never "you failed." */
export function streakSummaryCopy({ streak, persona } = {}) {
  const cur = Number(streak?.current_streak) || 0;
  const best = Number(streak?.longest_streak) || 0;
  if (cur === 0) {
    if (pickPersona(persona) === 'hype') {
      return 'Fresh start, clean slate. Next one’s yours — I’m ready when you are. 🔥';
    }
    return 'Fresh start whenever you’re ready. I’m here for the next one — no pressure, no catching up.';
  }
  const bestPart = best > cur ? ` (your best is ${best})` : '';
  return `You’ve kept your word ${cur} time${cur === 1 ? '' : 's'} in a row${bestPart}. Every single one counts.`;
}

/**
 * A personal-best celebration for the kept-word streak — the one thing the raw
 * streak number can't say on its own: you are AT your all-time high right now.
 * Shown ONLY when the current run equals the longest you've ever kept
 * (`current === longest`) and it's worth marking (2+ in a row).
 *
 * Anti-shame BY CONSTRUCTION: this line can only exist at a peak, so it can
 * never surface on a decline. The moment the current run drops below your best,
 * this returns '' and the page says NOTHING about the gap — never a "streak at
 * risk", never "you were better before". It frames the mark as "the longest
 * you've ever kept going", which is honest whether you just set a fresh record
 * or climbed back to match one (we can't tell the two apart, and both are a win
 * worth the same warmth). Returns '' when there's no peak to celebrate.
 *
 * @param {object} p { streak: { current_streak, longest_streak } }
 * @returns {string} the celebration line, or '' when not at a personal best
 */
export function personalBestCopy({ streak } = {}) {
  const cur = Number(streak?.current_streak) || 0;
  const best = Number(streak?.longest_streak) || 0;
  if (cur < 2 || cur !== best) return '';
  return `🏆 You’re at your best — ${cur} words kept in a row, the longest you’ve ever kept going. Keep it rolling.`;
}

/** Kept-word streak counts worth a distinct "you just reached it" mark. */
export const STREAK_MILESTONES = [3, 7, 14, 30, 100];

/**
 * A milestone badge for the kept-word streak — fires ONLY when the current run is
 * EXACTLY at one of {@link STREAK_MILESTONES}. It marks a discrete "you just
 * reached N kept words in a row" moment, independent of {@link personalBestCopy}
 * (which marks being at your all-time peak): you can cross the 14-word milestone
 * while your best is 30, and you can set a fresh personal best of 5 without
 * crossing a milestone. On the streak card the two can co-occur (at N === best ===
 * a milestone) — two true, unshaming wins that say different things.
 *
 * Anti-shame BY CONSTRUCTION: it reads current_streak (kept words ONLY), names a
 * count reached, and never references the past, a gap, a distance-to-the-next
 * milestone, or a "you were better." Between milestones it returns '' and the page
 * says nothing — it is never a "you're not there yet" nag. A run that climbs back
 * to 14 after a reset earns the exact same warmth as the first time (we can't tell
 * the two apart, and both are 14 words kept — worth the same mark).
 *
 * @param {object} p { streak: { current_streak } }
 * @returns {string} the milestone line, or '' when not exactly at a milestone
 */
export function milestoneCopy({ streak } = {}) {
  const cur = Number(streak?.current_streak) || 0;
  if (!STREAK_MILESTONES.includes(cur)) return '';
  return `🎯 ${cur} kept words in a row — that’s a real milestone. Proud of you.`;
}

// ── TWO-WAY TEXT CHECK-INS ───────────────────────────────────
// A text check-in ("You said you'd start the taxes at 2 — ready?") is only half
// the loop if you can't answer it. When someone texts back, we read the reply:
// "done / did it / yep" keeps the word; "later / not yet / tomorrow" is the
// no-shame reschedule. Anything we can't read gets a warm clarifying nudge — we
// never assume a miss from a message we didn't understand. STOP/START/HELP are
// intercepted upstream (consent.js) before this runs, so they never land here.

/**
 * Interpret an inbound check-in reply.
 * @param {string} text  the raw SMS body
 * @returns {'kept'|'reschedule'|'snooze'|null}  null = couldn't tell (ask, don't assume)
 */
export function detectCheckinReply(text) {
  const raw = String(text == null ? '' : text);
  const t = raw
    .toLowerCase()
    .replace(/[’‘]/g, "'")            // normalize curly apostrophes to straight
    .replace(/[^a-z0-9\s']/g, ' ')    // keep letters/digits/apostrophes; drop other punctuation/emoji
    .replace(/\s+/g, ' ')
    .trim();

  // A bare affirmation emoji (👍 ✅ 🙌 💪 …) is a near-universal "done" — but the
  // alnum normalization above strips every emoji, so a reply that is ONLY an emoji
  // collapses to empty and used to read as "I didn't catch that" on the exact
  // two-way channel that is the live moat. Recognize the positive ones as KEPT.
  // The word signals below still win whenever they're present ("not yet 👍" stays
  // a reschedule, "did it 🎉" stays kept via the words), so this emoji reading only
  // ever decides the case the words couldn't. We NEVER map an emoji to reschedule:
  // a truly unreadable reply (e.g. 🤔) must fall through to the warm "when do you
  // want to try again?" ask — never assume a miss.
  const AFFIRM_EMOJI = /[\u{1F44D}\u{1F44C}\u{1F64C}\u{1F4AA}\u{1F389}\u{1F525}\u{1F4AF}✅✔]/u;
  const hasAffirmEmoji = AFFIRM_EMOJI.test(raw);
  if (!t) return hasAffirmEmoji ? 'kept' : null;

  // "did it" / "got it done" / "all done" → kept. Check the reschedule forms
  // first — especially the NEGATED ones — so "not done" / "haven't yet" is never
  // misread as "done".
  const RESCHEDULE = /\b(later|not yet|notyet|not done|not finished|not complete[d]?|nope|tomorrow|reschedule|resched|snooze|skip|rain ?check|another time|next time|move it|push it|can'?t|cannot|couldn'?t|didn'?t|did not|haven'?t|havent|won'?t|no can do)\b/;
  // The yes-family alternatives are elongation-tolerant on purpose: a casual
  // "yesss", "yaas", "yea", "yah" is a near-universal "done", but the plain
  // `yes|yeah|ya` forms only matched the un-stretched spelling — so an excited
  // one-word affirmation fell through to "I didn't catch that" on the exact
  // two-way channel that is the live moat. The vowel/consonant runs (`ye+s+`,
  // `yea+h*`, `ya+s+`, `yah+`, `yep+`, `yup+`, `yay+`) stay anchored by `\b` on
  // both ends, so "year"/"yeast"/"yesterday" never match, and RESCHEDULE still
  // runs first so a negated "not yet yea" is a reschedule, never misread as kept.
  const KEPT = /\b(done|did it|did that|didit|finished|complete[d]?|got it done|all done|handled|nailed it|crushed it|yep+|yup+|yea+h*|ye+s+|yeh+|ya+s+|yah+|yay+|ya|kept|on it done)\b/;
  // The third answer, mid-task: "I'm on it — check back in a bit." The in-app
  // nudge has always offered a snooze button beside DONE / LATER, but the SMS
  // channel — the live moat — only understood two answers: an engaged person who
  // texted back "on it!" / "still working on it" got the confused "I didn't catch
  // that, reply DONE or LATER" instead of the warm "you got it, I'll swing back."
  // These are the ACTIVELY-doing-it phrasings — never "done", never "can't" — so
  // this only ever decides a reply that KEPT and RESCHEDULE both left as null; both
  // run first, so "on it done" stays kept and any negation stays a reschedule. A
  // residual bare "not on it" is guarded out below (it falls through to the warm
  // ask, never a wrong snooze) rather than being read as "check back."
  const SNOOZE = /\b(on it|onit|working on it|still working|still on it|still at it|still going|almost there|nearly there|getting to it|in the middle|middle of it|mid ?task|give me a (?:few|sec|min|moment)|gimme a (?:few|sec|min|moment)|few more min|couple more min|need a (?:few|sec|min|moment)|one sec|hang on|hold on)\b/;

  if (RESCHEDULE.test(t)) return 'reschedule';
  if (KEPT.test(t)) return 'kept';
  if (SNOOZE.test(t) && !/\bnot\b/.test(t)) return 'snooze';
  // bare affirmations / negations as a last pass
  if (/^(y|k|ok|okay|done|yay)$/.test(t)) return 'kept';
  if (/^(n|no|not)$/.test(t)) return 'reschedule';
  // A positive emoji rode along with words we couldn't classify ("meh 👍") → keep.
  if (hasAffirmEmoji) return 'kept';
  return null;
}

/** Reply after an SMS "done" — celebrate the person + name the streak. Never a scold. */
export function smsKeptReplyCopy({ persona, streak } = {}) {
  const n = Number(streak) || 0;
  if (pickPersona(persona) === 'hype') {
    return `YES — you did the thing!${n > 1 ? ` ${n} in a row, that’s all you.` : ''} 💪`;
  }
  return `Love it — you did the thing.${n > 1 ? ` That’s ${n} in a row; your word’s good with me.` : ' Your word’s good with me.'}`;
}

/** Reply after an SMS "later" — the no-shame reschedule. The chain stays intact. */
export function smsRescheduleReplyCopy({ persona } = {}) {
  if (pickPersona(persona) === 'hype') {
    return 'All good — life happens, no stress. Pick a fresh time in the app whenever you’re ready; your streak’s safe. 🔥';
  }
  return 'No problem at all — I’m still on your side. Set a new time in the app whenever you like; your word still counts.';
}

/** Reply when we couldn't read the message — ask, warmly. Never assume a miss. */
export function smsAmbiguousReplyCopy({ persona } = {}) {
  if (pickPersona(persona) === 'hype') {
    return 'Gotcha! Text DONE if you got it, or LATER to grab a new time — I’m here for you either way. 💪';
  }
  return 'I’m here for you. Reply DONE if you did it, or LATER to pick a new time — no rush, no pressure.';
}

/**
 * After a "later", ASK when — right here over text, not "go open the app". The
 * design LAW's literal promise on a miss: "no problem — when do you want to try
 * again?" The moat is that the whole conversation stays on the channel that
 * reached them.
 */
export function smsAskWhenCopy({ persona } = {}) {
  // Advertise the full vocabulary parseWhenReply actually reads — a clock time,
  // a relative offset, a named weekday (R-258), and a calendar date (R-259/260).
  // A natural-language time surface is only as usable as the phrasings people
  // know they can say; keep the examples in lock-step with the parser (tested).
  if (pickPersona(persona) === 'hype') {
    return 'No stress at all — when do you want to try again? Text me a time like 3pm, tomorrow 9am, Saturday, or Jul 20 and I’ll be right there. 🔥';
  }
  return 'No problem at all — when do you want to try again? Text me a time like 3pm, tomorrow 9am, Saturday, or Jul 20, and I’ll check back then.';
}

/** Confirm the new time the person gave over text. The word still counts; the streak is safe. */
export function smsRescheduledCopy({ persona, when, timezone, nowISO } = {}) {
  const at = when ? formatWhenLocal(when, timezone, nowISO) : 'then';
  if (pickPersona(persona) === 'hype') {
    return `Got it — I’ll check back ${at}. Your word still counts and your streak’s safe. Let’s go. 💪`;
  }
  return `Got it — I’ll check back ${at}. Your word still counts, and your streak stays right where it is.`;
}

/** We asked for a time and couldn't read one — ask again, warmly. Never assume a miss. */
export function smsWhenUnclearCopy({ persona } = {}) {
  // Same widened vocabulary as the ask copy — when a reply didn't land, steer
  // toward the phrasings that WORK (weekday, date), never away from them.
  if (pickPersona(persona) === 'hype') {
    return 'I didn’t quite catch a time there — try something like 3pm, tomorrow 9am, Saturday, or the 20th and I’ve got you. 💪';
  }
  return 'I didn’t catch a time there — try something like 3pm, tomorrow 9am, Saturday, or the 20th, and I’ll check back then.';
}

/**
 * The canonical in-app "when" examples for the `/me/` time fields — the
 * give-a-word placeholder, the reschedule prompt, and the empty-field re-ask.
 * Kept in lock-step with `parseWhenReply` exactly as `smsAskWhenCopy` is for the
 * text channel (R-262): a relative offset, a clock time, a named weekday
 * (R-258), and a calendar date (R-259/260) — the full range the ONE parser
 * reads. There is a single parser on every surface (R-233), so the in-app fields
 * must advertise what a person can actually type, or the weekday/date parsing is
 * stranded in the app the same way it was on SMS before R-262. The literal
 * examples are matched to `smsAskWhenCopy` so the app and the text channel speak
 * with one voice.
 * @returns {string[]}
 */
export function inAppWhenExamples() {
  return ['in 30 min', 'tomorrow 9am', 'Saturday', 'Jul 20'];
}

/** The in-app "when" examples as one comma-joined phrase for a placeholder / prose re-ask. */
export function inAppWhenExamplesText() {
  return inAppWhenExamples().join(', ');
}

/**
 * The shared check-in resolution core. Used by the in-app route AND the inbound
 * SMS reply path so both keep the streak the same way. Given an already-loaded
 * check-in row joined with its commitment, this:
 *   1. stamps the outcome on that specific check-in row,
 *   2. moves the commitment to its terminal state (one-shot) or keeps it active
 *      (recurring — a rhythm is never "done"),
 *   3. applies the kept-word streak transition (no miss counter, ever), and
 *   4. re-queues the next occurrence for a recurring commitment so the rhythm
 *      never stalls.
 * Returns the fresh streak so the caller can render warm, accurate copy.
 *
 * @param {object} env
 * @param {object} p  { userId, checkin: {id, commitment_id}, commitment: {id, recurrence, timezone, local_time, channel, persona}, outcome, note, nowISO }
 * @returns {Promise<{ streak: object, isRecurring: boolean }>}
 */
export async function applyCheckinOutcome(env, { userId, checkin, commitment, outcome, note = '', nowISO } = {}) {
  const now = nowISO || new Date().toISOString();
  const isRecurring = pickRecurrence(commitment.recurrence) !== 'none';
  const newCommitmentStatus = isRecurring ? 'active'
    : outcome === 'kept' ? 'kept'
    : outcome === 'missed' ? 'missed' : 'rescheduled';

  // 1. stamp the specific check-in row
  await env.DB.prepare(
    `UPDATE commitment_checkins
        SET status = ?, responded_at = datetime('now'), note = ?
      WHERE id = ? AND user_id = ?`
  ).bind(outcome, String(note || '').slice(0, MAX_DETAILS), checkin.id, userId).run();

  // 2. move the commitment
  await env.DB.prepare(
    `UPDATE commitments SET status = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`
  ).bind(newCommitmentStatus, commitment.id, userId).run();

  // 3. streak transition
  const prev = await readStreak(env, userId);
  const next = computeStreakAfter(prev, outcome, now.slice(0, 10));
  await writeStreak(env, userId, next);

  // 4. keep the rhythm alive (recurring only, idempotent)
  if (isRecurring) {
    const nextISO = nextOccurrenceISO({
      recurrence: commitment.recurrence,
      timezone: commitment.timezone,
      localTime: commitment.local_time,
      afterISO: now,
    });
    if (nextISO) {
      const existing = await env.DB.prepare(
        `SELECT id FROM commitment_checkins
          WHERE commitment_id = ? AND status = 'pending' AND scheduled_for > ? LIMIT 1`
      ).bind(commitment.id, now).first();
      if (!existing) {
        await env.DB.prepare(
          `INSERT INTO commitment_checkins (id, commitment_id, user_id, scheduled_for, channel, status)
           VALUES (?, ?, ?, ?, ?, 'pending')`
        ).bind(generateUUID(), commitment.id, userId, nextISO, commitment.channel || 'text').run();
      }
    }
  }

  // Instrument the loop's resolution — the signal the retention/coach proof
  // reads (IMPROVEMENT_PLAN L1). Non-fatal: recordEvent swallows its own errors,
  // so a resolve is never blocked by instrumentation. "reschedule" is a protected
  // outcome here, never a miss score. This one call covers BOTH the in-app resolve
  // route and the inbound-SMS reply path, since both share this core.
  const evt = outcomeEvent(outcome);
  if (evt) {
    await recordEvent(env, {
      userId, type: evt,
      data: { commitment_id: commitment.id, is_recurring: isRecurring, channel: commitment.channel || null },
    });
  }

  return { streak: next, isRecurring };
}

/** Read a user's kept-word streak row (module-level; used by applyCheckinOutcome). */
export async function readStreak(env, userId) {
  const row = await env.DB.prepare(
    `SELECT current_streak, longest_streak, total_kept, last_kept_date
       FROM accountability_streaks WHERE user_id = ?`
  ).bind(userId).first();
  return row || { current_streak: 0, longest_streak: 0, total_kept: 0, last_kept_date: null };
}

/** Upsert a user's kept-word streak row (module-level; used by applyCheckinOutcome). */
export async function writeStreak(env, userId, s) {
  await env.DB.prepare(
    `INSERT INTO accountability_streaks
       (user_id, current_streak, longest_streak, total_kept, last_kept_date, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       current_streak = excluded.current_streak,
       longest_streak = excluded.longest_streak,
       total_kept     = excluded.total_kept,
       last_kept_date = excluded.last_kept_date,
       updated_at     = excluded.updated_at`
  ).bind(userId, s.current_streak, s.longest_streak, s.total_kept, s.last_kept_date).run();
}

/** Rough heuristic: does the title already read as an action phrase? */
function startsWithVerbish(t) {
  return /^(start|finish|do|call|email|write|clean|go|read|study|work|pay|file|send|make|book|review)\b/i.test(t.trim());
}

/** Human-ish rendering of an ISO time for copy (kept simple; no locale deps). */
function formatWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/**
 * Person-side homecoming detection — the twin of the coach "back and moving" cue
 * (R-252), read on the person's OWN `/me/`. A person the bro reached out to during
 * a quiet stretch has come back UNDER THEIR OWN STEAM — no `?from=return` deep-link
 * tap. Returns `true` exactly once per dormancy episode so `/me/` can open the SAME
 * warm nudged-back welcome (R-249) a self-powered return earns, then never re-greets.
 *
 * Consume-once by construction: a `return_welcome_shown` marker recorded AFTER the
 * latest `return_nudge_sent` closes the episode. A genuine homecoming records that
 * marker (as the person's own activity) and returns `true`; a later reload — or a
 * new dormancy episode with no fresh nudge — finds the marker and returns `false`.
 * The nudge event carries the person's id in its payload (its own `user_id` is NULL
 * by construction, so it never counts as their activity), read back via
 * `json_extract` exactly as the coach roster query does.
 *
 * DESIGN LAW: this only decides WHETHER to open the existing warm door — it emits no
 * copy and names no gap. Non-fatal: any failure resolves to `false` (a missed
 * greeting, never a broken door).
 *
 * @param {object} env  Worker env with a D1-shaped `DB`
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
export async function detectHomecoming(env, userId) {
  if (!env || !env.DB || !userId) return false;
  try {
    // Latest nudge sent to this person (payload carries the id; row user_id is NULL).
    const nudge = await env.DB.prepare(
      `SELECT MAX(created_at) AS last_nudge_at
         FROM analytics_events
        WHERE event_type = 'return_nudge_sent'
          AND json_extract(event_data, '$.user_id') = ?`
    ).bind(userId).first();
    const lastNudgeAt = nudge && nudge.last_nudge_at;
    if (!lastNudgeAt) return false;

    // Episode already greeted? A welcome-shown marker after the latest nudge closes it.
    const shown = await env.DB.prepare(
      `SELECT 1 FROM analytics_events
        WHERE event_type = 'return_welcome_shown'
          AND user_id = ?
          AND created_at > ?
        LIMIT 1`
    ).bind(userId, lastNudgeAt).first();
    if (shown) return false;

    // Genuine homecoming: close the episode (their own activity) and greet once.
    await recordEvent(env, { userId, type: EVENTS.RETURN_WELCOME_SHOWN, data: {} });
    return true;
  } catch (err) {
    console.error('[accountability] homecoming detect error:', err && err.message);
    return false;
  }
}

// ── ROUTES ───────────────────────────────────────────────────
// Registered from index.js. `ctx` supplies the module-private helpers that
// live in index.js so this module stays import-free of the router internals.

/**
 * Register the accountability API on an itty-router instance.
 * @param {object} router  itty-router instance
 * @param {object} ctx  { getAuthToken, verifyToken, jsonResponse, generateUUID }
 */
export function registerAccountabilityRoutes(router, ctx) {
  const { getAuthToken, verifyToken, jsonResponse, generateUUID } = ctx;

  async function requireUser(request, env) {
    const token = getAuthToken(request);
    if (!token) return { error: jsonResponse({ error: 'Unauthorized' }, 401) };
    const payload = await verifyToken(token, env.JWT_SECRET);
    if (!payload) return { error: jsonResponse({ error: 'Invalid token' }, 401) };
    return { userId: payload.sub };
  }

  async function loadStreak(env, userId) {
    const row = await env.DB.prepare(
      `SELECT current_streak, longest_streak, total_kept, last_kept_date
         FROM accountability_streaks WHERE user_id = ?`
    ).bind(userId).first();
    return row || { current_streak: 0, longest_streak: 0, total_kept: 0, last_kept_date: null };
  }

  // Ensure a recurring commitment always has its next pending check-in queued.
  // Idempotent: a no-op for one-shots, and only inserts when no future pending
  // check-in already exists for this commitment. Keeps the daily rhythm alive
  // whether the user resolves in-app or the delivery cron sends it.
  async function ensureNextOccurrence(env, userId, commitment, afterISO) {
    if (pickRecurrence(commitment.recurrence) === 'none') return null;
    const nextISO = nextOccurrenceISO({
      recurrence: commitment.recurrence,
      timezone: commitment.timezone,
      localTime: commitment.local_time,
      afterISO,
    });
    if (!nextISO) return null;
    const existing = await env.DB.prepare(
      `SELECT id FROM commitment_checkins
        WHERE commitment_id = ? AND status = 'pending' AND scheduled_for > ? LIMIT 1`
    ).bind(commitment.id, afterISO).first();
    if (existing) return null;
    const nid = generateUUID();
    await env.DB.prepare(
      `INSERT INTO commitment_checkins (id, commitment_id, user_id, scheduled_for, channel, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`
    ).bind(nid, commitment.id, userId, nextISO, commitment.channel).run();
    return { id: nid, scheduled_for: nextISO };
  }

  async function saveStreak(env, userId, s) {
    await env.DB.prepare(
      `INSERT INTO accountability_streaks
         (user_id, current_streak, longest_streak, total_kept, last_kept_date, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         current_streak = excluded.current_streak,
         longest_streak = excluded.longest_streak,
         total_kept     = excluded.total_kept,
         last_kept_date = excluded.last_kept_date,
         updated_at     = datetime('now')`
    ).bind(userId, s.current_streak, s.longest_streak, s.total_kept, s.last_kept_date).run();
  }

  // ── CREATE a commitment (give your word) ──
  router.post('/api/commitments', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;

      let body;
      try { body = await request.json(); } catch { body = null; }

      // A person's FIRST word should accept the same warm, natural-language time
      // as the reschedule ("Move it") and the SMS reply — "in 30 min", "tomorrow
      // 9am", "3pm" — so no one has to fight a datetime picker just to give their
      // word. Same `parseWhenReply` (DST-correct, recipient-local, never-past,
      // ≤14-day horizon) every surface uses — one parser, one voice. Only kicks
      // in when no explicit `start_at` is supplied, so the picker and any API
      // client that still sends an ISO instant stay fully backward compatible.
      if (body && typeof body === 'object'
          && !(typeof body.start_at === 'string' && body.start_at.trim())
          && typeof body.when_text === 'string' && body.when_text.trim()) {
        const startISO = parseWhenReply(body.when_text, {
          nowISO: new Date().toISOString(),
          timezone: body.timezone,
          defaultTime: body.local_time,
        });
        // Couldn't read a concrete time — ask again warmly, in the shared voice,
        // and write NOTHING. Never assume a time (and, per the LAW, never a miss).
        if (!startISO) {
          return jsonResponse({ error: smsWhenUnclearCopy({ persona: pickPersona(body.persona) }) }, 400);
        }
        body = { ...body, start_at: startISO };
      }

      const parsed = validateCommitmentInput(body);
      if (!parsed.ok) return jsonResponse({ error: parsed.error }, 400);
      const v = parsed.value;

      const id = generateUUID();
      await env.DB.prepare(
        `INSERT INTO commitments
           (id, user_id, title, details, start_at, checkin_at, channel, persona, timezone, recurrence, local_time, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
      ).bind(id, auth.userId, v.title, v.details, v.startAt, v.checkinAt, v.channel, v.persona, v.timezone, v.recurrence, v.localTime || null).run();

      // Schedule the first check-in row (pending delivery). For a recurring
      // commitment the delivery cron materializes each subsequent occurrence.
      const checkinId = generateUUID();
      await env.DB.prepare(
        `INSERT INTO commitment_checkins
           (id, commitment_id, user_id, scheduled_for, channel, status)
         VALUES (?, ?, ?, ?, ?, 'pending')`
      ).bind(checkinId, id, auth.userId, v.checkinAt, v.channel).run();

      // Instrument "a word given" (non-fatal; IMPROVEMENT_PLAN L1).
      await recordEvent(env, {
        userId: auth.userId, type: EVENTS.COMMITMENT_CREATED,
        data: { commitment_id: id, recurrence: v.recurrence, channel: v.channel },
      });

      return jsonResponse({
        commitment: {
          id, title: v.title, details: v.details, start_at: v.startAt, checkin_at: v.checkinAt,
          channel: v.channel, persona: v.persona, timezone: v.timezone,
          recurrence: v.recurrence, local_time: v.localTime || null, status: 'active',
        },
        checkin_id: checkinId,
        message: checkinPromptCopy({ title: v.title, persona: v.persona }),
      }, 201);
    } catch (err) {
      console.error('[accountability] create error:', err && err.message);
      return jsonResponse({ error: 'Could not save that commitment. Try again in a moment.' }, 500);
    }
  });

  // ── LIST my commitments (active first, newest first) ──
  router.get('/api/commitments', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;

      const rows = await env.DB.prepare(
        `SELECT id, title, details, start_at, checkin_at, channel, persona, timezone, recurrence, local_time, status, created_at
           FROM commitments WHERE user_id = ?
          ORDER BY (status = 'active') DESC, start_at DESC
          LIMIT 200`
      ).bind(auth.userId).all();
      const commitments = (rows && rows.results) || [];

      // Attach each active word's NEXT check-in — the concrete moment the bro
      // next shows up — so the person sees it across their whole list at a
      // glance, not only by opening each word's detail (R-222). One grouped
      // query (no N+1): the soonest still-outstanding check-in per commitment.
      // A resolved/kept/moved word has none, so it stays null. This is the
      // person-side twin of the coach's next-check-in (R-224). No miss surfaced:
      // an outstanding row that is already past reads as "still waiting" in the
      // UI, never as a scold.
      const outstanding = await env.DB.prepare(
        `SELECT commitment_id, MIN(scheduled_for) AS next_checkin
           FROM commitment_checkins
          WHERE user_id = ? AND status IN ('pending', 'sent', 'deferred')
          GROUP BY commitment_id`
      ).bind(auth.userId).all();
      const nextByCommitment = {};
      for (const row of (outstanding && outstanding.results) || []) {
        nextByCommitment[row.commitment_id] = row.next_checkin;
      }
      for (const c of commitments) {
        c.next_checkin = c.status === 'active' ? (nextByCommitment[c.id] || null) : null;
      }

      return jsonResponse({ commitments }, 200, 'short');
    } catch (err) {
      console.error('[accountability] list error:', err && err.message);
      return jsonResponse({ error: 'Could not load your commitments.' }, 500);
    }
  });

  // ── GET one commitment + its check-ins ──
  router.get('/api/commitments/:id', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;
      const id = request.params.id;

      const commitment = await env.DB.prepare(
        `SELECT id, title, details, start_at, checkin_at, channel, persona, timezone, recurrence, local_time, status, created_at
           FROM commitments WHERE id = ? AND user_id = ?`
      ).bind(id, auth.userId).first();
      if (!commitment) return jsonResponse({ error: 'Not found' }, 404);

      const checkins = await env.DB.prepare(
        `SELECT id, scheduled_for, channel, status, responded_at, note
           FROM commitment_checkins WHERE commitment_id = ? AND user_id = ?
          ORDER BY scheduled_for ASC`
      ).bind(id, auth.userId).all();

      return jsonResponse({ commitment, checkins: (checkins && checkins.results) || [] }, 200, 'short');
    } catch (err) {
      console.error('[accountability] get error:', err && err.message);
      return jsonResponse({ error: 'Could not load that commitment.' }, 500);
    }
  });

  // ── DETAIL for one word — its rhythm, next check-in, and KEPT timeline ──
  // The momentum view for a single commitment: cadence, the next time the bro
  // shows up (active words only), and every check-in you KEPT on this word.
  // DESIGN LAW: this reads status='kept' only — a set-down or missed check-in
  // can never appear. There is no per-word miss list anywhere in the product.
  router.get('/api/commitments/:id/detail', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;
      const id = request.params.id;

      const commitment = await env.DB.prepare(
        `SELECT id, title, details, start_at, checkin_at, channel, persona, timezone, recurrence, local_time, status, created_at
           FROM commitments WHERE id = ? AND user_id = ?`
      ).bind(id, auth.userId).first();
      if (!commitment) return jsonResponse({ error: 'Not found' }, 404);

      // Kept check-ins for THIS word, most recent first (rendered window of 50).
      const keptRows = await env.DB.prepare(
        `SELECT responded_at AS kept_at, note
           FROM commitment_checkins
          WHERE commitment_id = ? AND user_id = ? AND status = 'kept'
          ORDER BY responded_at DESC
          LIMIT 50`
      ).bind(id, auth.userId).all();
      const kept = (keptRows && keptRows.results) || [];

      // Honest total kept for this word, even past the 50-row window.
      const countRow = await env.DB.prepare(
        `SELECT COUNT(*) AS n
           FROM commitment_checkins
          WHERE commitment_id = ? AND user_id = ? AND status = 'kept'`
      ).bind(id, auth.userId).first();
      const keptCount = Number(countRow && countRow.n) || 0;

      // The next moment the bro shows up — only meaningful while active. An
      // outstanding check-in is pending / sent / deferred; soonest first.
      let nextCheckin = null;
      if (commitment.status === 'active') {
        const up = await env.DB.prepare(
          `SELECT scheduled_for
             FROM commitment_checkins
            WHERE commitment_id = ? AND user_id = ? AND status IN ('pending', 'sent', 'deferred')
            ORDER BY scheduled_for ASC
            LIMIT 1`
        ).bind(id, auth.userId).first();
        nextCheckin = up ? up.scheduled_for : null;
      }

      const cadence = describeCadence({ recurrence: commitment.recurrence, localTime: commitment.local_time });

      // Per-word momentum: the same shared sparkline engine the /me/ page and the
      // coach view use, scoped to THIS word's kept instants in the word's own
      // timezone. keptRows is the 50 most-recent kept check-ins (DESC), which
      // fully covers the 14-day window for any real cadence; buildMomentum
      // ignores anything outside it. DESIGN LAW: kept-only in, kept-only out —
      // a quiet day is a short bar, never a surfaced miss.
      const nowISO = new Date().toISOString();
      const momentumTz = commitment.timezone || 'UTC';
      const momentum = buildMomentum({
        timestamps: kept.map((k) => k.kept_at),
        nowISO,
        timezone: momentumTz,
        intro: detailMomentumIntroCopy(),
        summary: detailMomentumSummaryCopy,
      });
      // Name the day the window peaked, warmly — the sparkline shows the shape,
      // this says WHEN. Only a genuine standout (2+ kept in a day) earns a
      // callout; detailPeakDayCopy returns '' otherwise, so a word of all-single
      // days (or a quiet window) shows nothing. Same nowISO/timezone the buckets
      // used, so "today"/"yesterday"/weekday agrees with the bars exactly.
      momentum.peakDay = detailPeakDayCopy({
        count: momentum.peak && momentum.peak.count,
        whenPhrase: describePeakDay(momentum.peak && momentum.peak.date, { nowISO, timezone: momentumTz }),
      });

      return jsonResponse({
        commitment,
        cadence,
        next_checkin: nextCheckin,
        kept,
        kept_count: keptCount,
        momentum,
        message: commitmentDetailCopy({ persona: commitment.persona, keptCount }),
      }, 200, 'short');
    } catch (err) {
      console.error('[accountability] detail error:', err && err.message);
      return jsonResponse({ error: 'Could not load that word.' }, 500);
    }
  });

  // ── RESOLVE a check-in (kept / missed / reschedule) ──
  router.post('/api/commitments/:id/checkin', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;
      const id = request.params.id;

      let body;
      try { body = await request.json(); } catch { body = {}; }
      const outcome = typeof body.outcome === 'string' ? body.outcome.toLowerCase() : '';
      if (!OUTCOMES.includes(outcome)) {
        return jsonResponse({ error: `outcome must be one of: ${OUTCOMES.join(', ')}` }, 400);
      }
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, MAX_DETAILS) : '';

      const commitment = await env.DB.prepare(
        `SELECT id, title, persona, channel, timezone, recurrence, local_time, status
           FROM commitments WHERE id = ? AND user_id = ?`
      ).bind(id, auth.userId).first();
      if (!commitment) return jsonResponse({ error: 'Not found' }, 404);

      const persona = pickPersona(commitment.persona);
      const isRecurring = pickRecurrence(commitment.recurrence) !== 'none';
      // A recurring commitment is never "done" — it keeps its rhythm. Only a
      // one-shot commitment resolves to a terminal state.
      const newCommitmentStatus = isRecurring ? 'active'
        : outcome === 'kept' ? 'kept'
        : outcome === 'missed' ? 'missed' : 'rescheduled';

      // Record the resolution on the pending check-in (or the latest one).
      await env.DB.prepare(
        `UPDATE commitment_checkins
            SET status = ?, responded_at = datetime('now'), note = ?
          WHERE user_id = ? AND commitment_id = ?
            AND id = (
              SELECT id FROM commitment_checkins
               WHERE commitment_id = ? AND user_id = ?
               ORDER BY (status = 'pending') DESC, scheduled_for DESC LIMIT 1
            )`
      ).bind(outcome, note, auth.userId, id, id, auth.userId).run();

      await env.DB.prepare(
        `UPDATE commitments SET status = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`
      ).bind(newCommitmentStatus, id, auth.userId).run();

      // Streak transition.
      const prev = await loadStreak(env, auth.userId);
      const today = new Date().toISOString().slice(0, 10);
      const next = computeStreakAfter(prev, outcome, today);
      await saveStreak(env, auth.userId, next);

      // Keep the daily rhythm alive: a recurring commitment always re-queues its
      // next occurrence, whichever way this check-in resolved (never a dead end).
      const nowISO = new Date().toISOString();
      const nextOccurrence = isRecurring
        ? await ensureNextOccurrence(env, auth.userId, commitment, nowISO)
        : null;

      const response = { streak: next };
      if (nextOccurrence) response.next_checkin = nextOccurrence;

      if (outcome === 'kept') {
        response.message = keptCopy({ persona, streak: next.current_streak });
      } else if (outcome === 'missed') {
        // A miss still offers the open door — never a dead end.
        response.message = missRescheduleCopy({ persona });
        response.offer_reschedule = true;
      } else {
        // reschedule: create the follow-up commitment so the word carries forward.
        // The "when" can arrive two ways, and BOTH go through the same time parser
        // as the SMS reschedule (`parseWhenReply`) so the in-app "Move it" and a
        // text reply read a person's words identically — one warm, DST-correct,
        // never-past parser, never two that drift apart. Either an explicit ISO
        // instant (`new_start_at`, e.g. from a picker) or a natural-language phrase
        // (`when_text`, e.g. "in 30 min", "tomorrow 9am", "3pm").
        let newStartISO = typeof body.new_start_at === 'string' && body.new_start_at.trim()
          ? body.new_start_at.trim()
          : null;
        if (!newStartISO && typeof body.when_text === 'string' && body.when_text.trim()) {
          newStartISO = parseWhenReply(body.when_text, {
            nowISO: new Date().toISOString(),
            timezone: commitment.timezone,
            defaultTime: commitment.local_time,
          });
          // Couldn't read a concrete time — ask again warmly, in the shared voice.
          // NEVER assume a time and (per the design LAW) never a miss.
          if (!newStartISO) {
            return jsonResponse({ error: smsWhenUnclearCopy({ persona }) }, 400);
          }
        }
        const parsed = validateCommitmentInput({
          title: commitment.title,
          start_at: newStartISO,
          checkin_at: body.new_checkin_at,
          channel: commitment.channel,
          persona,
          timezone: commitment.timezone,
        });
        if (!parsed.ok) return jsonResponse({ error: parsed.error }, 400);
        const v = parsed.value;
        const newId = generateUUID();
        await env.DB.prepare(
          `INSERT INTO commitments
             (id, user_id, title, details, start_at, checkin_at, channel, persona, timezone, status, rescheduled_from)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`
        ).bind(newId, auth.userId, v.title, '', v.startAt, v.checkinAt, v.channel, v.persona, v.timezone, id).run();

        const newCheckinId = generateUUID();
        await env.DB.prepare(
          `INSERT INTO commitment_checkins (id, commitment_id, user_id, scheduled_for, channel, status)
           VALUES (?, ?, ?, ?, ?, 'pending')`
        ).bind(newCheckinId, newId, auth.userId, v.checkinAt, v.channel).run();

        response.message = rescheduleConfirmCopy({ persona, when: v.startAt });
        response.new_commitment = {
          id: newId, title: v.title, start_at: v.startAt, checkin_at: v.checkinAt,
          channel: v.channel, persona: v.persona, status: 'active',
        };
      }

      return jsonResponse(response, 200);
    } catch (err) {
      console.error('[accountability] checkin error:', err && err.message);
      return jsonResponse({ error: 'Could not record that check-in. Your word still counts — try again.' }, 500);
    }
  });

  // ── RELEASE a commitment (set it down — the no-shame exit) ──
  // Plans change. Without this the only exits from an active word are kept /
  // missed / reschedule, so a commitment a person no longer intends to keep just
  // sits active and the delivery cron nudges it forever. Setting a word down is
  // NOT a miss: the kept-word streak is untouched (the chain never breaks on a
  // release), the pending check-ins are cancelled so the bro stops ringing, and
  // — because the commitment leaves 'active' — the cron's materializer never
  // re-queues a recurring occurrence. Idempotent: releasing an already-terminal
  // commitment is a warm no-op.
  router.post('/api/commitments/:id/release', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;
      const id = request.params.id;

      const commitment = await env.DB.prepare(
        `SELECT id, title, persona, status FROM commitments WHERE id = ? AND user_id = ?`
      ).bind(id, auth.userId).first();
      if (!commitment) return jsonResponse({ error: 'Not found' }, 404);

      const persona = pickPersona(commitment.persona);

      // Move the word to a terminal, blameless 'released' state.
      await env.DB.prepare(
        `UPDATE commitments SET status = 'released', updated_at = datetime('now')
          WHERE id = ? AND user_id = ?`
      ).bind(id, auth.userId).run();

      // Stop the bro from ringing: cancel any check-ins still waiting to send
      // (pending or held-for-quiet-hours). Cancelled check-ins are inert to the
      // delivery cron (it only reads status='pending'). The streak is NEVER read
      // or written here — releasing protects the chain by construction.
      await env.DB.prepare(
        `UPDATE commitment_checkins SET status = 'cancelled', responded_at = datetime('now')
          WHERE commitment_id = ? AND user_id = ? AND status IN ('pending', 'deferred', 'awaiting_time')`
      ).bind(id, auth.userId).run();

      // Instrument "a word set down" — a blameless exit, counted as its own
      // outcome, never a miss (non-fatal; IMPROVEMENT_PLAN L1).
      await recordEvent(env, {
        userId: auth.userId, type: EVENTS.COMMITMENT_RELEASED,
        data: { commitment_id: id },
      });

      return jsonResponse({
        commitment: { id, status: 'released' },
        message: releaseConfirmCopy({ persona }),
      }, 200);
    } catch (err) {
      console.error('[accountability] release error:', err && err.message);
      return jsonResponse({ error: 'Could not set that down just now — try again in a moment.' }, 500);
    }
  });

  // ── SNOOZE a check-in ("I'm on it") — keep the bro present, touch nothing else ──
  // A real accountability friend has a third answer between "I did it" and "move
  // the whole thing": "I'm on it — check back in a bit." A push nudge swiped away
  // in half a second of reflex is the exact ADHD failure mode this product exists
  // to beat; snooze keeps the nudge alive without moving the word or resetting the
  // rhythm. It re-arms the latest still-open check-in (or opens a fresh one) a few
  // minutes out. The kept-word streak is NEVER read or written here — a snooze is
  // not a resolution, by construction — and the commitment stays exactly as it is.
  router.post('/api/commitments/:id/snooze', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;
      const id = request.params.id;

      let body;
      try { body = await request.json(); } catch { body = {}; }
      const minutes = clampSnoozeMinutes(body && body.minutes);

      const commitment = await env.DB.prepare(
        `SELECT id, persona, channel, status FROM commitments WHERE id = ? AND user_id = ?`
      ).bind(id, auth.userId).first();
      if (!commitment) return jsonResponse({ error: 'Not found' }, 404);

      const persona = pickPersona(commitment.persona);

      // Only an active word has a live nudge to push forward. A word already
      // kept, moved, or set down is warmly left alone — never an error tone.
      if (commitment.status !== 'active') {
        return jsonResponse({
          error: 'That word isn’t open right now — there’s nothing waiting to check back on. Give a fresh word whenever you’re ready.',
        }, 409);
      }

      const snoozedUntil = new Date(Date.now() + minutes * 60000).toISOString();

      // Re-arm the latest still-open check-in if there is one: the person may be
      // answering a nudge already delivered (status='sent') or one held for quiet
      // hours ('deferred'). Reset attempts so the fresh window starts clean, and
      // clear responded_at — this check-in is not resolved, just moved a little.
      const open = await env.DB.prepare(
        `SELECT id FROM commitment_checkins
          WHERE commitment_id = ? AND user_id = ? AND status IN ('pending', 'sent', 'deferred', 'awaiting_time')
          ORDER BY scheduled_for DESC LIMIT 1`
      ).bind(id, auth.userId).first();

      if (open && open.id) {
        await env.DB.prepare(
          `UPDATE commitment_checkins
              SET status = 'pending', scheduled_for = ?, attempts = 0, last_error = NULL, responded_at = NULL
            WHERE id = ? AND user_id = ?`
        ).bind(snoozedUntil, open.id, auth.userId).run();
      } else {
        // No open check-in (the last one already resolved/skipped) — open a fresh
        // one so "I'm on it" always keeps the bro coming back.
        await env.DB.prepare(
          `INSERT INTO commitment_checkins (id, commitment_id, user_id, scheduled_for, channel, status)
           VALUES (?, ?, ?, ?, ?, 'pending')`
        ).bind(generateUUID(), id, auth.userId, snoozedUntil, commitment.channel || 'push').run();
      }

      return jsonResponse({
        commitment_id: id,
        snoozed_until: snoozedUntil,
        minutes,
        message: snoozeConfirmCopy({ persona, minutes }),
      }, 200);
    } catch (err) {
      console.error('[accountability] snooze error:', err && err.message);
      return jsonResponse({ error: 'Could not set that reminder just now — try again in a moment.' }, 500);
    }
  });

  // ── PAUSE a recurring rhythm (take a break — never ending the word) ──
  // "The bro who calls you every day" needs an off switch that isn't a goodbye.
  // Before this, the only ways off an active recurring word were to resolve each
  // occurrence, set it down (release — terminal), or absorb nudges you can't
  // answer while you're away. Pause suspends the rhythm on purpose: the
  // commitment moves to a 'paused' state, its still-waiting check-ins are
  // cancelled so the bro stops ringing, and — because the delivery cron's
  // materializer only re-queues an 'active' commitment — no new occurrence is
  // scheduled while paused. The kept-word streak is NEVER read or written: a
  // pause is not a miss, by construction. Pause is for a *rhythm*; a one-shot
  // word has set-it-down / move-it instead. Idempotent-safe (409 non-active).
  router.post('/api/commitments/:id/pause', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;
      const id = request.params.id;

      const commitment = await env.DB.prepare(
        `SELECT id, persona, recurrence, status FROM commitments WHERE id = ? AND user_id = ?`
      ).bind(id, auth.userId).first();
      if (!commitment) return jsonResponse({ error: 'Not found' }, 404);

      const persona = pickPersona(commitment.persona);

      // Pause is for a repeating rhythm. A one-time word has 'set it down' / 'move it'.
      if (pickRecurrence(commitment.recurrence) === 'none') {
        return jsonResponse({
          error: 'Pause is for a repeating check-in. For a one-time word, set it down or move it whenever you need.',
        }, 409);
      }
      // Only a running rhythm can be paused. Anything else is warmly left alone.
      if (commitment.status !== 'active') {
        return jsonResponse({
          error: 'That rhythm isn’t running right now — nothing to pause. Give a fresh word whenever you’re ready.',
        }, 409);
      }

      await env.DB.prepare(
        `UPDATE commitments SET status = 'paused', updated_at = datetime('now')
          WHERE id = ? AND user_id = ?`
      ).bind(id, auth.userId).run();

      // Stop the bro from ringing while paused: cancel any check-ins still waiting
      // to send (pending or held-for-quiet-hours). The streak is NEVER touched —
      // pausing protects the chain by construction.
      await env.DB.prepare(
        `UPDATE commitment_checkins SET status = 'cancelled', responded_at = datetime('now')
          WHERE commitment_id = ? AND user_id = ? AND status IN ('pending', 'deferred', 'awaiting_time')`
      ).bind(id, auth.userId).run();

      return jsonResponse({
        commitment: { id, status: 'paused' },
        message: pauseConfirmCopy({ persona }),
      }, 200);
    } catch (err) {
      console.error('[accountability] pause error:', err && err.message);
      return jsonResponse({ error: 'Could not pause that just now — try again in a moment.' }, 500);
    }
  });

  // ── RESUME a paused rhythm (welcome back) ──
  // Bring a paused recurring word back to life: it returns to 'active' and its
  // next occurrence is scheduled at the same recipient-local wall-clock time, so
  // the rhythm picks up cleanly from now (never a backlog of the days away).
  // Idempotent-safe: only a 'paused' word resumes (409 otherwise, no mutation).
  // The kept-word streak is NEVER read or written — the time away was allowed.
  router.post('/api/commitments/:id/resume', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;
      const id = request.params.id;

      const commitment = await env.DB.prepare(
        `SELECT id, persona, channel, recurrence, timezone, local_time, status
           FROM commitments WHERE id = ? AND user_id = ?`
      ).bind(id, auth.userId).first();
      if (!commitment) return jsonResponse({ error: 'Not found' }, 404);

      const persona = pickPersona(commitment.persona);

      if (commitment.status !== 'paused') {
        return jsonResponse({
          error: 'That rhythm isn’t paused — nothing to resume. You’re all set.',
        }, 409);
      }

      await env.DB.prepare(
        `UPDATE commitments SET status = 'active', updated_at = datetime('now')
          WHERE id = ? AND user_id = ?`
      ).bind(id, auth.userId).run();

      // Schedule the next occurrence so the rhythm actually starts ringing again.
      // ensureNextOccurrence is idempotent + a no-op for a non-recurring word (a
      // paused rhythm is always recurring by construction of the pause gate).
      const nowISO = new Date().toISOString();
      const next = await ensureNextOccurrence(env, auth.userId, commitment, nowISO);

      const response = {
        commitment: { id, status: 'active' },
        message: resumeConfirmCopy({ persona, when: next && next.scheduled_for }),
      };
      if (next) response.next_checkin = next;
      return jsonResponse(response, 200);
    } catch (err) {
      console.error('[accountability] resume error:', err && err.message);
      return jsonResponse({ error: 'Could not resume that just now — try again in a moment.' }, 500);
    }
  });

  // ── EDIT a commitment (change a word in place — a small change never costs the streak) ──
  // Before this, the only way to change a word was to set it down and give a
  // fresh one — which drops the whole recurring setup and (worse, on the design
  // LAW) makes a reworded title or a nudged time feel like starting over. Editing
  // in place keeps the same commitment: adjust the title, the time, or the whole
  // cadence, and the kept-word streak is NEVER read or written (an edit is not a
  // resolution). Only an open word can be edited — an active rhythm or a paused
  // one; a wrapped-up word (kept / moved / set down) is warmly refused with a
  // nudge to give a fresh word instead (409). When the schedule moves, the
  // outstanding check-in is cancelled and a fresh one queued at the new time —
  // but only while active; a paused rhythm stays quiet until you resume it.
  router.post('/api/commitments/:id/edit', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;
      const id = request.params.id;

      let body;
      try { body = await request.json(); } catch { body = null; }

      const commitment = await env.DB.prepare(
        `SELECT id, title, details, start_at, checkin_at, channel, persona, timezone, recurrence, local_time, status
           FROM commitments WHERE id = ? AND user_id = ?`
      ).bind(id, auth.userId).first();
      if (!commitment) return jsonResponse({ error: 'Not found' }, 404);

      const persona = pickPersona(commitment.persona);

      // Only an open word can be changed in place. A word already kept, moved, or
      // set down is done — the warm move is a fresh word, never an error tone.
      if (commitment.status !== 'active' && commitment.status !== 'paused') {
        return jsonResponse({
          error: 'That word’s already wrapped up — give a fresh one whenever you’re ready.',
        }, 409);
      }

      const built = buildCommitmentEdit(commitment, body, new Date().toISOString());
      if (!built.ok) return jsonResponse({ error: built.error }, 400);
      const v = built.value;

      // Persist the merged word. The edit keeps whatever status it had (active
      // stays active, paused stays paused) — editing is not resume.
      await env.DB.prepare(
        `UPDATE commitments
            SET title = ?, details = ?, start_at = ?, checkin_at = ?, channel = ?,
                persona = ?, timezone = ?, recurrence = ?, local_time = ?, updated_at = datetime('now')
          WHERE id = ? AND user_id = ?`
      ).bind(
        v.title, v.details, v.startAt, v.checkinAt, v.channel,
        v.persona, v.timezone, v.recurrence, v.localTime || null, id, auth.userId
      ).run();

      // If WHEN the bro shows up changed, re-queue the check-in: cancel the
      // outstanding one and, for a still-active word, schedule a fresh one at the
      // new time. A paused rhythm is left quiet — resume schedules it from now.
      if (built.scheduleChanged) {
        await env.DB.prepare(
          `UPDATE commitment_checkins SET status = 'cancelled', responded_at = datetime('now')
            WHERE commitment_id = ? AND user_id = ? AND status IN ('pending', 'deferred', 'awaiting_time')`
        ).bind(id, auth.userId).run();

        if (commitment.status === 'active') {
          await env.DB.prepare(
            `INSERT INTO commitment_checkins (id, commitment_id, user_id, scheduled_for, channel, status)
             VALUES (?, ?, ?, ?, ?, 'pending')`
          ).bind(generateUUID(), id, auth.userId, v.checkinAt, v.channel).run();
        }
      }

      const response = {
        commitment: {
          id, title: v.title, details: v.details, start_at: v.startAt, checkin_at: v.checkinAt,
          channel: v.channel, persona: v.persona, timezone: v.timezone,
          recurrence: v.recurrence, local_time: v.localTime || null, status: commitment.status,
        },
        message: editConfirmCopy({
          persona,
          scheduleChanged: built.scheduleChanged,
          when: built.scheduleChanged && commitment.status === 'active' ? v.checkinAt : null,
        }),
      };
      return jsonResponse(response, 200);
    } catch (err) {
      console.error('[accountability] edit error:', err && err.message);
      return jsonResponse({ error: 'Could not save that change just now — try again in a moment.' }, 500);
    }
  });

  // ── GET my kept-word streak ──
  router.get('/api/accountability/streak', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;
      const streak = await loadStreak(env, auth.userId);
      return jsonResponse({
        streak,
        message: streakSummaryCopy({ streak }),
        best: personalBestCopy({ streak }),
        milestone: milestoneCopy({ streak }),
      }, 200, 'short');
    } catch (err) {
      console.error('[accountability] streak error:', err && err.message);
      return jsonResponse({ error: 'Could not load your streak.' }, 500);
    }
  });

  // ── GET my homecoming — am I a person the bro reached out to who has just
  // come back under my own steam? The person-side twin of the coach "back and
  // moving" cue (R-252). `true` exactly once per dormancy episode → `/me/` opens
  // the same warm nudged-back welcome (R-249) a self-powered return earns (no
  // `?from=return` tap). Consume-once + non-fatal live in detectHomecoming; the
  // response is nocache because the detection closes the episode with a marker
  // write, so a cached "true" would let a reload re-greet.
  router.get('/api/accountability/homecoming', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;
      const homecoming = await detectHomecoming(env, auth.userId);
      return jsonResponse({ homecoming }, 200);
    } catch (err) {
      console.error('[accountability] homecoming error:', err && err.message);
      return jsonResponse({ homecoming: false }, 200);
    }
  });

  // ── GET my kept-word log (the "words you kept" record) ──
  // The streak endpoint gives the current run + a lifetime total; this gives the
  // actual list — every word this person KEPT, most recent first, joined to its
  // title. Momentum-only by construction and by the DESIGN LAW: the query reads
  // ONLY status='kept' check-ins, so a set-down or moved word never appears here.
  // There is deliberately no "missed" list anywhere — a positive record, never a
  // wall of red. Lifetime total comes from the kept-word streak row (total_kept,
  // which only ever increments on a kept word), so it's honest even past the
  // rendered window.
  router.get('/api/accountability/kept', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;

      const rows = await env.DB.prepare(
        `SELECT k.responded_at AS kept_at, c.title AS title
           FROM commitment_checkins k
           JOIN commitments c ON c.id = k.commitment_id
          WHERE k.user_id = ? AND k.status = 'kept'
          ORDER BY k.responded_at DESC
          LIMIT 50`
      ).bind(auth.userId).all();

      const streak = await loadStreak(env, auth.userId);
      const total = Number(streak.total_kept) || 0;

      // ── Your kept-word momentum (per-day KEPT count over a recent window) ──
      // Same shape the coach sees, turned around for the person's own eyes. A
      // representative timezone for day boundaries: the most recently touched
      // commitment zone, UTC fallback. Fetch a slightly wider raw window than
      // the axis (tz offsets can shift an instant across midnight); bucketKeptByDay
      // trims to the last N local days. DESIGN LAW: reads status='kept' ONLY.
      const nowISO = new Date().toISOString();
      const tzRow = await env.DB.prepare(
        `SELECT timezone FROM commitments
          WHERE user_id = ? AND timezone IS NOT NULL AND timezone <> ''
          ORDER BY updated_at DESC LIMIT 1`
      ).bind(auth.userId).first();
      const momentumTz = (tzRow && tzRow.timezone) || 'UTC';
      const windowCutoffISO = new Date(Date.parse(nowISO) - (MOMENTUM_WINDOW_DAYS + 2) * 86400000).toISOString();
      const keptRows = await env.DB.prepare(
        `SELECT responded_at FROM commitment_checkins
          WHERE user_id = ? AND status = 'kept' AND responded_at IS NOT NULL AND responded_at >= ?
          ORDER BY responded_at ASC
          LIMIT 1000`
      ).bind(auth.userId, windowCutoffISO).all();
      const keptTimestamps = ((keptRows && keptRows.results) || []).map((r) => r.responded_at);
      const momentum = buildMomentum({
        timestamps: keptTimestamps,
        days: MOMENTUM_WINDOW_DAYS,
        nowISO,
        timezone: momentumTz,
        intro: momentumSelfIntroCopy(),
        summary: momentumSelfSummaryCopy,
      });

      return jsonResponse({
        kept: (rows && rows.results) || [],
        total_kept: total,
        momentum,
        message: keptLogCopy({ total }),
      }, 200, 'short');
    } catch (err) {
      console.error('[accountability] kept-log error:', err && err.message);
      return jsonResponse({ error: 'Could not load your kept words.' }, 500);
    }
  });
}
