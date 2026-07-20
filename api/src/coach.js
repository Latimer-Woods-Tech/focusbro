// ════════════════════════════════════════════════════════════
// FOCUSBRO — COACH ROSTER  (Contender track, issue #10, Phase A)
// ════════════════════════════════════════════════════════════
// The skeleton coach dashboard: an operator-facing, READ-ONLY view of the
// clients a coach supports and each client's kept-word momentum.
//
// A coach is any user who supports others. The full coach white-label —
// cadence/voice/script config, wholesale billing, the operator hierarchy —
// is Phase C, gated on the @latimer-woods-tech/operator UNBLOCK. This module
// deliberately stops at the skeleton: a consent-respecting roster link and a
// read-only view. It does NOT build a parallel billing or hierarchy system.
//
// CONSENT IS LOAD-BEARING: a coach cannot see a client's commitments or streak
// until the client accepts the invitation. Inviting only creates a `pending`
// link; the coach sees nothing about a person who has not opted in. This is the
// honest skeleton of the real onboarding Phase C will flesh out.
//
// THE DESIGN LAW (non-negotiable): never shame — and it applies to the coach's
// view too. A dashboard is exactly where a client's misses could get tallied
// into a "who's falling behind" list; that would be the guilt engine wearing a
// coach's hat. So this view shows KEPT-WORD momentum only. There is no miss
// count anywhere in the roster, by design — the same law that governs what the
// bro says to a client governs what a coach sees about them. Enforced by
// coach.test.js (banned-word + no-"AI" + no-clinical-claim assertions).
// ════════════════════════════════════════════════════════════

import { describeCadence, formatWhenLocal, STREAK_MILESTONES } from './accountability.js';
import { RETURN_NUDGE_QUIET_DAYS } from './checkins-cron.js';
import { buildWeeklyReport } from './report.js';
import { EVENTS } from './events.js';
import {
  MOMENTUM_WINDOW_DAYS,
  localDayInZone,
  bucketKeptByDay,
  sparklineBars,
  describePeakDay,
  buildMomentum as buildMomentumBlock,
} from './momentum.js';

// Re-exported so existing importers (and coach.test.js) keep their import path
// while the implementations live in the shared ./momentum.js engine.
export { MOMENTUM_WINDOW_DAYS, localDayInZone, bucketKeptByDay, sparklineBars };

/** Roster link states. A coach sees client data only in the `active` state. */
export const COACH_LINK_STATES = ['pending', 'active', 'declined', 'removed'];

const MAX_LABEL = 120;

/** Normalize/validate a coach's private label for a client (optional). */
export function normalizeClientLabel(label) {
  if (typeof label !== 'string') return '';
  return label.trim().slice(0, MAX_LABEL);
}

/** Basic email shape check — good enough to reject obvious junk before a lookup. */
export function looksLikeEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// ── ROSTER COPY ENGINE ───────────────────────────────────────
// Every string a coach reads about a client is warm and momentum-framed.
// We celebrate kept words; we never surface a failure tally. On a fresh or
// reset streak it reads as an open page, never "this one is slipping."

/** Header subtitle for the dashboard — sets the tone for the whole view. */
export function dashboardIntroCopy() {
  return 'The people you show up for, and the words they’re keeping. Cheer the wins; the rest just means the next one’s ahead.';
}

/** Warm one-line status for a single client, framed by kept-word momentum. */
export function clientStatusLine({ streak } = {}) {
  const cur = Number(streak?.current_streak) || 0;
  const best = Number(streak?.longest_streak) || 0;
  if (cur === 0) {
    return best > 0
      ? 'Open page right now — a strong run already logged and the next one ahead.'
      : 'Just getting started — a clean page to build on.';
  }
  const bestPart = best > cur ? ` (their best is ${best})` : '';
  return `${cur} kept word${cur === 1 ? '' : 's'} in a row${bestPart} — real momentum.`;
}

/** Shown when a coach's roster has no active clients yet. */
export function rosterEmptyCopy() {
  return 'No one on your roster yet. Invite someone you support by their email — they’ll get to accept before you see anything.';
}

/** Status text for an invitation the client hasn’t answered yet. */
export function invitePendingCopy() {
  return 'Invited — waiting for them to accept. No rush, and nothing to see until they do.';
}

/** Confirmation copy after a coach sends an invitation. */
export function inviteSentCopy({ email } = {}) {
  const who = email ? ` to ${email}` : '';
  return `Invitation sent${who}. They choose whether to opt in — you’ll see their kept-word momentum once they accept.`;
}

/**
 * Header copy for the client-rhythm panel. A cadence view shows WHEN a person
 * asked the bro to show up — the shape of their commitment, never a scorecard.
 */
export function rhythmIntroCopy() {
  return 'The rhythm they set for themselves — the times they’ve asked the bro to show up.';
}

/** Shown in the rhythm panel when an active client has no live commitments. */
export function rhythmEmptyCopy() {
  return 'Nothing on the books right now — a clear page, ready for their next word.';
}

/**
 * Warm "next time the bro shows up" line for a single active commitment. The
 * whole product thesis is a companion who shows up ON A SCHEDULE, so a coach
 * should see the CONCRETE next occurrence — "Next up tomorrow at 8:40 AM" — not
 * just the abstract cadence. DESIGN LAW: this reads only an OUTSTANDING (future)
 * check-in — a moment the bro is about to keep — so it is momentum by
 * construction and can never surface a miss. When nothing is scheduled yet (a
 * one-time word already answered, or a rhythm the cron is about to re-arm), it
 * stays warm and forward-looking, never "overdue".
 * @param {object} p { iso, timezone, nowISO }
 * @returns {string}
 */
export function nextCheckinCopy({ iso, timezone, nowISO } = {}) {
  if (iso && !Number.isNaN(Date.parse(iso))) {
    return `Next up ${formatWhenLocal(iso, timezone, nowISO)}`;
  }
  return 'Next check-in lining up.';
}

/**
 * The warm coach-voice "door held open" line for a client whose soonest
 * outstanding check-in time has already passed but is still open. Third-person
 * twin of me.js `listNextCheckinWaitingCopy` — the whole point is that time
 * passing is not failure here, so this is NEVER "late"/"overdue"/a miss.
 * @returns {string}
 */
export function rosterNextCheckinWaitingCopy() {
  return 'Still here whenever they’re ready';
}

