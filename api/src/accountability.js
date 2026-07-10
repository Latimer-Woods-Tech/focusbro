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

  // For a recurring commitment the cron needs a local-time anchor to compute
  // each next occurrence; derive it from the start instant when not given.
  const localTime = recurrence === 'none'
    ? ''
    : (localTimeIn ? fmtLocalTime(localTimeIn.h, localTimeIn.m) : localTimeFromISO(startAt, timezone));

  return { ok: true, value: { title, details, startAt, checkinAt, channel, persona, timezone, recurrence, localTime } };
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
 * @returns {'kept'|'reschedule'|null}  null = couldn't tell (ask, don't assume)
 */
export function detectCheckinReply(text) {
  const t = String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[’‘]/g, "'")            // normalize curly apostrophes to straight
    .replace(/[^a-z0-9\s']/g, ' ')    // keep letters/digits/apostrophes; drop other punctuation/emoji
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;

  // "did it" / "got it done" / "all done" → kept. Check the reschedule forms
  // first — especially the NEGATED ones — so "not done" / "haven't yet" is never
  // misread as "done".
  const RESCHEDULE = /\b(later|not yet|notyet|not done|not finished|not complete[d]?|nope|tomorrow|reschedule|resched|snooze|skip|rain ?check|another time|next time|move it|push it|can'?t|cannot|couldn'?t|didn'?t|did not|haven'?t|havent|won'?t|no can do)\b/;
  const KEPT = /\b(done|did it|did that|didit|finished|complete[d]?|got it done|all done|handled|nailed it|crushed it|yep|yup|yeah|yes|yeh|ya|kept|on it done)\b/;

  if (RESCHEDULE.test(t)) return 'reschedule';
  if (KEPT.test(t)) return 'kept';
  // bare affirmations / negations as a last pass
  if (/^(y|k|ok|okay|done|yay)$/.test(t)) return 'kept';
  if (/^(n|no|not)$/.test(t)) return 'reschedule';
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

      return jsonResponse({ commitments: (rows && rows.results) || [] }, 200, 'short');
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
        const parsed = validateCommitmentInput({
          title: commitment.title,
          start_at: body.new_start_at,
          checkin_at: body.new_checkin_at,
          channel: commitment.channel,
          persona,
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
          WHERE commitment_id = ? AND user_id = ? AND status IN ('pending', 'deferred')`
      ).bind(id, auth.userId).run();

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
          WHERE commitment_id = ? AND user_id = ? AND status IN ('pending', 'sent', 'deferred')
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
          WHERE commitment_id = ? AND user_id = ? AND status IN ('pending', 'deferred')`
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

  // ── GET my kept-word streak ──
  router.get('/api/accountability/streak', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;
      const streak = await loadStreak(env, auth.userId);
      return jsonResponse({
        streak,
        message: streakSummaryCopy({ streak }),
      }, 200, 'short');
    } catch (err) {
      console.error('[accountability] streak error:', err && err.message);
      return jsonResponse({ error: 'Could not load your streak.' }, 500);
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

      return jsonResponse({
        kept: (rows && rows.results) || [],
        total_kept: total,
        message: keptLogCopy({ total }),
      }, 200, 'short');
    } catch (err) {
      console.error('[accountability] kept-log error:', err && err.message);
      return jsonResponse({ error: 'Could not load your kept words.' }, 500);
    }
  });
}
