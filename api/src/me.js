// ════════════════════════════════════════════════════════════
// FOCUSBRO — CONSUMER ACCOUNTABILITY FRONT DOOR  (Contender #10, Phase A)
// ════════════════════════════════════════════════════════════
// The consumer-facing surface for the accountability core. Until now the API
// (give-your-word, kept-word streak, check-in resolution) had exactly one front
// door — the coach dashboard (/coach/). This is the door for the person doing
// the thing: sign in, give your word, watch the streak grow, and resolve a
// check-in as "did it / not yet / move it" — never a wall of red failures.
//
// Self-contained page (like /coach/): signs in against /auth/login (or creates
// an account via /auth/register), stores the token in localStorage
// (with one-time migration support for legacy 'focusbro_token'), and drives the existing /api/commitments +
// /api/accountability/streak API. Authed surface → noindex, not in the sitemap.
//
// THE ONE DESIGN LAW (non-negotiable): never shame. A to-do app that shows past
// "missed" items in red is precisely the guilt engine we refuse to build. So a
// missed word is NOT a failure tally here — it renders as an open door ("ready
// when you are") with a one-tap way to try again. There is no miss counter on
// this page, anywhere. The copy below is enforced by me.test.js (banned-word +
// no-"AI" + no-clinical-claim assertions), the same guardrail the rest of the
// accountability surface carries.
// ════════════════════════════════════════════════════════════

import { consentPanelCopy, consentLanguage } from './consent.js';
import {
  momentumSelfHeadingCopy,
  momentumSelfIntroCopy,
  momentumSelfSummaryCopy,
  powerHoursHeadingCopy,
  powerHoursIntroCopy,
  powerHoursCopy,
  bestDayHeadingCopy,
  bestDayIntroCopy,
  bestDayCopy,
  showedUpDaysHeadingCopy,
  showedUpDaysIntroCopy,
  showedUpDaysCopy,
  powerDayHeadingCopy,
  powerDayIntroCopy,
  powerDayCopy,
  typicalDayHeadingCopy,
  typicalDayIntroCopy,
  typicalDayCopy,
  bestWeekHeadingCopy,
  bestWeekIntroCopy,
  bestWeekCopy,
  keepingSinceHeadingCopy,
  keepingSinceIntroCopy,
  keepingSinceCopy,
  detailMomentumHeadingCopy,
  detailMomentumIntroCopy,
  detailMomentumSummaryCopy,
  detailPeakDayCopy,
  personalBestCopy,
  milestoneCopy,
  keptTotalLandmarkCopy,
  personalRecordCopy,
  inAppWhenExamplesText,
} from './accountability.js';

/** The commitment lifecycle states the consumer view can render. */
import { pageHead, pageNav } from './page-shell.js';

export const COMMITMENT_STATUSES = ['active', 'kept', 'missed', 'rescheduled', 'released', 'paused'];

/**
 * How a commitment status is shown to the person who gave the word.
 *
 * The design LAW lives here: a `missed` commitment must never present as a
 * failure. It becomes an open door — same warmth as the voice on the phone.
 * Returns a stable `tone` key the page CSS colors (never red-for-shame) and a
 * `label` that is safe to render verbatim.
 *
 * @param {string} status one of COMMITMENT_STATUSES
 * @returns {{ key: string, label: string, tone: 'active'|'kept'|'moved'|'open' }}
 */
export function statusPresentation(status) {
  switch (status) {
    case 'kept':
      return { key: 'kept', label: 'Kept', tone: 'kept' };
    case 'rescheduled':
      return { key: 'moved', label: 'Moved — still on', tone: 'moved' };
    case 'missed':
      // NOT a failure. An open door.
      return { key: 'open', label: 'Ready when you are', tone: 'open' };
    case 'released':
      // A word set down by choice. Blameless — plans change, and that's fine.
      return { key: 'rest', label: 'Set down', tone: 'open' };
    case 'paused':
      // A rhythm on a break by choice. Still yours; picks up when you're back.
      return { key: 'paused', label: 'Paused', tone: 'moved' };
    case 'active':
    default:
      return { key: 'active', label: 'On the books', tone: 'active' };
  }
}

/** Lede under the page title — warm, one word at a time, no pressure. */
export function mePageIntroCopy() {
  return "The words you’ve given, and the ones you’re keeping. One at a time.";
}

/** Heading over the give-your-word form. */
export function giveWordHeadingCopy() {
  return 'Give your word';
}

/**
 * Contextual note shown when the person arrives from a finished focus block
 * (the pomodoro→word bridge, #76/R-241). The timer carries the "one thing" they
 * were focused on into `?task=`, and we prefill the title with it — so the most-
 * earned moment lands one tap from a kept word, not on a blank form. Design LAW:
 * still an offer, never a demand — the time and the word are always theirs to set.
 */
export function carryOverNoteCopy() {
  return 'Carrying over what you just focused on. Give it your word and I’ll check in.';
}

/** Heading over the escalation-ceiling control — the wedge, in the person's words. */
export function escalationCeilingHeadingCopy() {
  return 'How hard should I nudge you?';
}

/** The promise under the heading: you set the ceiling, I never cross it. */
export function escalationCeilingIntroCopy() {
  return 'You set the ceiling and I never cross it. If a nudge goes quiet, this is the most I’ll ever do — your call, changeable any time.';
}

/**
 * The selectable ceiling rungs, low→high, each with a plain promise of exactly
 * what the bro will and won't do. Values mirror the API's CEILING_LEVELS; the
 * voice rung ('call') is previewed separately (coming soon), not selectable yet.
 * @returns {Array<{value:string,label:string,desc:string}>}
 */
export function escalationCeilingOptions() {
  return [
    { value: 'none', label: 'Just the nudge', desc: 'One push notification, and that’s it — no text follow-up, ever.' },
    { value: 'text', label: 'A nudge, then one text', desc: 'If the nudge stays quiet for 15 minutes, I’ll send a single warm text. Never more than one.' },
  ];
}

/** Preview of the voice rung — the top of the ladder, opt-in, still to come. */
export function escalationCeilingVoiceSoonCopy() {
  return 'A gentle call is on the way — soon you’ll be able to add it as the last rung, only if you want it.';
}

/** Heading over the coach own-words sharing control — the person's own words, their call. */
export function noteSharingHeadingCopy() {
  return 'Let a coach hear your words';
}

/**
 * The promise under the heading. Names exactly what turning this on does and
 * what stays private, and that it is off until the person chooses it — so the
 * control reads as a gift of consent, never a default give-away. Anti-shame by
 * construction: it only ever talks about words you KEEP.
 * @returns {string}
 */
export function noteSharingIntroCopy() {
  return 'If you work with a coach through FocusBro, they already see your kept-word momentum. Turn this on and the note they can send you may also carry your own words from a word you kept — the little wins you jot down. It’s off unless you turn it on, and you can turn it back off any time.';
}

/** The checkbox label — a plain, present-tense statement of the choice. */
export function noteSharingToggleLabelCopy() {
  return 'Share my own words from a kept word with my coach';
}

/**
 * First-run welcome heading. Shown ONLY to a signed-in person with zero words
 * given — the activation moment the whole product turns on. An invitation, in
 * their own language; never a scold about an empty page.
 */
export function firstRunHeadingCopy() {
  return 'Let’s give your first word.';
}

/** First-run body — the deal, warmly and in one breath. Nothing to live up to. */
export function firstRunBodyCopy() {
  return 'Pick one thing you’ll do — big or small — and when. I’ll show up to check in. ' +
    'That’s the whole deal, and you can change it any time.';
}

/** Label over the example seeds — a nudge for the blank-page moment, not a demand. */
export function firstRunExamplesLabel() {
  return 'Not sure where to start? Tap one to fill it in:';
}

/**
 * A few low-stakes example first words. Tapping one only fills the title — the
 * person still sets the time and gives the word themselves (we never assume it).
 * Deliberately small and blameless; the first word should feel easy to keep.
 * @returns {string[]}
 */
export function firstRunExamples() {
  return [
    'reply to that one email',
    'a ten-minute tidy',
    'go for a short walk',
    'drink a glass of water',
  ];
}

/** Empty state — an invitation, never a scold about having done nothing. */
export function emptyCommitmentsCopy() {
  return "No words given yet. What’s one thing you’ll do — and when? I’ll check in.";
}

/**
 * Re-entry welcome heading. Shown ONLY to a signed-in person who HAS given words
 * before but has nothing in flight right now — the "welcome back" moment. A
 * returning person is not a first-timer, so they never see the first-run pitch;
 * but a warm door beats a cold empty list. Never names a gap or a lapsed streak.
 */
export function reentryHeadingCopy() {
  return 'Welcome back.';
}

/**
 * Re-entry body — a no-catching-up invitation to give the next word. It leans on
 * nothing owed: no gap to explain, no streak to rescue, just the next small thing
 * whenever they're ready. The design LAW, applied to the re-engagement moment.
 */
export function reentryBodyCopy() {
  return 'Good to see you again. No catching up and no gap to explain — just pick the ' +
    'next thing you’ll do, and I’ll be here to check in.';
}

/** One tap from a finished word or welcome-back door into the next-word composer. */
export function nextWordActionLabel() {
  return 'Give your next word';
}

/**
 * The nudged-back welcome heading — shown ONLY when a person arrives via the
 * return-nudge deep-link (`/me/?from=return`, W4 / L3, #40). It closes the
 * outreach loop: the bro reached out, and here they are. Warmer and more personal
 * than the generic re-entry door, it acknowledges that they showed up — never the
 * absence that prompted the nudge. Shown once per arrival, then the marker clears.
 */
export function returnWelcomeHeadingCopy() {
  return 'Glad you’re here.';
}

/**
 * Nudged-back welcome body — an ally glad you picked up, holding the door open.
 * The design LAW at its sharpest: it celebrates the return itself, names no gap,
 * no lapsed streak, nothing owed — just the next small word whenever they're
 * ready. This is the on-page half of the return nudge's "no pressure at all."
 */
export function returnWelcomeBodyCopy() {
  return 'You showed up — that’s the whole thing, and I’m glad you did. Nothing to catch ' +
    'up on and nothing to explain; just pick the next thing you’ll do, and I’ll be right ' +
    'here to check in.';
}

/**
 * Which entry banner (if any) belongs on the page, derived purely from the live
 * commitments list. Single source of truth for both the first-run and re-entry
 * toggles — the client mirrors this exact branch inline.
 *   - `'first-word'`  → never given a word: the first-run invitation.
 *   - `'welcome-back'`→ has words but none active or paused: the warm re-entry door.
 *   - `'in-flight'`   → an active or paused word exists: no banner, just the work.
 * @param {Array<{status?: string}>} commitments
 * @returns {'first-word'|'welcome-back'|'in-flight'}
 */
export function entryState(commitments) {
  if (!commitments || !commitments.length) return 'first-word';
  for (let i = 0; i < commitments.length; i++) {
    const s = commitments[i] && commitments[i].status;
    if (s === 'active' || s === 'paused') return 'in-flight';
  }
  return 'welcome-back';
}

/** Heading over the kept-word streak number. Counts what you keep, never misses. */
export function streakHeadingCopy() {
  return 'Words kept in a row';
}

/** The three ways to resolve an active check-in, in the consumer's own words. */
export function checkinActionLabels() {
  return { kept: 'I did it', missed: 'Not yet', reschedule: 'Move it' };
}

/**
 * The optional sibling of "I did it": keep the word AND leave a word about it,
 * so the person's kept-word history reads back in their OWN voice — parity with
 * the SMS "done, finally filed the taxes 🎉" path (a text reply's real words
 * already become the kept-note). The plain "I did it" stays the instant one-tap
 * keep; this only invites a person who wants to mark the moment to add one.
 */
export function keptWithNoteActionLabel() {
  return 'I did it, and…';
}

/**
 * The optional prompt shown when a person chooses to leave a word alongside a
 * kept word. Purely a celebration of what they just did and a note for their own
 * history — never required, never a scold, never a tally. Empty is fine (the word
 * is kept either way); backing out keeps nothing and leaves the fast tap free.
 */
export function keptNotePromptCopy() {
  return 'Love it — you did it. Want to add a word about how it went? (Optional, just for your own history.)';
}