/**
 * At-a-glance next-check-in line for a client on the coach ROSTER (not the
 * drill-in rhythm panel). The whole product thesis is a companion who shows up
 * ON A SCHEDULE, so a coach should see the soonest concrete moment the bro will
 * next keep a word for THIS client across their whole roster — not only by
 * opening "View rhythm" one client at a time (R-224). This is the coach-side
 * twin of the person's own at-a-glance next check-in (R-233).
 *
 * DESIGN LAW, by construction: the caller only ever passes an OUTSTANDING
 * check-in (pending/sent/deferred) that belongs to an ACTIVE commitment — a
 * future moment about to be KEPT, never a miss. When that moment has already
 * passed but is still open, this reads as a warm "still here whenever they're
 * ready" (the door held open), NEVER "late"/"overdue". Nothing queued → '' so
 * the at-a-glance card stays clean (the drill-in rhythm view carries per-word
 * detail).
 * @param {object} p { iso, timezone, nowISO }
 * @returns {string} rendered line, or '' when there is nothing outstanding
 */
export function rosterNextCheckinLine({ iso, timezone, nowISO } = {}) {
  if (!iso || Number.isNaN(Date.parse(iso))) return '';
  const now = nowISO && !Number.isNaN(Date.parse(nowISO)) ? Date.parse(nowISO) : Date.now();
  if (Date.parse(iso) <= now) return rosterNextCheckinWaitingCopy();
  return nextCheckinCopy({ iso, timezone, nowISO });
}

// ── RE-ENGAGEMENT CUE (the operator-side twin of the return nudge) ─
// The product already reaches out to a person who has gone quiet across the
// whole app on its own (the return nudge — Wingspan W4 / #40). A human coach
// does the SAME thing by hand between sessions; this gives them the cue to add
// their personal touch at the same moment the automated nudge fires. It rides
// the exact dormancy threshold as the return nudge (RETURN_NUDGE_QUIET_DAYS) so
// the two signals can never drift apart.
//
// DESIGN LAW, by construction: quiet is NEVER a delinquency flag here. The cue
// exists only to open a warm connection — "a good moment to reach out" — and
// names nothing about what wasn't done. A brand-new client with no activity yet
// is a clean page, not a quiet one, and is never flagged (the roster query only
// surfaces clients who WERE here and have since gone quiet).

/** Days of app-wide silence before a coach sees the reach-out cue — the same
 * dormancy line the automated return nudge uses, so they move together. */
export const COACH_REACH_OUT_QUIET_DAYS = RETURN_NUDGE_QUIET_DAYS;

/**
 * The warm coach-voice cue for an active client who has gone quiet across the
 * app for at least COACH_REACH_OUT_QUIET_DAYS. Returns '' below that line (and
 * for missing/garbage input) so a card only ever carries the cue when there is
 * genuinely a quiet stretch to answer — never for a client who is simply new or
 * currently active. Purely an invitation to connect; it says nothing about a
 * gap, a miss, or a lapse, for the coach or the client.
 * @param {object} p { quietDays }
 * @returns {string} the cue, or '' when there is nothing to surface
 */
export function reachOutCueCopy({ quietDays } = {}) {
  const n = Number(quietDays);
  if (!Number.isFinite(n) || n < COACH_REACH_OUT_QUIET_DAYS) return '';
  return 'A quiet stretch lately — a warm moment to reach out and let them know you’re in their corner.';
}

// ── "BACK AND MOVING" CELEBRATION (the positive twin of the reach-out cue) ─
// The reach-out cue (above) is the *worried* half of the operator-side return
// loop: it marks who has gone quiet so a coach can add their personal touch at
// the moment the automated nudge fires. This is its *joyful* half — the coach
// mirror of the person-side nudged-back welcome (`/me/`, R-249): when a client
// the bro reached out to during a quiet stretch has come back and is moving
// again, the roster celebrates it, so the coach reconnects at the good moment,
// not only the worried one.
//
// DESIGN LAW, by construction: this ONLY ever fires on a return, and the copy
// celebrates the return itself — it names no gap, no absence, nothing owed. The
// two cues are exact complements on ONE dormancy line (COACH_REACH_OUT_QUIET_DAYS):
// reach-out marks the currently-quiet; "back" marks the once-quiet-now-active who
// were nudged in between — a client can never carry both at once.

/**
 * The warm coach-voice cue for an active client who was reached out to during a
 * quiet stretch and has since come back and been active again. Returns '' unless
 * the caller passes an explicit `back: true` (the roster query owns the decision;
 * any falsy/garbage input is silent) so a card only ever carries this on a
 * genuine return. Purely a celebration and an invitation to reconnect; it names
 * nothing about the gap that preceded the return.
 * @param {object} p { back }
 * @returns {string} the cue, or '' when there is nothing to celebrate
 */
export function backAfterReachCopy({ back } = {}) {
  if (back !== true) return '';
  return 'Back and moving again — a great moment to tell them you noticed, and that you’re glad they’re here.';
}

// ── KEPT-WORD MILESTONE CUE (the coach twin of the person-side badge) ──────
// The person's own /me/ streak card shows a discrete "you just reached it"
// badge the moment a kept-word run crosses a meaningful count (3/7/14/30/100 —
// R-255, `milestoneCopy`). This is its operator mirror: when a client's current
// kept-word run is EXACTLY at one of those counts, the roster surfaces a warm
// coach-voice cue so the coach can send a word at the moment it lands. It reads
// the streak already loaded for the card — no extra query, no schema change.
//
// DESIGN LAW, by construction: this reads `current_streak` (kept words ONLY),
// fires exactly at a milestone and returns '' everywhere else, and names only
// the count reached and the invitation to celebrate — never a gap, a distance
// to the next milestone, a "not there yet", or anything owed. Between milestones
// the card carries nothing, so it is never a "this one is slipping" prompt. It
// is independent of the reach-out / back-and-moving cues — a milestone is its
// own good news and can sit beside any of them.

/**
 * The warm coach-voice cue for an active client whose CURRENT kept-word run has
 * just crossed a milestone ({@link STREAK_MILESTONES}). Returns '' unless the
 * current streak is exactly a milestone value, so a card only ever carries it at
 * the moment the count lands. Purely a celebration and an invitation to send a
 * word; it names the count reached and nothing about a gap or a distance to go.
 * @param {object} p { streak } — the client streak row ({ current_streak })
 * @returns {string} the cue, or '' when the run is not exactly at a milestone
 */
export function clientMilestoneCopy({ streak } = {}) {
  const cur = Number(streak?.current_streak) || 0;
  if (!STREAK_MILESTONES.includes(cur)) return '';
  return `🎯 ${cur} kept words in a row — a milestone just landed. A great moment to send a word.`;
}

