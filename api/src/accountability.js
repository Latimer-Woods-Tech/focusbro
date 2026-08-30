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
import {
  buildMomentum, describePeakDay, MOMENTUM_WINDOW_DAYS,
  bucketKeptByHour, peakKeptHour, describeHourBand,
  POWER_HOURS_WINDOW_DAYS,
  allTimeBestDay,
  distinctKeptDays,
  bucketKeptByWeekday, peakKeptWeekday, describeWeekday,
  typicalKeptPerActiveDay,
  allTimeBestWeek, describeBestWeek, BEST_WEEK_MIN_COUNT,
  formatCalendarDay, calendarDaysAgo,
} from './momentum.js';
import { recordEvent, outcomeEvent, sanitizeAttribution, EVENTS } from './events.js';

/** Check-in delivery channels available in Phase A. Voice is Phase B (engine-gated). */
export const CHANNELS = ['push', 'text'];

/** Configurable companion persona. Both are warm; neither ever shames. */
export const PERSONAS = ['ally', 'hype'];

/** Resolution outcomes for a check-in. */
export const OUTCOMES = ['kept', 'missed', 'reschedule'];

export { sanitizeAttribution };

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
 * hour", "in a couple hours", "in a few days" (couple=2, few=3, unit required);
 * "3pm", "3:30 pm", "9am", "14:00", "noon", "midnight", bare "3"/"8"
 * (soonest future); "tonight" (and its texting spellings "tonite"/"2nite"/
 * "tnite"), "this afternoon", "this morning", "in the
 * morning", "in the afternoon", "in the evening", "end of day"/"eod"/"cob"
 * (17:00, the close of the working day), "first thing"/"first thing tomorrow"
 * (09:00, the start of the working day), "lunch"/"lunchtime"/"after lunch"
 * (13:00, the midday break), "dinner"/"dinnertime"/"after dinner"
 * (18:00, the evening meal), "mid-morning" (10:30) and "mid-afternoon"
 * (15:30) (a bare part of day today,
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

  // "-ish", the softener this audience leans on hardest, glued straight onto the
  // time it hedges — "5ish", "noonish", "8ish tonight", "5:30ish". The
  // separator-stripping pass above already lets the SPACED/HYPHENATED form through
  // ("3-ish" → "3 ish", read cleanly as 3:00), but the GLUED form the same texter
  // is at least as likely to send stayed welded to its anchor: "5ish" never
  // reached the clock branch, "noonish" never matched `\bnoon\b`, and both fell to
  // the cold re-ask — a quiet "he didn't get me" on the two-way text moat at the
  // exact moment the anti-shame LAW matters most (voice still gated). Peel a glued
  // "ish" off a digit or a named clock-word so it reads identically to its spaced
  // twin. Anchored TIGHT so it can never gut an ordinary word that merely ends in
  // "ish": only a DIGIT ("5ish" → "5", "5:30ish" → "5:30") or one of the specific
  // clock words below sheds it — "finish", "wish", "polish", "spanish" are all
  // left untouched.
  t = t
    .replace(/(\d)ish\b/g, '$1')
    .replace(/\b(noon|midnight|tonight|tonite|tomorrow|tmrw|morning|afternoon|evening)ish\b/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

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
      } else {
        // Casual word-quantity: "in a couple hours", "in a few days", "in a
        // couple of minutes". `couple`=2, `few`=3 — the SAME numeric meaning
        // already codified for the create-flow parser's NUMWORD map, now shared
        // with the reschedule channel. These are among the most natural ways an
        // ADHD brain defers a task ("gimme a couple hours"), and left unread they
        // fell to the cold re-ask — a quiet "he didn't get me" on the two-way
        // text moat that is the whole point while voice is gated, the same gap
        // "end of day"/"first thing"/"lunch"/"in N days" each closed before.
        // A unit is REQUIRED: a bare "in a couple" carries no concrete length, so
        // it stays a warm re-ask rather than firing ~2 minutes out (a nag, the
        // opposite of the anti-shame LAW). The "a/an" is optional ("in couple
        // hours") and an "of" is absorbed ("a couple of hours"). ("a"/"an" + a
        // unit alone — "in an hour", "in a day" — is already read above.)
        const wm = t.match(/^in\s+(?:an?\s+)?(couple|few)\s+(?:of\s+)?(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks)\b/);
        if (wm) {
          const n = wm[1] === 'few' ? 3 : 2;
          const u = wm[2];
          mins = /^w/.test(u) ? n * 7 * 24 * 60
            : /^d/.test(u) ? n * 24 * 60
            : /^h/.test(u) ? n * 60
            : n;
        }
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

  // ── Bare relative duration, no "in": "2 hours", "an hour", "20 min", "a
  // couple days", "few weeks", "half an hour" ── A person answering "when?" —
  // or giving a first word in the create form, which resolves through this same
  // parser (R-226) — routinely drops the "in": "couple hours", "an hour", "2
  // days". Left unread, such a reply didn't just fall to the warm re-ask: the
  // clock branch below read the COUNT as a wall-clock hour and SILENTLY DROPPED
  // the unit — "2 hours" landing at 2 AM tomorrow, "20 minutes" at 8 PM, "2
  // days" at 2 AM, "3 hrs" at 3 PM. A wrong time is the worst outcome on the
  // two-way text moat (the bro showing up at 2 AM when you said "two hours"),
  // strictly worse than the honest re-ask. This reads a bare duration IDENTICALLY
  // to its "in …" form. Guarded tight so it can only ever upgrade, never steal a
  // clock or a date: an explicit duration UNIT is REQUIRED (a bare "3"/"9" stays
  // a clock, untouched), and the WHOLE message must be just that duration (± a
  // leading/trailing hedge — "maybe"/"like"/"i think" — or an "or so"/"ish"/
  // "please"), so a "tomorrow 2 hours"-shaped or dated or weekday reply is never
  // matched here. In the SMS/in-app check-in paths a bare
  // "an hour"/"2 hours" is classified a SNOOZE upstream (detectCheckinReply) and
  // never reaches this parser, so this changes only the create form and the
  // day/week-unit replies the snooze net doesn't own — always toward the right
  // instant.
  //
  // Hedge tolerance: this audience rarely answers a bare duration flat — it comes
  // wrapped in uncertainty ("maybe 2 hours", "like 20 minutes", "an hour i
  // think", "prob a couple days"). The whole-message match below is what keeps
  // this branch from ever stealing a clock or a date, but a leading/trailing
  // hedge word broke that match, so the reply fell PAST it into the clock branch
  // and hit the exact wrong-time bug this branch exists to kill — "like 20
  // minutes" landing at 8 PM, "prob 2 days" at 2 PM, "2 hours i think" at 2 PM,
  // the unit silently dropped and the count read as a wall-clock hour (the worst
  // outcome on the moat: the bro showing up hours off from what you said). So the
  // same fillers are stripped from BOTH ends before matching. This stays strictly
  // upgrade-only: an explicit duration UNIT is still required and the message must
  // STILL be nothing but that duration once the hedge is peeled, so a hedged clock
  // or weekday ("maybe 3", "maybe 3pm", "like saturday") carries no unit / isn't a
  // duration and falls through UNCHANGED to the branches that already read it.
  {
    // Uncertainty fillers this audience wraps a duration in. Peeled off the FRONT
    // and BACK only (a hedge sitting INSIDE — "2 maybe hours" — is left alone, so
    // the middle of a reply is never silently reshaped into a duration it wasn't).
    const HEDGE = 'maybe|perhaps|possibly|prob|probably|like|say|lets say|let\'s say|how about|what about|how bout|i guess|guess|i think|i reckon|idk|dunno|hmm+|uh+|um+|erm?|well';
    const HEDGE_LEAD = new RegExp(`^(?:${HEDGE})\\b\\s*`);
    const HEDGE_TRAIL = new RegExp(`\\s*\\b(?:${HEDGE})$`);
    let bare = t
      .replace(/\bor (?:so|two|more)\b/g, ' ')
      .replace(/\bish\b/g, ' ')
      .replace(/\b(please|pls|thanks|thx|thank you)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    let prev;
    do {
      prev = bare;
      bare = bare.replace(HEDGE_LEAD, '').replace(HEDGE_TRAIL, '').replace(/\s+/g, ' ').trim();
    } while (bare !== prev);
    const unitMins = (n, u) => (
      /^w/.test(u) ? n * 7 * 24 * 60
        : /^d/.test(u) ? n * 24 * 60
        : /^h/.test(u) ? n * 60
        : n
    );
    const U = '(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks)';
    let bareMins = null;
    if (/^half(\s+an?)?\s+hour$/.test(bare)) bareMins = 30;
    else if (/^an?\s+hour$/.test(bare)) bareMins = 60;
    else if (/^an?\s+day$/.test(bare)) bareMins = 24 * 60;
    else if (/^an?\s+week$/.test(bare)) bareMins = 7 * 24 * 60;
    else {
      const dm = bare.match(new RegExp(`^(\\d{1,4})\\s*${U}$`));
      if (dm) bareMins = unitMins(parseInt(dm[1], 10), dm[2]);
      else {
        const wm = bare.match(new RegExp(`^(?:an?\\s+)?(couple|few)\\s+(?:of\\s+)?${U}$`));
        if (wm) bareMins = unitMins(wm[1] === 'few' ? 3 : 2, wm[2]);
      }
    }
    if (bareMins > 0) return inRange(nowMs + Math.round(bareMins) * MIN_MS);
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
  // "noon" is modelled as a part-of-day anchor (see the `partOfDay` ladder below)
  // so it COMPOSES with every day branch — "tomorrow noon", "saturday noon",
  // "the 12th at noon" — exactly like "morning"/"afternoon"/"lunch". It used to
  // sit here as a standalone branch that read only today/tomorrow, which produced
  // two wrong-time outputs on the two-way text moat (the exact worst outcome the
  // design LAW guards): the `&& !/\btomorrow\b/` guard skipped "tomorrow noon"
  // and, with "noon" absent from the ladder, that branch fell to the 09:00
  // default — silently DROPPING noon; and any other day-qualified "noon"
  // ("saturday noon", "the 12th at noon") fired here and returned today/tomorrow
  // noon, IGNORING the day and landing the reschedule days early. Bare "noon"
  // still lands via the bare part-of-day branch below, unchanged.

  // "day after tomorrow" CONTAINS "tomorrow" but means +2 days. Detect it first
  // so the tomorrow branch below can land it two days out instead of one — a
  // reschedule for the day-after must never arrive a full day early on the exact
  // two-way text channel that is the moat (showing up a day early reads as a nag,
  // the opposite of the anti-shame design LAW).
  const wantsDayAfterTomorrow = /\bday after (tomorrow|tmrw|tmr)\b/.test(t);
  const wantsTomorrow = /\b(tomorrow|tmrw|tmr)\b/.test(t);
  // "tonite" / "2nite" / "tnite" — the texting spellings of "tonight". This is
  // the SMS reschedule channel that is the moat while voice is gated, and it
  // receives shorthand: the tomorrow matcher above already reads "tmrw"/"tmr",
  // but tonight read only its full spelling — an asymmetry that dropped the most
  // common casual "later today" answer this audience texts ("lets do it 2nite")
  // to the cold "I couldn't read that time" re-ask, a quiet "he didn't get me"
  // at the exact moment the design LAW matters. Same 20:00 anchor as "tonight";
  // "2nite" carries no clock (the "2" has no word boundary before "nite", so the
  // clock matcher below never reads it as 2 o'clock), so it composes cleanly.
  const wantsTonight = /\b(tonight|tonite|2nite|tnite|this evening)\b/.test(t);
  // "end of day" / "eod" / "cob" — the conventional close of the working day, a
  // concrete 17:00 anchor that sits distinctly between "afternoon" (14:00) and
  // "evening" (19:00). A very common, unambiguous reschedule answer ("I'll get to
  // the taxes end of day") that, left unread, fell to the warm re-ask — a quiet
  // "he didn't get me" on the two-way text channel that is the moat while voice
  // is gated. Modelled as a part-of-day so the ONE anchor composes with every
  // branch (today, tomorrow, a named weekday, a calendar date) exactly the way
  // "morning"/"evening" already do — no branch-by-branch plumbing. Checked first
  // so the explicit phrase wins; it shares no words with the other parts of day,
  // so ordering only ever helps.
  // "first thing" / "first thing tomorrow" / "first thing in the morning" — the
  // start of the working day, a concrete 09:00 anchor. One of the most common,
  // idiomatic ways an ADHD brain defers a task to the next fresh start ("I'll do
  // it first thing"), and left unread it fell to the warm re-ask — the same quiet
  // "he didn't get me" on the two-way text moat that "end of day" did. Modelled
  // as a part-of-day (same 09:00 as "morning", which "first thing in the morning"
  // literally names, so the two never contradict) so the ONE anchor composes with
  // every branch (today, tomorrow, a named weekday, a date) with no branch-by-
  // branch plumbing. Checked before the bare "morning" so the explicit phrase is
  // read as such; they share the same hour, so ordering only ever helps.
  // "lunch" / "lunchtime" / "after lunch" — the midday break, a concrete 13:00
  // anchor that sits distinctly between "noon" (12:00) and "afternoon" (14:00). A
  // very common casual reschedule answer ("I'll get to it after lunch"), and left
  // unread it fell to the warm re-ask — the same quiet "he didn't get me" on the
  // two-way text moat that "end of day" and "first thing" did. Modelled as a
  // part-of-day so the ONE anchor composes with every branch (today, tomorrow, a
  // named weekday, a date) with no branch-by-branch plumbing. It shares no word
  // with the other parts of day ("lunch" is not inside "afternoon"), so ordering
  // only ever helps; `\blunch\b` never fires inside a longer word.
  // "dinner" / "dinnertime" / "after dinner" — the evening meal, a concrete 18:00
  // anchor that fills the one remaining gap between "eod"/"cob" (17:00) and
  // "evening" (19:00). "I'll get to it after dinner" is one of the most common
  // casual ways someone reschedules a task into the evening, and left unread it
  // fell to the warm re-ask — the same quiet "he didn't get me" on the two-way
  // text moat that "end of day", "first thing" and "lunch" closed. Modelled as a
  // part-of-day so the ONE anchor composes with every branch (today, tomorrow, a
  // named weekday, a date) with no branch-by-branch plumbing. It shares no word
  // with the other parts of day, so ordering only ever helps; `\bdinner\b` never
  // fires inside a longer word (e.g. "dinnerware").
  // "mid-morning" (10:30) and "mid-afternoon" (15:30) — the two spans of the
  // working day still unread between the anchors above. "I'll get to it
  // mid-afternoon" sits distinctly between "afternoon" (14:00) and "eod"/"cob"
  // (17:00); "mid-morning" between "morning"/"first thing" (09:00) and "lunch"
  // (13:00). Left unread they fell to the warm re-ask — the same quiet "he
  // didn't get me" on the two-way text moat that "eod", "first thing", "lunch"
  // and "dinner" closed. Modelled as parts-of-day so the ONE anchor composes
  // with every branch (today, tomorrow, a named weekday, a date) — no branch-by-
  // branch plumbing. Each is checked BEFORE its bare parent ("morning" /
  // "afternoon") so the explicit compound wins: after normalization "mid-morning"
  // reads as "mid morning", whose "morning" token would otherwise be caught by
  // the bare check; `[\s-]?` reads both the hyphenated and run-together spellings,
  // and `\bmid[\s-]?morning\b` never fires inside an unrelated word (e.g. "midterm").
  const partOfDay = /\b(eod|cob|end of (?:the )?day|close of business)\b/.test(t) ? [17, 0]
    : /\bfirst thing\b/.test(t) ? [9, 0]
    : /\bmid[\s-]?morning\b/.test(t) ? [10, 30]
    : /\bmorning\b/.test(t) ? [9, 0]
    : /\bnoon\b/.test(t) ? [12, 0]
    : /\blunch(?:\s?time)?\b/.test(t) ? [13, 0]
    : /\bmid[\s-]?afternoon\b/.test(t) ? [15, 30]
    : /\bafternoon\b/.test(t) ? [14, 0]
    : /\bdinner(?:\s?time)?\b/.test(t) ? [18, 0]
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
  // "tomorrow 3" behave alike. "weekend" reads as Saturday; "wknd" is its
  // SMS-native spelling — the two-way text channel that is the moat while voice
  // is gated receives the texted shorthand ("lets do it this wknd", "nxt wknd"),
  // and left unread it fell to the cold "I couldn't read that time" re-ask — a
  // quiet "he didn't get me" at the exact moment the anti-shame design LAW
  // matters. `wknd` shares the Saturday anchor "weekend" already uses.
  const wdMatch = t.match(
    /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|weekend|wknd|sun|mon|tues|tue|weds|wed|thurs|thur|thu|fri|sat)\b/
  );
  if (wdMatch) {
    const WD = {
      sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tues: 2, tue: 2,
      wednesday: 3, weds: 3, wed: 3, thursday: 4, thurs: 4, thur: 4, thu: 4,
      friday: 5, fri: 5, saturday: 6, sat: 6, weekend: 6, wknd: 6,
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
    // "next friday"/"next wknd" forces the following week; `nxt` is the texted
    // spelling of "next" the SMS-native audience uses ("nxt fri", "nxt wknd"),
    // read alongside it so the shorthand lands the following-week occurrence
    // instead of falling to the cold re-ask.
    const offsets = /\b(next|nxt)\b/.test(t) ? [base + 7] : [base, base + 7];
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
/**
 * Pick a stable, non-negative index in [0, n) from an optional `seed`.
 * A number seed is used directly (mod n); a string seed is hashed. An absent /
 * empty seed always returns 0 — so an unseeded caller gets the canonical variant
 * unchanged, and every existing snapshot holds. Deterministic and pure: the same
 * seed always maps to the same index, so a redelivered/retried check-in reads
 * IDENTICALLY (never a different message on a retry), while different occurrences
 * of a recurring commitment rotate.
 * @param {number|string|null|undefined} seed
 * @param {number} n  number of variants (>0)
 * @returns {number}
 */
function seedIndex(seed, n) {
  if (!(n > 0)) return 0;
  if (seed === undefined || seed === null || seed === '') return 0;
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    return ((Math.trunc(seed) % n) + n) % n;
  }
  const s = String(seed);
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return ((h % n) + n) % n;
}

/**
 * The outbound check-in nudge — the bro showing up at the moment the person said.
 *
 * This is the OTHER half of the two-way text moat (the inbound reply parser is
 * the first). A recurring commitment fires this on every occurrence, so a single
 * fixed line means an ADHD brain reads the EXACT same text every day — and a
 * message that never changes becomes wallpaper the brain filters out, which is
 * precisely how a nudge decays into a swipe-away and the moat quietly erodes. So
 * the copy rotates across a small set of warm, tone-identical variants, selected
 * deterministically from `seed` (the caller passes the per-occurrence check-in
 * id, stable across retries — see `deliverCheckin`). Every variant obeys THE
 * DESIGN LAW: an ally glad you showed up, never a boss, never a tally. `seed`
 * omitted → variant 0 (the canonical line, unchanged) so previews and unseeded
 * callers are untouched.
 * @param {{ title?: string, persona?: string, seed?: number|string }} [opts]
 * @returns {string}
 */
export function checkinPromptCopy({ title, persona, seed } = {}) {
  const what = (title || 'the thing').toString();
  const doWhat = `${startsWithVerbish(what) ? '' : 'do '}${what}`;
  if (pickPersona(persona) === 'hype') {
    // Every hype variant carries an unmistakable hype marker (Yo / 🔥) — the
    // coach-checkin-delivery contract asserts it.
    const v = [
      `Yo — you called it: ${what}. Let’s get it. I’m right here with you. 🔥`,
      `Yo, it’s go time — ${doWhat}! I’m right here with you. Let’s move. 🔥`,
      `Let’s GO — time to ${doWhat}. 🔥 I’m in your corner; one step and we’re rolling.`,
      `Yo — ready to ${doWhat}? 🔥 I’m right beside you. One tiny start and we’re off. 💪`,
    ];
    return v[seedIndex(seed, v.length)];
  }
  const v = [
    `You said you’d ${doWhat}. I’m here — ready to go? We’ve got this.`,
    `You’re up: time to ${doWhat}. No pressure — I’m right here with you.`,
    `Ready to ${doWhat}? I’ve got your back. One small start and we’re moving.`,
    `Let’s ${doWhat} together. I’m right here whenever you’re set to begin.`,
  ];
  return v[seedIndex(seed, v.length)];
}

/**
 * The one-line reply hint appended to a TEXT check-in (only). Text has no action
 * buttons, so the nudge itself makes the two-way loop discoverable: DONE keeps
 * the word; LATER opens the "when do you want to try again?" conversation; and
 * HELP ME START turns a stuck moment into one tiny first move. Never a scold —
 * every route is offered warmly.
 */
export function checkinReplyHint(persona) {
  return pickPersona(persona) === 'hype'
    ? 'Reply DONE, LATER to pick when to try again, or HELP ME START for one tiny first move. 💪'
    : 'Reply DONE, LATER to pick when to try again, or HELP ME START for one tiny first move.';
}

/**
 * The ONE follow-up when a delivered check-in has gone quiet (Wingspan W1,
 * the escalation ladder: push → SMS, exactly once, consent-gated). ADHD brains
 * swipe a push away by reflex; a text lands differently. The LAW carries
 * through hardest here — an escalation is an ally knocking once more, never a
 * scold, never a tally, and it always offers the warm exit ("pick a better
 * time") as readily as the start.
 *
 * Like `checkinPromptCopy`, this rotates across warm, tone-identical variants
 * seeded deterministically from `seed` (the caller passes the per-occurrence
 * check-in id — see `runEscalations`). A recurring commitment that goes quiet
 * each day would otherwise get the IDENTICAL escalation text every time — the
 * same wallpaper decay one rung down the ladder — so a daily miss reads as the
 * bro finding a fresh way to say "still here", not a form letter. Every variant
 * offers a way in (a tiny step), the warm exit ("pick a better time") recurs
 * through the rotation so a person who needs to defer always sees it, and none
 * tallies. `seed` omitted → variant 0 (the canonical line, unchanged) so
 * previews and unseeded callers are untouched.
 * @param {{ title?: string, persona?: string, seed?: number|string }} [opts]
 * @returns {string}
 */
export function escalationCopy({ title, persona, seed } = {}) {
  const what = (title || 'the thing').toString();
  if (pickPersona(persona) === 'hype') {
    // Every hype variant carries a hype marker (🔥 / Yo) and offers both a tiny
    // step now and the warm exit — an ally knocking once more, never a scold.
    const v = [
      `Still right here — ${what} is ready when you are. One tiny step together? 🔥`,
      `Yo — still in your corner on ${what}. One small step now, or grab a better time — either way I’ve got you. 🔥`,
      `No stress — I’m still here for ${what}. 🔥 Want to knock out one little piece together, or pick a time that fits better?`,
      `Still here, still with you — ${what} whenever you’re ready. 🔥 One tiny start together, or line up a better time?`,
    ];
    return v[seedIndex(seed, v.length)];
  }
  const v = [
    `No rush — I’m still here about ${what}. Want to start small together, or pick a better time?`,
    `Still here about ${what} — no pressure at all. We can take one tiny step together, or find a time that works better.`,
    `I’m right here whenever you’re ready for ${what}. Want to ease in with one small start, or pick a better time?`,
    `No rush at all — ${what} is still here for you. One little step together, or shall we line up a better time?`,
  ];
  return v[seedIndex(seed, v.length)];
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
 *
 * Like `checkinPromptCopy` and `escalationCopy`, this rotates across warm,
 * tone-identical variants seeded deterministically from `seed` (the caller passes
 * a per-dormancy-EPISODE identifier — see `runReturnNudges`, which seeds on the
 * user id + the activity timestamp that anchors this episode). A person who goes
 * quiet, returns, and goes quiet again would otherwise get the IDENTICAL welcome
 * back each time — the same wallpaper decay the nudge and the knock already shed
 * one and two rungs down the ladder, and at the single most delicate moment on
 * the channel: a re-entry after silence. So a repeat-returner meets the bro
 * finding a fresh way to hold the door open, never a form letter. Every variant
 * still holds zero agenda, names no absence, and ends with the same open-door way
 * in ("give a word for today?"); every hype variant carries the 💪 hype marker
 * and no ally variant does (the calm-vs-hype discriminator). `seed` omitted →
 * variant 0 (the canonical line, unchanged) so previews and unseeded callers are
 * byte-for-byte untouched.
 * @param {{ persona?: string, seed?: number|string }} [opts]
 * @returns {string}
 */
export function returnNudgeCopy({ persona, seed } = {}) {
  if (pickPersona(persona) === 'hype') {
    // Every hype variant carries the 💪 hype marker and holds the door open with
    // zero agenda — an ally glad you exist, never a word about the silence.
    const v = [
      'Yo — no agenda, just in your corner. 💪 Whenever you want to line something up, I’m right here. Want to give a word for today?',
      'Yo — no agenda, just hyped you’re here. 💪 Whenever you want to line something up, I’m right beside you. Want to give a word for today?',
      'Yo — good to see you. 💪 No pressure, no catch — whenever you’re ready to line something up, I’m right here for it. Want to give a word for today?',
      'Yo — I’m in your corner, no agenda at all. 💪 Whenever you feel like starting something fresh, I’ve got you. Want to give a word for today?',
    ];
    return v[seedIndex(seed, v.length)];
  }
  const v = [
    'Hey — no pressure at all, just checking in. I’m still here whenever you want to pick something back up. Want to give a word for today?',
    'Hey — no agenda here, just glad you’re around. Whenever you feel like lining something up, I’m right here. Want to give a word for today?',
    'Hey there — the door’s wide open, no pressure at all. Whenever you’re ready to pick something up, I’ve got you. Want to give a word for today?',
    'Hey — good to see you. No rush and nothing owed; I’m still right here whenever you want to start fresh. Want to give a word for today?',
  ];
  return v[seedIndex(seed, v.length)];
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

/**
 * Confirming a reschedule: the word still counts; the chain is intact. This is
 * the IN-APP twin of `smsRescheduledCopy` — a person who taps "Move it" and gives
 * a new time gets the same warmth a texted reschedule does.
 *
 * `progress` (true when the "when?" reply actually REPORTED movement — "made good
 * progress, tomorrow 9am", "chipping away, move it to tomorrow" — per
 * `isProgressReply`) meets that momentum by name: "love that you got moving." Same
 * warmth, still names the new time, still keeps the streak safe, never a count or
 * a scold. A bare time ("tomorrow 9am") leaves `progress` false and keeps the
 * generic copy. Mirrors `smsRescheduledCopy` and `snoozeConfirmCopy` so every
 * reschedule surface — text and app — sees reported work the same way.
 */
export function rescheduleConfirmCopy({ persona, when, progress = false } = {}) {
  const at = when ? ` for ${formatWhen(when)}` : '';
  if (pickPersona(persona) === 'hype') {
    return progress
      ? `Love that you got moving — that’s momentum! Locked in${at}. Nothing broken, we just go again. 💪`
      : `Locked in${at}. I got you — nothing broken, we just go again. 💪`;
  }
  return progress
    ? `Love that you got moving — I’ll check back${at}. Your word’s still good with me; we just pick it back up.`
    : `Got it — I’ll check back${at}. Your word’s still good with me; we just pick it back up.`;
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
 * Warm reply when a check-in resolve arrives for a word that is no longer active
 * — already kept, set down (released), paused, or otherwise settled (e.g. a stale
 * tab, or a second device acting after the word was closed elsewhere). Under the
 * design LAW this is never a scold and never a miss: the word simply isn't waiting
 * on the person right now, and the door back in stays open. Streak is never touched.
 */
export function alreadySettledCopy({ persona } = {}) {
  if (pickPersona(persona) === 'hype') {
    return 'That one’s already handled — nothing waiting on you here. Streak’s safe. Give a fresh word whenever you’re ready. 💪';
  }
  return 'That word isn’t waiting on you right now — it’s already settled, no problem at all. Your streak stays right where it is. Give a new word whenever you’re ready.';
}

/**
 * Warm reply when a resolve arrives for a word that IS still active but whose
 * current occurrence is already logged — a double-tap, a stale card, a second
 * device — or when the only thing open is a future day's not-yet-due check-in.
 * Unlike {@link alreadySettledCopy} it never says "give a new word": the word is
 * a live rhythm still rolling on its own, so the copy simply confirms this one is
 * already counted and gets out of the way. No second streak credit, no shame, no
 * count — the design LAW holds.
 */
export function alreadyLoggedCopy({ persona } = {}) {
  if (pickPersona(persona) === 'hype') {
    return 'Already logged this one — you’re covered. 🙌 Nothing else waiting right now; I’ll catch you at the next one.';
  }
  return 'Got this one already — you’re all set, no need to log it twice. Nothing else is waiting on you right now; I’ll be here at the next check-in.';
}

/**
 * Confirming a snooze ("I'm on it"): the person is mid-thing and wants the bro
 * to check back shortly — not a resolution, not a reschedule, not a miss. The
 * copy is glad they're on it and promises to come back, never "don't forget,"
 * never pressure. Names the interval so the return is concrete.
 *
 * `progress` (true when the reply actually REPORTED movement — "halfway", "made
 * good progress", "still working" — per `isProgressReply`) meets that momentum
 * by name: "love that you're moving." Same warmth, same interval, still never a
 * count or a scold — it just sees the work they told us they did. A bare "on it"
 * / "hang on" leaves `progress` false and keeps the generic glad-you're-on-it copy.
 */
export function snoozeConfirmCopy({ persona, minutes, progress = false } = {}) {
  const m = clampSnoozeMinutes(minutes);
  if (pickPersona(persona) === 'hype') {
    return progress
      ? `Love that you’re moving — that’s momentum! I’ll swing back in ${m} minutes. Right here cheering you on. 🔥`
      : `Love it — you’re on it! I’ll swing back in ${m} minutes. Right here cheering you on. 🔥`;
  }
  return progress
    ? `Love that you’re moving on it — I’ll check back in ${m} minutes. No rush at all; I’m right here.`
    : `You got it — I’ll check back in ${m} minutes. No rush at all; I’m right here.`;
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

/** Lifetime kept-word totals worth a distinct "you've kept this many, ever" mark. */
export const KEPT_TOTAL_LANDMARKS = [10, 25, 50, 100, 250, 500, 1000];

/**
 * A LIFETIME-landmark badge for the kept-word total — the one number in the whole
 * product that can only ever go up. Where {@link milestoneCopy} marks a current
 * RUN (which a single miss resets to zero) and {@link personalBestCopy} marks
 * being AT your all-time peak (which a decline takes away), this marks the
 * cumulative count of every word you have EVER kept crossing a landmark
 * ({@link KEPT_TOTAL_LANDMARKS}).
 *
 * Anti-shame not just by wording but by ARITHMETIC: it reads `total_kept`, which
 * {@link computeStreakAfter} increments on a kept word and NEVER decrements — a
 * miss silently resets the run but never touches the lifetime total. So this line
 * can only ever appear on the way UP; no reset, quiet stretch, or missed word can
 * ever take a reached landmark away. It is the celebration that survives every
 * reset — for the person whose run keeps returning to zero, it is the count that
 * only grows.
 *
 * Fires ONLY when the lifetime total is EXACTLY a landmark, '' otherwise — so a
 * between-landmarks total carries nothing: never a "N to go" nag, never a
 * distance-to-next, never a reference to a gap or a past. Independent of both
 * streak celebrations and free to co-occur with either: you can cross your 100th
 * kept word (a lifetime landmark) while your current run is 4 and your best is 30
 * — three true, unshaming wins that each say something different.
 *
 * @param {object} p { streak: { total_kept } }
 * @returns {string} the landmark line, or '' when not exactly at a landmark
 */
export function keptTotalLandmarkCopy({ streak } = {}) {
  const total = Number(streak?.total_kept) || 0;
  if (!KEPT_TOTAL_LANDMARKS.includes(total)) return '';
  return `🏅 ${total} words kept, all-time — every word you’ve ever shown up for. This number only ever grows. Proud of you.`;
}

/**
 * The STANDING all-time record for the kept-word streak — your strongest run,
 * shown as a permanent record that a reset can never revoke. This fills the one
 * gap the other three streak lines leave open: at `current_streak === 0` (a fresh
 * start, or the moment right after a miss zeroes the run) {@link streakSummaryCopy}
 * says only "fresh start", and {@link personalBestCopy} / {@link milestoneCopy}
 * both go silent — so the person's genuine best run (a real thing they achieved)
 * becomes completely invisible at the single most shame-prone moment in the
 * product ("I lost my streak"). This surfaces it there, as reassurance.
 *
 * Anti-shame not just by wording but by ARITHMETIC and by GATING:
 * - `longest_streak` is monotonic — {@link computeStreakAfter} only ever raises it
 *   (a miss resets the run but never lowers the best), so this line, like the
 *   lifetime landmark, can only ever describe a number on the way up; no reset can
 *   take a reached record away.
 * - It fires ONLY at `current_streak === 0`. That is deliberate: it never sits
 *   beside a live run (where {@link streakSummaryCopy} already narrates the best
 *   inline, and where a "your record is N but you're at M" juxtaposition would be
 *   exactly the decline-comparison the LAW forbids). At zero there is no current
 *   run to compare against, so the record stands alone — a standing achievement,
 *   never a gap. It names the record and frames it as permanent ("yours to keep",
 *   "a fresh start never takes it back"); it never references the reset, a decline,
 *   a "you were better", or a distance to anything.
 *
 * Requires `longest_streak >= 2` (a run of one isn't a record worth naming),
 * matching {@link personalBestCopy}'s "worth marking" bar. Returns '' otherwise.
 *
 * @param {object} p { streak: { current_streak, longest_streak } }
 * @returns {string} the standing-record line, or '' when there's no record to hold
 */
export function personalRecordCopy({ streak } = {}) {
  const cur = Number(streak?.current_streak) || 0;
  const best = Number(streak?.longest_streak) || 0;
  if (cur !== 0 || best < 2) return '';
  return `🛡️ Your best run stands: ${best} words kept in a row — the strongest you’ve ever put together, and it’s yours to keep. A fresh start never takes it back.`;
}

// ── POWER HOURS ──────────────────────────────────────────────
// The person's own read of WHEN in the day their kept words tend to land — the
// insight the per-day momentum sparkline can't give. The histogram math + the
// signal gate live in ./momentum.js (bucketKeptByHour, peakKeptHour); the warm
// first-person words live here with the API that emits them.
//
// DESIGN LAW, by construction: it reads a status='kept' histogram ONLY, so it can
// only ever point at an hour you SHOWED UP — never a quiet hour, never a "you get
// nothing done after lunch". It names a single high point as a strength to lean
// into, and fires ONLY when peakKeptHour clears its signal gate — a thin or flat
// history returns null → '' here, never a guess.

/** Heading over the person's power-hours read. */
export function powerHoursHeadingCopy() {
  return 'Your power hours';
}

/** Intro under the power-hours heading — first person, strengths-only by design. */
export function powerHoursIntroCopy() {
  return 'The time of day your kept words tend to land. Only ever your strong hours — a quiet hour is just quiet, never counted against you.';
}

/**
 * Warm one-line "power hours" read: names the hour of day the person is strongest,
 * from a peak-hour object (see {@link peakKeptHour}). Anti-shame by CONSTRUCTION —
 * it points only at a time they kept their word and frames it as a window to lean
 * into, never a deficit, a comparison, or the hours they missed. Returns '' when
 * there is no trustworthy power hour to name (the gate returned null).
 * @param {object} p
 * @param {{ hour:number, count:number } | null} p.peak  from {@link peakKeptHour}
 * @returns {string}
 */
export function powerHoursCopy({ peak } = {}) {
  if (!peak || typeof peak.hour !== 'number') return '';
  const when = describeHourBand(peak.hour);
  if (!when) return '';
  return `You’re strongest around ${when} — that’s where most of your kept words land. Lean into it. 💪`;
}

// ── ALL-TIME BEST DAY ────────────────────────────────────────
// The person's own high-water mark: the single day they kept the most words
// EVER. The per-day momentum sparkline shows the last two weeks; the power-hours
// read shows the time of day; the per-word detail view has its own best day — but
// nothing said "the most you ever kept across ALL your words in ONE day". This
// does. The bucketing + record math live in ./momentum.js (allTimeBestDay); the
// warm first-person words live here with the API that emits them.
//
// DESIGN LAW, by construction: it reads a status='kept' histogram ONLY, so it can
// only ever crown a day the person SHOWED UP. It is a standing record that only
// ever climbs (a past kept day never disappears) — never a bar you must clear,
// never a comparison to today, never a "you were better before". Fires ONLY when
// allTimeBestDay clears its floor → a thin history returns null → '' here.

/** Heading over the person's all-time best-day record. */
export function bestDayHeadingCopy() {
  return 'Your best day';
}

/** Intro under the best-day heading — first person, record-only by design. */
export function bestDayIntroCopy() {
  return 'The most kept words you’ve ever put together in a single day — a high-water mark that’s yours to keep. A quiet day never takes it back.';
}

/**
 * Warm one-line all-time best-day read: names the record count and the day it
 * happened, from an {@link allTimeBestDay} result. Anti-shame by CONSTRUCTION —
 * it celebrates a peak the person actually hit and frames it as a standing record
 * that only ever climbs, never a target to clear, a comparison to today, or a
 * decline. Follows {@link detailPeakDayCopy}'s colon phrasing so a relative day
 * name ("today"/"yesterday") reads naturally. Returns '' when there is no record
 * to crown (the engine returned null) or the day can't be named.
 * @param {object} p
 * @param {{ date:string, count:number } | null} p.best  from {@link allTimeBestDay}
 * @param {string} [p.nowISO]     "today" anchor for the warm day name
 * @param {string} [p.timezone]   IANA zone the record was bucketed in
 * @returns {string}
 */
export function bestDayCopy({ best, nowISO, timezone } = {}) {
  const count = Number(best && best.count) || 0;
  if (!best || count < 2) return '';
  const when = describePeakDay(best.date, { nowISO, timezone });
  if (!when) return '';
  const words = count === 1 ? 'word' : 'words';
  return `🌟 Your best day so far: ${when} — ${count} kept ${words} in one day. The most you’ve ever put together at once, and it only ever climbs from here.`;
}

// ── KEPT SINCE (how long you've been keeping ONE word) ───────
// The per-word momentum sparkline shows the recent shape and the best-day callout
// names the peak; neither says how LONG this word has been a practice. This does —
// it names the day you first kept THIS word, so a long-standing rhythm reads as
// the practice it is ("keeping this since Jul 8"), not just a raw count. The
// date math lives in ./momentum.js (formatCalendarDay, calendarDaysAgo); the warm
// first-person words live here with the API that emits them.
//
// DESIGN LAW, by construction: it reads the FIRST status='kept' instant ONLY (the
// route's MIN is over kept rows — no miss is ever read or surfaced), so it can
// only ever anchor to a day the person SHOWED UP. It is a standing fact that only
// ages forward — a quiet stretch or a reset never moves the "since" date or
// erases the practice. It fires ONLY once the word is a real practice (a floor on
// the count AND a week or more of history), so a just-started or thin word returns
// '' and nothing shows — never a "since today", never a "0 days".

/** Minimum kept count before a word is a "practice" worth a since-anchor. */
export const KEPT_SINCE_MIN_COUNT = 3;
/** Minimum span (days) before "since" reads as a standing practice, not "today". */
export const KEPT_SINCE_MIN_DAYS = 7;

/**
 * Warm one-line "you've been keeping this since …" anchor for a single word's
 * detail panel. Anti-shame by CONSTRUCTION — it reads only the first KEPT instant
 * on this word and frames the span as a practice being built, never a lapse, a
 * gap since, a comparison, or a miss. Fires ONLY at {@link KEPT_SINCE_MIN_COUNT}+
 * kept AND {@link KEPT_SINCE_MIN_DAYS}+ of history (so a young or thin word shows
 * nothing); returns '' when there's no anchor to name.
 *
 * @param {object} p
 * @param {string} p.firstKeptISO  the earliest status='kept' responded_at for this word
 * @param {number} p.count         the word's honest lifetime kept count
 * @param {string} [p.nowISO]      "today" anchor (defaults to now)
 * @param {string} [p.timezone]    IANA zone the day is resolved in
 * @param {'ally'|'hype'} [p.persona]
 * @returns {string} the since-anchor line, or '' when there's no practice to name
 */
export function keptSinceCopy({ firstKeptISO, count, nowISO, timezone, persona } = {}) {
  const n = Number(count) || 0;
  if (n < KEPT_SINCE_MIN_COUNT) return '';
  const daysAgo = calendarDaysAgo(firstKeptISO, { nowISO, timezone });
  if (daysAgo == null || daysAgo < KEPT_SINCE_MIN_DAYS) return '';
  const day = formatCalendarDay(firstKeptISO, { nowISO, timezone });
  if (!day) return '';
  if (pickPersona(persona) === 'hype') {
    return `🌱 Keeping this one since ${day} — ${n} and going strong. That’s a real practice you built. 💪`;
  }
  return `🌱 You’ve been keeping this one since ${day} — the practice you’ve been building, one kept word at a time.`;
}

// ── KEEPING YOUR WORD SINCE (the account-level longevity anchor) ──
// The per-word "kept since" (above) names how long ONE word has been a practice.
// This is the same longevity read one level up: the day the person kept their
// VERY FIRST word here, across ALL their commitments — a standing anchor for the
// whole account, the start of the practice they've been building. Where the
// lifetime landmark (keptTotalLandmarkCopy) counts HOW MANY and the best day
// (bestDayCopy) crowns the tallest single day, this names the WHEN it all began.
//
// DESIGN LAW, by construction: the route's read is a MIN(responded_at) over
// status='kept' rows ONLY — no miss is ever read or surfaced — so it can only ever
// anchor to a day the person SHOWED UP. It is a standing fact that only ages
// forward: a quiet stretch or a reset never moves the "since" date or erases the
// practice. It fires ONLY once there's a real practice to name (a floor on the
// lifetime kept count AND a week or more of history), so a brand-new or thin
// account returns '' and nothing shows — never a "since today", never a "0 days".

/** Minimum lifetime kept words before the account-level since-anchor speaks. */
export const ACCOUNT_SINCE_MIN_COUNT = 5;
/** Minimum span (days) since the first kept word before "since" reads as standing. */
export const ACCOUNT_SINCE_MIN_DAYS = 7;

/** Heading over the account-level "keeping your word since" anchor. */
export function keepingSinceHeadingCopy() {
  return 'Keeping your word';
}

/** Intro under the keeping-your-word heading — first person, longevity-only by design. */
export function keepingSinceIntroCopy() {
  return 'The day you first kept your word here — the start of the practice you’ve been building, one word at a time. It only ever grows from here.';
}

/**
 * Warm one-line account-level "you've been keeping your word since …" anchor for
 * /me/. The person-level twin of {@link keptSinceCopy} (which is per-word): it names
 * the day of the FIRST kept word across ALL commitments. Anti-shame by CONSTRUCTION
 * — it reads only the first KEPT instant (the route's MIN is over kept rows — no
 * miss is ever read) and frames the span as a practice being built, never a lapse,
 * a gap-since, a comparison, or a miss. Fires ONLY at {@link ACCOUNT_SINCE_MIN_COUNT}+
 * lifetime kept AND {@link ACCOUNT_SINCE_MIN_DAYS}+ of history (so a young or thin
 * account shows nothing); returns '' when there's no anchor to name.
 *
 * @param {object} p
 * @param {string} p.firstKeptISO  the earliest status='kept' responded_at, account-wide
 * @param {number} p.count         the person's lifetime kept count (streak.total_kept)
 * @param {string} [p.nowISO]      "today" anchor (defaults to now)
 * @param {string} [p.timezone]    IANA zone the day is resolved in
 * @param {'ally'|'hype'} [p.persona]
 * @returns {string} the account since-anchor line, or '' when there's no practice to name
 */
export function keepingSinceCopy({ firstKeptISO, count, nowISO, timezone, persona } = {}) {
  const n = Number(count) || 0;
  if (n < ACCOUNT_SINCE_MIN_COUNT) return '';
  const daysAgo = calendarDaysAgo(firstKeptISO, { nowISO, timezone });
  if (daysAgo == null || daysAgo < ACCOUNT_SINCE_MIN_DAYS) return '';
  const day = formatCalendarDay(firstKeptISO, { nowISO, timezone });
  if (!day) return '';
  if (pickPersona(persona) === 'hype') {
    return `🌱 You’ve been keeping your word since ${day} — that’s a real practice you built, and it only grows from here. 💪`;
  }
  return `🌱 You’ve been keeping your word since ${day} — the practice you’ve been building here, one word at a time.`;
}

// ── DAYS YOU SHOWED UP (lifetime distinct active days) ───────
// The BREADTH companion to the lifetime kept COUNT: keptTotalLandmarkCopy counts
// HOW MANY words, bestDayCopy crowns the tallest single day, keepingSinceCopy
// names WHEN it began — this names HOW MANY DAYS the person showed up at all. Two
// accounts with the same kept total read very differently if one kept them across
// six days and the other across thirty-five; this surfaces that spread as a warm,
// standing number. Anti-shame by CONSTRUCTION: it counts only distinct days that
// carry a status='kept' word (the route reads kept rows ONLY — no miss is ever
// read), so it can only ever count days the person SHOWED UP; a quiet day is
// simply not in the set, never counted and never subtracted, so the number can
// only climb. No comparison, no target, no "days since".

/** Minimum distinct active days before "days you showed up" reads as a practice. */
export const SHOWED_UP_DAYS_MIN = 3;

/** Heading over the account-level "days you showed up" breadth read. */
export function showedUpDaysHeadingCopy() {
  return 'Days you showed up';
}

/** Intro under the days-you-showed-up heading — first person, breadth-only by design. */
export function showedUpDaysIntroCopy() {
  return 'The number of separate days you’ve kept your word here — every one a day you came through for yourself. It only ever grows.';
}

/**
 * Warm one-line "you’ve shown up on N different days" breadth read for /me/. The
 * BREADTH twin of the lifetime landmark (which counts words): it names the count
 * of distinct local days the person kept at least one word. Anti-shame by
 * CONSTRUCTION — the count is derived from status='kept' instants ONLY (no miss is
 * ever read), so every counted day is a day they showed up; the copy frames it as
 * days-came-through, never a target, a comparison, a gap, or a miss. Fires ONLY at
 * {@link SHOWED_UP_DAYS_MIN}+ distinct days (so a barely-started account shows
 * nothing); returns '' when there’s no real spread to name.
 *
 * @param {object} p
 * @param {number} p.days             the count of distinct active days
 * @param {'ally'|'hype'} [p.persona]
 * @returns {string} the breadth line, or '' when below the floor
 */
export function showedUpDaysCopy({ days, persona } = {}) {
  const n = Number(days) || 0;
  if (n < SHOWED_UP_DAYS_MIN) return '';
  // n is always ≥ SHOWED_UP_DAYS_MIN (≥ 3) here, so the plural is unconditional,
  // but keep the singular guard so the helper stays honest if the floor ever drops.
  const dayWord = n === 1 ? 'day' : 'days';
  if (pickPersona(persona) === 'hype') {
    return `📆 You’ve shown up on ${n} different ${dayWord} — that’s ${n} times you came through for yourself. Keep stacking them. 💪`;
  }
  return `📆 You’ve shown up on ${n} different ${dayWord} — that’s ${n} separate days you came through for yourself.`;
}

// ── POWER DAY (the weekday your kept words most often land) ──
// The weekday sibling of power hours: powerHoursCopy names the HOUR of day the
// person is strongest; this names the DAY OF THE WEEK they come through most,
// across their kept history. The histogram math + the signal gate live in
// ./momentum.js (bucketKeptByWeekday, peakKeptWeekday); the warm first-person
// words live here with the API that emits them.
//
// DESIGN LAW, by construction: it reads a status='kept' histogram ONLY, so it can
// only ever point at a weekday you SHOWED UP — never a "weak day", never a "you
// never keep words on Mondays". It names a single high point as a strength to lean
// into, and fires ONLY when peakKeptWeekday clears its signal gate — a thin, flat,
// or tied history returns null → '' here, never a guess.

/** Heading over the person's power-day read. */
export function powerDayHeadingCopy() {
  return 'Your power day';
}

/** Intro under the power-day heading — first person, strengths-only by design. */
export function powerDayIntroCopy() {
  return 'The day of the week your kept words most often land. Only ever your strongest day — a quiet day is just quiet, never counted against you.';
}

/**
 * Warm one-line "power day" read: names the weekday the person comes through most,
 * from a peak-weekday object (see {@link peakKeptWeekday}). Anti-shame by
 * CONSTRUCTION — it points only at a weekday they kept their word and frames it as
 * a day to lean into, never a deficit, a comparison, or the days they missed.
 * Returns '' when there is no trustworthy power day to name (the gate returned null)
 * or the weekday can't be named.
 * @param {object} p
 * @param {{ weekday:number, count:number } | null} p.peak  from {@link peakKeptWeekday}
 * @param {'ally'|'hype'} [p.persona]
 * @returns {string}
 */
export function powerDayCopy({ peak, persona } = {}) {
  if (!peak || typeof peak.weekday !== 'number') return '';
  const day = describeWeekday(peak.weekday);
  if (!day) return '';
  if (pickPersona(persona) === 'hype') {
    return `📅 ${day}s are your day — that’s where most of your kept words land. Keep stacking them. 💪`;
  }
  return `📅 You’re strongest on ${day}s — that’s the day of the week most of your kept words land. Lean into it. 💪`;
}

// ── TYPICAL DAY (how much you tend to keep on a day you show up) ──
// The INTENSITY read beside the count/peak/breadth reads: keptTotalLandmarkCopy
// counts HOW MANY, bestDayCopy crowns the tallest single day, showedUpDaysCopy
// names HOW MANY DAYS, powerDayCopy names the strongest weekday — this names the
// average kept words on a day the person shows up: their rhythm. The math lives in
// ./momentum.js (typicalKeptPerActiveDay); the warm first-person words live here.
//
// DESIGN LAW, by construction: the average is built from a status='kept' history
// ONLY — both the kept total it divides and the distinct active days it divides by
// are kept-only, so a quiet day is in neither and can never be averaged in. It can
// only ever describe the days the person SHOWED UP. No target, no comparison, no
// "days you kept nothing". It fires only once the history clears the signal gate;
// and even then, below ~2 words a day it stays silent (that story is already told
// by "days you showed up"), so it never reads as a hollow "about 1 a day".

/** Minimum rounded words-per-active-day before the typical-day line speaks. Below
 *  this the read adds nothing beyond "you showed up" (already its own card), so it
 *  stays silent rather than name a hollow figure. */
export const TYPICAL_DAY_MIN_PER_DAY = 2;

/** Heading over the person's typical-day intensity read. */
export function typicalDayHeadingCopy() {
  return 'Your typical day';
}

/** Intro under the typical-day heading — first person, kept-days-only by design. */
export function typicalDayIntroCopy() {
  return 'About how many words you keep on a day you show up — your rhythm, drawn only from the days you came through. A quiet day is just quiet, never averaged in.';
}

/**
 * Warm one-line "typical day" read: names about how many words the person keeps on
 * a day they show up, from a {@link typicalKeptPerActiveDay} result. Anti-shame by
 * CONSTRUCTION — the average is drawn from status='kept' days ONLY, so it frames a
 * rhythm the person keeps, never a deficit, a comparison, or the days they missed.
 * Rounds to a warm "about N" and stays SILENT below {@link TYPICAL_DAY_MIN_PER_DAY}
 * (a ~1-a-day average adds nothing past "days you showed up") or when there is no
 * trustworthy average to name (the gate returned null).
 * @param {object} p
 * @param {{ perDay:number, total:number, days:number } | null} p.typical  from {@link typicalKeptPerActiveDay}
 * @param {'ally'|'hype'} [p.persona]
 * @returns {string}
 */
export function typicalDayCopy({ typical, persona } = {}) {
  if (!typical || typeof typical.perDay !== 'number' || !Number.isFinite(typical.perDay)) return '';
  const n = Math.round(typical.perDay);
  if (!(n >= TYPICAL_DAY_MIN_PER_DAY)) return '';
  const wordWord = n === 1 ? 'word' : 'words';
  if (pickPersona(persona) === 'hype') {
    return `🌤️ On a day you show up, you keep about ${n} ${wordWord} — that’s your rhythm. Keep it rolling. 💪`;
  }
  return `🌤️ On a day you show up, you keep about ${n} ${wordWord} — that’s your rhythm, drawn only from the days you came through.`;
}

// ── BEST WEEK (the biggest week you ever put together) ────────
// The week-scale peer of bestDayCopy: where the best DAY crowns the tallest single
// day, this crowns the tallest local WEEK — the seven-day stretch you strung the
// most kept words together in. The math lives in ./momentum.js (allTimeBestWeek,
// describeBestWeek); the warm first-person words live here with the API that emits
// them.
//
// DESIGN LAW, by construction: the week is built from a status='kept' history ONLY
// (allTimeBestWeek buckets kept instants), so it can only ever crown a week the
// person SHOWED UP. It is a standing record that only ever climbs — a quiet week
// never takes it back, and there is no "worst week" or week-over-week comparison
// anywhere. It fires only past the signal floor; and it stays SILENT unless the
// week beats the person's best single DAY (a week no bigger than one day would only
// echo the best-day card, adding nothing).

/** Heading over the person's all-time best-week record. */
export function bestWeekHeadingCopy() {
  return 'Your best week';
}

/** Intro under the best-week heading — first person, record-only by design. */
export function bestWeekIntroCopy() {
  return 'The most kept words you’ve ever strung together across a single week — a high-water mark that’s yours to keep. A quiet week never takes it back.';
}

/**
 * Warm one-line all-time best-week read: names the record count and the week it
 * happened, from an {@link allTimeBestWeek} result. Anti-shame by CONSTRUCTION — it
 * celebrates a peak the person actually hit and frames it as a standing record that
 * only ever climbs, never a target, a week-over-week comparison, or a decline.
 *
 * Stays SILENT unless the best week is strictly BIGGER than the best single day
 * (`bestDayCount`): a "best week" no larger than one already-crowned day would only
 * echo the best-day card, so it adds nothing and shows nothing. Returns '' when
 * there is no record to crown (engine returned null / below floor) or the week
 * can't be named.
 *
 * @param {object} p
 * @param {{ weekStart:string, count:number } | null} p.best  from {@link allTimeBestWeek}
 * @param {number} [p.bestDayCount=0]  the person's best SINGLE-day count, to gate against echo
 * @param {string} [p.nowISO]     "this week" anchor for the warm week name
 * @param {string} [p.timezone]   IANA zone the record was bucketed in
 * @param {'ally'|'hype'} [p.persona]
 * @returns {string}
 */
export function bestWeekCopy({ best, bestDayCount = 0, nowISO, timezone, persona } = {}) {
  const count = Number(best && best.count) || 0;
  if (!best || count < BEST_WEEK_MIN_COUNT) return '';
  const dayFloor = Number(bestDayCount) || 0;
  if (count <= dayFloor) return ''; // a week no bigger than one day just echoes best-day
  const when = describeBestWeek(best.weekStart, { nowISO, timezone });
  if (!when) return '';
  const words = count === 1 ? 'word' : 'words';
  if (pickPersona(persona) === 'hype') {
    return `🏔️ Biggest week yet: ${when} — ${count} kept ${words} across it. A record only you can beat, and it only ever climbs. 💪`;
  }
  return `🏔️ Your best week so far: ${when} — ${count} kept ${words} across it. The most you’ve ever put together in seven days, and it only ever climbs from here.`;
}

// ── TWO-WAY TEXT CHECK-INS ───────────────────────────────────
// A text check-in ("You said you'd start the taxes at 2 — ready?") is only half
// the loop if you can't answer it. When someone texts back, we read the reply:
// "done / did it / yep" keeps the word; "later / not yet / tomorrow" is the
// no-shame reschedule. Anything we can't read gets a warm clarifying nudge — we
// never assume a miss from a message we didn't understand. STOP/START/HELP are
// intercepted upstream (consent.js) before this runs, so they never land here.

/**
 * Normalize an inbound reply the one way every reply-reading surface reads it:
 * lowercase, straighten curly apostrophes, drop punctuation/emoji to spaces,
 * collapse whitespace. Shared by `detectCheckinReply` and `isProgressReply` so
 * the two never drift on what counts as, say, "half-way" vs "halfway".
 */
function normalizeReplyText(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[’‘]/g, "'")            // normalize curly apostrophes to straight
    .replace(/[^a-z0-9\s']/g, ' ')    // keep letters/digits/apostrophes; drop other punctuation/emoji
    .replace(/\s+/g, ' ')
    .trim();
}

/** A direct request for a tiny starting intervention, never the CTIA bare HELP. */
export function isStartHelpReply(text) {
  const t = normalizeReplyText(text);
  return /^(help me start|help me get started|get me started|i need help starting|can you help me start|i can'?t start|i'?m stuck|stuck|where do i start)$/.test(t);
}

// Partial-progress phrasing, shared between the classifier and the progress
// reader. PARTIAL_DONE catches the qualified-"done" spellings that must be
// intercepted BEFORE KEPT; PARTIAL is everything else, read AFTER KEPT so a real
// completion still wins. Kept at module scope (not re-declared per call) so
// `detectCheckinReply` and `isProgressReply` share one definition of "progress".
const PARTIAL_DONE = /\b(half\s?way done|half\s?done|partly done|part done)\b/;
const PARTIAL = /\b(half\s?way|part\s?way|part of the way|mid\s?way|made a start|made (?:some |good )?progress|making progress|some progress|good progress|just started|getting started|started|chipping (?:away|at it)|working through(?: it)?|in progress|underway)\b/;
// The subset of the plain-snooze family that ALSO reports movement (not just
// "about to" / "hold on"): "still working", "almost there", "in the middle".
// These read as progress for the confirmation copy; a bare "on it" / "hang on"
// does not.
const PROGRESS_MOVEMENT = /\b(working on it|still working|still on it|still at it|still going|almost there|nearly there|in the middle|middle of it)\b/;
// The subset of the flow-state family (FLOW, in detectCheckinReply) that reports
// active EXERTION — the person moving the needle right now, not merely a focused
// state: "grinding", "cranking", "plugging away", "on a roll", "in the groove",
// "beast mode". R-273 already reads the whole flow family as a snooze; this lets
// the confirmation copy meet these movement phrases with "love that you're
// moving" instead of the generic "you got it", the same way PROGRESS_MOVEMENT
// does for the marker-word snooze family. Deliberately a strict subset of FLOW:
// the pure focus-STATE phrases ("in the zone", "locked in", "dialed in", "heads
// down", "in the weeds", "in the flow") report engagement but not reported
// movement, so they keep the generic-warm snooze copy — same warmth, same
// interval, just not the movement line. Every form is `\b`-anchored and matches
// FLOW's exact spelling so the two never drift. Never touches the streak — a
// snooze is not a resolution and not a miss.
const FLOW_MOVEMENT = /\b(on a roll|in the groove|beast mode|cranking(?: away| through)?|plugging away|grinding(?: away)?)\b/;
// The hardest reply on the whole moat: a self-critical miss. An ADHD user
// drowning in shame texts back "failed again", "i suck", "gave up", "i'm
// useless", "what's the point", "i'm the worst". None of these carries a
// reschedule marker word (no "later"/"tomorrow"/"can't"/"didn't"), so they fell
// through the entire classifier to a bare `null` — and `null` is the COLD "I
// didn't catch that, reply DONE or LATER" re-prompt. That is the exact scold the
// ONE design LAW forbids ("never shame"), delivered to the very person who most
// needs the warm hand. Read the residual self-blame / defeat family as a
// RESCHEDULE — the no-shame path, which answers "no problem, when do you want to
// try again?" and keeps the streak safe (a reschedule never resets it).
//
// Streak-safe AND regression-safe BY CONSTRUCTION: this net is consulted only in
// detectCheckinReply AFTER RESCHEDULE, KEPT, PARTIAL, SNOOZE, FLOW and the bare
// hold-length nets have each already returned. So a real completion ("did it, i
// suck at this but got it done") stays KEPT, a "later"/"tomorrow" stays a plain
// RESCHEDULE, and an "on it, i'm useless at focusing" stays a SNOOZE — every
// existing classification is untouched. The only reply this net can ever change
// is one that would otherwise have gone cold. The "the worst"/"a failure"/etc.
// identity phrases are anchored to the "i'm ..." self-frame so a stray "worst
// case, tomorrow" (already a reschedule) or "the point is done" (already kept)
// can never reach or trip them.
const SHAME_MISS = /\b(i suck(?: at this)?|i'?m (?:useless|hopeless|worthless|so useless|a failure|such a failure|the worst|a mess|a disaster|terrible at this|so bad at this|no good)|so useless|failed again|failed miserably|totally failed|i failed|complete failure|total failure|gave up|giving up|i give up|no use|what'?s the point|whats the point|messed it up|messed up|screwed up|blew it|hopeless)\b/;

/**
 * Does this reply report the person has actually MOVED the needle — as opposed
 * to merely "on it" / "hold on"? Meant to be called only when the reply already
 * classified as a snooze; lets the confirmation copy meet real progress with
 * "love that you're moving" instead of the generic "you got it". The active
 * flow-state exertion phrases ("grinding", "cranking", "on a roll", "in the
 * groove", "beast mode", "plugging away") count too — the most engaged reply of
 * all is unambiguously the person moving the needle — while the pure focus-STATE
 * flow phrases ("in the zone", "locked in") stay generic-warm. A negation
 * ("no progress" / "not started") is never progress. Never reads or writes the
 * streak — this only tunes wording; a snooze is not a resolution, by construction.
 * @param {string} text  the raw SMS body
 * @returns {boolean}
 */
export function isProgressReply(text) {
  const t = normalizeReplyText(text);
  if (!t) return false;
  // A negation is never progress: the bare "no progress" / "not started" and the
  // contracted "haven't started" / "didn't" (a reschedule the classifier catches
  // upstream, but guarded here too so isProgressReply is safe to call on any text).
  if (/\b(no|not|never)\b/.test(t) || /n't\b/.test(t)) return false;
  return PARTIAL_DONE.test(t) || PARTIAL.test(t) || PROGRESS_MOVEMENT.test(t) || FLOW_MOVEMENT.test(t);
}

// The neutral provenance note kept when a "done" reply carried no words of its
// own — an emoji- or punctuation-only "👍" that would only read redundantly
// beside the ✓ in the kept-word history.
export const KEPT_NOTE_FALLBACK = 'via SMS reply';

/**
 * The note to store on a KEPT check-in resolved over SMS, so the kept-word
 * history reads back in the person's OWN voice. A "done" reply often carries
 * real words — "done, finally filed the taxes 🎉", "yesss knocked it out" — and
 * those words are the truest, warmest record of the moment they showed up; keep
 * THEM verbatim (whitespace-collapsed, trimmed, capped) instead of a robotic
 * system label. Only a reply with no letters or digits (emoji- or
 * punctuation-only) has no color worth surfacing, so it falls back to the
 * neutral `KEPT_NOTE_FALLBACK`. The reply already classified as KEPT upstream,
 * so this is never a scold and never reads or writes the streak — it only
 * decides what the person sees written under their own kept word.
 * @param {string} text  the raw inbound SMS body
 * @returns {string}  the note to store on the kept check-in
 */
export function keptNoteFromReply(text) {
  const raw = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!raw) return KEPT_NOTE_FALLBACK;
  // Needs at least one letter or digit to be "their words"; an emoji-only reply
  // renders redundantly beside the history tick, so keep the neutral note.
  if (!/[\p{L}\p{N}]/u.test(raw)) return KEPT_NOTE_FALLBACK;
  return raw.slice(0, MAX_DETAILS);
}

/**
 * Read a stated hold-length out of an "I'm on it" reply, so the bro checks back
 * WHEN the person said — not at a fixed default. The best-case user, mid-task,
 * often names their own interval: "on it, give me 20", "still working — check
 * back in an hour", "hang on, 30 more minutes". Honoring it is the difference
 * between a friend who listens and one who nods and ignores you on the exact
 * two-way channel the moat is built on.
 *
 * Returns whole minutes, always clamped to the snooze window
 * ([SNOOZE_MIN_MIN, SNOOZE_MAX_MIN]) so a snooze can never quietly become a
 * disappearance (too short) or a full reschedule (too long); returns `null`
 * when no length was stated, so the caller keeps `SNOOZE_DEFAULT_MIN` exactly as
 * before — this is UPGRADE-ONLY, never a shorter or wronger nudge than today.
 *
 * Only ever call this on a reply ALREADY classified as a snooze by
 * `detectCheckinReply`: in that context a bare number is a hold-length
 * ("give me 20"), never a clock time. An explicit clock ("at 3", "3 pm") is
 * guarded out regardless, so even a mis-called reply falls back to the default,
 * never a wrong minute count. NEVER reads or writes the streak — a snooze is not
 * a resolution and not a miss, by construction.
 *
 * @param {string} text  the raw inbound reply
 * @returns {number|null}  clamped minutes, or null when no length was stated
 */
export function parseSnoozeMinutes(text) {
  const t = normalizeReplyText(text);
  if (!t) return null;
  // A clock time ("at 3", "3 pm", "noon o'clock") is a reschedule TARGET, never a
  // hold length — never read it as minutes. (The caller only reaches here on a
  // snooze, but guard anyway so a mis-classification can't turn into a wrong count.)
  if (/\b(?:am|pm|noon|midnight)\b/.test(t) || /\bo'?clock\b/.test(t) || /\bat\s+\d/.test(t)) return null;
  // A multi-day horizon ("in 2 days", "next week", "tomorrow") is a reschedule,
  // never a snooze hold — a snooze is bounded to minutes/hours by construction.
  // Guard here so neither a mis-classified caller nor the `isStatedHoldLength`
  // detector below ever reads "2 days" as a 2-minute (clamped-to-5) hold.
  if (/\b(days?|weeks?|months?|years?|tomorrow|tonight)\b/.test(t)) return null;

  const WORDNUM = {
    five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30,
    forty: 40, fifty: 50, sixty: 60, ninety: 90,
    an: 1, a: 1, one: 1, couple: 2, few: 3,
  };
  const toNum = (w) => (/^\d+$/.test(w) ? parseInt(w, 10) : (WORDNUM[w] ?? null));

  // Fixed idioms first, so "half an hour" isn't misread as "an hour" (60).
  if (/\bhalf\s?(?:an?\s+)?hour\b/.test(t)) return clampSnoozeMinutes(30);
  if (/\b(?:an?\s+)?hour and a half\b/.test(t)) return clampSnoozeMinutes(90);
  if (/\bquarter(?:\s+of\s+an)?\s+hour\b/.test(t)) return clampSnoozeMinutes(15);

  // number + unit: "20 min", "an hour", "2 hrs", "forty five minutes", "45m",
  // "20 more minutes" (an optional "more" between the count and the unit).
  const NUMWORD = '\\d{1,3}|an|a|one|couple|few|five|ten|fifteen|twenty|thirty|forty|fifty|sixty|ninety';
  const um = new RegExp(`\\b(${NUMWORD})(?:[\\s-]+(five))?(?:\\s+more)?\\s*(hours?|hrs?|h|minutes?|mins?|m)\\b`).exec(t);
  if (um) {
    let n = toNum(um[1]);
    if (n != null) {
      if (um[2] === 'five') n += 5;                       // "forty five"
      return clampSnoozeMinutes(/^h/.test(um[3]) ? n * 60 : n);
    }
  }

  // bare number behind a snooze lead-in: "give me 20", "in 30", "another 15".
  const bm = new RegExp('\\b(?:give me|gimme|need|another|in|make it|about|just|wait)\\s+(\\d{1,3}|five|ten|fifteen|twenty|thirty|forty|fifty|sixty|ninety)\\b').exec(t);
  if (bm) {
    const n = toNum(bm[1]);
    if (n != null) return clampSnoozeMinutes(n);
  }

  return null; // no stated length → caller keeps SNOOZE_DEFAULT_MIN
}

/**
 * Is this reply a bare "check back in N" hold-length — a stated minutes/hours
 * window with NO "on it" / "still working" marker word to give it away?
 *
 * The mid-task person often answers with the length alone: "give me 20",
 * "an hour", "30 more minutes", "half an hour". Without a marker word,
 * `detectCheckinReply` used to leave these unclassified, and the awaiting-"when?"
 * and fresh-nudge paths then handed them to `parseWhenReply` — which read
 * "give me 20" as 8 pm and "2 hours" as 2 am, or (for the un-clockable ones)
 * fell to the cold "I couldn't read that time." Both are a quiet "he didn't get
 * me" on the exact two-way text channel the moat is built on, from the best-case,
 * actively-doing-it user. Recognizing the stated length as the third answer (a
 * snooze) closes that gap.
 *
 * Deliberately conservative, so it never steals a genuine reschedule:
 *  - an "in ..." reply names a TARGET time and stays owned by `parseWhenReply`
 *    ("in 20 minutes" / "in an hour" remain reschedules, unchanged);
 *  - a clock time and any multi-day horizon are guarded to `null` inside
 *    `parseSnoozeMinutes`, so a length only ever reads as minutes/hours.
 * Meant to be consulted only AFTER the RESCHEDULE / KEPT / progress / marker-word
 * SNOOZE nets have each had their turn, so those always win.
 *
 * @param {string} text  the raw inbound reply
 * @returns {boolean}
 */
export function isStatedHoldLength(text) {
  const t = normalizeReplyText(text);
  if (!t) return false;
  // "in ..." names a target time (a reschedule), owned by parseWhenReply — never
  // reclassify it as a hold here.
  if (/^in\b/.test(t)) return false;
  return parseSnoozeMinutes(text) != null;
}

// A genuine completion sometimes rides in on a grateful/emotional negation —
// "did it, didn't think I could", "done, can't believe I finally finished",
// "nailed it, couldn't have done it without you", "finished, couldn't be
// happier". The negator belongs to the gratitude, not to the task: the person
// unmistakably KEPT their word. But RESCHEDULE's negation net
// (couldn't/didn't/can't/haven't) runs first inside `detectCheckinReply` and read
// the warmest, most grateful reply on the live two-way moat as a *not-done* — the
// coldest possible answer ("no problem, when do you want to try again?") AND a
// silent denial of the kept-word streak the person just earned. These three nets
// let `detectCheckinReply` intercept that exact case, and only that case, ahead
// of RESCHEDULE.
//
// Safe by construction — it fires ONLY when a CLEAN (un-negated) completion word
// co-occurs with a recognized positive-negation idiom AND there is no
// reschedule-intent word:
//  - a real "not done" / "not finished" / "didn't get it done" has its completion
//    word directly negated → no clean occurrence → never matches;
//  - a real "couldn't do it" / "haven't started" carries no completion word at all;
//  - a genuine "…, tomorrow" / "later" / "push it" is vetoed by RESCHEDULE_INTENT.
// So this only ever rescues a real win; it can never inflate the streak with a
// miss. Never reads or writes the streak itself — it only routes the outcome.
const GRATEFUL_COMPLETION_IDIOM = /\b(didn'?t think|didn'?t expect|don'?t think|can'?t believe|can'?t wait|can'?t thank|couldn'?t be (?:happier|more|prouder|better)|couldn'?t have (?:done|made|asked)|never (?:thought|imagined))\b/;
const RESCHEDULE_INTENT = /\b(later|tomorrow|tonight|next week|reschedul|resched|snooze|skip|rain ?check|another time|next time|move it|push it|not yet|no can do)\b/;
const CLEAN_COMPLETION = /\b(done|did it|did that|finished|completed?|nailed it|crushed it|handled it|knocked it out|got it done|all done)\b/g;
const NEGATOR_BEFORE_COMPLETION = /\b(?:not|never|no|didn'?t|couldn'?t|can'?t|cannot|won'?t|haven'?t|wasn'?t|isn'?t|ain'?t|don'?t)\b[a-z'\s]{0,14}$/;
/**
 * True when a completion word appears at least once with NO negator immediately
 * before it — i.e. the reply reports a real, un-negated completion. Used to keep
 * "not done" / "didn't get it done" out of the grateful-completion intercept
 * while still recognizing the clean "done" in "done, couldn't have done it
 * without you". Read-only; never touches the streak.
 * @param {string} t  normalized reply text
 * @returns {boolean}
 */
function hasCleanCompletion(t) {
  CLEAN_COMPLETION.lastIndex = 0;
  let m;
  while ((m = CLEAN_COMPLETION.exec(t)) !== null) {
    if (!NEGATOR_BEFORE_COMPLETION.test(t.slice(0, m.index))) return true;
  }
  return false;
}

/**
 * Interpret an inbound check-in reply.
 * @param {string} text  the raw SMS body
 * @returns {'kept'|'reschedule'|'snooze'|null}  null = couldn't tell (ask, don't assume)
 */
export function detectCheckinReply(text) {
  const raw = String(text == null ? '' : text);
  const t = normalizeReplyText(raw);

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
  // The "hold on / give me more time" family is the same third answer said as a
  // plea for a little more room, not a resolution and not a "later": "a bit
  // longer", "need more time", "hang tight", "bear with me", "brb", "one moment",
  // "in a bit", "shortly". These are the actively-doing-it user asking the bro to
  // swing back — yet without a marker word they fell through to the cold "I
  // couldn't read that time" on both SMS paths. Each alternative is guarded so it
  // can't steal a genuine reschedule: "no longer" (never anymore) can't match the
  // qualifier-required `(?:little|bit|while) longer`, and "no more time" can't
  // match the qualifier-required more-time form; RESCHEDULE still runs first, so a
  // "…, tomorrow" always wins. A bare "in a bit/sec/moment" carries no number, so
  // it never collides with an "in 20 minutes" reschedule target.
  const SNOOZE = /\b(on it|onit|working on it|still working|still on it|still at it|still going|almost there|nearly there|getting to it|in the middle|middle of it|mid ?task|give me a (?:few|sec|min|moment)|gimme a (?:few|sec|min|moment)|few more min|couple more min|need a (?:few|sec|min|moment)|one sec|hang on|hold on|hang tight|sit tight|bear with me|brb|be right back|(?:one|just a|a) moment|just a (?:sec|second|min|minute|moment)|in a (?:bit|sec|second|min|minute|moment)|(?:a )?(?:little|bit|while) longer|(?:need|want|(?:a )?(?:little|bit)) more time|shortly|momentarily)\b/;
  // Flow-state slang is the SAME third answer, said by the MOST engaged person:
  // asked "you doing it?", the head-down ADHD user texts back "in the zone",
  // "locked in", "grinding", "on a roll", "heads down", "in the weeds". None of
  // these carry an "on it"/"still working" marker word, a number, or a
  // done/later word, so they fell through to the cold "I couldn't read that time"
  // / "reply DONE or LATER" on both SMS paths — the coldest reply to the single
  // most engaged message on the live two-way moat. Read the whole family as the
  // third answer (a snooze) and re-arm the nudge at the default interval (no
  // length stated → R-270 keeps SNOOZE_DEFAULT_MIN). Deliberately excludes the
  // disengaged look-alikes so a real miss/distraction can never be read as
  // "check back": "zoned OUT" (spaced out) and "locked OUT" (done for the day)
  // never match the `in`-anchored forms, and "cooking" is left out entirely
  // because "cooking dinner" is a genuine distraction, not flow. Every form is
  // `\b`-anchored and the `not` guard below keeps a negated "not in the zone"
  // out — RESCHEDULE and KEPT still run first, so "later, in the zone elsewhere"
  // stays a reschedule and "done, was in the zone" stays kept.
  const FLOW = /\b(in the zone|zoned in|dialed in|locked in|heads? down|deep in (?:it|the weeds)|deep into it|in the weeds|on a roll|in the groove|beast mode|cranking(?: away| through)?|plugging away|grinding(?: away)?|in (?:the |a )?flow|flow state)\b/;
  // Partial progress is the SAME third answer, said the other way round. "halfway",
  // "made a start", "chipping away", "in progress" all mean *I'm mid-thing, check
  // back* — an engaged person, never done, never a miss. Most of these used to fall
  // through to the cold "I didn't catch that". Split into two nets so a real
  // completion always wins: PARTIAL_DONE catches the qualified-"done" spellings
  // ("half done", "halfway done", "partly done") that tripped KEPT's `done` and got
  // over-credited as a resolved word — it runs BEFORE KEPT precisely to intercept
  // that. Everything else runs AFTER KEPT, so "started and all done" still keeps the
  // word. A `no`/`not` guard keeps a negated "no progress" / "not started" out of a
  // wrong snooze (RESCHEDULE runs first, so "haven't started" stays the reschedule),
  // and a residual bare negation falls through to the warm ask, never a mislabel.
  // (PARTIAL_DONE / PARTIAL live at module scope now, shared with isProgressReply.)

  // A clean completion wrapped in a grateful negation idiom ("did it, didn't
  // think I could", "nailed it, couldn't have done it without you") is a KEPT
  // word, not a reschedule — intercept it before RESCHEDULE's negation net can
  // read the warmest reply on the moat as a not-done and deny the streak. Guarded
  // three ways (clean completion + gratitude idiom + no reschedule-intent word) so
  // a real "not done" / "couldn't do it" / "…tomorrow" can never reach here.
  if (hasCleanCompletion(t) && GRATEFUL_COMPLETION_IDIOM.test(t) && !RESCHEDULE_INTENT.test(t)) return 'kept';
  if (RESCHEDULE.test(t)) return 'reschedule';
  if (PARTIAL_DONE.test(t) && !/\b(no|not)\b/.test(t)) return 'snooze';
  if (KEPT.test(t)) return 'kept';
  if (PARTIAL.test(t) && !/\b(no|not)\b/.test(t)) return 'snooze';
  if (SNOOZE.test(t) && !/\bnot\b/.test(t)) return 'snooze';
  // Flow-state slang ("in the zone", "locked in", "grinding", "on a roll") — the
  // most engaged reply, the same third answer. RESCHEDULE / KEPT / progress /
  // marker-word SNOOZE have all run first, so a completion or a "later"/"tomorrow"
  // always wins; only a residual flow-state phrase reaches here. Streak-safe by
  // construction — a snooze is not a resolution and not a miss.
  if (FLOW.test(t) && !/\bnot\b/.test(t)) return 'snooze';
  // The third answer said as a bare length, no marker word: "give me 20", "an
  // hour", "30 more minutes", "half an hour". RESCHEDULE/KEPT/progress/marker-word
  // SNOOZE have all run first, so a completion or a "later"/"tomorrow" always wins;
  // only a residual stated minutes/hours hold reaches here. `isStatedHoldLength`
  // excludes "in ..." targets and clock/multi-day answers, so this never steals a
  // genuine reschedule. Streak-safe by construction — a snooze is not a resolution
  // and not a miss.
  if (isStatedHoldLength(raw)) return 'snooze';
  // A self-critical miss ("failed again", "i suck", "gave up", "i'm useless",
  // "what's the point") — the emotionally hardest reply on the two-way moat.
  // RESCHEDULE/KEPT/PARTIAL/SNOOZE/FLOW/hold-length have ALL run first, so a
  // completion, a "later"/"tomorrow", and any engaged mid-task reply have each
  // already returned; only a residual self-blame phrase reaches here. Read it as
  // the no-shame RESCHEDULE (warm "when do you want to try again?"), never the
  // cold `null` re-prompt — that cold branch aimed at this reply is the exact
  // scold the design LAW forbids. Streak-safe: a reschedule never resets.
  if (SHAME_MISS.test(t)) return 'reschedule';
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

export const START_HELP_MIN = 2;

/** A two-minute micro-start intervention, followed by a promised check-back. */
export function smsStartHelpCopy({ persona } = {}) {
  if (pickPersona(persona) === 'hype') {
    return 'I’ve got you. Open the thing and do only the first tiny move — two minutes, that’s it. I’ll check back in two. Text STARTED when you’re moving, or LATER for a new time. 💪';
  }
  return 'I’m with you. Open the thing and do only the first tiny move — two minutes, nothing more. I’ll check back in two. Text STARTED when you’re moving, or LATER for a new time.';
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

/**
 * Confirm the new time the person gave over text. The word still counts; the
 * streak is safe — a reschedule protects the chain by construction, never a miss.
 *
 * `progress` (true when the same reply also REPORTED movement — "made good
 * progress, tomorrow 9am" — per `isProgressReply`) meets that momentum by name:
 * "love that you got moving." Same warmth, same new time, still never a count or
 * a scold — it just sees the work they told us they did while pushing the check-in
 * out. Mirrors `snoozeConfirmCopy`'s progress arm so the two reschedule surfaces
 * (a snooze that holds the time, a reschedule that sets a new one) read the same.
 * A reschedule with no movement reported leaves `progress` false and keeps the
 * generic warm confirm.
 *
 * Like `checkinPromptCopy`, `escalationCopy`, and `returnNudgeCopy`, this rotates
 * across warm, tone-identical variants seeded deterministically from `seed` (the
 * SMS reply path passes the per-OCCURRENCE `open.checkin_id` — a recurring
 * commitment materializes a new check-in row per occurrence, so the seed advances
 * day to day while a retry of the SAME occurrence reads identically). A person on
 * a recurring commitment who reschedules regularly would otherwise get the
 * IDENTICAL confirmation every time — the same wallpaper decay the outbound nudge,
 * escalation knock, and return nudge already shed, now on the reply family, on the
 * two-way channel the whole thesis rests on. Every variant still names the new
 * time, keeps the word/streak safe (a reschedule protects the chain — never a
 * miss, never a tally), and never scolds; every hype variant carries the 💪 hype
 * marker and no ally variant does (the calm-vs-hype discriminator). `seed` omitted
 * → variant 0 (the canonical line, unchanged) on every (persona × progress) arm,
 * so previews and unseeded callers are byte-for-byte untouched.
 */
export function smsRescheduledCopy({ persona, when, timezone, nowISO, progress = false, seed } = {}) {
  const at = when ? formatWhenLocal(when, timezone, nowISO) : 'then';
  if (pickPersona(persona) === 'hype') {
    // Every hype variant carries the 💪 marker, names the new time, and keeps the
    // word/streak safe — an ally rolling on, never a scold.
    const v = progress ? [
      `Love that you got moving — that’s momentum! I’ll check back ${at}. Your word still counts and your streak’s safe. Let’s go. 💪`,
      `Love that you got some done — that’s real momentum! New time’s locked: I’ll check back ${at}. Your word still counts and your streak’s safe. 💪`,
      `Yesss, you moved on it — momentum! I’ll swing back ${at}. Your word still counts and your streak’s safe; we just roll on. 💪`,
      `That’s the good stuff — you got moving! I’ll check back ${at}. Your word still counts, your streak’s safe, we keep going. 💪`,
    ] : [
      `Got it — I’ll check back ${at}. Your word still counts and your streak’s safe. Let’s go. 💪`,
      `Locked in — I’ll check back ${at}. Your word still counts and your streak’s safe; we just go again. 💪`,
      `You got it — new time’s set: I’ll swing back ${at}. Your word still counts and your streak’s safe. 💪`,
      `Done — I’ll be right here ${at}. Your word still counts and your streak’s safe. Let’s go. 💪`,
    ];
    return v[seedIndex(seed, v.length)];
  }
  const v = progress ? [
    `Love that you got moving — I’ll check back ${at}. Your word still counts, and your streak stays right where it is.`,
    `Love that you made some headway — I’ll check back ${at}. Your word still counts, and your streak stays right where it is.`,
    `Glad you got moving on it — I’ll swing back ${at}. Your word still counts, and your streak stays put.`,
    `Nice, you got a bit done — I’ll check back ${at}. Your word still counts, and your streak stays right where it is.`,
  ] : [
    `Got it — I’ll check back ${at}. Your word still counts, and your streak stays right where it is.`,
    `All set — I’ll check back ${at}. Your word still counts, and your streak stays right where it is.`,
    `Got the new time — I’ll swing back ${at}. Your word still counts, and your streak stays put.`,
    `Noted — I’ll be right here ${at}. Your word still counts, and your streak stays right where it is.`,
  ];
  return v[seedIndex(seed, v.length)];
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
 * THE DESIGN-LAW SURFACE for the bro's actual voice — every outbound and
 * user-facing string the accountability copy engine emits, enumerated so the one
 * canonical `scanDesignLaw` guard (`design-law.js`) sweeps them the same way it
 * sweeps the dashboard surfaces (`meCopySurface`, `roomCopySurface`, …).
 *
 * WHY this surface matters most: these are the words that land on a person's
 * PHONE — the check-in nudge, the escalation knock, the return-nudge, the
 * two-way SMS replies, and every kept/miss/reschedule/snooze/pause/resume/edit
 * confirmation. The anti-shame law (issue #10: "any copy that tallies failures
 * is a defect") is at its highest stakes here, yet before this the copy engine
 * had no unified sweep — each string was only as safe as its own local test.
 * The five dashboard `*CopySurface()` helpers were folded into one scanner in
 * R-325; this closes the gap on the surface that actually reaches the user.
 *
 * Enumerated across BOTH personas (calm `ally` + `hype`) and the argument arms
 * that change the wording (streak counts, `progress` reported vs not,
 * `scheduleChanged`, empty vs populated records), so a future edit that leaks a
 * shame word / "AI" / a clinical claim onto ANY arm of ANY persona is caught.
 * Consumer voice: `allowAdhd` is false — the bro never names a diagnosis.
 *
 * @returns {string[]} every string the copy engine can say to a person.
 */
export function accountabilityCopySurface() {
  const personas = ['ally', 'hype'];
  const when = '2026-08-11T09:00:00.000Z';
  const title = 'the taxes';
  const out = [];
  const add = (...strings) => {
    for (const s of strings) {
      if (typeof s === 'string' && s.length > 0) out.push(s);
    }
  };
  for (const persona of personas) {
    // The outbound nudges + hints — what actually reaches the phone.
    add(checkinPromptCopy({ title, persona }));
    add(checkinReplyHint(persona));
    // Sweep EVERY escalation variant (8 seeds > 4 variants covers wraparound),
    // so a shame word edited into any rotated line fails the build, not just
    // the canonical one.
    for (let seed = 0; seed < 8; seed += 1) add(escalationCopy({ title, persona, seed }));
    // Sweep EVERY return-nudge variant too (the re-entry greeting also rotates,
    // seeded per dormancy episode), so a shame word edited into any rotated line
    // fails the build, not just the canonical one.
    for (let seed = 0; seed < 8; seed += 1) add(returnNudgeCopy({ persona, seed }));
    // Resolution confirmations across every streak / progress / schedule arm.
    add(keptCopy({ persona, streak: 0 }), keptCopy({ persona, streak: 1 }), keptCopy({ persona, streak: 5 }));
    add(missRescheduleCopy({ persona }));
    add(rescheduleConfirmCopy({ persona, when }), rescheduleConfirmCopy({ persona, when, progress: true }));
    add(releaseConfirmCopy({ persona }));
    add(alreadySettledCopy({ persona }));
    add(snoozeConfirmCopy({ persona, minutes: 10 }), snoozeConfirmCopy({ persona, minutes: 10, progress: true }));
    add(pauseConfirmCopy({ persona }));
    add(resumeConfirmCopy({ persona, when }));
    add(editConfirmCopy({ persona }), editConfirmCopy({ persona, scheduleChanged: true, when }));
    add(keptLogCopy({ persona, total: 0 }), keptLogCopy({ persona, total: 1 }), keptLogCopy({ persona, total: 5 }));
    // First-person momentum + streak voice (persona arms present on some).
    add(momentumSelfSummaryCopy({ total: 0 }), momentumSelfSummaryCopy({ total: 5, peak: { count: 3 } }));
    add(detailMomentumSummaryCopy({ total: 0 }), detailMomentumSummaryCopy({ total: 5, peak: { count: 3 } }));
    add(commitmentDetailCopy({ persona, keptCount: 0 }), commitmentDetailCopy({ persona, keptCount: 5 }));
    // The per-word "kept since" longevity anchor (fires at 3+ kept, a week+ of history).
    add(keptSinceCopy({ firstKeptISO: '2026-07-08T14:00:00Z', count: 5, nowISO: when, timezone: 'UTC', persona }));
    add(
      streakSummaryCopy({ persona, streak: { current_streak: 0, longest_streak: 0 } }),
      streakSummaryCopy({ persona, streak: { current_streak: 5, longest_streak: 7 } }),
    );
    // The two-way SMS reply family — the moat's on-channel conversation.
    add(smsKeptReplyCopy({ persona, streak: 0 }), smsKeptReplyCopy({ persona, streak: 5 }));
    add(smsRescheduleReplyCopy({ persona }));
    add(smsAmbiguousReplyCopy({ persona }));
    add(smsStartHelpCopy({ persona }));
    add(smsAskWhenCopy({ persona }));
    // Sweep EVERY reschedule-confirmation variant (both progress arms; 8 seeds >
    // 4 variants covers wraparound), so a shame word edited into any rotated line
    // fails the build, not just the canonical one.
    for (let seed = 0; seed < 8; seed += 1) {
      add(smsRescheduledCopy({ persona, when, seed }));
      add(smsRescheduledCopy({ persona, when, progress: true, seed }));
    }
    add(smsWhenUnclearCopy({ persona }));
  }
  // Persona-independent momentum headings/intros + peak/best/milestone marks.
  add(momentumSelfHeadingCopy(), momentumSelfIntroCopy());
  add(detailMomentumHeadingCopy(), detailMomentumIntroCopy());
  add(detailPeakDayCopy({ count: 3, whenPhrase: 'Tuesday' }));
  add(personalBestCopy({ streak: { current_streak: 5, longest_streak: 5 } }));
  add(milestoneCopy({ streak: { current_streak: 7 } }));
  add(inAppWhenExamplesText());
  return out;
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

// ── THE SILENT MISS, MET WITH WARMTH ON RETURN ───────────────
// R-286 / R-288. The escalation ladder (checkins-cron.js) knocks exactly ONCE
// more on a quiet PUSH check-in — an SMS — then latches `escalated_at` and, if
// that lands on silence too, goes quiet forever. That was the last unresolved
// corner of the two-way moat: a check-in nobody ever answered sat as an eternal
// `status='sent'` row, surfacing across the list as a "still waiting" ghost that
// never closes.
//
// The DESIGN LAW's answer to a miss is never a scold and never a dangling thread:
// it's a warm, no-shame door held open. So the moment the person comes back under
// their own steam, we resolve every genuinely-silent check-in as a `reschedule` —
// the streak-protected outcome (computeStreakAfter leaves the chain untouched),
// the same one a person's own "later" earns. A recurring rhythm keeps rolling
// (its next occurrence materializes); a one-shot reads "Moved — still on."
// Nothing is ever scored as a miss; the door simply stops standing ajar.
//
// R-288 — the guarantee now covers EVERY channel, not just the one with a ladder.
// The escalation ladder is push-only (`runEscalations` scans `channel = 'push'`),
// so a TEXT check-in is never escalated: `escalated_at` stays NULL forever, and
// the R-286 scan (which required `escalated_at IS NOT NULL`) never saw it — a
// silently-missed text word sat open as its own eternal ghost. Text has no
// escalation anchor, so its silence is measured from `delivered_at` instead, held
// for the SAME total window a push miss weathers before it qualifies
// (`STRANDED_TEXT_SILENCE_MIN`), so the door opens equally late on either channel.
//
// Bounded + safe by construction: a push check-in qualifies only once ESCALATED
// and then silent for a further hour (`STRANDED_SILENCE_MIN`); a text check-in
// only once delivered and silent for `STRANDED_TEXT_SILENCE_MIN` — either way a
// reply still in flight is never stolen. Resolution runs through the one shared
// `applyCheckinOutcome` core (idempotent — a resolved row no longer matches);
// and the whole pass is non-fatal, so a hiccup never blocks the return it rides.

/**
 * Minutes an ESCALATED, still-unanswered push check-in must stay silent before a
 * return resolves it. The escalation SMS itself fires 15 min after a quiet push
 * (ESCALATION_DELAY_MIN); this further hour of silence marks a genuine miss, not
 * a reply the person is about to send as they walk back in.
 */
export const STRANDED_SILENCE_MIN = 60;

/**
 * Minutes a delivered-but-unanswered TEXT check-in must stay silent — measured
 * from `delivered_at` — before a return resolves it. Text has no escalation
 * ladder (that's push-only), so it has no `escalated_at` anchor; this window is
 * set to the SAME total silence a push miss weathers before it qualifies — the
 * 15-min escalation delay (ESCALATION_DELAY_MIN) plus the further
 * STRANDED_SILENCE_MIN — so a missed word is held open exactly as long on either
 * channel, and a text reply the person is about to send is never stolen.
 */
export const STRANDED_TEXT_SILENCE_MIN = 15 + STRANDED_SILENCE_MIN;

/** Max stranded check-ins reconciled per return — bounded; a person has few. */
const STRANDED_LIMIT = 25;

/** Blameless provenance note on an auto-resolved silent miss (safe to surface). */
export const STRANDED_NOTE = 'Moved on your return — still on.';

/**
 * Resolve a returning person's silently-missed check-ins as no-shame reschedules.
 *
 * "Silently missed" spans both channels of the moat:
 *   - a PUSH check-in the bro escalated (one SMS) that then went fully quiet for
 *     at least `STRANDED_SILENCE_MIN` past the escalation; and
 *   - a TEXT check-in — which has no escalation ladder, so no `escalated_at`
 *     anchor — that stayed quiet for `STRANDED_TEXT_SILENCE_MIN` past delivery.
 *     This also covers a text nudge the person answered with a bare "later" (so
 *     it is parked `awaiting_time`, the bro having asked "when?") and then never
 *     named a time: the same delivered-but-unanswered thread, closed the same
 *     warm way rather than left hanging as the one open state the door can't see.
 * Both are on a still-active commitment, and each is closed through the shared
 * `applyCheckinOutcome` core as a `reschedule`: streak-safe, rhythm-continuing
 * for a recurring word, and never a miss score.
 *
 * DESIGN LAW: emits no scold and names no gap — it only stops an unanswered row
 * from sitting open forever, so the person meets a door, not a ghost. Non-fatal:
 * any failure resolves to `{ reconciled }` with what it managed, never throwing
 * into the caller (a return is never blocked by a housekeeping pass).
 *
 * @param {object} env  Worker env with a D1-shaped `DB`
 * @param {string} userId
 * @param {{ nowISO?: string }} [opts]
 * @returns {Promise<{ reconciled: number }>}
 */
export async function reconcileStrandedCheckins(env, userId, { nowISO } = {}) {
  if (!env || !env.DB || !userId) return { reconciled: 0 };
  const now = nowISO || new Date().toISOString();
  const nowMs = new Date(now).getTime();
  const cutoff = new Date(nowMs - STRANDED_SILENCE_MIN * 60 * 1000).toISOString();
  const textCutoff = new Date(nowMs - STRANDED_TEXT_SILENCE_MIN * 60 * 1000).toISOString();
  let reconciled = 0;
  try {
    const stranded = await env.DB.prepare(
      `SELECT c.id AS checkin_id, c.commitment_id,
              m.recurrence, m.timezone, m.local_time, m.channel, m.status AS commitment_status
         FROM commitment_checkins c
         JOIN commitments m ON m.id = c.commitment_id
        WHERE c.user_id = ?
          AND c.status IN ('sent', 'awaiting_time')
          AND c.responded_at IS NULL
          AND m.status = 'active'
          AND (
                (c.channel = 'push' AND c.escalated_at IS NOT NULL AND c.escalated_at <= ?)
             OR (c.channel = 'text' AND c.escalated_at IS NULL AND c.delivered_at IS NOT NULL AND c.delivered_at <= ?)
              )
        ORDER BY COALESCE(c.escalated_at, c.delivered_at) ASC
        LIMIT ?`
    ).bind(userId, cutoff, textCutoff, STRANDED_LIMIT).all();

    const rows = (stranded && stranded.results) || [];
    for (const row of rows) {
      try {
        await applyCheckinOutcome(env, {
          userId,
          checkin: { id: row.checkin_id, commitment_id: row.commitment_id },
          commitment: {
            id: row.commitment_id,
            recurrence: row.recurrence,
            timezone: row.timezone,
            local_time: row.local_time,
            channel: row.channel,
            status: row.commitment_status,
          },
          outcome: 'reschedule',
          note: STRANDED_NOTE,
          nowISO: now,
        });
        reconciled++;
      } catch (err) {
        console.error('[accountability] stranded reconcile row error:', err && err.message);
      }
    }
  } catch (err) {
    console.error('[accountability] stranded reconcile error:', err && err.message);
  }
  return { reconciled };
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
    const payload = await verifyToken(token, env.JWT_SECRET, env);
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
        data: {
          commitment_id: id,
          recurrence: v.recurrence,
          channel: v.channel,
          attribution: sanitizeAttribution(body.attribution),
        },
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

      // The silent miss, met with warmth on return (R-286): loading your words is
      // you coming back, so first close any check-in the bro nudged that then went
      // fully quiet — resolved as a no-shame reschedule (streak-safe, rhythm kept)
      // BEFORE the list is read, so a returning person meets an open door, never an
      // unanswered "still waiting" ghost. Non-fatal by construction: never blocks
      // the load.
      await reconcileStrandedCheckins(env, auth.userId, { nowISO: new Date().toISOString() });

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
          WHERE user_id = ? AND status IN ('pending', 'sent', 'deferred', 'awaiting_time')
          GROUP BY commitment_id`
      ).bind(auth.userId).all();
      const nextByCommitment = {};
      for (const row of (outstanding && outstanding.results) || []) {
        nextByCommitment[row.commitment_id] = row.next_checkin;
      }
      for (const c of commitments) {
        c.next_checkin = c.status === 'active' ? (nextByCommitment[c.id] || null) : null;
      }

      // In-app fallback — the bro still shows up when we could not reach the
      // person at all. A check-in the cron parked `skipped` PURELY for a missing
      // delivery channel (no push subscription, push/text not configured, or no
      // number on file) never reached them — unlike a `stale` skip, which aged
      // out on purpose and whose recurring word already rolled to a fresh
      // occurrence. For that unreachable case, opening the app is the ONLY place
      // the bro can still hold the door: for any ACTIVE word left with nothing
      // outstanding (a one-shot with no next occurrence — otherwise it silently
      // shows nothing), surface its most recent unreachable check-in as the same
      // warm, already-past "still here" open door (never a miss, never a scold).
      // Guarded so the extra grouped query only runs when a gap actually exists,
      // and still one query (no N+1).
      const anyUnfilled = commitments.some((c) => c.status === 'active' && !c.next_checkin);
      if (anyUnfilled) {
        const unreachable = await env.DB.prepare(
          `SELECT commitment_id, MAX(scheduled_for) AS next_checkin
             FROM commitment_checkins
            WHERE user_id = ? AND status = 'skipped'
              AND last_error IN ('no_subscription', 'push_not_configured', 'no_phone', 'text_not_configured')
            GROUP BY commitment_id`
        ).bind(auth.userId).all();
        const unreachableByCommitment = {};
        for (const row of (unreachable && unreachable.results) || []) {
          unreachableByCommitment[row.commitment_id] = row.next_checkin;
        }
        for (const c of commitments) {
          if (c.status === 'active' && !c.next_checkin && unreachableByCommitment[c.id]) {
            c.next_checkin = unreachableByCommitment[c.id];
          }
        }
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
            WHERE commitment_id = ? AND user_id = ? AND status IN ('pending', 'sent', 'deferred', 'awaiting_time')
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

      // This word's longevity — how long you've been keeping it. Reads the FIRST
      // kept instant on this word (MIN over status='kept' only — like every read
      // in this flow, no miss row is ever touched) and, once it's a standing
      // practice (KEPT_SINCE_MIN_COUNT+ kept, KEPT_SINCE_MIN_DAYS+ of history),
      // names the day the practice began. DESIGN LAW: kept-only in, a positive
      // anchor out; keptSinceCopy stays '' for a young or thin word, so a
      // just-started word shows nothing — never a "since today", never a "0 days".
      // Skipped entirely for a never-yet-kept word (no first instant to read).
      let firstKeptISO = null;
      if (keptCount > 0) {
        const firstRow = await env.DB.prepare(
          `SELECT MIN(responded_at) AS first_kept
             FROM commitment_checkins
            WHERE commitment_id = ? AND user_id = ? AND status = 'kept'`
        ).bind(id, auth.userId).first();
        firstKeptISO = (firstRow && firstRow.first_kept) || null;
      }
      const keptSince = keptSinceCopy({
        firstKeptISO, count: keptCount, nowISO, timezone: momentumTz, persona: commitment.persona,
      });

      return jsonResponse({
        commitment,
        cadence,
        next_checkin: nextCheckin,
        kept,
        kept_count: keptCount,
        momentum,
        kept_since: keptSince,
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
      let outcome = typeof body.outcome === 'string' ? body.outcome.toLowerCase() : '';
      if (!OUTCOMES.includes(outcome)) {
        return jsonResponse({ error: `outcome must be one of: ${OUTCOMES.join(', ')}` }, 400);
      }
      let note = typeof body.note === 'string' ? body.note.trim().slice(0, MAX_DETAILS) : '';

      const commitment = await env.DB.prepare(
        `SELECT id, title, persona, channel, timezone, recurrence, local_time, status
           FROM commitments WHERE id = ? AND user_id = ?`
      ).bind(id, auth.userId).first();
      if (!commitment) return jsonResponse({ error: 'Not found' }, 404);

      const persona = pickPersona(commitment.persona);

      // Never resurrect a word that's already been set down or otherwise settled.
      // The kept/snooze interceptions below already guard on `active`, but the main
      // resolve path did not — so a resolve landing on a released/paused/kept word
      // (a stale tab, or a second device acting after the word was closed elsewhere)
      // would move the commitment's status and re-arm a recurring rhythm, ringing
      // the bro again on a word the person explicitly closed. That is the guilt
      // engine the design LAW forbids and the SMS twin of the inbound-reply guard in
      // consent.js. A settled word is not waiting on anyone: reply warmly, write
      // NOTHING (no check-in stamp, no status move, streak untouched), keep the door
      // open. 200 (not an error) — nothing failed; the word is simply already done.
      if (commitment.status !== 'active') {
        return jsonResponse({
          status: commitment.status,
          message: alreadySettledCopy({ persona }),
        }, 200);
      }

      const isRecurring = pickRecurrence(commitment.recurrence) !== 'none';

      // Free-text carried on the in-app "Move it → when?" surface. Read up-front
      // because both the KEPT interception (just below) and the SNOOZE
      // interception (further down) must inspect it BEFORE this is treated as a
      // reschedule. An explicit picker instant (ISO new_start_at) is an
      // unambiguous reschedule and never a completion or a snooze.
      const rescheduleWhenText = typeof body.when_text === 'string' ? body.when_text.trim() : '';
      const hasExplicitInstant = typeof body.new_start_at === 'string' && body.new_start_at.trim();

      // Parity with the SMS awaiting-"when?" path (consent.js, R-275): someone who
      // tapped "Move it → when?" and then reports they actually FINISHED — "did it,
      // didn't think I could!" — is keeping their word, not rescheduling. R-275
      // taught detectCheckinReply to read that grateful completion as 'kept'; over
      // SMS the awaiting-time reply already honors it (resolveKept). Without this,
      // the in-app surface fell through parseWhenReply to the cold "I couldn't read
      // that time" AND silently denied the kept-word streak the person just earned
      // — the coldest possible answer to the warmest reply, the exact R-275 defect
      // on the other channel. Convert to a real kept so the whole resolution below
      // (streak credit, kept copy, kept event) runs identically to the Kept button.
      // Same guards as the snooze interception: only the reschedule "when?" surface,
      // only a natural-language when_text with no explicit picker instant, only an
      // active word. A real not-done can never reach here — detectCheckinReply
      // returns 'kept' only on a clean, un-negated completion, never on a miss.
      if (
        outcome === 'reschedule'
        && commitment.status === 'active'
        && rescheduleWhenText
        && !hasExplicitInstant
        && detectCheckinReply(rescheduleWhenText) === 'kept'
      ) {
        outcome = 'kept';
        // Keep the person's OWN grateful words as the note (parity with the SMS
        // resolveKept's keptNoteFromReply) when they didn't type a separate note,
        // so the kept-word history reads back in their voice, not a robotic label.
        if (!note) note = keptNoteFromReply(rescheduleWhenText);
      }

      // A recurring commitment is never "done" — it keeps its rhythm. Only a
      // one-shot commitment resolves to a terminal state.
      const newCommitmentStatus = isRecurring ? 'active'
        : outcome === 'kept' ? 'kept'
        : outcome === 'missed' ? 'missed' : 'rescheduled';

      // "I'm on it" while answering the in-app "Move it → when?" prompt is a
      // SNOOZE, not a reschedule — the best-case user, mid-task, saying "gimme a
      // few". Over SMS the awaiting-time reply already reads this warmly, so the
      // engaged person meets the same warmth on both channels; without this, an
      // in-app "actually I'm on it" fell through parseWhenReply to the cold
      // "I couldn't read that time" — the wrong answer for the exact person who
      // IS doing the thing. Honor it BEFORE any resolution write, so the check-in
      // is re-pended (not resolved) and the kept-word streak is never read or
      // written — a snooze is not a resolution and not a miss, by construction.
      // Guards, all load-bearing: only on 'reschedule' (the "when?" surface),
      // only for a natural-language when_text with no explicit picker instant
      // (an ISO new_start_at is an unambiguous reschedule), and only on an active
      // word (a settled one-shot has no live nudge to push). detectCheckinReply
      // runs RESCHEDULE before SNOOZE, so a plain "later" here stays a reschedule
      // and still gets the warm re-ask — never a wrong snooze.
      if (
        outcome === 'reschedule'
        && commitment.status === 'active'
        && rescheduleWhenText
        && !hasExplicitInstant
        && detectCheckinReply(rescheduleWhenText) === 'snooze'
      ) {
        // Honor a stated hold-length ("gimme 20", "check back in an hour"); a
        // snooze with no named interval keeps the default. Clamped, streak-safe.
        const minutes = parseSnoozeMinutes(rescheduleWhenText) ?? SNOOZE_DEFAULT_MIN;
        const snoozedUntil = new Date(Date.now() + minutes * 60000).toISOString();
        // Mirror the /snooze endpoint exactly: re-arm the CURRENT still-open
        // check-in — the SOONEST open occurrence, the one the /me/ card surfaces
        // and the person is acting on — or open a fresh one; reset attempts, clear
        // last_error / responded_at (not resolved, just moved a little). Ordering
        // `scheduled_for ASC` is load-bearing: for a recurring word the delivery
        // cron marks today's check-in `sent` and materializes tomorrow's as
        // `pending` (checkins-cron.js), so a `DESC` pick would snooze TOMORROW's
        // occurrence into today and orphan today's `sent` row into a false
        // escalation nudge — the exact R-284 bug class, here on the snooze path.
        const open = await env.DB.prepare(
          `SELECT id FROM commitment_checkins
            WHERE commitment_id = ? AND user_id = ? AND status IN ('pending', 'sent', 'deferred', 'awaiting_time')
            ORDER BY scheduled_for ASC LIMIT 1`
        ).bind(id, auth.userId).first();
        if (open && open.id) {
          await env.DB.prepare(
            `UPDATE commitment_checkins
                SET status = 'pending', scheduled_for = ?, attempts = 0, last_error = NULL, responded_at = NULL
              WHERE id = ? AND user_id = ?`
          ).bind(snoozedUntil, open.id, auth.userId).run();
        } else {
          await env.DB.prepare(
            `INSERT INTO commitment_checkins (id, commitment_id, user_id, scheduled_for, channel, status)
             VALUES (?, ?, ?, ?, ?, 'pending')`
          ).bind(generateUUID(), id, auth.userId, snoozedUntil, commitment.channel || 'push').run();
        }
        // Count the "I'm on it" like every other snooze surface. This in-app
        // interception historically returned here WITHOUT recording anything —
        // the exact "web route skipped the analytics event → undercounting
        // browser users in the founder scorecard" gap noted below, on the snooze
        // path. A snooze is a first-class engagement signal (never a resolution,
        // never a miss): record it as COMMITMENT_SNOOZE and mark the check-in
        // responded, parity with the /snooze endpoint and the SMS branches.
        await recordEvent(env, {
          userId: auth.userId,
          type: EVENTS.COMMITMENT_SNOOZE,
          data: { commitment_id: id, is_recurring: isRecurring, channel: commitment.channel || null },
        });
        await recordEvent(env, {
          userId: auth.userId,
          type: EVENTS.CHECKIN_RESPONDED,
          data: { commitment_id: id, channel: commitment.channel || null },
        });
        return jsonResponse({
          commitment_id: id,
          snoozed_until: snoozedUntil,
          minutes,
          action: 'snoozed',
          message: snoozeConfirmCopy({ persona, minutes, progress: isProgressReply(rescheduleWhenText) }),
        }, 200);
      }

      // Validate the new time BEFORE resolving anything. Previously the route
      // stamped the check-in, moved the commitment, and changed the streak before
      // discovering that a reschedule phrase was unreadable. A 400 must be a true
      // no-op: the person's existing word remains open until we understand when.
      let rescheduleValue = null;
      if (outcome === 'reschedule') {
        let newStartISO = typeof body.new_start_at === 'string' && body.new_start_at.trim()
          ? body.new_start_at.trim()
          : null;
        if (!newStartISO && rescheduleWhenText) {
          newStartISO = parseWhenReply(rescheduleWhenText, {
            nowISO: new Date().toISOString(),
            timezone: commitment.timezone,
            defaultTime: commitment.local_time,
          });
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
        rescheduleValue = parsed.value;
      }

      // Record the resolution on the check-in the person is actually acting on:
      // the SOONEST still-outstanding occurrence — the exact one the /me/ card
      // surfaces as `next_checkin` (MIN(scheduled_for) over the same open set,
      // see the `outstanding` query above). This MUST NOT pick a later row.
      // For a recurring word, the delivery cron marks today's check-in `sent` and
      // immediately materializes tomorrow's as `pending` (checkins-cron.js). The
      // previous ordering — pending-first, then latest `scheduled_for` DESC —
      // therefore stamped the resolution on TOMORROW's not-yet-due occurrence and
      // orphaned today's delivered check-in as an unanswered `sent` row: the card
      // kept reading "still here whenever you're ready" right after the person
      // marked it done, and the escalation ladder then texted a false "still here
      // about <word>" nudge for a task they had already completed. Ordering by
      // `scheduled_for ASC` over the open set resolves the current occurrence and
      // leaves the future one untouched — an early in-app resolve (before any
      // delivery) still lands on the single pending row exactly as before.
      // The open set includes `awaiting_time`: when the current occurrence was
      // delivered over text and answered "later" (so the bro asked "when?"), it
      // is the soonest-open row and MUST be the one a subsequent in-app tap
      // resolves — otherwise ASC skips it and stamps tomorrow's freshly
      // materialized `pending` row (the R-284 wrong-row/orphan defect, one
      // substate over), crediting the streak for a day that has not happened and
      // orphaning the delivered occurrence into a false "still here" nudge.
      // Resolve the soonest OPEN occurrence — but only one that is genuinely DUE:
      // already delivered (sent / deferred / awaiting_time), or a `pending` row
      // scheduled no later than the end of today in the recipient's zone (an early
      // completion of today's not-yet-delivered word — "did it before you even
      // pinged me"). A FUTURE day's `pending` occurrence is deliberately excluded.
      //
      // R-284 fixed the CRON-ordering twin of this defect (today `sent` + tomorrow
      // `pending` both open → resolve today's, not tomorrow's). This closes the
      // DOUBLE-RESOLVE twin: once today's occurrence is resolved, the only open row
      // for a recurring word is tomorrow's freshly-materialized `pending` one, so a
      // SECOND resolve — a double-tap, a stale card, a second device — would stamp
      // IT, crediting the kept-word streak for a day that hasn't happened AND
      // swallowing tomorrow's check-in so the bro never shows up tomorrow. Both are
      // defects under the design LAW: an inflated count the coach pitch rests on,
      // and a silently-dropped nudge on the exact channel that IS the product.
      // "Today's occurrence" is a local-calendar-day boundary, not a fixed offset —
      // only that distinguishes tomorrow's 9am nudge when it's now 11pm (~10h out)
      // from today's 9am word when it's now 4am (~5h out).
      const resolveTz = commitment.timezone || 'UTC';
      const resolveTp = tzParts(Date.now(), resolveTz);
      let dueBefore;
      if (resolveTp) {
        // Midnight tonight → the first instant of tomorrow, in the recipient's zone.
        const tmr = new Date(Date.UTC(+resolveTp.year, +resolveTp.month - 1, +resolveTp.day) + 24 * 60 * 60 * 1000);
        dueBefore = new Date(
          zonedWallToUtcMs(tmr.getUTCFullYear(), tmr.getUTCMonth() + 1, tmr.getUTCDate(), 0, 0, resolveTz),
        ).toISOString();
      } else {
        dueBefore = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      }

      const resolveRes = await env.DB.prepare(
        `UPDATE commitment_checkins
            SET status = ?, responded_at = datetime('now'), note = ?
          WHERE user_id = ? AND commitment_id = ?
            AND id = (
              SELECT id FROM commitment_checkins
               WHERE commitment_id = ? AND user_id = ?
                 AND ( status IN ('sent', 'deferred', 'awaiting_time')
                       OR (status = 'pending' AND scheduled_for < ?) )
               ORDER BY scheduled_for ASC LIMIT 1
            )`
      ).bind(outcome, note, auth.userId, id, id, auth.userId, dueBefore).run();

      // Nothing due was waiting: the current occurrence is already logged (a
      // double-tap / stale card / second device), or the only open row is a future
      // day's not-yet-due one. Resolve NOTHING — no second streak credit for one
      // word, no swallowed future check-in, no duplicate kept event. Reply warm and
      // blameless; the rhythm keeps rolling on its own. 200 (nothing failed).
      if (!(resolveRes && resolveRes.meta && resolveRes.meta.changes > 0)) {
        return jsonResponse({
          status: commitment.status,
          message: alreadyLoggedCopy({ persona }),
        }, 200);
      }

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
        // The time was parsed and validated above, before any state changed.
        const v = rescheduleValue;
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

        // Parity with the SMS reschedule (R-263): if the "when?" reply reported
        // movement alongside the new time ("made good progress, tomorrow 9am"),
        // meet it by name. Only the natural-language `when_text` can carry a
        // progress phrase; an explicit picker instant has none, so it stays generic.
        response.message = rescheduleConfirmCopy({ persona, when: v.startAt, progress: isProgressReply(rescheduleWhenText) });
        response.new_commitment = {
          id: newId, title: v.title, start_at: v.startAt, checkin_at: v.checkinAt,
          channel: v.channel, persona: v.persona, status: 'active',
        };
      }

      // The web route historically skipped the analytics event that the SMS
      // route records through applyCheckinOutcome(), undercounting browser users
      // in the founder scorecard. Record the same canonical outcome only after
      // the complete resolution succeeds; instrumentation remains non-fatal.
      const evt = outcomeEvent(outcome);
      if (evt) {
        await recordEvent(env, {
          userId: auth.userId,
          type: evt,
          data: {
            commitment_id: id,
            is_recurring: isRecurring,
            channel: commitment.channel || null,
            ...(outcome === 'reschedule' && response.new_commitment
              ? { rescheduled_to: response.new_commitment.id }
              : {}),
          },
        });
      }
      await recordEvent(env, {
        userId: auth.userId,
        type: EVENTS.CHECKIN_RESPONDED,
        data: { commitment_id: id, channel: commitment.channel || null },
      });

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
        `SELECT id, title, persona, channel, status FROM commitments WHERE id = ? AND user_id = ?`
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
      await recordEvent(env, {
        userId: auth.userId, type: EVENTS.CHECKIN_RESPONDED,
        data: { commitment_id: id, channel: commitment.channel || null },
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

      // The hold length can arrive two ways, and every OTHER snooze surface — the
      // SMS "gimme 20" reply and the in-app "Move it → I'm on it" path — already
      // reads a natural-language length through the shared `parseSnoozeMinutes`.
      // This endpoint used to accept ONLY a numeric `minutes`, so it was the one
      // snooze surface that couldn't understand "give me 20" / "half an hour" — an
      // API/UX parity gap against the "one parser on every surface" line the
      // two-way moat is built on (R-233). Read both: an explicit numeric `minutes`
      // keeps the exact prior API contract and wins; otherwise a `when_text` is
      // read with the SAME parser (a clock time or multi-day horizon is guarded to
      // the default in there, never mis-clamped into a wrong count), and a plain
      // snooze with neither stays the default. Streak-safe by construction — this
      // route never reads or writes the kept-word streak.
      const whenText = body && typeof body.when_text === 'string' ? body.when_text.trim() : '';
      const minutes = body && body.minutes != null
        ? clampSnoozeMinutes(body.minutes)
        : (whenText ? (parseSnoozeMinutes(whenText) ?? SNOOZE_DEFAULT_MIN) : SNOOZE_DEFAULT_MIN);

      const commitment = await env.DB.prepare(
        `SELECT id, persona, channel, status, recurrence FROM commitments WHERE id = ? AND user_id = ?`
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

      // Re-arm the CURRENT still-open check-in — the SOONEST open occurrence, the
      // one the /me/ card surfaces (MIN(scheduled_for)) and the person is answering:
      // a nudge already delivered (status='sent') or one held for quiet hours
      // ('deferred'). Reset attempts so the fresh window starts clean, and clear
      // responded_at — not resolved, just moved a little. Ordering `scheduled_for
      // ASC` is load-bearing: for a recurring word the cron materializes tomorrow's
      // occurrence as `pending` while today's is `sent`, so a `DESC` pick would
      // snooze TOMORROW's occurrence into today and orphan today's `sent` row into a
      // false escalation nudge (the R-284 bug class, on the snooze path). ASC re-arms
      // the occurrence the person is acting on and leaves the future one to fire.
      const open = await env.DB.prepare(
        `SELECT id FROM commitment_checkins
          WHERE commitment_id = ? AND user_id = ? AND status IN ('pending', 'sent', 'deferred', 'awaiting_time')
          ORDER BY scheduled_for ASC LIMIT 1`
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

      // A snooze is a first-class engagement signal (the "I'm on it" third
      // answer) — counted on its own, never a resolution and never a miss.
      await recordEvent(env, {
        userId: auth.userId,
        type: EVENTS.COMMITMENT_SNOOZE,
        data: {
          commitment_id: id,
          is_recurring: pickRecurrence(commitment.recurrence) !== 'none',
          channel: commitment.channel || null,
        },
      });
      await recordEvent(env, {
        userId: auth.userId,
        type: EVENTS.CHECKIN_RESPONDED,
        data: { commitment_id: id, channel: commitment.channel || null },
      });

      return jsonResponse({
        commitment_id: id,
        snoozed_until: snoozedUntil,
        minutes,
        // Meet reported movement by name — "love that you're moving" — the exact
        // warmth the SMS and in-app "when?" snooze surfaces already give, so a
        // "grinding away, gimme 20" here no longer lands on the flatter generic
        // line. Only a natural-language when_text can carry that signal; a numeric
        // `minutes` request has no words to read, so it keeps the generic-warm copy.
        message: snoozeConfirmCopy({ persona, minutes, progress: whenText ? isProgressReply(whenText) : false }),
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

      // Neutralise any occurrence left over from before the break BEFORE queuing
      // the fresh one. Pause deliberately cancels only the waiting substates
      // (`pending`/`deferred`/`awaiting_time`) and leaves a DELIVERED-but-
      // unanswered `sent` nudge live — safe *while paused* because every active-
      // scoped surface filters on `m.status='active'`, so the stray row is inert.
      // Resume flips the word back to 'active', which re-arms that same stray row
      // on exactly those surfaces: the escalation cron (`c.status='sent' AND
      // m.status='active'`) would text a "still here about <word>" nudge chasing a
      // moment from before the break, and the /me/ + coach next-check-in
      // (MIN(scheduled_for) over the open set) would surface that pre-pause
      // moment beside the freshly-queued one as a DUPLICATE open occurrence.
      // Resume's contract is "pick up cleanly from now, never a backlog of the
      // days away" — so the pre-pause occurrence is superseded, exactly as an
      // edit's time change supersedes its outstanding check-in. Cancel the same
      // wider set the edit path does (`sent` included). Anti-shame by
      // construction: `cancelled` is inert, the streak is never read or written
      // by a resume, and no miss is recorded.
      await env.DB.prepare(
        `UPDATE commitment_checkins SET status = 'cancelled', responded_at = datetime('now')
          WHERE commitment_id = ? AND user_id = ? AND status IN ('pending', 'sent', 'deferred', 'awaiting_time')`
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
      //
      // The cancel set includes a DELIVERED-but-unanswered `sent` row, unlike
      // release/pause (which cancel only the waiting substates and leave `sent`
      // live). The difference is load-bearing: release/pause move the commitment
      // OUT of 'active', so every active-scoped surface — the /me/ + coach
      // next-check-in (MIN over the open set), the escalation cron
      // (`c.status='sent' AND m.status='active'`), and the resolve guard — stops
      // touching the stray `sent` row and it goes inert. An edit KEEPS the word
      // active, so a leftover `sent` occurrence is NOT neutralised: it would
      // linger beside the freshly-queued `pending` one as a DUPLICATE open
      // occurrence — the /me/ card's MIN(scheduled_for) would surface the OLD,
      // pre-edit moment the person just moved away from, and the escalation
      // ladder would chase that superseded moment with a false "still here about
      // <word>" nudge (a design-LAW brush: the bro chasing a moment you
      // rescheduled). Editing the time redefines the current occurrence, so the
      // delivered nudge for the old moment is superseded — cancel it too. Anti-
      // shame by construction: `cancelled` is inert, the streak is never read or
      // written by an edit, and no miss is recorded.
      if (built.scheduleChanged) {
        await env.DB.prepare(
          `UPDATE commitment_checkins SET status = 'cancelled', responded_at = datetime('now')
            WHERE commitment_id = ? AND user_id = ? AND status IN ('pending', 'sent', 'deferred', 'awaiting_time')`
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
        // The lifetime-total landmark (10/25/50/100/250/500/1000 words kept ever).
        // Reads total_kept, which only ever grows, so — unlike best/milestone (both
        // current-run signals that a miss can zero) — this celebration can never be
        // taken away once reached. '' between landmarks, so it never nags.
        landmark: keptTotalLandmarkCopy({ streak }),
        // The STANDING all-time record — the strongest run, shown ONLY at a fresh
        // start (current_streak === 0), where the summary/best/milestone lines all
        // go quiet. Reads longest_streak (monotonic; a reset never lowers it), so
        // it can only describe a record on the way up, and it stands alone with no
        // current run to compare against — reassurance, never a decline.
        record: personalRecordCopy({ streak }),
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
        `SELECT k.responded_at AS kept_at, c.title AS title, k.note AS note
           FROM commitment_checkins k
           JOIN commitments c ON c.id = k.commitment_id
          WHERE k.user_id = ? AND k.status = 'kept'
          ORDER BY k.responded_at DESC
          LIMIT 50`
      ).bind(auth.userId).all();
      const keptList = (rows && rows.results) || [];

      // The warm one-line "momentum read" for /me/ (Phase A): the most recent word
      // the person kept WITH a note, read back to them in their OWN words. The rows
      // are DESC by kept-at, so the first one carrying a non-empty note is the
      // latest — a returning person is greeted by their last win in their own
      // voice, not a bare tick. DESIGN LAW: own-voice celebration and a memory,
      // never a tally; and (like every row in this query) status='kept' ONLY, so a
      // set-down or missed word can never reach it. Null when no kept word carried
      // a note yet — the client simply shows nothing, never an empty scold.
      let latestNote = null;
      for (const r of keptList) {
        const n = typeof r.note === 'string' ? r.note.trim() : '';
        if (n) { latestNote = { note: n, title: r.title, kept_at: r.kept_at }; break; }
      }

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

      // ── Your power hours (kept-word count by local hour over a wider window) ──
      // A time-of-day pattern needs more history than the 14-day sparkline to be
      // honest, so this reads its own POWER_HOURS_WINDOW_DAYS window and buckets
      // by local wall-clock hour. DESIGN LAW: status='kept' ONLY (same as every
      // read here) → it can only ever name an hour the person SHOWED UP, and the
      // peak gate keeps a thin/flat history from getting an arbitrary "power hour".
      const powerCutoffISO = new Date(Date.parse(nowISO) - (POWER_HOURS_WINDOW_DAYS + 1) * 86400000).toISOString();
      const powerRows = await env.DB.prepare(
        `SELECT responded_at FROM commitment_checkins
          WHERE user_id = ? AND status = 'kept' AND responded_at IS NOT NULL AND responded_at >= ?
          ORDER BY responded_at DESC
          LIMIT 2000`
      ).bind(auth.userId, powerCutoffISO).all();
      const powerTimestamps = ((powerRows && powerRows.results) || []).map((r) => r.responded_at);
      const powerPeak = peakKeptHour(bucketKeptByHour({ timestamps: powerTimestamps, timezone: momentumTz }));
      const powerHours = powerHoursCopy({ peak: powerPeak });

      // ── Your all-time best day (the most kept words ever in a single day) ──
      // A record needs the WHOLE history, not a trailing window — a best day from
      // a year ago is still the record — so this reads status='kept' with no date
      // cutoff (bounded to a generous LIMIT that is effectively all-time for this
      // product; the record is recomputed each read and only ever climbs as kept
      // rows accumulate). DESIGN LAW: status='kept' ONLY, so it can only ever
      // crown a day the person SHOWED UP; the floor keeps a thin history from
      // getting a hollow "best day".
      const allKeptRows = await env.DB.prepare(
        `SELECT responded_at FROM commitment_checkins
          WHERE user_id = ? AND status = 'kept' AND responded_at IS NOT NULL
          ORDER BY responded_at DESC
          LIMIT 5000`
      ).bind(auth.userId).all();
      const allKeptTimestamps = ((allKeptRows && allKeptRows.results) || []).map((r) => r.responded_at);
      const bestDayRaw = allTimeBestDay({ timestamps: allKeptTimestamps, timezone: momentumTz });
      const bestDay = bestDayCopy({
        best: bestDayRaw,
        nowISO,
        timezone: momentumTz,
      });

      // ── Your best week (the most kept words ever across a single week) ──
      // The week-scale peer of the best-day record: the Monday-anchored local week
      // the person kept the most words in. Reuses the SAME all-time status='kept'
      // scan already fetched above (no new query), folds its days into weeks, and
      // names the peak week only when it clears the floor AND beats the best single
      // DAY — so it never just echoes the best-day card. DESIGN LAW: status='kept'
      // ONLY → it can only ever crown a week the person SHOWED UP; a thin history,
      // or a week no bigger than one day, returns '' → the card stays hidden.
      const bestWeek = bestWeekCopy({
        best: allTimeBestWeek({ timestamps: allKeptTimestamps, timezone: momentumTz }),
        bestDayCount: bestDayRaw ? bestDayRaw.count : 0,
        nowISO,
        timezone: momentumTz,
      });

      // ── Days you showed up (lifetime distinct active days) ──
      // The BREADTH read beside the best day: how many separate local days carry a
      // kept word. Reuses the SAME all-time status='kept' scan already fetched for
      // the best day (no new query, same effectively-all-time LIMIT bound), so it
      // costs nothing extra and stays consistent with the record above it. DESIGN
      // LAW: status='kept' ONLY → every counted day is a day the person SHOWED UP;
      // the floor keeps a thin history from getting a hollow "1 day".
      const showedUpDays = showedUpDaysCopy({
        days: distinctKeptDays({ timestamps: allKeptTimestamps, timezone: momentumTz }),
      });

      // ── Your power day (the weekday your kept words most often land) ──
      // The weekday sibling of power hours: instead of the HOUR of day, it names the
      // DAY OF THE WEEK the person comes through most. Reuses the SAME all-time
      // status='kept' scan already fetched above (no new query), buckets it by local
      // weekday, and names the single peak only when peakKeptWeekday clears its
      // signal gate. DESIGN LAW: status='kept' ONLY → it can only ever name a weekday
      // the person SHOWED UP; a thin, flat, or tied history returns null → '' here.
      const powerDay = powerDayCopy({
        peak: peakKeptWeekday(bucketKeptByWeekday({ timestamps: allKeptTimestamps, timezone: momentumTz })),
      });

      // ── Your typical day (average kept words per active day) ──
      // The INTENSITY read beside the count/peak/breadth reads: when the person
      // shows up, about how many words do they keep? Reuses the SAME all-time
      // status='kept' scan already fetched above (no new query) — both the kept
      // total it averages and the distinct active days it divides by are drawn from
      // kept rows ONLY, so a quiet day is in neither and the average can only ever
      // describe a day they SHOWED UP. DESIGN LAW: status='kept' ONLY; the gate (and
      // the ~2-a-day floor in the copy) keep a thin or flat history from getting a
      // hollow figure → '' → the card stays hidden.
      const typicalDay = typicalDayCopy({
        typical: typicalKeptPerActiveDay({ timestamps: allKeptTimestamps, timezone: momentumTz }),
      });

      // ── Keeping your word since … (account-level longevity anchor) ──
      // The day the person kept their VERY FIRST word here, across all commitments
      // — the per-word "kept since" read one level up. A dedicated MIN(responded_at)
      // over status='kept' is correct regardless of the all-time LIMIT above (the
      // true earliest, even past 5000 rows). Skipped entirely below the count floor
      // so a thin account never touches the DB for an anchor it won't show. DESIGN
      // LAW: status='kept' ONLY — the MIN can only ever fall on a day they SHOWED UP.
      let keepingSince = '';
      if (total >= ACCOUNT_SINCE_MIN_COUNT) {
        const firstKeptRow = await env.DB.prepare(
          `SELECT MIN(responded_at) AS first_kept FROM commitment_checkins
            WHERE user_id = ? AND status = 'kept' AND responded_at IS NOT NULL`
        ).bind(auth.userId).first();
        keepingSince = keepingSinceCopy({
          firstKeptISO: firstKeptRow && firstKeptRow.first_kept,
          count: total,
          nowISO,
          timezone: momentumTz,
        });
      }

      return jsonResponse({
        kept: keptList,
        latest_note: latestNote,
        total_kept: total,
        momentum,
        power_hours: powerHours,
        best_day: bestDay,
        best_week: bestWeek,
        showed_up_days: showedUpDays,
        power_day: powerDay,
        typical_day: typicalDay,
        keeping_since: keepingSince,
        message: keptLogCopy({ total }),
      }, 200, 'short');
    } catch (err) {
      console.error('[accountability] kept-log error:', err && err.message);
      return jsonResponse({ error: 'Could not load your kept words.' }, 500);
    }
  });
}