/** The quiet "I'm setting this word down" action — a blameless exit, not a miss. */
export function releaseActionLabel() {
  return 'Set it down';
}

/** "I'm on it" — check back shortly. Keeps the bro present; not a resolution. */
export function snoozeActionLabel() {
  return 'I’m on it';
}

/**
 * The optional prompt shown when a person taps "I'm on it" — lets them say how
 * long they need so the bro checks back WHEN they said, in-app the same way the
 * SMS "on it, give me 20" path already does (R-270/R-277, one parser per R-233).
 * Purely optional: a stated length is honored, an empty answer keeps today's
 * quick default check-back, and backing out leaves the word exactly as it is.
 * Never a resolution, never a miss, never a tally — the streak is untouched.
 */
export function snoozeLengthPromptCopy() {
  return 'On it. How long do you need? (Optional — “20 min”, “an hour”… or just OK and I’ll check back soon.)';
}

/**
 * The in-app "when do you want to try again?" prompt — shown when a person taps
 * "Not yet" on a check-in or "Move it" on an active word. A missed moment is an
 * opening, never a terminal failure: this asks for the next workable time in the
 * SAME warm words the SMS reschedule path uses, and the answer rides the one
 * shared when-parser (R-233). Extracted into a named copy fn so this — the single
 * most anti-shame-critical string in the product — is swept by `meCopySurface()`
 * and the design-LAW gate, and can never be edited into a scold unseen.
 * DESIGN LAW: an open door, never a tally, never "AI", never clinical.
 */
export function reschedulePromptCopy() {
  return `No problem — when do you want to try again? (e.g. ${inAppWhenExamplesText()})`;
}

/**
 * The confirm shown when a person sets a word down — a blameless exit, not a miss.
 * Setting a word down never touches the kept-word streak, and the copy says so
 * plainly so the action never reads as a loss. Extracted into a named copy fn so
 * it is swept by `meCopySurface()` and the design-LAW gate rather than hiding as
 * an inline client literal.
 * DESIGN LAW: a calm, on-your-side exit, never a tally, never "AI", never clinical.
 */
export function releaseConfirmCopy() {
  return 'Set this word down? No problem at all — your streak stays as it is, and you can start a new one whenever you’re ready.';
}

/** Suspend a repeating rhythm without ending the word — "life happens." */
export function pauseActionLabel() {
  return 'Pause';
}

/** Bring a paused rhythm back — welcome back, no catching up. */
export function resumeActionLabel() {
  return 'Resume';
}

/** Change a word in place — a reworded title, a new time — without losing the streak. */
export function editActionLabel() {
  return 'Edit';
}

/** Label for the per-word detail toggle — a look at one word's momentum. */
export function detailActionLabel() {
  return 'View';
}

/** Heading over the per-word detail panel's kept timeline. Never a miss list. */
export function detailKeptHeadingCopy() {
  return 'Kept on this word';
}

/** Label for the next-check-in line in the detail panel. Forward, not a scold. */
export function detailNextLabelCopy() {
  return 'Next check-in';
}

/** Label for the next-check-in line on each active word in the /me/ list. Forward, never a scold. */
export function listNextCheckinLabelCopy() {
  return 'Next check-in';
}

/**
 * The warm state for an active word whose check-in moment has already passed but
 * is still open (the bro is holding the door). NEVER "late", "overdue", or a
 * miss — the whole point is that time passing is not failure here. A concrete,
 * on-your-side "I'm still here" line.
 */
export function listNextCheckinWaitingCopy() {
  return 'Still here whenever you’re ready';
}

/** Heading over the kept-word log — the record of words you kept. Never a miss list. */
export function keptLogHeadingCopy() {
  return 'Words you kept';
}

/**
 * Empty state for the kept-word log — an open invitation, never a scold about an
 * empty record. The first kept word will land here; until then this is a promise,
 * not a blank ledger of failure.
 */
export function keptLogEmptyCopy() {
  return 'Every word you keep gathers here. The first one’s waiting for you.';
}

// The person's own kept-word momentum copy (momentumSelf*Copy) lives in
// accountability.js — the API that emits it — and is imported at the top of this
// module for the page shell + the design-LAW copy surface.

/**
 * Warm framing label for the /me/ "momentum read" — the person's OWN words from
 * the most recent word they kept-with-a-note, read back to them beneath the
 * momentum sparkline. Returning to the page is greeted by your last win in your
 * own voice, not a bare tick. The label is the frame only; the person's note
 * text is rendered (escaped, in quotes) alongside it by the client, so THEIR
 * words are never scanned — this label carries all the tone the gate checks.
 * DESIGN LAW: a celebration and a memory, never a tally, never "AI", never
 * clinical. Shown only when a kept word actually carried a note.
 */
export function latestKeptNoteLabelCopy() {
  return 'Last word you kept, in your own words';
}

/** The standing promise at the foot of the page — the design LAW, in plain words. */
export function mePageFootnoteCopy() {
  return 'FocusBro is an ally, not a boss. When a check-in lands and it didn’t happen, ' +
    'the answer is always “no problem — when do you want to try again?” We count the ' +
    'words you keep, never the ones you don’t.';
}

/**
 * Every consumer-page string the design-LAW test scans. Kept in one place so a
 * new label can never slip onto the page without the banned-word gate seeing it.
 * @returns {string[]}
 */
export function meCopySurface() {
  const labels = checkinActionLabels();
  return [
    mePageIntroCopy(),
    giveWordHeadingCopy(),
    carryOverNoteCopy(),
    escalationCeilingHeadingCopy(),
    escalationCeilingIntroCopy(),
    ...escalationCeilingOptions().flatMap((o) => [o.label, o.desc]),
    escalationCeilingVoiceSoonCopy(),
    noteSharingHeadingCopy(),
    noteSharingIntroCopy(),
    noteSharingToggleLabelCopy(),
    firstRunHeadingCopy(),
    firstRunBodyCopy(),
    firstRunExamplesLabel(),
    ...firstRunExamples(),
    reentryHeadingCopy(),
    reentryBodyCopy(),
    nextWordActionLabel(),
    returnWelcomeHeadingCopy(),
    returnWelcomeBodyCopy(),
    emptyCommitmentsCopy(),
    streakHeadingCopy(),
    personalBestCopy({ streak: { current_streak: 2, longest_streak: 2 } }),
    personalBestCopy({ streak: { current_streak: 12, longest_streak: 12 } }),
    milestoneCopy({ streak: { current_streak: 3 } }),
    milestoneCopy({ streak: { current_streak: 100 } }),
    keptTotalLandmarkCopy({ streak: { total_kept: 10 } }),
    keptTotalLandmarkCopy({ streak: { total_kept: 1000 } }),
    personalRecordCopy({ streak: { current_streak: 0, longest_streak: 2 } }),
    personalRecordCopy({ streak: { current_streak: 0, longest_streak: 42 } }),
    labels.kept, labels.missed, labels.reschedule,
    keptWithNoteActionLabel(),
    keptNotePromptCopy(),
    releaseActionLabel(),
    snoozeActionLabel(),
    snoozeLengthPromptCopy(),
    reschedulePromptCopy(),
    releaseConfirmCopy(),
    pauseActionLabel(),
    resumeActionLabel(),
    editActionLabel(),
    detailActionLabel(),
    detailKeptHeadingCopy(),
    detailNextLabelCopy(),
    listNextCheckinLabelCopy(),
    listNextCheckinWaitingCopy(),
    detailMomentumHeadingCopy(),
    detailMomentumIntroCopy(),
    detailMomentumSummaryCopy({ total: 0, days: 14 }),
    detailMomentumSummaryCopy({ total: 1, days: 14, peak: { count: 1 } }),
    detailMomentumSummaryCopy({ total: 6, days: 14, peak: { count: 2 } }),
    detailPeakDayCopy({ count: 2, whenPhrase: 'Wednesday' }),
    detailPeakDayCopy({ count: 4, whenPhrase: 'Monday, Jul 2' }),
    keptLogHeadingCopy(),
    keptLogEmptyCopy(),
    momentumSelfHeadingCopy(),
    momentumSelfIntroCopy(),
    momentumSelfSummaryCopy({ total: 0, days: 14 }),
    momentumSelfSummaryCopy({ total: 1, days: 14, peak: { count: 1 } }),
    momentumSelfSummaryCopy({ total: 9, days: 14, peak: { count: 3 } }),
    powerHoursHeadingCopy(),
    powerHoursIntroCopy(),
    powerHoursCopy({ peak: { hour: 9, count: 5 } }),
    powerHoursCopy({ peak: { hour: 14, count: 8 } }),
    powerHoursCopy({ peak: { hour: 22, count: 4 } }),
    powerHoursCopy({ peak: { hour: 0, count: 3 } }),
    powerHoursCopy({ peak: { hour: 12, count: 6 } }),
    bestDayHeadingCopy(),
    bestDayIntroCopy(),
    bestDayCopy({ best: { date: '2026-07-02', count: 7 }, nowISO: '2026-08-17T12:00:00Z', timezone: 'UTC' }),
    bestDayCopy({ best: { date: '2026-08-16', count: 3 }, nowISO: '2026-08-17T12:00:00Z', timezone: 'UTC' }),
    bestDayCopy({ best: { date: '2026-08-17', count: 5 }, nowISO: '2026-08-17T12:00:00Z', timezone: 'UTC' }),
    showedUpDaysHeadingCopy(),
    showedUpDaysIntroCopy(),
    showedUpDaysCopy({ days: 3 }),
    showedUpDaysCopy({ days: 28, persona: 'hype' }),
    showedUpDaysCopy({ days: 150, persona: 'ally' }),
    powerDayHeadingCopy(),
    powerDayIntroCopy(),
    powerDayCopy({ peak: { weekday: 0, count: 5 } }),
    powerDayCopy({ peak: { weekday: 2, count: 9 }, persona: 'hype' }),
    powerDayCopy({ peak: { weekday: 5, count: 6 }, persona: 'ally' }),
    powerDayCopy({ peak: { weekday: 6, count: 4 } }),
    typicalDayHeadingCopy(),
    typicalDayIntroCopy(),
    typicalDayCopy({ typical: { perDay: 2, total: 12, days: 6 } }),
    typicalDayCopy({ typical: { perDay: 3.4, total: 34, days: 10 }, persona: 'hype' }),
    typicalDayCopy({ typical: { perDay: 5, total: 60, days: 12 }, persona: 'ally' }),
    bestWeekHeadingCopy(),
    bestWeekIntroCopy(),
    bestWeekCopy({ best: { weekStart: '2026-06-29', count: 18 }, bestDayCount: 7, nowISO: '2026-08-17T12:00:00Z', timezone: 'UTC' }),
    bestWeekCopy({ best: { weekStart: '2026-08-10', count: 9 }, bestDayCount: 3, nowISO: '2026-08-17T12:00:00Z', timezone: 'UTC', persona: 'hype' }),
    bestWeekCopy({ best: { weekStart: '2026-08-17', count: 6 }, bestDayCount: 4, nowISO: '2026-08-17T12:00:00Z', timezone: 'UTC', persona: 'ally' }),
    keepingSinceHeadingCopy(),
    keepingSinceIntroCopy(),
    keepingSinceCopy({ firstKeptISO: '2026-07-08T14:00:00Z', count: 6, nowISO: '2026-08-17T12:00:00Z', timezone: 'UTC', persona: 'ally' }),
    keepingSinceCopy({ firstKeptISO: '2026-07-08T14:00:00Z', count: 40, nowISO: '2026-08-17T12:00:00Z', timezone: 'UTC', persona: 'hype' }),
    keepingSinceCopy({ firstKeptISO: '2025-11-20T09:00:00Z', count: 120, nowISO: '2026-08-17T12:00:00Z', timezone: 'UTC', persona: 'ally' }),
    latestKeptNoteLabelCopy(),
    mePageFootnoteCopy(),
    ...COMMITMENT_STATUSES.map((s) => statusPresentation(s).label),
  ];
}

/**
 * Render the self-contained consumer accountability page (/me/).
 * No server state is needed — the page authenticates client-side and reads the
 * accountability API. Returns an HTML string.
 */