// ── COACH-VISIBLE WEEKLY SNAPSHOT (the coach-proof report, operator side) ────
// A person can generate a /me/report and copy/paste or mail it to their coach.
// This surfaces the SAME seven-day kept-word summary natively on the coach's
// client view, so a report becomes coach-visible without the person having to
// hand it over by hand — the concrete surface the Phase 3 coach-GTM gate ("≥5
// real coach-visible reports", docs/IMPROVEMENT_PLAN.md L5) needs. The numbers
// come from the SAME pure buildWeeklyReport the person's own report uses, so a
// coach's "this week" count can never drift from what the client sees; only the
// VOICE differs — these two helpers re-frame the report's second-person headline
// and mutual-accountability line into the coach's third person.
//
// DESIGN LAW, by construction: buildWeeklyReport buckets KEPT instants only and
// counts the ally's own showings-up — never a client's misses. A quiet week is a
// clean page here exactly as it is on the person's report, never a shortfall.

/**
 * The coach-voice one-line summary of a client's last seven days of KEPT words —
 * the third-person twin of report.js `reportHeadlineCopy`. Kept-word framed: the
 * count is only ever the wins, and a quiet week reads as a clean page, never a
 * gap. Always non-empty so it can anchor the client-detail "this week" block.
 * @param {object} p { keptThisWeek }
 * @returns {string}
 */
export function clientWeeklyKeptCopy({ keptThisWeek = 0 } = {}) {
  const n = Number(keptThisWeek) || 0;
  if (n <= 0) {
    return 'A quiet week so far — a clean page. Their next kept word lands right here.';
  }
  return `This week: ${n} kept word${n === 1 ? '' : 's'}.`;
}

/**
 * The coach-voice mutual-accountability line — the third-person twin of report.js
 * `showedUpCopy`: how many times FocusBro itself showed up for this client over
 * the last seven days (the check-ins it delivered when it said it would). Counts
 * the ALLY keeping its word, never the client's outcomes, so it can only read as
 * support. Returns '' when the bro has not had a moment to show up yet this week —
 * a quiet page, nothing to celebrate and nothing to apologise for.
 * @param {object} p { showedUp }
 * @returns {string}
 */
export function clientWeeklyShowedUpCopy({ showedUp = 0 } = {}) {
  const n = Number(showedUp) || 0;
  if (n <= 0) return '';
  return `FocusBro showed up for them ${n} time${n === 1 ? '' : 's'} this week — the bro kept its word too.`;
}

// ── BETWEEN-SESSION NOTE (the coach's copy/share artifact) ───────────────────
// The weekly snapshot above lets a coach SEE where a client's week stands. This
// turns that same seven-day picture into a ready-to-send, copy-pasteable note a
// coach can drop into a text or email BETWEEN sessions — the leverage artifact
// the whole coach-operator channel is about (issue #10: "the coach gets the
// dashboard and keeps the client"). It reads in the client's own second person,
// so the coach can send it as-is or personalise it first.
//
// DESIGN LAW, by construction: it is built from the SAME kept-word-framed
// buildWeeklyReport as everything else on this surface. It celebrates kept words
// and the ally's showings-up; it never tallies, names, or hints at a miss. A
// quiet week reads as a clean page — an open door, never "you fell behind." No
// "AI", no clinical/treatment claim.

/**
 * The warm, second-person kept-word line at the heart of the between-session
 * note. Kept-word framed: a quiet week is a clean page (an open door), never a
 * shortfall, and the count is only ever the wins. Always a non-empty string.
 * The first character is capitalised so the line stands on its own.
 * @param {object} p { keptThisWeek }
 * @returns {string}
 */
export function clientNoteKeptCopy({ keptThisWeek = 0 } = {}) {
  const n = Number(keptThisWeek) || 0;
  const s = n <= 0
    ? 'a quiet week so far — and that’s a clean page, not a mark against you. Whenever you’re ready for your next word, I’m right here for it.'
    : `you kept ${n} word${n === 1 ? '' : 's'} this week — that’s you showing up for yourself, and it’s really good to see.`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The note's optional longer-arc line: a kept-word momentum picture over the
 * recent window (the same MOMENTUM_WINDOW_DAYS the coach already sees charted on
 * screen), voiced for the client in second person and carried into the sendable
 * note so the momentum rides along with the copy, not just the weekly count.
 *
 * DESIGN LAW, by construction: momentum.js buckets KEPT instants ONLY, so this
 * line can only ever celebrate wins. A window with no wins returns '' — the note
 * simply carries nothing rather than a "0 over N days" tally, exactly as a quiet
 * week reads as a clean page above. The peak callout names a strongest day, never
 * a slow one. No "AI", no clinical claim.
 *
 * @param {object} momentum  a buildMomentum() result { total, days, sparkline, ... }
 * @param {object} [opts]    { peakDayName } a warm day name from describePeakDay()
 * @returns {string} the momentum line, or '' when there is nothing to celebrate
 */
export function clientNoteMomentumCopy(momentum, { peakDayName = '' } = {}) {
  const m = (momentum && typeof momentum === 'object') ? momentum : {};
  const total = Number(m.total) || 0;
  if (total <= 0) return ''; // a quiet window adds nothing — never a "0 kept" tally
  const days = Number(m.days) || MOMENTUM_WINDOW_DAYS;
  const spark = (typeof m.sparkline === 'string' && m.sparkline) ? m.sparkline : '';
  const peak = (typeof peakDayName === 'string' && peakDayName.trim()) ? peakDayName.trim() : '';
  const peakClause = peak ? ` — your strongest day was ${peak}` : '';
  const shape = spark ? ` Here’s the shape of it: ${spark}` : '';
  return `Zooming out to the last ${days} days, you’ve kept ${total} word${total === 1 ? '' : 's'}${peakClause}.${shape}`;
}

/**
 * Build the plain-text between-session note a coach can copy and send a client.
 * Second person, no markup — ready to paste into a text or email. Assembled
 * purely from a buildWeeklyReport() result (report.js), so its counts can never
 * drift from what the client sees on their own /me/report or the coach sees in
 * the "this week" snapshot.
 *
 * DESIGN LAW: every line here is a kept word, a milestone reached, the longer
 * arc of kept-word momentum, or the next moment the bro will show up — never a
 * miss. The milestone line rides straight from the report (present only AT a
 * milestone), the momentum line only ever celebrates wins (omitted on a quiet
 * window), and the upcoming-word line reads only a future, about-to-be-kept
 * check-in.
 *
 * @param {object} weekly  a buildWeeklyReport() result
 * @param {object} [opts]  { label, momentum, peakDayName } — label is the client's
 *   roster label (used as a first name); momentum is an optional buildMomentum()
 *   result whose longer-arc kept-word line rides along; peakDayName is a warm day
 *   name from describePeakDay() for that momentum window.
 * @returns {string}
 */
export function buildClientNote(weekly, { label = '', momentum = null, peakDayName = '' } = {}) {
  const w = (weekly && typeof weekly === 'object') ? weekly : {};
  const name = normalizeClientLabel(label);
  const kept = Number(w.kept_this_week) || 0;

  const lines = [];
  lines.push(`Hi${name ? ' ' + name : ''} — a quick note between our sessions.`);
  lines.push('');
  lines.push(clientNoteKeptCopy({ keptThisWeek: kept }));
  // The milestone line is already anti-shame by construction (present only when
  // the current kept-word run is exactly at a milestone; '' otherwise), so a
  // between-milestone week carries nothing rather than a "not there yet" line.
  if (w.milestone) lines.push(w.milestone);
  // The longer arc: a kept-word momentum picture over the recent window, the
  // sendable twin of the sparkline the coach sees charted on screen. Present
  // only when there are wins to show (kept-instants only) — a quiet window adds
  // nothing rather than a tally, mirroring the clean-page kept-word line above.
  const momentumLine = clientNoteMomentumCopy(momentum, { peakDayName });
  if (momentumLine) lines.push(momentumLine);
  // The soonest still-open check-in across the client's active rhythms — the
  // concrete next moment the bro shows up. The endpoint feeds this from
  // OUTSTANDING check-ins only (pending/sent/deferred), so it is momentum by
  // construction: a moment about to be kept, never a resolved miss. It may sit
  // slightly in the past but still open, and the copy stays forward-looking
  // ("I’ll be there for it") — never "overdue".
  const rhythms = Array.isArray(w.rhythms) ? w.rhythms : [];
  const upcoming = rhythms
    .filter((r) => r && r.next_checkin && !Number.isNaN(Date.parse(r.next_checkin)))
    .sort((a, b) => Date.parse(a.next_checkin) - Date.parse(b.next_checkin))[0];
  if (upcoming && upcoming.title) {
    const cadence = upcoming.cadence ? ` — ${upcoming.cadence}` : '';
    lines.push(`You’ve got "${upcoming.title}" on the books${cadence}. I’ll be there for it.`);
  }
  lines.push('');
  lines.push('I’m in your corner — talk soon.');
  lines.push('');
  lines.push('— sent with FocusBro (focusbro.net)');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

// ── WEEKLY HOMECOMING DIGEST (the batched, between-session twin of the cues) ─
// The reach-out cue and "back and moving" celebration above are LIVE, per-client
// signals that live on the roster card. A coach preparing for a between-session
// review also wants the batched roll-up: over the past week, WHICH of the people
// they support went quiet and have come back. This is that digest — one warm,
// glanceable line the coach can carry into the review.
//
// DESIGN LAW, by construction: the digest counts ONLY homecomings — a person who
// was quiet, was reached out to (the automated return nudge), and came home (a
// `return_welcome_shown` marker, the SAME signal the person-side welcome records
// on a genuine return, R-249/R-253). It never counts, names, or hints at who did
// NOT come back. A quiet week is just a quiet week — a clean page, never a
// shortfall. It rides the trailing-week window of the weekly report.

/** The digest's trailing window — the past week, matching the weekly report. */
export const HOMECOMING_DIGEST_WINDOW_DAYS = 7;

/** A display name for a returning client — their label, or a warm fallback that
 * never exposes an email and never reads as anonymous. */
function homecomingClientName(label) {
  return normalizeClientLabel(label) || 'Someone you support';
}

/** Join client display names into a warm human list, capped so the line stays
 * glanceable ("A", "A and B", "A, B, and C", "A, B, and 4 more"). */
function joinClientNames(names) {
  const CAP = 6;
  const shown = names.slice(0, CAP);
  const extra = names.length - shown.length;
  if (extra > 0) return `${shown.join(', ')}, and ${extra} more`;
  if (shown.length === 1) return shown[0];
  if (shown.length === 2) return `${shown[0]} and ${shown[1]}`;
  return `${shown.slice(0, -1).join(', ')}, and ${shown[shown.length - 1]}`;
}

/** Header copy for the digest panel — names the panel as a celebration of returns. */
export function homecomingDigestIntroCopy() {
  return 'Homecomings this week — the people you support who went quiet and have come back.';
}

/**
 * Warm one-line summary of the week's homecomings. Celebration-only: it names
 * how many people came back (and who), and on a week with none reads as a clean,
 * calm page — never a count of who stayed away.
 * @param {object} p { count, names }
 * @returns {string}
 */
export function homecomingDigestSummaryCopy({ count, names = [] } = {}) {
  const n = Number(count) || 0;
  if (n <= 0) {
    return 'No homecomings to note this week — and that’s just a calm week, nothing more. When someone you support comes back, they’ll show up right here.';
  }
  const who = Array.isArray(names)
    ? names.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())
    : [];
  const list = who.length ? ` — ${joinClientNames(who)}` : '';
  const people = n === 1 ? 'person' : 'people';
  return `${n} ${people} you support came back this week${list}. A great moment to tell them you noticed, and that you’re glad they’re here.`;
}

/**
 * Assemble the coach-facing weekly homecoming digest from raw marker rows. Each
 * row is one person's most-recent homecoming inside the window:
 * { client_id, label, at }. De-duplicates by person (a person is counted once,
 * however many times they returned this week), newest first. Celebration-only by
 * construction — the assembled shape holds only who came back, never who didn't.
 * @param {object} p { rows, days }
 * @returns {object} { window_days, count, clients, intro, summary }
 */
export function buildHomecomingDigest({ rows = [], days = HOMECOMING_DIGEST_WINDOW_DAYS } = {}) {
  const span = Number(days) || HOMECOMING_DIGEST_WINDOW_DAYS;
  const seen = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !r.client_id) continue;
    const at = typeof r.at === 'string' ? r.at : '';
    const prev = seen.get(r.client_id);
    if (!prev || (at && at > prev.at)) {
      seen.set(r.client_id, { client_id: r.client_id, label: homecomingClientName(r.label), at });
    }
  }
  const clients = Array.from(seen.values()).sort((a, b) => (b.at > a.at ? 1 : b.at < a.at ? -1 : 0));
  const count = clients.length;
  return {
    window_days: span,
    count,
    clients,
    intro: homecomingDigestIntroCopy(),
    summary: homecomingDigestSummaryCopy({ count, names: clients.map((c) => c.label) }),
  };
}