export function renderMePage() {
  const A = checkinActionLabels();
  const KEPT_NOTE = keptWithNoteActionLabel();
  const KEPT_NOTE_PROMPT = keptNotePromptCopy();
  const RELEASE = releaseActionLabel();
  const SNOOZE = snoozeActionLabel();
  const SNOOZE_LEN_PROMPT = snoozeLengthPromptCopy();
  const RESCHEDULE_PROMPT = reschedulePromptCopy();
  const RELEASE_CONFIRM = releaseConfirmCopy();
  const PAUSE = pauseActionLabel();
  const RESUME = resumeActionLabel();
  const EDIT = editActionLabel();
  const VIEW = detailActionLabel();
  const NEXT_LABEL = listNextCheckinLabelCopy();
  const NEXT_WAITING = listNextCheckinWaitingCopy();
  return `${pageHead({ title: 'Your word — FocusBro', description: 'Give your word, keep it, and watch your kept-word streak grow. FocusBro checks in — an ally, never a scold.', maxWidth: 720 })}
<body>
${pageNav([{ href: '/', label: 'Home' }, { href: '/me/report', label: 'Weekly report' }, { href: '/coach/', label: 'Coach view' }, { href: '/about.html', label: 'About' }])}
<h1>Your word</h1>
<p class="intro">${mePageIntroCopy()}</p>

<div id="signin" class="card hidden">
  <h2 id="signinTitle">Sign in</h2>
  <p class="muted">Give your word, keep it, and I’ll check in. Your streak lives with your account.</p>
  <form id="signinForm">
    <label for="email">Email</label>
    <input id="email" type="email" placeholder="you@example.com" autocomplete="username" required />
    <label for="password">Password</label>
    <input id="password" type="password" placeholder="password" autocomplete="current-password" required />
    <div class="actions">
      <button type="submit" id="signinSubmit">Sign in</button>
      <button type="button" class="secondary" id="toggleMode">Create an account</button>
    </div>
  </form>
  <p class="err hidden" id="signinErr"></p>
</div>

<div id="app" class="hidden">
  <p class="muted hidden" id="anonNote">No account needed. Give your word and I’ll hold it in this browser. <a href="#" id="signinLink">Have an account? Sign in</a></p>
  <div id="firstRun" class="card firstrun hidden">
    <h2>${firstRunHeadingCopy()}</h2>
    <p class="streakmsg">${firstRunBodyCopy()}</p>
    <p class="muted" style="margin-bottom:6px;">${firstRunExamplesLabel()}</p>
    <div class="seedrow" id="seedRow">${firstRunExamples()
      .map((t) => `<button type="button" class="seed" data-seed="${t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}">${t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</button>`)
      .join('')}</div>
  </div>

  <div id="reentry" class="card firstrun hidden">
    <h2>${reentryHeadingCopy()}</h2>
    <p class="streakmsg">${reentryBodyCopy()}</p>
    <div class="actions"><button type="button" data-next-word>${nextWordActionLabel()}</button></div>
  </div>

  <div id="returnWelcome" class="card firstrun hidden">
    <h2>${returnWelcomeHeadingCopy()}</h2>
    <p class="streakmsg">${returnWelcomeBodyCopy()}</p>
    <div class="actions"><button type="button" data-next-word>${nextWordActionLabel()}</button></div>
  </div>

  <div class="card">
    <div class="streakwrap">
      <div class="streak" id="streakNum">0<small>${streakHeadingCopy()}</small></div>
      <div class="streakmsg" id="streakMsg"></div>
    </div>
    <div class="streakbest hidden" id="streakBest"></div>
    <div class="streakmilestone hidden" id="streakMilestone"></div>
    <div class="streaklandmark hidden" id="streakLandmark"></div>
    <div class="streakrecord hidden" id="streakRecord"></div>
  </div>

  <div class="card">
    <h2>${giveWordHeadingCopy()}</h2>
    <p class="next-step hidden" id="carryNote">${carryOverNoteCopy()}</p>
    <form id="commitForm">
      <label for="title">What will you do?</label>
      <input id="title" type="text" placeholder="start the taxes" maxlength="200" required />
      <div class="row">
        <div>
          <label for="startAt">When?</label>
          <input id="startAt" type="text" placeholder="${inAppWhenExamplesText()}" autocomplete="off" required />
        </div>
        <div>
          <label for="persona">Companion tone</label>
          <select id="persona">
            <option value="ally">Calm ally</option>
            <option value="hype">Hype</option>
          </select>
        </div>
        <div>
          <label for="channel">Check-in by</label>
          <select id="channel">
            <option value="push">Push notification</option>
            <option value="text">Text</option>
          </select>
        </div>
        <div>
          <label for="repeat">Repeat</label>
          <select id="repeat">
            <option value="none">Just once</option>
            <option value="daily">Every day</option>
            <option value="weekdays">Weekdays</option>
          </select>
        </div>
      </div>
      <p class="muted" id="repeatHint">Pick a repeat and I’ll check in at the same time each day — the same warm nudge, on a rhythm.</p>
      <div class="actions"><button type="submit">Give my word</button></div>
    </form>
    <p class="ok hidden" id="commitMsg"></p>
    <p class="err hidden" id="commitErr"></p>
  </div>

  <div id="list"></div>

  <div class="card hidden" id="momentumCard">
    <h2>${momentumSelfHeadingCopy()}</h2>
    <div id="momentum"></div>
    <p class="latest-note hidden" id="latestNote"></p>
  </div>

  <div class="card hidden" id="powerHoursCard">
    <h2>${powerHoursHeadingCopy()}</h2>
    <p class="muted">${powerHoursIntroCopy()}</p>
    <p class="powerhours" id="powerHours"></p>
  </div>

  <div class="card hidden" id="bestDayCard">
    <h2>${bestDayHeadingCopy()}</h2>
    <p class="muted">${bestDayIntroCopy()}</p>
    <p class="bestday" id="bestDay"></p>
  </div>

  <div class="card hidden" id="keepingSinceCard">
    <h2>${keepingSinceHeadingCopy()}</h2>
    <p class="muted">${keepingSinceIntroCopy()}</p>
    <p class="keepingsince" id="keepingSince"></p>
  </div>

  <div class="card hidden" id="showedUpDaysCard">
    <h2>${showedUpDaysHeadingCopy()}</h2>
    <p class="muted">${showedUpDaysIntroCopy()}</p>
    <p class="showedupdays" id="showedUpDays"></p>
  </div>

  <div class="card hidden" id="powerDayCard">
    <h2>${powerDayHeadingCopy()}</h2>
    <p class="muted">${powerDayIntroCopy()}</p>
    <p class="powerday" id="powerDay"></p>
  </div>

  <div class="card hidden" id="typicalDayCard">
    <h2>${typicalDayHeadingCopy()}</h2>
    <p class="muted">${typicalDayIntroCopy()}</p>
    <p class="typicalday" id="typicalDay"></p>
  </div>

  <div class="card hidden" id="bestWeekCard">
    <h2>${bestWeekHeadingCopy()}</h2>
    <p class="muted">${bestWeekIntroCopy()}</p>
    <p class="bestweek" id="bestWeek"></p>
  </div>

  <div class="card" id="keptLog">
    <h2>${keptLogHeadingCopy()}</h2>
    <p class="streakmsg" id="keptMsg"></p>
    <div id="keptList"></div>
  </div>

  <div class="card" id="ceilingCard">
    <h2>${escalationCeilingHeadingCopy()}</h2>
    <p class="muted">${escalationCeilingIntroCopy()}</p>
    <label for="ceiling">The most I’ll do</label>
    <select id="ceiling">${escalationCeilingOptions()
      .map((o) => `<option value="${o.value}">${o.label.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</option>`)
      .join('')}</select>
    <p class="muted" id="ceilingDesc"></p>
    <p class="muted">${escalationCeilingVoiceSoonCopy()}</p>
    <p class="ok hidden" id="ceilingMsg"></p>
  </div>

  <div class="card" id="noteSharingCard">
    <h2>${noteSharingHeadingCopy()}</h2>
    <p class="muted">${noteSharingIntroCopy()}</p>
    <label style="display:flex; gap:8px; align-items:flex-start;">
      <input id="noteSharing" type="checkbox" style="width:auto; margin-top:3px;" />
      <span>${noteSharingToggleLabelCopy()}</span>
    </label>
    <p class="ok hidden" id="noteSharingMsg"></p>
  </div>

  <div class="card hidden" id="claimCard">
    <h2>Keep this word everywhere</h2>
    <p class="muted">Your word lives in this browser for now. Add an email and a password and it follows you to any device — and I can email you a way back in.</p>
    <form id="claimForm">
      <label for="claimEmail">Email</label>
      <input id="claimEmail" type="email" placeholder="you@example.com" autocomplete="email" required />
      <label for="claimPassword">Password</label>
      <input id="claimPassword" type="password" placeholder="at least 8 characters" autocomplete="new-password" minlength="8" required />
      <div class="actions"><button type="submit" id="claimSubmit">Save my account</button></div>
    </form>
    <p class="err hidden" id="claimErr"></p>
    <p class="next-step hidden" id="claimMsg"></p>
  </div>

  <div class="card" id="consentCard">
    <h2>${consentPanelCopy().heading}</h2>
    <p class="muted">${consentPanelCopy().intro}</p>
    <form id="consentForm">
      <label for="phone">${consentPanelCopy().phoneLabel}</label>
      <input id="phone" type="tel" placeholder="+1 555 765 4321" autocomplete="tel" />
      <div class="row">
        <div>
          <label for="quietStart">${consentPanelCopy().quietStartLabel}</label>
          <select id="quietStart"><option value="">—</option></select>
        </div>
        <div>
          <label for="quietEnd">${consentPanelCopy().quietEndLabel}</label>
          <select id="quietEnd"><option value="">—</option></select>
        </div>
      </div>
      <p class="muted" style="margin-top:6px;">${consentPanelCopy().quietHint}</p>
      <label style="display:flex; gap:8px; align-items:flex-start; margin-top:12px;">
        <input id="agree" type="checkbox" style="width:auto; margin-top:3px;" />
        <span>${consentLanguage('text')}</span>
      </label>
      <div class="actions">
        <button type="submit" id="consentSave">${consentPanelCopy().saveButton}</button>
        <button type="button" class="secondary" id="consentOptOut">${consentPanelCopy().optOutButton}</button>
      </div>
    </form>
    <p class="ok hidden" id="consentMsg"></p>
    <p class="err hidden" id="consentErr"></p>
  </div>

  <div class="card hidden" id="founderMetrics">
    <h2>Acquisition scorecard</h2>
    <p class="muted">Which messages create accountability that lasts—not just traffic.</p>
    <p id="founderMetricsSummary"></p>
    <p id="founderDecisionSummary" class="muted"></p>
    <div style="overflow-x:auto;">
      <table style="width:100%; border-collapse:collapse; text-align:left;">
        <thead>
          <tr>
            <th>Source / campaign / creative / challenge</th><th>Visits</th><th>Words</th><th>Activation</th>
            <th>Delivered</th><th>Kept</th><th>D1</th><th>D7</th>
          </tr>
        </thead>
        <tbody id="founderMetricsRows"></tbody>
      </table>
    </div>
  </div>

  <p class="muted"><a href="#" id="signout">Sign out</a></p>
</div>

<p class="footnote">${mePageFootnoteCopy()}</p>

<script>
(function () {
  var TOKEN_KEY = 'focusbro_token';
  var mode = 'login'; // or 'register'
  var el = function (id) { return document.getElementById(id); };
  var show = function (n) { if (n) n.classList.remove('hidden'); };
  var hide = function (n) { if (n) n.classList.add('hidden'); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };
  var token = function () { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } };
  var authHeaders = function () {
    var headers = { 'Content-Type': 'application/json' };
    var legacyToken = token();
    if (legacyToken) headers.Authorization = 'Bearer ' + legacyToken;
    return headers;
  };

  // Turn a datetime-local value into an unambiguous ISO string (UTC Z).
  function toISO(localValue) {
    if (!localValue) return null;
    var d = new Date(localValue);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  function fmtWhen(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso || '');
    try { return d.toLocaleString(); } catch (e) { return d.toISOString().replace('T', ' ').slice(0, 16); }
  }
  // ISO → a value the datetime-local input accepts ("YYYY-MM-DDTHH:MM"), in the
  // viewer's local zone so the picker shows the same wall-clock time they set.
  function toLocalInput(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var off = d.getTimezoneOffset() * 60000;
    return new Date(d.getTime() - off).toISOString().slice(0, 16);
  }

  // Inline "change this word in place" form, hidden until Edit is tapped. Pre-
  // filled with the word's current title, time, and rhythm. Saving keeps the same
  // commitment (and the streak); it never sets the word down and starts over.
  function editFormHTML(c) {
    var reps = [['none', 'Just once'], ['daily', 'Every day'], ['weekdays', 'Weekdays']];
    var opts = '';
    for (var i = 0; i < reps.length; i++) {
      var sel = (c.recurrence || 'none') === reps[i][0] ? ' selected' : '';
      opts += '<option value="' + reps[i][0] + '"' + sel + '>' + esc(reps[i][1]) + '</option>';
    }
    return '<div class="editform hidden" data-edit="' + esc(c.id) + '">'
      + '<label>Change the word</label>'
      + '<input class="e-title" type="text" maxlength="200" value="' + esc(c.title) + '" />'
      + '<div class="row">'
      +   '<div><label>When?</label><input class="e-when" type="datetime-local" value="' + esc(toLocalInput(c.start_at)) + '" /></div>'
      +   '<div><label>Repeat</label><select class="e-repeat">' + opts + '</select></div>'
      + '</div>'
      + '<div class="actions">'
      +   '<button class="small" data-act="edit-save" data-id="' + esc(c.id) + '">Save changes</button>'
      +   '<button class="small secondary" data-act="edit-cancel" data-id="' + esc(c.id) + '">Cancel</button>'
      + '</div></div>';
  }

  var STATUS = {
    active: { label: ${JSON.stringify(statusPresentation('active').label)}, tone: 'active' },
    kept: { label: ${JSON.stringify(statusPresentation('kept').label)}, tone: 'kept' },
    rescheduled: { label: ${JSON.stringify(statusPresentation('rescheduled').label)}, tone: 'moved' },
    missed: { label: ${JSON.stringify(statusPresentation('missed').label)}, tone: 'open' },
    released: { label: ${JSON.stringify(statusPresentation('released').label)}, tone: 'open' },
    paused: { label: ${JSON.stringify(statusPresentation('paused').label)}, tone: 'moved' }
  };
  function present(status) { return STATUS[status] || STATUS.active; }

  function renderStreak(data) {
    var s = (data && data.streak) || {};
    el('streakNum').innerHTML = esc(s.current_streak || 0) + '<small>${streakHeadingCopy()}</small>';
    el('streakMsg').textContent = (data && data.message) || '';
    // Personal-best celebration: shown ONLY when the server sends a non-empty
    // line (current run === all-time best, 2+). Anti-shame by construction — the
    // API returns '' on a decline, so this banner can never name a gap.
    var best = el('streakBest');
    if (best) {
      var line = (data && data.best) || '';
      best.textContent = line;
      if (line) { best.classList.remove('hidden'); } else { best.classList.add('hidden'); }
    }
    // Milestone badge: shown ONLY when the server sends a non-empty line (the
    // current run is exactly at a kept-word milestone). Independent of the
    // personal-best line — both can show at once, each a true win. Anti-shame by
    // construction: the API returns '' between milestones, so this never nags.
    var mile = el('streakMilestone');
    if (mile) {
      var mline = (data && data.milestone) || '';
      mile.textContent = mline;
      if (mline) { mile.classList.remove('hidden'); } else { mile.classList.add('hidden'); }
    }
    // Lifetime landmark: shown ONLY when the server sends a non-empty line (the
    // lifetime kept-word TOTAL is exactly at a landmark — 10/25/50/100/…). Unlike
    // the best/milestone lines above (both read the current run, which a miss can
    // zero), this reads total_kept, which only ever grows — so once it shows, no
    // reset can take it back. Independent of the other two: all three can show at
    // once, each a distinct, true win. Anti-shame by construction — the API
    // returns '' between landmarks, so this never nags.
    var land = el('streakLandmark');
    if (land) {
      var lline = (data && data.landmark) || '';
      land.textContent = lline;
      if (lline) { land.classList.remove('hidden'); } else { land.classList.add('hidden'); }
    }
    // Standing all-time record: shown ONLY when the server sends a non-empty line
    // (current run is at zero AND there's a best run of 2+ on record). This is the
    // one line that speaks at a fresh start, where message/best/milestone all go
    // quiet — the strongest run held as a permanent record a reset can't revoke.
    // Anti-shame by construction: it fires only with no current run to compare
    // against, and the API returns '' the instant a run is going, so it never sits
    // beside — or nags about — a live streak.
    var rec = el('streakRecord');
    if (rec) {
      var rline = (data && data.record) || '';
      rec.textContent = rline;
      if (rline) { rec.classList.remove('hidden'); } else { rec.classList.add('hidden'); }
    }
  }

  // Pre-select the person's remembered companion tone (calm ally vs. hype) once,
  // on first load, so a returning person doesn't re-pick their voice every time —
  // the vision's "persona ... per user." Applied a single time so it never fights
  // a mid-session change; the form still overrides per word, and an unset default
  // simply leaves the standing calm ally selected.
  var personaHydrated = false;
  function applyDefaultPersona(data) {
    if (personaHydrated) return;
    var sel = el('persona');
    var pref = data && data.default_persona;
    if (sel && (pref === 'ally' || pref === 'hype')) { sel.value = pref; }
    personaHydrated = true;
  }
  function loadStreak() {
    fetch('/api/accountability/streak', { headers: authHeaders() })
      .then(function (r) { if (r.status === 401) throw new Error('unauthorized'); return r.json(); })
      .then(function (data) { applyDefaultPersona(data); renderStreak(data); })
      .catch(function () {});
  }

  // The kept-word log — every word you kept, most recent first. Momentum-only:
  // the API returns ONLY kept check-ins, so there is never a miss list to render.
  var KEPT_EMPTY = ${JSON.stringify(keptLogEmptyCopy())};
  function renderKept(data) {
    var host = el('keptList');
    var msg = el('keptMsg');
    if (msg) msg.textContent = (data && data.message) || '';
    var kept = (data && data.kept) || [];
    if (!host) return;
    if (!kept.length) {
      host.innerHTML = '<p class="muted">' + esc(KEPT_EMPTY) + '</p>';
      return;
    }
    var html = '';
    for (var i = 0; i < kept.length; i++) {
      var k = kept[i];
      html += '<div class="keptrow">'
        + '<div><span class="tick">✓</span><span class="name">' + esc(k.title) + '</span></div>'
        + '<div class="when">' + esc(fmtWhen(k.kept_at)) + '</div>'
        + '</div>';
    }
    host.innerHTML = html;
  }

  // Your kept-word momentum — the same sparkline the coach sees, turned around
  // for your own eyes. Bars scale to your busiest day; a quiet day is a short
  // grey bar (the absence of a win), never a surfaced miss. Hidden until there
  // is at least one kept word, so a brand-new page isn't a chart of nothing.
  // One sparkline renderer for every surface that shows momentum (the /me/
  // momentum card AND the per-word detail panel): intro + scaled bars + summary,
  // from a shared momentum payload. Bars scale to the busiest day; a quiet day is
  // a short grey bar (the absence of a win), never a surfaced miss.
  function sparkBlockHTML(m) {
    var max = 0, i;
    for (i = 0; i < m.buckets.length; i++) { if (m.buckets[i].count > max) max = m.buckets[i].count; }
    var label = (m.sparkline ? m.sparkline + ' — ' : '') + (m.summary || '');
    var bars = '';
    for (i = 0; i < m.buckets.length; i++) {
      var b = m.buckets[i];
      var pct = max > 0 ? Math.max(7, Math.round((b.count / max) * 100)) : 7;
      var cls = b.count > 0 ? 'spark-bar' : 'spark-bar zero';
      var title = esc(b.date) + ': ' + esc(b.count) + ' kept';
      bars += '<div class="' + cls + '" style="height:' + pct + '%" title="' + title + '"></div>';
    }
    // The peak-day callout rides along only where the API attaches it (the
    // per-word detail panel); on the /me/ and coach momentum cards m.peakDay is
    // undefined, so nothing extra renders — one renderer, still every surface.
    return '<div class="momentum-intro">' + esc(m.intro || '') + '</div>'
      + '<div class="spark" role="img" aria-label="' + esc(label) + '">' + bars + '</div>'
      + '<div class="momentum-summary">' + esc(m.summary || '') + '</div>'
      + (m.peakDay ? '<div class="momentum-peak">' + esc(m.peakDay) + '</div>' : '');
  }
  // True only when a momentum payload has at least one kept word to show, so no
  // surface ever renders a chart of nothing.
  function hasMomentum(m) { return !!(m && m.buckets && m.buckets.length && Number(m.total) > 0); }

  function renderMomentum(m) {
    var card = el('momentumCard');
    var host = el('momentum');
    if (!host || !card) return;
    if (!hasMomentum(m)) {
      card.classList.add('hidden');
      host.innerHTML = '';
      return;
    }
    host.innerHTML = sparkBlockHTML(m);
    card.classList.remove('hidden');
  }

  // The warm one-line "momentum read": the person's OWN words from the most recent
  // word they kept-with-a-note, read back beneath the sparkline. Frame comes from
  // the design-LAW-scanned label; the note itself is their own text (escaped, in
  // quotes). Rides inside the momentum card, so it only ever shows once there is
  // real momentum — and only when a kept word actually carried a note. No note yet
  // → the line stays hidden (never a blank or a scold).
  var LATEST_NOTE_LABEL = ${JSON.stringify(latestKeptNoteLabelCopy())};
  function renderLatestNote(ln) {
    var host = el('latestNote');
    if (!host) return;
    var note = ln && typeof ln.note === 'string' ? ln.note.trim() : '';
    if (!note) { host.classList.add('hidden'); host.textContent = ''; return; }
    host.innerHTML = '<span class="latest-note-label">' + esc(LATEST_NOTE_LABEL) + '</span> “' + esc(note) + '”';
    host.classList.remove('hidden');
  }

  // Your power hours: the warm one-line read of WHEN in the day your kept words
  // tend to land. The server sends a non-empty string ONLY when there's enough
  // kept history to name a trustworthy peak (design-LAW-scanned, strengths-only);
  // a thin or flat history sends '' and the card simply stays hidden — never a
  // blank panel, never a guess.
  function renderPowerHours(line) {
    var card = el('powerHoursCard');
    var host = el('powerHours');
    if (!card || !host) return;
    var s = typeof line === 'string' ? line.trim() : '';
    if (!s) { card.classList.add('hidden'); host.textContent = ''; return; }
    host.textContent = s;
    card.classList.remove('hidden');
  }

  // Your best day: the warm one-line read of the most words you ever kept in a
  // single day — a standing record. The server sends a non-empty string ONLY when
  // there's a real high-water mark to crown (a day that cleared the floor,
  // design-LAW-scanned, record-only); a thin history sends '' and the card simply
  // stays hidden — never a blank panel, never a hollow "best day: 1".
  function renderBestDay(line) {
    var card = el('bestDayCard');
    var host = el('bestDay');
    if (!card || !host) return;
    var s = typeof line === 'string' ? line.trim() : '';
    if (!s) { card.classList.add('hidden'); host.textContent = ''; return; }
    host.textContent = s;
    card.classList.remove('hidden');
  }

  // Keeping your word since …: the account-level longevity anchor — the day you
  // first kept your word here, across all your words. The server sends a non-empty
  // string ONLY when there's a real practice to name (a lifetime kept floor AND a
  // week+ of history, design-LAW-scanned, longevity-only); a young or thin account
  // sends '' and the card simply stays hidden — never a "since today", never a "0
  // days".
  function renderKeepingSince(line) {
    var card = el('keepingSinceCard');
    var host = el('keepingSince');
    if (!card || !host) return;
    var s = typeof line === 'string' ? line.trim() : '';
    if (!s) { card.classList.add('hidden'); host.textContent = ''; return; }
    host.textContent = s;
    card.classList.remove('hidden');
  }

  // Days you showed up: the account-level BREADTH read — how many separate days
  // you've kept your word here. The server sends a non-empty string ONLY when
  // there's a real spread to name (3+ distinct active days, design-LAW-scanned,
  // breadth-only); a barely-started account sends '' and the card stays hidden —
  // never a hollow "1 day", never a zero.
  function renderShowedUpDays(line) {
    var card = el('showedUpDaysCard');
    var host = el('showedUpDays');
    if (!card || !host) return;
    var s = typeof line === 'string' ? line.trim() : '';
    if (!s) { card.classList.add('hidden'); host.textContent = ''; return; }
    host.textContent = s;
    card.classList.remove('hidden');
  }

  // Your power day: the warm one-line read of WHICH DAY OF THE WEEK your kept words
  // most often land — the weekday sibling of power hours. The server sends a
  // non-empty string ONLY when there's enough kept history to name a trustworthy
  // peak weekday (design-LAW-scanned, strengths-only); a thin, flat, or tied
  // history sends '' and the card simply stays hidden — never a blank panel, never
  // a guess.
  function renderPowerDay(line) {
    var card = el('powerDayCard');
    var host = el('powerDay');
    if (!card || !host) return;
    var s = typeof line === 'string' ? line.trim() : '';
    if (!s) { card.classList.add('hidden'); host.textContent = ''; return; }
    host.textContent = s;
    card.classList.remove('hidden');
  }

  // Your typical day: the warm one-line read of about how many words you keep on a
  // day you show up — the INTENSITY read beside the count/peak/breadth cards. The
  // server sends a non-empty string ONLY when there's enough kept history for an
  // honest average AND it clears the ~2-a-day floor (design-LAW-scanned, kept-days
  // only); a thin, flat, or ~1-a-day history sends '' and the card stays hidden —
  // never a blank panel, never a hollow average.
  function renderTypicalDay(line) {
    var card = el('typicalDayCard');
    var host = el('typicalDay');
    if (!card || !host) return;
    var s = typeof line === 'string' ? line.trim() : '';
    if (!s) { card.classList.add('hidden'); host.textContent = ''; return; }
    host.textContent = s;
    card.classList.remove('hidden');
  }

  // Your best week: the warm one-line read of the biggest week you ever put
  // together — the week-scale peer of the best-day record. The server sends a
  // non-empty string ONLY when there's a real record to crown (past the floor AND
  // strictly bigger than your best single day, design-LAW-scanned, record-only); a
  // thin history, or a week no larger than one day, sends '' and the card simply
  // stays hidden — never a blank panel, never an echo of the best-day card.
  function renderBestWeek(line) {
    var card = el('bestWeekCard');
    var host = el('bestWeek');
    if (!card || !host) return;
    var s = typeof line === 'string' ? line.trim() : '';
    if (!s) { card.classList.add('hidden'); host.textContent = ''; return; }
    host.textContent = s;
    card.classList.remove('hidden');
  }

  function loadKept() {
    fetch('/api/accountability/kept', { headers: authHeaders() })
      .then(function (r) { if (r.status === 401) throw new Error('unauthorized'); return r.json(); })
      .then(function (data) {
        renderKept(data);
        renderMomentum(data && data.momentum);
        renderLatestNote(data && data.latest_note);
        renderPowerHours(data && data.power_hours);
        renderBestDay(data && data.best_day);
        renderKeepingSince(data && data.keeping_since);
        renderShowedUpDays(data && data.showed_up_days);
        renderPowerDay(data && data.power_day);
        renderTypicalDay(data && data.typical_day);
        renderBestWeek(data && data.best_week);
      })
      .catch(function () {});
  }

  // The concrete next moment the bro shows up on an ACTIVE word, shown right on
  // the list card so you see it across every word at a glance (not only by
  // opening detail). If that moment has already passed but the check-in is still
  // open, we NEVER say "late" — the door is still held: a warm "still here"
  // line. Non-active words, or an active word with nothing queued, show nothing.
  function nextCheckinLineHTML(c) {
    if (!c || c.status !== 'active' || !c.next_checkin) return '';
    var t = new Date(c.next_checkin).getTime();
    if (isNaN(t)) return '';
    if (t <= Date.now()) {
      return '<div class="when next waiting">' + esc(${JSON.stringify(NEXT_WAITING)}) + '</div>';
    }
    return '<div class="when next">' + esc(${JSON.stringify(NEXT_LABEL)}) + ': ' + esc(fmtWhen(c.next_checkin)) + '</div>';
  }

  function renderList(commitments) {
    var host = el('list');
    if (!commitments || !commitments.length) {
      host.innerHTML = '<div class="card muted">' + esc(${JSON.stringify(emptyCommitmentsCopy())}) + '</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < commitments.length; i++) {
      var c = commitments[i];
      var p = present(c.status);
      var cadence = c.recurrence === 'daily' ? ' · every day'
        : c.recurrence === 'weekdays' ? ' · weekdays' : '';
      html += '<div class="card" data-id="' + esc(c.id) + '">'
        + '<div class="commit">'
        +   '<div><div class="name">' + esc(c.title) + '</div>'
        +     '<div class="when">' + esc(fmtWhen(c.start_at)) + esc(cadence) + '</div>'
        +     nextCheckinLineHTML(c)
        +   '</div>'
        +   '<span class="pill ' + p.tone + '">' + esc(p.label) + '</span>'
        + '</div>';
      if (c.status === 'active') {
        // Pause is the "life happens" flex for a repeating rhythm only.
        var isRecur = (c.recurrence === 'daily' || c.recurrence === 'weekdays');
        html += '<div class="actions">'
          + '<button class="small" data-act="kept" data-id="' + esc(c.id) + '">' + esc(${JSON.stringify(A.kept)}) + '</button>'
          + '<button class="small secondary" data-act="kept-note" data-id="' + esc(c.id) + '">' + esc(${JSON.stringify(KEPT_NOTE)}) + '</button>'
          + '<button class="small secondary" data-act="snooze" data-id="' + esc(c.id) + '">' + esc(${JSON.stringify(SNOOZE)}) + '</button>'
          + '<button class="small secondary" data-act="missed" data-id="' + esc(c.id) + '">' + esc(${JSON.stringify(A.missed)}) + '</button>'
          + '<button class="small secondary" data-act="reschedule" data-id="' + esc(c.id) + '">' + esc(${JSON.stringify(A.reschedule)}) + '</button>'
          + (isRecur ? '<button class="small secondary" data-act="pause" data-id="' + esc(c.id) + '">' + esc(${JSON.stringify(PAUSE)}) + '</button>' : '')
          + '<button class="small secondary" data-act="edit" data-id="' + esc(c.id) + '">' + esc(${JSON.stringify(EDIT)}) + '</button>'
          + '<button class="small secondary" data-act="view" data-id="' + esc(c.id) + '">' + esc(${JSON.stringify(VIEW)}) + '</button>'
          + '<button class="small secondary" data-act="release" data-id="' + esc(c.id) + '">' + esc(${JSON.stringify(RELEASE)}) + '</button>'
          + '</div>'
          + editFormHTML(c);
      } else if (c.status === 'paused') {
        // A rhythm on a break — one tap to welcome it back. No catching up.
        // Edit stays available while paused: adjust the plan before you resume it.
        html += '<div class="actions">'
          + '<button class="small" data-act="resume" data-id="' + esc(c.id) + '">' + esc(${JSON.stringify(RESUME)}) + '</button>'
          + '<button class="small secondary" data-act="edit" data-id="' + esc(c.id) + '">' + esc(${JSON.stringify(EDIT)}) + '</button>'
          + '<button class="small secondary" data-act="view" data-id="' + esc(c.id) + '">' + esc(${JSON.stringify(VIEW)}) + '</button>'
          + '</div>'
          + editFormHTML(c);
      } else if (c.status === 'missed') {
        // The open door — one tap to try again, never a dead end.
        html += '<div class="actions">'
          + '<button class="small" data-act="reschedule" data-id="' + esc(c.id) + '">Try again</button>'
          + '<button class="small secondary" data-act="view" data-id="' + esc(c.id) + '">' + esc(${JSON.stringify(VIEW)}) + '</button>'
          + '</div>';
      } else {
        // A kept word opens the next loop in one tap. Moved / released words stay
        // quiet; every finished word can still open its momentum-only detail.
        html += '<div class="actions">'
          + (c.status === 'kept' ? '<button class="small" data-act="next-word" data-id="' + esc(c.id) + '">' + esc(NEXT_WORD) + '</button>' : '')
          + '<button class="small secondary" data-act="view" data-id="' + esc(c.id) + '">' + esc(${JSON.stringify(VIEW)}) + '</button>'
          + '</div>';
      }
      html += '<div class="detail hidden" data-detail="' + esc(c.id) + '"></div>';
      html += '<div class="msg" data-msg="' + esc(c.id) + '"></div>';
      html += '</div>';
    }
    host.innerHTML = html;
  }

  function loadList() {
    fetch('/api/commitments', { headers: authHeaders() })
      .then(function (r) { if (r.status === 401) throw new Error('unauthorized'); return r.json(); })
      .then(function (data) {
        var commitments = (data && data.commitments) || [];
        renderList(commitments);
        updateFirstRun(commitments);
      })
      .catch(function () {});
  }

  // Which entry banner belongs on the page — mirrors entryState() in me.js.
  //   'first-word'   → never given a word: the first-run invitation.
  //   'welcome-back' → has words but none active or paused: the warm re-entry door.
  //   'in-flight'    → an active or paused word exists: no banner, just the work.
  function entryState(commitments) {
    if (!commitments || !commitments.length) return 'first-word';
    for (var i = 0; i < commitments.length; i++) {
      var s = commitments[i] && commitments[i].status;
      if (s === 'active' || s === 'paused') return 'in-flight';
    }
    return 'welcome-back';
  }

  // First-run welcome is the activation moment (zero words). Re-entry is the
  // welcome-back door for a returning person with no word in flight — never the
  // cold-start pitch, never a scold about a gap. Exactly one shows, or neither
  // (when a word is on the books). On the first-run empty load we gently place
  // the cursor in the title field, focused once so a later reload never steals it.
  var _firstRunFocused = false;
  var _lastCommitments = null;
  // Re-run the entry-door logic against the last-rendered list — used when the
  // async homecoming check resolves AFTER the list already painted a generic door,
  // so the nudged-back welcome can take over cleanly.
  function refreshEntryDoors() { if (_lastCommitments) updateFirstRun(_lastCommitments); }
  function updateFirstRun(commitments) {
    _lastCommitments = commitments;
    var state = entryState(commitments);
    var first = el('firstRun');
    var back = el('reentry');
    // When the nudged-back welcome is up — arrived via ?from=return (FROM_RETURN)
    // OR come back under their own steam after a nudge (HOMECOMING) — it replaces
    // the generic first-run/re-entry doors: a returning person never sees the
    // cold-start pitch, and two "welcome back" banners never stack.
    var returning = FROM_RETURN || HOMECOMING;
    if (first) { if (state === 'first-word' && !returning) show(first); else hide(first); }
    if (back) { if (state === 'welcome-back' && !returning) show(back); else hide(back); }
    if (state === 'first-word' && !_firstRunFocused) {
      _firstRunFocused = true;
      var t = el('title');
      if (t && !t.value) { try { t.focus(); } catch (e) {} }
    }
  }

  // Tapping an example seed only fills the title, then moves to "When?" — the
  // person still sets the time and gives the word themselves. We never assume a
  // time or auto-commit; the seed is a warm starting point, nothing more.
  var seedRow = el('seedRow');
  if (seedRow) {
    seedRow.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('button[data-seed]') : null;
      if (!b) return;
      ev.preventDefault();
      var t = el('title');
      if (t) { t.value = b.getAttribute('data-seed') || ''; }
      var w = el('startAt');
      if (w) { try { w.focus(); } catch (e) {} }
    });
  }

  // The pomodoro→word bridge (#76): the timer carries the "one thing" you were
  // focused on into ?task=. Prefill the title so a finished focus block lands one
  // tap from a kept word — never auto-committed; you still set the time and give
  // the word. Read once, at the top, so it survives the sign-in gate.
  var PREFILL_TASK = (function () {
    try { return (new URLSearchParams(location.search).get('task') || '').trim().slice(0, 200); }
    catch (e) { return ''; }
  })();
  var PREFILL_WHEN = (function () {
    try { return (new URLSearchParams(location.search).get('when') || '').trim().slice(0, 80); }
    catch (e) { return ''; }
  })();
  var ATTRIBUTION = (function () {
    var out = {};
    try {
      var q = new URLSearchParams(location.search);
      ['source', 'campaign', 'content', 'challenge'].forEach(function (key) {
        var value = (q.get(key) || '').trim().slice(0, 80);
        if (value) out[key] = value;
      });
    } catch (e) {}
    return out;
  })();
  function applyPrefill() {
    if (!PREFILL_TASK) return;
    var t = el('title');
    if (t && !t.value) { t.value = PREFILL_TASK; }
    var w = el('startAt');
    if (w && PREFILL_WHEN && !w.value) { w.value = PREFILL_WHEN; }
    show(el('carryNote'));
    if (w) { try { w.focus(); } catch (e) {} }
  }

  // Collapse the double gesture (R-314). A person who typed a word and a time on
  // the homepage and pressed "Give my word" arrived here to the SAME form and had
  // to press it AGAIN — 0 of every visitor ever crossed that dead-end. The homepage
  // leaves a one-shot, ~60s, same-tab token proving that press; when it matches the
  // word this page was opened for, we give the word for them — the same path the
  // button runs — so they land on the warm confirmation, not a second form. Guests
  // are still created only on a real human gesture (the homepage press); a bare
  // /me/?task= load carries no token and creates nothing. One-shot: consumed before
  // use, so a reload never re-fires; any failure just leaves the prefilled form.
  var AUTO_WORD_TRIED = false;
  function readWordHandoff() {
    try {
      var raw = sessionStorage.getItem('focusbro_word_handoff');
      if (!raw) return null;
      sessionStorage.removeItem('focusbro_word_handoff');
      var h = JSON.parse(raw);
      if (!h || typeof h.ts !== 'number' || (Date.now() - h.ts) > 60000) return null;
      return h;
    } catch (e) { return null; }
  }
  function maybeAutoGiveWord() {
    if (AUTO_WORD_TRIED) return;
    AUTO_WORD_TRIED = true;
    var h = readWordHandoff();
    if (!h) return;
    // Only honor a token for the very word this page was opened for — never fire a
    // stale gesture against a different task carried in the URL.
    if (PREFILL_TASK && h.t && h.t !== PREFILL_TASK) return;
    var t = el('title'), w = el('startAt');
    if (!t || !t.value.trim() || !w || !w.value.trim()) return;
    giveWord({ auto: true });
  }

  // The next-word bridge never guesses a task, time, or channel and never
  // auto-commits. One tap simply moves the person into the composer, preserving
  // anything they have already typed.
  function focusNextWord() {
    hide(el('commitMsg')); hide(el('commitErr'));
    var form = el('commitForm');
    if (form) {
      try { form.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
    }
    var t = el('title');
    if (t) { try { t.focus(); } catch (e) {} }
  }

  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('[data-next-word]') : null;
    if (!btn) return;
    ev.preventDefault();
    focusNextWord();
  });

  // The return-nudge deep-link (#40, W4/L3): a person the bro reached out to has
  // tapped back in (?from=return). Read the marker once, up front, so it survives
  // the sign-in gate — then greet them with the specifically warm nudged-back
  // welcome and clear the marker so a reload never re-greets. Never names the gap.
  var FROM_RETURN = (function () {
    try { return new URLSearchParams(location.search).get('from') === 'return'; }
    catch (e) { return false; }
  })();
  function applyReturnWelcome() {
    if (!FROM_RETURN) return;
    show(el('returnWelcome'));
    // Drop just the marker (keep any ?task= prefill) so a refresh won't re-greet.
    try {
      var u = new URL(location.href);
      u.searchParams.delete('from');
      history.replaceState(null, '', u.pathname + u.search + u.hash);
    } catch (e) {}
  }

  // The person-side twin of the coach "back and moving" cue (R-252): a person the
  // bro reached out to during a quiet stretch has come back UNDER THEIR OWN STEAM —
  // no ?from=return deep-link. The server confirms it's a genuine homecoming (and
  // closes the episode so a reload never re-greets), and we open the SAME warm
  // nudged-back welcome the deep-link shows — never naming the gap. Runs even on the
  // deep-link path so the server episode is consumed there too (no cross-session
  // re-greet). Non-fatal: any failure just leaves the ordinary re-entry door in place.
  var HOMECOMING = false;
  function loadHomecoming() {
    fetch('/api/accountability/homecoming', { headers: authHeaders() })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.homecoming) {
          HOMECOMING = true;
          show(el('returnWelcome'));
          refreshEntryDoors();
        }
      })
      .catch(function () {});
  }

  // The door, measured. An anonymous visitor is shown the FORM — the first word
  // creates a guest account on submit (a gesture, rate-limited server-side),
  // never on page load. A guest sees the claim card; a claimed account does not.
  var ANONYMOUS = false, GUEST = false;
  function enterAnonymous() {
    ANONYMOUS = true; GUEST = false;
    hide(el('signin')); show(el('app')); show(el('anonNote'));
    hide(el('signout')); hide(el('consentCard')); hide(el('claimCard')); hide(el('founderMetrics'));
    updateFirstRun([]);
    applyPrefill();
    maybeAutoGiveWord();
  }
  function startGuest() {
    return fetch('/auth/guest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.b.error || 'Could not start');
        ANONYMOUS = false; GUEST = true;
        hide(el('anonNote')); show(el('signout')); show(el('consentCard')); show(el('claimCard'));
        return res.b;
      });
  }
  // Check-ins are delivered by push. Ask on the gesture that earned it — the
  // first word — never on load; record what the browser said, so the funnel
  // shows how many words CAN be followed up. Best-effort: a word is saved
  // whether or not this succeeds.
  function urlBase64ToUint8Array(base64) {
    var padding = '='.repeat((4 - base64.length % 4) % 4);
    var raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function recordPushPermission(result) {
    try {
      fetch('/sync/events', { method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ events: [{ id: 'pp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), type: 'push_permission', at: new Date().toISOString(), result: result }] }) })
        .catch(function () {});
    } catch (e) {}
  }
  function ensurePush() {
    try {
      if (sessionStorage.getItem('focusbro_push_asked')) return;
      sessionStorage.setItem('focusbro_push_asked', '1');
    } catch (e) {}
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) { recordPushPermission('unsupported'); return; }
    if (Notification.permission === 'denied') { recordPushPermission('denied'); return; }
    navigator.serviceWorker.register('/sw.js')
      .then(function (reg) {
        return Notification.requestPermission().then(function (perm) {
          if (perm !== 'granted') { recordPushPermission(perm === 'denied' ? 'denied' : 'dismissed'); return null; }
          return fetch('/vapid/public-key').then(function (r) { return r.ok ? r.json() : null; }).then(function (k) {
            if (!k || !k.public_key) { recordPushPermission('not_configured'); return null; }
            return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(k.public_key) });
          });
        });
      })
      .then(function (sub) {
        if (!sub) return;
        var label = 'Web';
        try { label = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || 'Web'; } catch (e) {}
        return fetch('/notifications/subscribe', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ subscription: sub.toJSON ? sub.toJSON() : sub, device_label: label }) })
          .then(function (r) { recordPushPermission(r.ok ? 'granted' : 'failed'); });
      })
      .catch(function () { recordPushPermission('failed'); });
  }

  function enterApp(session) { ANONYMOUS = false; GUEST = !!(session && session.guest); hide(el('signin')); show(el('app')); hide(el('anonNote')); show(el('signout')); show(el('consentCard')); if (GUEST) show(el('claimCard')); else hide(el('claimCard')); applyPrefill(); applyReturnWelcome(); loadHomecoming(); loadStreak(); loadList(); loadKept(); loadConsent(); loadCeiling(); loadNoteSharing(); loadFounderMetrics(); maybeAutoGiveWord(); }

  function metricRate(rate) {
    return rate == null ? '—' : Math.round(Number(rate) * 100) + '%';
  }

  function loadFounderMetrics() {
    fetch('/api/internal/metrics?since_days=30', { headers: authHeaders() })
      .then(function (r) {
        if (!r.ok) return null;
        return r.json();
      })
      .then(function (body) {
        if (!body || !body.metrics) return;
        var m = body.metrics;
        var summary = el('founderMetricsSummary');
        summary.textContent =
          (m.totals.commitments_created || 0) + ' words · ' +
          (m.totals.checkins_delivered || 0) + ' check-ins · ' +
          metricRate(m.kept_word_rate) + ' kept · D1 ' +
          metricRate(m.retention && m.retention.d1 && m.retention.d1.rate) +
          ' · D7 ' + metricRate(m.retention && m.retention.d7 && m.retention.d7.rate);
        var decision = m.decision || {};
        var depth = decision.commitments || {};
        var delivery = decision.delivery || {};
        var response = decision.response || {};
        var recovery = decision.reschedule_recovery || {};
        var median = depth.median_per_user == null ? '—' : Number(depth.median_per_user);
        var channelDelivery = (delivery.by_channel || []).map(function (row) {
          return row.channel + ' ' + metricRate(row.rate);
        }).join(', ');
        el('founderDecisionSummary').textContent =
          'Learning gates: delivery ' + metricRate(delivery.rate) + ' (' +
          Number(delivery.delivered || 0) + '/' + Number(delivery.attempted || 0) +
          (channelDelivery ? '; ' + channelDelivery : '') + ') · median ' +
          median + ' words per activated person · ' +
          metricRate(response.rate) + ' recipients responded (' +
          Number(response.responded || 0) + '/' + Number(response.recipients || 0) + ') · ' +
          metricRate(recovery.rate) + ' moved words recovered (' +
          Number(recovery.recovered || 0) + '/' + Number(recovery.rescheduled || 0) + ').';
        var rows = (m.acquisition || []).map(function (a) {
          var attribution = a.attribution || {};
          var labelParts = [attribution.source || 'direct'];
          if (attribution.campaign) labelParts.push(attribution.campaign);
          if (attribution.content) labelParts.push('creative: ' + attribution.content);
          if (attribution.challenge) labelParts.push('challenge: ' + attribution.challenge);
          var label = labelParts.join(' / ');
          return '<tr>' +
            '<td>' + esc(label) + '</td>' +
            '<td>' + Number(a.landing_visits || 0) + '</td>' +
            '<td>' + Number(a.commitments_created || 0) + '</td>' +
            '<td>' + metricRate(a.activation_rate) + '</td>' +
            '<td>' + Number(a.checkins_delivered || 0) + '</td>' +
            '<td>' + metricRate(a.kept_word_rate) + '</td>' +
            '<td>' + metricRate(a.retention.d1.rate) + '</td>' +
            '<td>' + metricRate(a.retention.d7.rate) + '</td>' +
            '</tr>';
        });
        el('founderMetricsRows').innerHTML = rows.join('') ||
          '<tr><td colspan="8" class="muted">No acquisition activity in this window yet.</td></tr>';
        show(el('founderMetrics'));
      })
      .catch(function () {}); // Founder-only enhancement; never blocks the core loop.
  }

  var CONSENT_COPY = ${JSON.stringify(consentPanelCopy())};

  // ── Escalation ceiling (the wedge): the person caps how far the ladder may
  // ever climb, and we save it the instant they change it. A control, never a
  // demand — the default preserves the gentle push→one-text ladder.
  var CEILING_OPTS = ${JSON.stringify(escalationCeilingOptions())};
  function ceilingDescFor(v) {
    for (var i = 0; i < CEILING_OPTS.length; i++) { if (CEILING_OPTS[i].value === v) return CEILING_OPTS[i].desc; }
    return '';
  }
  function updateCeilingDesc() {
    var sel = el('ceiling'); var d = el('ceilingDesc');
    if (sel && d) d.textContent = ceilingDescFor(sel.value);
  }
  function loadCeiling() {
    var sel = el('ceiling');
    if (!sel) return;
    fetch('/api/escalation', { headers: authHeaders() })
      .then(function (r) { if (r.status === 401) throw new Error('unauthorized'); return r.json(); })
      .then(function (data) { if (data && data.ceiling) { sel.value = data.ceiling; } updateCeilingDesc(); })
      .catch(function () { updateCeilingDesc(); });
  }
  var ceilingSel = el('ceiling');
  if (ceilingSel) {
    ceilingSel.addEventListener('change', function () {
      updateCeilingDesc();
      hide(el('ceilingMsg'));
      fetch('/api/escalation', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ ceiling: ceilingSel.value })
      })
        .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
        .then(function (res) {
          var m = el('ceilingMsg');
          m.textContent = res.ok ? 'Got it — that’s the most I’ll do.' : (res.b.error || 'Could not save that just now — try again.');
          m.className = res.ok ? 'ok' : 'err';
          show(m);
        })
        .catch(function () { var m = el('ceilingMsg'); m.textContent = 'Could not save that just now — try again.'; m.className = 'err'; show(m); });
    });
  }

  // ── Coach own-words sharing: the person decides whether the note a coach can
  // send them may carry their own words from a kept word. Off unless they turn
  // it on; saved the instant they toggle it. A consent gift, never a default.
  function loadNoteSharing() {
    var box = el('noteSharing');
    if (!box) return;
    fetch('/api/coach/note-consent', { headers: authHeaders() })
      .then(function (r) { if (r.status === 401) throw new Error('unauthorized'); return r.json(); })
      .then(function (data) { box.checked = !!(data && data.shared); })
      .catch(function () {});
  }
  var noteSharingBox = el('noteSharing');
  if (noteSharingBox) {
    noteSharingBox.addEventListener('change', function () {
      hide(el('noteSharingMsg'));
      fetch('/api/coach/note-consent', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ shared: noteSharingBox.checked })
      })
        .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
        .then(function (res) {
          var m = el('noteSharingMsg');
          if (!res.ok) { noteSharingBox.checked = !noteSharingBox.checked; }
          m.textContent = res.ok
            ? (noteSharingBox.checked ? 'On — your coach can hear your words now. Change it any time.' : 'Off — your words stay with you.')
            : (res.b.error || 'Could not save that just now — try again.');
          m.className = res.ok ? 'ok' : 'err';
          show(m);
        })
        .catch(function () {
          noteSharingBox.checked = !noteSharingBox.checked;
          var m = el('noteSharingMsg'); m.textContent = 'Could not save that just now — try again.'; m.className = 'err'; show(m);
        });
    });
  }

  function fillHours(sel) {
    if (!sel) return;
    for (var h = 0; h < 24; h++) {
      var o = document.createElement('option');
      o.value = String(h);
      o.textContent = (h < 10 ? '0' + h : h) + ':00';
      sel.appendChild(o);
    }
  }

  function loadConsent() {
    fillHoursOnce();
    fetch('/api/consent', { headers: authHeaders() })
      .then(function (r) { if (r.status === 401) throw new Error('unauthorized'); return r.json(); })
      .then(function (data) {
        var text = (data && data.channels && data.channels.text) || null;
        if (!text) return;
        if (text.quiet_start != null) el('quietStart').value = String(text.quiet_start);
        if (text.quiet_end != null) el('quietEnd').value = String(text.quiet_end);
        var msg = el('consentMsg');
        if (text.status === 'granted') { msg.textContent = ''; el('agree').checked = true; }
        else if (text.status === 'revoked') { msg.textContent = CONSENT_COPY.optedOut; show(msg); }
      })
      .catch(function () {});
  }

  var _hoursFilled = false;
  function fillHoursOnce() {
    if (_hoursFilled) return;
    fillHours(el('quietStart')); fillHours(el('quietEnd'));
    _hoursFilled = true;
  }

  function tzGuess() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } }

  var consentForm = el('consentForm');
  if (consentForm) {
    consentForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      hide(el('consentMsg')); hide(el('consentErr'));
      if (!el('agree').checked) { var e0 = el('consentErr'); e0.textContent = CONSENT_COPY.needAgree; show(e0); return; }
      var phone = el('phone').value.trim();
      if (!phone) { var e1 = el('consentErr'); e1.textContent = CONSENT_COPY.needPhone; show(e1); return; }
      var qs = el('quietStart').value, qe = el('quietEnd').value;
      fetch('/api/consent', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({
          channel: 'text', agree: true, phone: phone,
          quiet_start: qs === '' ? null : Number(qs),
          quiet_end: qe === '' ? null : Number(qe),
          timezone: tzGuess()
        })
      })
        .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
        .then(function (res) {
          if (!res.ok) { var e = el('consentErr'); e.textContent = res.b.error || 'Could not save that.'; show(e); return; }
          var m = el('consentMsg'); m.textContent = res.b.message || CONSENT_COPY.savedOk; show(m);
        })
        .catch(function () { var e = el('consentErr'); e.textContent = 'Could not save that just now — try again.'; show(e); });
    });

    el('consentOptOut').addEventListener('click', function () {
      hide(el('consentMsg')); hide(el('consentErr'));
      fetch('/api/consent/opt-out', {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ channel: 'text' })
      })
        .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
        .then(function (res) {
          var m = el('consentMsg'); m.textContent = (res.ok && res.b.message) ? res.b.message : CONSENT_COPY.optedOut; show(m);
          el('agree').checked = false;
        })
        .catch(function () { var e = el('consentErr'); e.textContent = 'Could not update that just now — try again.'; show(e); });
    });
  }

  function toSignin() { try { localStorage.removeItem(TOKEN_KEY); } catch (e) {} show(el('signin')); hide(el('app')); }

  function resolve(id, outcome, extra) {
    var body = { outcome: outcome };
    if (extra) { for (var k in extra) body[k] = extra[k]; }
    var msgHost = document.querySelector('[data-msg="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    fetch('/api/commitments/' + encodeURIComponent(id) + '/checkin', {
      method: 'POST', headers: authHeaders(), body: JSON.stringify(body)
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
      .then(function (res) {
        if (msgHost) { msgHost.textContent = res.b.message || res.b.error || ''; msgHost.className = 'msg ' + (res.ok ? 'ok' : 'err'); }
        if (res.ok) {
          loadStreak(); loadKept();
          // Keep the ally's confirmation on screen long enough to be read.
          // Rendering the refreshed list immediately replaces the card and used
          // to erase the successful “not yet” / reschedule acknowledgement.
          window.setTimeout(loadList, 1200);
        }
      })
      .catch(function () { if (msgHost) { msgHost.textContent = 'Could not record that just now — your word still counts. Try again.'; msgHost.className = 'msg err'; } });
  }

  // Set a word down — a blameless exit. The streak is never touched.
  function release(id) {
    var msgHost = document.querySelector('[data-msg="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    fetch('/api/commitments/' + encodeURIComponent(id) + '/release', {
      method: 'POST', headers: authHeaders()
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
      .then(function (res) {
        if (msgHost) { msgHost.textContent = res.b.message || res.b.error || ''; msgHost.className = 'msg ' + (res.ok ? 'ok' : 'err'); }
        if (res.ok) { loadList(); }
      })
      .catch(function () { if (msgHost) { msgHost.textContent = 'Could not set that down just now — try again.'; msgHost.className = 'msg err'; } });
  }

  // "I'm on it" — keep the bro coming back a little out without moving the word
  // or touching the streak. Nothing in the list changes, so just show the warm
  // confirmation on the card. An optional stated length is sent as when_text and
  // read by the SAME parser as the SMS "on it, give me 20" path (R-277); no
  // length keeps today's quick default. The streak is never read or written.
  function snooze(id, whenText) {
    var msgHost = document.querySelector('[data-msg="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    fetch('/api/commitments/' + encodeURIComponent(id) + '/snooze', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify(whenText ? { when_text: whenText } : {})
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
      .then(function (res) {
        if (msgHost) { msgHost.textContent = res.b.message || res.b.error || ''; msgHost.className = 'msg ' + (res.ok ? 'ok' : 'err'); }
      })
      .catch(function () { if (msgHost) { msgHost.textContent = 'Could not set that reminder just now — try again.'; msgHost.className = 'msg err'; } });
  }

  // Pause a repeating rhythm — take a break without ending the word. Fully
  // reversible (Resume), streak untouched, so no confirm needed. Reload the list
  // so the card flips to its Paused state.
  function pause(id) {
    var msgHost = document.querySelector('[data-msg="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    fetch('/api/commitments/' + encodeURIComponent(id) + '/pause', {
      method: 'POST', headers: authHeaders()
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
      .then(function (res) {
        if (msgHost) { msgHost.textContent = res.b.message || res.b.error || ''; msgHost.className = 'msg ' + (res.ok ? 'ok' : 'err'); }
        if (res.ok) { loadList(); }
      })
      .catch(function () { if (msgHost) { msgHost.textContent = 'Could not pause that just now — try again.'; msgHost.className = 'msg err'; } });
  }

  // Resume a paused rhythm — welcome back. The next check-in is scheduled from
  // now; no backlog of the days away.
  function resume(id) {
    var msgHost = document.querySelector('[data-msg="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    fetch('/api/commitments/' + encodeURIComponent(id) + '/resume', {
      method: 'POST', headers: authHeaders()
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
      .then(function (res) {
        if (msgHost) { msgHost.textContent = res.b.message || res.b.error || ''; msgHost.className = 'msg ' + (res.ok ? 'ok' : 'err'); }
        if (res.ok) { loadList(); }
      })
      .catch(function () { if (msgHost) { msgHost.textContent = 'Could not resume that just now — try again.'; msgHost.className = 'msg err'; } });
  }

  // Reveal the inline edit form for a card (and hide any other open one).
  function openEdit(id) {
    var forms = document.querySelectorAll('.editform');
    for (var i = 0; i < forms.length; i++) {
      if (forms[i].getAttribute('data-edit') === id) show(forms[i]); else hide(forms[i]);
    }
  }
  function closeEdit(id) {
    var f = document.querySelector('[data-edit="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    if (f) hide(f);
  }

  // Save an in-place change. Sends only title/time/cadence; the streak is never
  // touched (an edit is not a resolution). Mirrors the create form's schedule
  // shape: a repeating word anchors to the picker's local time-of-day.
  function saveEdit(id) {
    var form = document.querySelector('[data-edit="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    if (!form) return;
    var msgHost = document.querySelector('[data-msg="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    var title = (form.querySelector('.e-title') || {}).value;
    var whenVal = (form.querySelector('.e-when') || {}).value;
    var repeat = (form.querySelector('.e-repeat') || {}).value || 'none';
    var iso = toISO(whenVal);
    if (!iso) {
      if (msgHost) { msgHost.textContent = 'When do you want this? Pick a time.'; msgHost.className = 'msg err'; }
      return;
    }
    var tz = 'UTC';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (x) {}
    var body = {
      title: (title || '').trim(),
      start_at: iso,
      recurrence: repeat,
      local_time: (whenVal || '').slice(11, 16),
      timezone: tz
    };
    fetch('/api/commitments/' + encodeURIComponent(id) + '/edit', {
      method: 'POST', headers: authHeaders(), body: JSON.stringify(body)
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
      .then(function (res) {
        if (msgHost) { msgHost.textContent = res.b.message || res.b.error || ''; msgHost.className = 'msg ' + (res.ok ? 'ok' : 'err'); }
        if (res.ok) { loadList(); }
      })
      .catch(function () { if (msgHost) { msgHost.textContent = 'Could not save that change just now — try again.'; msgHost.className = 'msg err'; } });
  }

  // Look at one word's momentum — its cadence, next check-in, and the kept
  // timeline for THIS word. Toggles the inline panel; a second tap closes it.
  // The API returns kept check-ins only, so there is never a miss list here.
  var DETAIL_KEPT_HEADING = ${JSON.stringify(detailKeptHeadingCopy())};
  var DETAIL_NEXT_LABEL = ${JSON.stringify(detailNextLabelCopy())};
  // Same warm "the door is still held" line the /me/ list card uses (R-233) —
  // reused verbatim so the list and this detail panel can never diverge on how a
  // passed-but-open check-in reads. NEVER "late"/"overdue".
  var DETAIL_NEXT_WAITING = ${JSON.stringify(listNextCheckinWaitingCopy())};
  var DETAIL_MOMENTUM_HEADING = ${JSON.stringify(detailMomentumHeadingCopy())};
  function openDetail(id) {
    var host = document.querySelector('[data-detail="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    if (!host) return;
    if (!host.classList.contains('hidden')) { hide(host); host.innerHTML = ''; return; }
    host.innerHTML = '<p class="muted">Loading…</p>';
    show(host);
    fetch('/api/commitments/' + encodeURIComponent(id) + '/detail', { headers: authHeaders() })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
      .then(function (res) {
        if (!res.ok) { host.innerHTML = '<p class="err">' + esc((res.b && res.b.error) || 'Could not load that word.') + '</p>'; return; }
        host.innerHTML = renderDetail(res.b);
      })
      .catch(function () { host.innerHTML = '<p class="err">Could not load that just now — try again.</p>'; });
  }
  function renderDetail(d) {
    var cadence = (d && d.cadence) || '';
    var next = (d && d.next_checkin) || null;
    var kept = (d && d.kept) || [];
    var html = '<div class="detailbody">';
    if (cadence) { html += '<div class="when">' + esc(cadence) + '</div>'; }
    // The next moment the bro shows up on THIS word. If that moment has already
    // passed but the check-in is still open (a slipped, quiet-hours- or
    // night-deferred delivery — the row stays pending, the door held), NEVER show
    // a stale past time that reads as a no-show: fall to the same warm "still
    // here" line the /me/ list card, coach roster, and report already use. A
    // future moment is still named outright. (Matches nextCheckinLineHTML.)
    if (next) {
      var nt = new Date(next).getTime();
      if (!isNaN(nt) && nt <= Date.now()) {
        html += '<div class="when waiting">' + esc(DETAIL_NEXT_WAITING) + '</div>';
      } else {
        html += '<div class="when">' + esc(DETAIL_NEXT_LABEL) + ': ' + esc(fmtWhen(next)) + '</div>';
      }
    }
    if (d && d.message) { html += '<p class="streakmsg">' + esc(d.message) + '</p>'; }
    // How long you've been keeping THIS word — the server sends a non-empty line
    // ONLY once it's a standing practice (kept-only, design-LAW-scanned); a young
    // or thin word sends '' and nothing shows, never a "since today".
    if (d && d.kept_since) { html += '<p class="keptsince">' + esc(d.kept_since) + '</p>'; }
    // This word's own momentum — the same shared sparkline as the /me/ card,
    // scoped to this one word. Shown only once it has a kept word, so a
    // never-yet-kept word isn't a chart of nothing.
    if (hasMomentum(d && d.momentum)) {
      html += '<div class="name" style="margin-top:8px;">' + esc(DETAIL_MOMENTUM_HEADING) + '</div>'
        + sparkBlockHTML(d.momentum);
    }
    if (kept.length) {
      html += '<div class="name" style="margin-top:8px;">' + esc(DETAIL_KEPT_HEADING) + '</div>';
      for (var i = 0; i < kept.length; i++) {
        html += '<div class="keptrow">'
          + '<div><span class="tick">✓</span><span class="when">' + esc(fmtWhen(kept[i].kept_at)) + '</span></div>'
          + (kept[i].note ? '<div class="when">' + esc(kept[i].note) + '</div>' : '')
          + '</div>';
      }
    }
    html += '</div>';
    return html;
  }

  // Action buttons (delegated).
  el('list').addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('button[data-act]') : null;
    if (!btn) return;
    ev.preventDefault();
    var id = btn.getAttribute('data-id');
    var act = btn.getAttribute('data-act');
    if (act === 'next-word') { focusNextWord(); return; }
    if (act === 'kept') { resolve(id, 'kept'); return; }
    if (act === 'kept-note') {
      // Keep the word AND carry the person's own words into its kept-note, so the
      // per-word history reads back in their voice — parity with the SMS "done,
      // finally filed the taxes 🎉" path. The plain "I did it" stays the instant
      // keep; this is the opt-in "mark the moment" sibling. A cancelled prompt
      // (null) backs out entirely and leaves the fast tap free; a submitted value
      // — even empty — keeps the word, with the trimmed words as the note when
      // present. The server stores body.note the same way it stores an SMS reply's
      // words, and the streak is never read or written here (a keep is a keep).
      var word = prompt(${JSON.stringify(KEPT_NOTE_PROMPT)});
      if (word === null) return;
      var trimmed = word.trim();
      resolve(id, 'kept', trimmed ? { note: trimmed } : undefined);
      return;
    }
    if (act === 'snooze') {
      // "I'm on it" — ask, gently and optionally, how long they need so the bro
      // checks back WHEN they said (in-app parity with the SMS "give me 20"
      // path, R-270/R-277). A cancelled prompt (null) backs out and leaves the
      // word exactly as it is; an empty answer keeps today's quick default
      // check-back; a stated length rides the server's shared snooze parser.
      // Never a resolution, never a miss — the streak is untouched either way.
      var snoozeLen = prompt(${JSON.stringify(SNOOZE_LEN_PROMPT)});
      if (snoozeLen === null) return;
      var snoozeLenTrim = snoozeLen.trim();
      snooze(id, snoozeLenTrim ? snoozeLenTrim : undefined);
      return;
    }
    if (act === 'pause') { pause(id); return; }
    if (act === 'resume') { resume(id); return; }
    if (act === 'edit') { openEdit(id); return; }
    if (act === 'view') { openDetail(id); return; }
    if (act === 'edit-save') { saveEdit(id); return; }
    if (act === 'edit-cancel') { closeEdit(id); return; }
    if (act === 'missed') {
      // “Not yet” is an opening, never a terminal failure state. Ask for the
      // next workable moment and use the same warm reschedule path as “Move it.”
      var notYetWhen = prompt(${JSON.stringify(RESCHEDULE_PROMPT)});
      if (!notYetWhen || !notYetWhen.trim()) return;
      resolve(id, 'reschedule', { when_text: notYetWhen.trim() });
      return;
    }
    if (act === 'release') {
      if (window.confirm(${JSON.stringify(RELEASE_CONFIRM)})) { release(id); }
      return;
    }
    if (act === 'reschedule') {
      var when = prompt(${JSON.stringify(RESCHEDULE_PROMPT)});
      if (!when || !when.trim()) return;
      // Send the words as typed — the server reads them with the SAME parser as a
      // text reply, so a relative offset, a clock time, a weekday, and a date all
      // work in-app too (R-258/259/260 vocabulary, one parser per R-233).
      // A warm nudge comes back if the time can't be read; never a rigid format.
      resolve(id, 'reschedule', { when_text: when.trim() });
    }
  });

  el('toggleMode').addEventListener('click', function () {
    mode = (mode === 'login') ? 'register' : 'login';
    el('signinTitle').textContent = (mode === 'register') ? 'Create an account' : 'Sign in';
    el('signinSubmit').textContent = (mode === 'register') ? 'Create account' : 'Sign in';
    el('toggleMode').textContent = (mode === 'register') ? 'I already have an account' : 'Create an account';
    el('password').setAttribute('autocomplete', (mode === 'register') ? 'new-password' : 'current-password');
    hide(el('signinErr'));
  });

  el('signinForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    hide(el('signinErr'));
    var path = (mode === 'register') ? '/auth/register' : '/auth/login';
    fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: el('email').value.trim(), password: el('password').value })
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
      .then(function (res) {
        if (!res.ok) { throw new Error(res.b.error || 'Sign in failed'); }
        try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
        enterApp({ guest: false });
      })
      .catch(function (e) { var n = el('signinErr'); n.textContent = e.message || 'Sign in failed'; show(n); });
  });

  // The word, given. Shared by the manual submit and the homepage-handoff auto-
  // complete (maybeAutoGiveWord) so both travel exactly ONE path — guest creation,
  // the POST, the warm confirmation, and the push ask never diverge. Returns a
  // Promise so the auto path can stay quiet on the one failure it must not shout:
  // a missing time (that only happens on a manual submit; the auto path never
  // fires without a prefilled "when").
  function giveWord(opts) {
    var auto = !!(opts && opts.auto);
    hide(el('commitMsg')); hide(el('commitErr'));
    // The very first "when" now speaks the same warm language as the reschedule
    // and the text channel — a relative offset, a clock time, a weekday, and a
    // date all land here. The server runs the shared parseWhenReply; for a
    // repeating word it derives the same-time-each-day anchor from the resolved
    // instant, so no separate local_time here.
    var whenText = el('startAt').value.trim();
    if (!whenText) {
      if (!auto) { var e0 = el('commitErr'); e0.textContent = 'When do you want to start? Try something like ${inAppWhenExamplesText()}.'; show(e0); }
      return Promise.resolve();
    }
    var tz = 'UTC';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (x) {}
    var repeat = el('repeat').value;
    var payload = {
      title: el('title').value.trim(),
      when_text: whenText,
      persona: el('persona').value,
      channel: el('channel').value,
      recurrence: repeat,
      timezone: tz,
      attribution: ATTRIBUTION
    };
    return (ANONYMOUS ? startGuest() : Promise.resolve(null))
      .then(function () {
        return fetch('/api/commitments', { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
      })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
      .then(function (res) {
        if (!res.ok) { var e = el('commitErr'); e.textContent = res.b.error || 'Could not save that.'; show(e); return; }
        var m = el('commitMsg'); m.textContent = res.b.message || 'Got it — I’ll check in.'; show(m);
        el('title').value = ''; el('startAt').value = ''; hide(el('carryNote'));
        loadStreak(); loadList(); loadKept(); loadConsent();
        if (payload.channel === 'push') ensurePush();
      })
      .catch(function (err) { var e = el('commitErr'); e.textContent = (err && err.message) || 'Could not save that commitment. Try again in a moment.'; show(e); });
  }
  el('commitForm').addEventListener('submit', function (ev) { ev.preventDefault(); giveWord(); });

  el('claimForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    hide(el('claimErr')); hide(el('claimMsg'));
    fetch('/auth/claim', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ email: el('claimEmail').value.trim(), password: el('claimPassword').value })
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
      .then(function (res) {
        if (!res.ok) { var e = el('claimErr'); e.textContent = res.b.error || 'Could not save the account.'; show(e); return; }
        GUEST = false;
        el('claimForm').classList.add('hidden');
        var m = el('claimMsg'); m.textContent = 'Saved. Your word now follows you — check your inbox to confirm your email.'; show(m);
      })
      .catch(function () { var e = el('claimErr'); e.textContent = 'Could not save the account. Try again in a moment.'; show(e); });
  });

  el('signinLink').addEventListener('click', function (ev) { ev.preventDefault(); hide(el('app')); show(el('signin')); });

  el('signout').addEventListener('click', function (ev) {
    ev.preventDefault();
    var currentToken = token();
    var headers = {};
    if (currentToken) headers.Authorization = 'Bearer ' + currentToken;
    fetch('/auth/logout', {
      method: 'POST',
      headers: headers
    }).catch(function () {
      // Local sign-out must remain available during a network outage. The
      // server credential expires or can be revoked with logout-all later.
    }).then(toSignin);
  });

  // No session: the FORM, not a password. The first word creates the guest
  // account on submit (see startGuest). Returning people take the sign-in link.
  function showSigninDoor() { enterAnonymous(); }
  function enterFromSession(response) {
    return response.json().then(function (body) { enterApp(body); }).catch(function () { enterApp(null); });
  }

  function restoreSession() {
    var legacyToken = token();
    if (legacyToken) {
      fetch('/auth/exchange', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + legacyToken }
      }).then(function (response) {
        if (!response.ok) throw new Error('Legacy exchange rejected');
        try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
        enterApp({ guest: false });
      }).catch(function () {
        // A rejected legacy token is no longer useful or safe to retain. The
        // cookie check still recovers a session created in another tab.
        try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
        fetch('/auth/session').then(function (response) {
          if (response.ok) enterFromSession(response); else showSigninDoor();
        }).catch(showSigninDoor);
      });
      return;
    }

    fetch('/auth/session').then(function (response) {
      if (response.ok) enterFromSession(response); else showSigninDoor();
    }).catch(showSigninDoor);
  }

  restoreSession();
})();
</script>
</body></html>`;
}