// ── KEPT-WORD MOMENTUM SPARKLINE ─────────────────────────────
// A coach should feel a client's momentum at a glance, not just read a single
// streak number. So the detail view carries a per-day count of KEPT words over
// a recent window — a little sparkline of "words kept per day".
//
// The math lives in ./momentum.js (shared with the person's own /me/ view). The
// coach voice — third-person, "their momentum" — is supplied here. DESIGN LAW,
// by construction: momentum.js reads KEPT instants ONLY, so nothing a coach
// sees here can read as "who's slipping."

/** Header copy for the momentum panel — a momentum chart, framed as such. */
export function momentumIntroCopy() {
  return 'Words kept per day — the shape of their momentum. Quiet days are just quiet; we only ever count the wins.';
}

/**
 * Warm one-line summary of the kept-word window. Momentum-only: it names the
 * total kept and the best single day, and on a quiet window it reads as a fresh
 * page — never a tally of what wasn't done.
 * @param {object} p { total, days, peak }
 * @returns {string}
 */
export function momentumSummaryCopy({ total, days = MOMENTUM_WINDOW_DAYS, peak } = {}) {
  const kept = Number(total) || 0;
  const span = Number(days) || MOMENTUM_WINDOW_DAYS;
  if (kept === 0) {
    return `A clean page over the last ${span} days — every window is a fresh start, and the next kept word lands right here.`;
  }
  const best = Number(peak && peak.count) || 0;
  const bestPart = best > 1 ? ` Their best day: ${best} kept.` : '';
  return `${kept} word${kept === 1 ? '' : 's'} kept over the last ${span} days.${bestPart}`;
}

/**
 * Assemble the coach-facing momentum block from raw kept instants. Thin wrapper
 * over the shared engine that injects the coach (third-person) voice.
 * @param {object} p { timestamps, days, nowISO, timezone }
 * @returns {object} { intro, days, timezone, buckets, total, peak, sparkline, summary }
 */
export function buildMomentum({ timestamps, days = MOMENTUM_WINDOW_DAYS, nowISO, timezone } = {}) {
  return buildMomentumBlock({
    timestamps, days, nowISO, timezone,
    intro: momentumIntroCopy(),
    summary: momentumSummaryCopy,
  });
}

// ── ROUTES ───────────────────────────────────────────────────
// Registered from index.js so the module-private helpers (getAuthToken,
// verifyToken, jsonResponse, generateUUID) stay in one scope.

/**
 * Register the coach roster API on an itty-router instance.
 * @param {object} router itty-router instance
 * @param {object} ctx  { getAuthToken, verifyToken, jsonResponse, generateUUID }
 */
export function registerCoachRoutes(router, ctx) {
  const { getAuthToken, verifyToken, jsonResponse, generateUUID } = ctx;

  async function requireUser(request, env) {
    const token = getAuthToken(request);
    if (!token) return { error: jsonResponse({ error: 'Unauthorized' }, 401) };
    const payload = await verifyToken(token, env.JWT_SECRET);
    if (!payload) return { error: jsonResponse({ error: 'Invalid token' }, 401) };
    return { userId: payload.sub };
  }

  async function loadStreakFor(env, userId) {
    const row = await env.DB.prepare(
      `SELECT current_streak, longest_streak, total_kept, last_kept_date
         FROM accountability_streaks WHERE user_id = ?`
    ).bind(userId).first();
    return row || { current_streak: 0, longest_streak: 0, total_kept: 0, last_kept_date: null };
  }

  // ── COACH: invite an existing user (by email) onto my roster ──
  // Creates a `pending` link only. The coach sees NOTHING about the person
  // until they accept — consent is the gate, not a formality.
  router.post('/api/coach/clients', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;

      let body;
      try { body = await request.json(); } catch { body = null; }
      const email = body && typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (!looksLikeEmail(email)) {
        return jsonResponse({ error: 'Enter the email of the person you support.' }, 400);
      }
      const label = normalizeClientLabel(body && body.label);

      const client = await env.DB.prepare(
        'SELECT id FROM users WHERE email = ? AND is_active = 1'
      ).bind(email).first();
      // Do not reveal whether the email maps to an account (enumeration guard);
      // the invitation simply stays unclaimable until that person signs up.
      if (!client) {
        return jsonResponse({ message: inviteSentCopy({ email }), status: 'pending' }, 202);
      }
      if (client.id === auth.userId) {
        return jsonResponse({ error: 'You’re already on your own side — invite someone you support.' }, 400);
      }

      // Idempotent: reuse an existing link unless it was removed/declined.
      const existing = await env.DB.prepare(
        'SELECT id, status FROM coach_clients WHERE coach_user_id = ? AND client_user_id = ?'
      ).bind(auth.userId, client.id).first();

      if (existing && (existing.status === 'pending' || existing.status === 'active')) {
        return jsonResponse({ message: inviteSentCopy({ email }), status: existing.status, link_id: existing.id }, 200);
      }

      if (existing) {
        await env.DB.prepare(
          `UPDATE coach_clients
              SET status = 'pending', client_label = ?, invited_at = datetime('now'),
                  responded_at = NULL, updated_at = datetime('now')
            WHERE id = ?`
        ).bind(label, existing.id).run();
        return jsonResponse({ message: inviteSentCopy({ email }), status: 'pending', link_id: existing.id }, 200);
      }

      const id = generateUUID();
      await env.DB.prepare(
        `INSERT INTO coach_clients
           (id, coach_user_id, client_user_id, client_label, status, invited_at)
         VALUES (?, ?, ?, ?, 'pending', datetime('now'))`
      ).bind(id, auth.userId, client.id, label).run();

      return jsonResponse({ message: inviteSentCopy({ email }), status: 'pending', link_id: id }, 201);
    } catch (err) {
      console.error('[coach] invite error:', err && err.message);
      return jsonResponse({ error: 'Could not send that invitation. Try again in a moment.' }, 500);
    }
  });

  // ── COACH: my roster (pending + active) with kept-word momentum ──
  // Active clients carry a streak summary + active-commitment count. Pending
  // links carry nothing but their state — no data before consent.
  router.get('/api/coach/clients', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;

      const links = await env.DB.prepare(
        `SELECT cc.id AS link_id, cc.client_user_id, cc.client_label, cc.status,
                cc.invited_at, cc.responded_at, u.email AS client_email
           FROM coach_clients cc
           JOIN users u ON u.id = cc.client_user_id
          WHERE cc.coach_user_id = ? AND cc.status IN ('pending','active')
          ORDER BY (cc.status = 'active') DESC, cc.invited_at DESC
          LIMIT 200`
      ).bind(auth.userId).all();

      const roster = [];
      for (const link of (links && links.results) || []) {
        const entry = {
          link_id: link.link_id,
          client_id: link.client_user_id,
          label: link.client_label || '',
          email: link.client_email,
          status: link.status,
          invited_at: link.invited_at,
        };
        if (link.status === 'active') {
          const streak = await loadStreakFor(env, link.client_user_id);
          const active = await env.DB.prepare(
            `SELECT COUNT(*) AS n FROM commitments WHERE user_id = ? AND status = 'active'`
          ).bind(link.client_user_id).first();
          entry.streak = {
            current_streak: Number(streak.current_streak) || 0,
            longest_streak: Number(streak.longest_streak) || 0,
            total_kept: Number(streak.total_kept) || 0,
          };
          entry.active_commitments = Number(active && active.n) || 0;
          entry.status_line = clientStatusLine({ streak });
          // Coach twin of the person-side kept-word milestone badge (R-255): a
          // warm cue exactly when this client's current run lands on a milestone
          // count. Reads the streak already loaded above — no extra query. ''
          // between milestones, so it is never a nag.
          entry.milestone_line = clientMilestoneCopy({ streak });
        } else {
          entry.status_line = invitePendingCopy();
        }
        roster.push(entry);
      }

      // The weekly homecoming digest starts empty (also the correct answer for a
      // coach with no active clients — no one to have come home) and is filled in
      // below once we know the active-client set.
      let homecomingDigest = buildHomecomingDigest({ rows: [] });

      // At-a-glance next check-in per active client — the soonest concrete
      // moment the bro next shows up for them — so a coach sees it across the
      // whole roster, not only by opening "View rhythm" per client (R-224). ONE
      // grouped query over all active clients (no N+1 across the roster): the
      // JOIN pins each outstanding check-in to an ACTIVE commitment, so a stray
      // row on a released word never leaks in, and MIN() picks the soonest. The
      // bare `timezone` follows that MIN row (SQLite min/max bare-column rule),
      // so the moment is formatted in its OWN commitment's zone. Momentum-only
      // by construction: pending/sent/deferred is a future moment about to be
      // KEPT — never a miss.
      const activeIds = roster.filter((e) => e.status === 'active').map((e) => e.client_id);
      if (activeIds.length) {
        const placeholders = activeIds.map(() => '?').join(', ');
        const nextRows = await env.DB.prepare(
          `SELECT c.user_id AS client_id, MIN(cc.scheduled_for) AS next_for, c.timezone AS timezone
             FROM commitment_checkins cc
             JOIN commitments c ON c.id = cc.commitment_id
            WHERE c.user_id IN (${placeholders})
              AND c.status = 'active'
              AND cc.status IN ('pending', 'sent', 'deferred')
            GROUP BY c.user_id`
        ).bind(...activeIds).all();
        const nextByClient = {};
        for (const r of (nextRows && nextRows.results) || []) {
          nextByClient[r.client_id] = { iso: r.next_for, timezone: r.timezone || 'UTC' };
        }
        const nowISO = new Date().toISOString();
        for (const entry of roster) {
          if (entry.status !== 'active') continue;
          const n = nextByClient[entry.client_id];
          entry.next_checkin = (n && n.iso) || null;
          entry.next_checkin_line = rosterNextCheckinLine({
            iso: n && n.iso, timezone: n && n.timezone, nowISO,
          });
        }

        // Re-engagement cue: the operator-side twin of the return nudge. Which
        // active clients have gone quiet across the whole app (their most recent
        // first-party event is older than the SAME dormancy line the automated
        // return nudge uses) — so a coach knows the exact moment a personal note
        // would land. ONE grouped query (no N+1). We compare on the calendar-day
        // prefix (`substr(created_at,1,10)`), the format-agnostic pattern
        // events.js already uses for cohorts, so mixed ISO/space timestamps sort
        // correctly. A client with NO events never appears here — a clean page,
        // never flagged. DESIGN LAW: quiet is only ever an invitation to
        // connect; the query surfaces WHO to reach, the copy never names a miss.
        const cutoffMs = Date.parse(nowISO) - COACH_REACH_OUT_QUIET_DAYS * 24 * 60 * 60 * 1000;
        const cutoffDay = new Date(cutoffMs).toISOString().slice(0, 10);
        const quietRows = await env.DB.prepare(
          `SELECT user_id AS client_id
             FROM analytics_events
            WHERE user_id IN (${placeholders})
            GROUP BY user_id
           HAVING substr(MAX(created_at), 1, 10) <= ?`
        ).bind(...activeIds, cutoffDay).all();
        const quietSet = new Set();
        for (const r of (quietRows && quietRows.results) || []) quietSet.add(r.client_id);
        for (const entry of roster) {
          if (entry.status !== 'active') continue;
          // quietDays is day-granular and only needs to clear the threshold to
          // show the cue (the copy itself is non-numeric — never a countdown).
          entry.reach_out_line = quietSet.has(entry.client_id)
            ? reachOutCueCopy({ quietDays: COACH_REACH_OUT_QUIET_DAYS })
            : '';
        }

        // "Back and moving" celebration: the positive twin of the reach-out cue.
        // Which active clients were reached out to by the automated return nudge
        // during a quiet stretch (a return_nudge_sent whose day is on/before the
        // SAME cutoff) and have since come back and been active again (their most
        // recent event is AFTER that cutoff day). ONE grouped query, no N+1: a
        // per-client last-activity day joined to a per-client last-nudge day. The
        // nudge event carries the client id in its JSON payload (userId is NULL so
        // it never counts as the client's own activity — events.js), so we read it
        // via json_extract. Non-fatal by construction: a celebration must never be
        // able to take down the roster, so a failure here just yields no cue.
        // DESIGN LAW: this fires ONLY on a genuine return; the copy celebrates the
        // return and names nothing about the gap. Exact complement of reach-out on
        // the one cutoffDay line — currently-active here (`last_day > cutoffDay`)
        // vs currently-quiet there (`<= cutoffDay`) — so no client is ever both.
        let backSet = new Set();
        try {
          const backRows = await env.DB.prepare(
            `SELECT act.client_id AS client_id
               FROM (
                 SELECT user_id AS client_id, substr(MAX(created_at), 1, 10) AS last_day
                   FROM analytics_events
                  WHERE user_id IN (${placeholders})
                  GROUP BY user_id
               ) act
               JOIN (
                 SELECT json_extract(event_data, '$.user_id') AS uid,
                        substr(MAX(created_at), 1, 10) AS nudge_day
                   FROM analytics_events
                  WHERE event_type = 'return_nudge_sent'
                    AND json_extract(event_data, '$.user_id') IN (${placeholders})
                  GROUP BY uid
               ) nud ON nud.uid = act.client_id
              WHERE act.last_day > ?
                AND nud.nudge_day <= ?`
          ).bind(...activeIds, ...activeIds, cutoffDay, cutoffDay).all();
          for (const r of (backRows && backRows.results) || []) backSet.add(r.client_id);
        } catch (err) {
          console.warn('[coach] back-after-reach query failed:', err && err.message);
          backSet = new Set();
        }
        for (const entry of roster) {
          if (entry.status !== 'active') continue;
          // Exact complement in code, too: never celebrate a return for a client
          // the same pass marks as currently quiet (the SQL already guarantees it).
          entry.back_line = (!quietSet.has(entry.client_id) && backSet.has(entry.client_id))
            ? backAfterReachCopy({ back: true })
            : '';
        }

        // Weekly homecoming digest: the batched, between-session twin of the
        // live reach-out / back-and-moving cues above. Which active clients came
        // HOME this week — a `return_welcome_shown` marker (the SAME signal /me/
        // records on a genuine return, R-249/R-253; the row's user_id is the
        // person's own id) inside the trailing week. ONE grouped query, newest
        // marker per person (no N+1). We compare on the calendar-day prefix
        // (`substr(created_at,1,10)`), the format-agnostic pattern events.js uses,
        // so mixed ISO/space timestamps sort correctly. Non-fatal by construction:
        // a celebration must never be able to take down the roster, so any failure
        // just yields an empty digest. DESIGN LAW: the digest holds only who came
        // back this week, never who stayed away.
        try {
          const weekCutoffDay = new Date(
            Date.parse(nowISO) - HOMECOMING_DIGEST_WINDOW_DAYS * 24 * 60 * 60 * 1000
          ).toISOString().slice(0, 10);
          const homeRows = await env.DB.prepare(
            `SELECT user_id AS client_id, MAX(created_at) AS at
               FROM analytics_events
              WHERE event_type = 'return_welcome_shown'
                AND user_id IN (${placeholders})
                AND substr(created_at, 1, 10) >= ?
              GROUP BY user_id`
          ).bind(...activeIds, weekCutoffDay).all();
          const labelById = new Map(roster.map((e) => [e.client_id, e.label]));
          const homeInput = ((homeRows && homeRows.results) || []).map((r) => ({
            client_id: r.client_id,
            label: labelById.get(r.client_id) || '',
            at: r.at,
          }));
          homecomingDigest = buildHomecomingDigest({ rows: homeInput });
        } catch (err) {
          console.warn('[coach] homecoming digest query failed:', err && err.message);
          homecomingDigest = buildHomecomingDigest({ rows: [] });
        }
      }

      return jsonResponse({
        intro: dashboardIntroCopy(),
        roster,
        homecoming_digest: homecomingDigest,
        empty_message: roster.length ? null : rosterEmptyCopy(),
      }, 200, 'nocache');
    } catch (err) {
      console.error('[coach] roster error:', err && err.message);
      return jsonResponse({ error: 'Could not load your roster.' }, 500);
    }
  });

  // ── COACH: read-only detail for one ACTIVE client ──
  // Active commitments + kept-word streak only. No miss list, ever.
  router.get('/api/coach/clients/:clientId', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;
      const clientId = request.params.clientId;

      const link = await env.DB.prepare(
        `SELECT client_label, status FROM coach_clients
          WHERE coach_user_id = ? AND client_user_id = ?`
      ).bind(auth.userId, clientId).first();
      if (!link || link.status !== 'active') {
        // Same 404 whether the link is missing or not yet accepted — no leak.
        return jsonResponse({ error: 'Not found' }, 404);
      }

      const streak = await loadStreakFor(env, clientId);
      const commitments = await env.DB.prepare(
        `SELECT id, title, start_at, checkin_at, status, recurrence, local_time, timezone
           FROM commitments
          WHERE user_id = ? AND status = 'active'
          ORDER BY start_at ASC
          LIMIT 100`
      ).bind(clientId).all();

      // The soonest OUTSTANDING check-in per active commitment — the concrete
      // next moment the bro will show up. One grouped query (not N per row).
      // Momentum-only by construction: an outstanding check-in is a future
      // moment about to be KEPT (pending/sent/deferred), never a miss.
      const nextRows = await env.DB.prepare(
        `SELECT commitment_id, MIN(scheduled_for) AS next_for
           FROM commitment_checkins
          WHERE user_id = ? AND status IN ('pending', 'sent', 'deferred')
          GROUP BY commitment_id`
      ).bind(clientId).all();
      const nextByCommitment = {};
      for (const r of (nextRows && nextRows.results) || []) {
        nextByCommitment[r.commitment_id] = r.next_for;
      }
      const nowISO = new Date().toISOString();

      // ── Kept-word momentum sparkline (per-day KEPT count over a recent window) ──
      // A representative timezone for day boundaries: the client's most recently
      // touched commitment zone, falling back to UTC. Fetch a slightly wider raw
      // window than the axis (tz offsets can shift an instant across midnight),
      // then bucketKeptByDay trims to the last N local days. DESIGN LAW: reads
      // status='kept' ONLY — a quiet day is a short bar, never a surfaced miss.
      const tzRow = await env.DB.prepare(
        `SELECT timezone FROM commitments
          WHERE user_id = ? AND timezone IS NOT NULL AND timezone <> ''
          ORDER BY updated_at DESC LIMIT 1`
      ).bind(clientId).first();
      const momentumTz = (tzRow && tzRow.timezone) || 'UTC';
      const windowCutoffISO = new Date(Date.parse(nowISO) - (MOMENTUM_WINDOW_DAYS + 2) * 86400000).toISOString();
      const keptRows = await env.DB.prepare(
        `SELECT responded_at FROM commitment_checkins
          WHERE user_id = ? AND status = 'kept' AND responded_at IS NOT NULL AND responded_at >= ?
          ORDER BY responded_at ASC
          LIMIT 1000`
      ).bind(clientId, windowCutoffISO).all();
      const keptTimestamps = ((keptRows && keptRows.results) || []).map((r) => r.responded_at);
      const momentum = buildMomentum({
        timestamps: keptTimestamps, days: MOMENTUM_WINDOW_DAYS, nowISO, timezone: momentumTz,
      });

      // Surface each commitment's self-set cadence (the rhythm) AND the concrete
      // next check-in, read-only. This is when they asked to be met and when the
      // bro shows up next — never a miss list.
      const activeCommitments = ((commitments && commitments.results) || []).map((c) => {
        const nextCheckin = nextByCommitment[c.id] || null;
        return {
          title: c.title,
          start_at: c.start_at,
          checkin_at: c.checkin_at,
          status: c.status,
          recurrence: c.recurrence || 'none',
          local_time: c.local_time || null,
          timezone: c.timezone || 'UTC',
          cadence: describeCadence({ recurrence: c.recurrence, localTime: c.local_time }),
          next_checkin: nextCheckin,
          next_checkin_label: nextCheckinCopy({ iso: nextCheckin, timezone: c.timezone || 'UTC', nowISO }),
        };
      });

      // ── Coach-visible WEEKLY snapshot ──
      // The seven-day kept-word summary from the person's own /me/report, made
      // coach-visible natively here (Phase 3 GTM gate: "≥5 real coach-visible
      // reports"). The ally's showings-up: first-party 'checkin_delivered' events
      // for THIS client over the same wide raw window buildWeeklyReport trims to
      // the trailing 7 local days. A support signal, never a miss series.
      const deliveredRows = await env.DB.prepare(
        `SELECT created_at FROM analytics_events
          WHERE user_id = ? AND event_type = ? AND created_at >= ?
          ORDER BY created_at ASC
          LIMIT 1000`
      ).bind(clientId, EVENTS.CHECKIN_DELIVERED, windowCutoffISO).all();
      const deliveredTimestamps = ((deliveredRows && deliveredRows.results) || []).map((r) => r.created_at);

      // Built from the SAME pure buildWeeklyReport the person's report uses, so a
      // coach's "this week" count can never drift from what the client sees. We
      // consume only the kept-word counts + window and re-voice them for the coach
      // (clientWeekly*Copy); the person-voiced headline / next-step stay on
      // /me/report. DESIGN LAW: buildWeeklyReport is kept-word-framed by
      // construction, so this surface carries no miss, for the coach or the client.
      const weekly = buildWeeklyReport({
        streak,
        keptTimestamps,
        deliveredTimestamps,
        rhythms: activeCommitments.map((c) => ({
          title: c.title, recurrence: c.recurrence, local_time: c.local_time,
          timezone: c.timezone, next_checkin: c.next_checkin,
        })),
        timezone: momentumTz,
        nowISO,
      });
      const week = {
        kept_this_week: weekly.kept_this_week,
        showed_up_this_week: weekly.showed_up_this_week,
        since: weekly.window && weekly.window.since,
        until: weekly.window && weekly.window.until,
        summary_line: clientWeeklyKeptCopy({ keptThisWeek: weekly.kept_this_week }),
        showed_up_line: clientWeeklyShowedUpCopy({ showedUp: weekly.showed_up_this_week }),
      };

      // A ready-to-send between-session note built from the SAME weekly picture,
      // so the coach can copy it straight into a text or email (issue #10, the
      // coach-operator leverage artifact). Kept-word framed by construction. The
      // note now also carries the longer kept-word arc — the same momentum block
      // charted on screen — voiced for the client, so a copied/emailed note shows
      // the shape of their momentum, not just this week's count. describePeakDay
      // reuses the on-screen peak-day naming (reads '' on an all-quiet window).
      const peakDayName = describePeakDay(momentum.peak && momentum.peak.date, { nowISO, timezone: momentumTz });
      const noteText = buildClientNote(weekly, { label: link.client_label, momentum, peakDayName });

      return jsonResponse({
        client_id: clientId,
        label: link.client_label || '',
        streak: {
          current_streak: Number(streak.current_streak) || 0,
          longest_streak: Number(streak.longest_streak) || 0,
          total_kept: Number(streak.total_kept) || 0,
        },
        status_line: clientStatusLine({ streak }),
        week,
        note_text: noteText,
        momentum,
        rhythm_intro: rhythmIntroCopy(),
        rhythm_empty: activeCommitments.length ? null : rhythmEmptyCopy(),
        active_commitments: activeCommitments,
      }, 200, 'nocache');
    } catch (err) {
      console.error('[coach] client detail error:', err && err.message);
      return jsonResponse({ error: 'Could not load that client.' }, 500);
    }
  });

  // ── COACH: remove a link from my roster (soft) ──
  router.delete('/api/coach/clients/:clientId', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;
      const clientId = request.params.clientId;
      await env.DB.prepare(
        `UPDATE coach_clients SET status = 'removed', updated_at = datetime('now')
          WHERE coach_user_id = ? AND client_user_id = ?`
      ).bind(auth.userId, clientId).run();
      return jsonResponse({ ok: true }, 200);
    } catch (err) {
      console.error('[coach] remove error:', err && err.message);
      return jsonResponse({ error: 'Could not update your roster.' }, 500);
    }
  });

  // ── CLIENT side: invitations awaiting my answer ──
  router.get('/api/coach/invitations', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;
      const rows = await env.DB.prepare(
        `SELECT cc.id AS link_id, cc.invited_at, u.email AS coach_email
           FROM coach_clients cc
           JOIN users u ON u.id = cc.coach_user_id
          WHERE cc.client_user_id = ? AND cc.status = 'pending'
          ORDER BY cc.invited_at DESC
          LIMIT 100`
      ).bind(auth.userId).all();
      return jsonResponse({ invitations: (rows && rows.results) || [] }, 200, 'nocache');
    } catch (err) {
      console.error('[coach] invitations error:', err && err.message);
      return jsonResponse({ error: 'Could not load your invitations.' }, 500);
    }
  });

  // ── CLIENT side: accept / decline an invitation (consent gate) ──
  router.post('/api/coach/invitations/:id/accept', async (request, env) => {
    return respondToInvite(request, env, 'active');
  });
  router.post('/api/coach/invitations/:id/decline', async (request, env) => {
    return respondToInvite(request, env, 'declined');
  });

  async function respondToInvite(request, env, nextStatus) {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;
      const id = request.params.id;
      // Only the invited client may answer, and only a pending invite.
      const link = await env.DB.prepare(
        `SELECT id FROM coach_clients
          WHERE id = ? AND client_user_id = ? AND status = 'pending'`
      ).bind(id, auth.userId).first();
      if (!link) return jsonResponse({ error: 'Not found' }, 404);
      await env.DB.prepare(
        `UPDATE coach_clients SET status = ?, responded_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ?`
      ).bind(nextStatus, id).run();
      return jsonResponse({ ok: true, status: nextStatus }, 200);
    } catch (err) {
      console.error('[coach] respond error:', err && err.message);
      return jsonResponse({ error: 'Could not update that invitation.' }, 500);
    }
  }
}
