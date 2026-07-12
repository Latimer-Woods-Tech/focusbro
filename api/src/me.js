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
// ('focusbro_token'), and drives the existing /api/commitments +
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
} from './accountability.js';

/** The commitment lifecycle states the consumer view can render. */
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

/** The quiet "I'm setting this word down" action — a blameless exit, not a miss. */
export function releaseActionLabel() {
  return 'Set it down';
}

/** "I'm on it" — check back shortly. Keeps the bro present; not a resolution. */
export function snoozeActionLabel() {
  return 'I’m on it';
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
    firstRunHeadingCopy(),
    firstRunBodyCopy(),
    firstRunExamplesLabel(),
    ...firstRunExamples(),
    reentryHeadingCopy(),
    reentryBodyCopy(),
    emptyCommitmentsCopy(),
    streakHeadingCopy(),
    labels.kept, labels.missed, labels.reschedule,
    releaseActionLabel(),
    snoozeActionLabel(),
    pauseActionLabel(),
    resumeActionLabel(),
    editActionLabel(),
    detailActionLabel(),
    detailKeptHeadingCopy(),
    detailNextLabelCopy(),
    keptLogHeadingCopy(),
    keptLogEmptyCopy(),
    momentumSelfHeadingCopy(),
    momentumSelfIntroCopy(),
    momentumSelfSummaryCopy({ total: 0, days: 14 }),
    momentumSelfSummaryCopy({ total: 1, days: 14, peak: { count: 1 } }),
    momentumSelfSummaryCopy({ total: 9, days: 14, peak: { count: 3 } }),
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
  const RELEASE = releaseActionLabel();
  const SNOOZE = snoozeActionLabel();
  const PAUSE = pauseActionLabel();
  const RESUME = resumeActionLabel();
  const EDIT = editActionLabel();
  const VIEW = detailActionLabel();
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex, nofollow" />
<title>Your word — FocusBro</title>
<meta name="description" content="Give your word, keep it, and watch your kept-word streak grow. FocusBro checks in — an ally, never a scold." />
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; max-width: 720px; margin: 0 auto; padding: 24px; line-height: 1.55; color: #111827; }
  a { color: #4f46e5; }
  h1 { margin-bottom: 4px; }
  h2 { font-size: 18px; margin: 0 0 8px; }
  .intro { color: #4b5563; margin-top: 0; }
  .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px 18px; margin: 12px 0; }
  .streakwrap { display: flex; align-items: center; gap: 18px; }
  .streak { font-size: 44px; font-weight: 700; color: #4f46e5; line-height: 1; }
  .streak small { display: block; font-size: 12px; font-weight: 500; color: #6b7280; margin-top: 4px; }
  .streakmsg { color: #4b5563; font-size: 15px; }
  .name { font-weight: 600; }
  .when { color: #6b7280; font-size: 13px; }
  .muted { color: #6b7280; font-size: 13px; }
  .pill { display: inline-block; font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px; }
  .pill.active { background: #eef2ff; color: #4338ca; }
  .pill.kept   { background: #ecfdf5; color: #047857; }
  .pill.moved  { background: #eff6ff; color: #1d4ed8; }
  .pill.open   { background: #fff7ed; color: #b45309; }
  label { display: block; font-size: 13px; color: #374151; margin: 10px 0 4px; }
  input, select, button, textarea { font-size: 15px; padding: 9px 12px; border-radius: 8px; border: 1px solid #d1d5db; font-family: inherit; }
  input, select, textarea { width: 100%; box-sizing: border-box; }
  button { background: #4f46e5; color: #fff; border: none; cursor: pointer; }
  button.secondary { background: #f3f4f6; color: #374151; }
  button.small { padding: 6px 12px; font-size: 14px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  .row > div { flex: 1 1 220px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
  .hidden { display: none; }
  .err { color: #b91c1c; font-size: 14px; }
  .ok { color: #047857; font-size: 14px; }
  .commit { display: flex; justify-content: space-between; gap: 14px; align-items: flex-start; flex-wrap: wrap; }
  .footnote { margin-top: 28px; font-size: 13px; color: #6b7280; border-top: 1px solid #e5e7eb; padding-top: 14px; }
  .momentum-intro { color: #6b7280; font-size: 13px; margin: 0 0 8px; }
  .spark { display: flex; align-items: flex-end; gap: 3px; height: 44px; margin: 6px 0; }
  .spark-bar { flex: 1 1 0; min-width: 4px; background: #4f46e5; border-radius: 2px 2px 0 0; min-height: 3px; opacity: .85; }
  .spark-bar.zero { background: #e5e7eb; }
  .momentum-summary { color: #4b5563; font-size: 13px; margin: 4px 0 2px; }
  .keptrow { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px solid #f3f4f6; }
  .keptrow:last-child { border-bottom: none; }
  .keptrow .tick { color: #047857; font-weight: 700; margin-right: 8px; }
  .editform { margin-top: 12px; padding-top: 12px; border-top: 1px dashed #e5e7eb; }
  .editform label { margin-top: 6px; }
  .detail { margin-top: 12px; padding-top: 12px; border-top: 1px dashed #e5e7eb; }
  .detail .streakmsg { margin: 6px 0; }
  .firstrun { background: #f5f3ff; border-color: #ddd6fe; }
  .firstrun h2 { margin-bottom: 6px; }
  .seedrow { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
  .seed { background: #eef2ff; color: #4338ca; border: 1px solid #e0e7ff; border-radius: 999px; padding: 6px 12px; font-size: 14px; cursor: pointer; }
</style></head>
<body>
<nav style="font-size:14px;color:#374151;"><a href="/">Home</a> | <a href="/coach/">Coach view</a> | <a href="/about.html">About</a></nav>
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
  </div>

  <div class="card">
    <div class="streakwrap">
      <div class="streak" id="streakNum">0<small>${streakHeadingCopy()}</small></div>
      <div class="streakmsg" id="streakMsg"></div>
    </div>
  </div>

  <div class="card">
    <h2>${giveWordHeadingCopy()}</h2>
    <form id="commitForm">
      <label for="title">What will you do?</label>
      <input id="title" type="text" placeholder="start the taxes" maxlength="200" required />
      <div class="row">
        <div>
          <label for="startAt">When?</label>
          <input id="startAt" type="text" placeholder="in 30 min, tomorrow 9am, 3pm" autocomplete="off" required />
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
  </div>

  <div class="card" id="keptLog">
    <h2>${keptLogHeadingCopy()}</h2>
    <p class="streakmsg" id="keptMsg"></p>
    <div id="keptList"></div>
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
  var authHeaders = function () { return { 'Authorization': 'Bearer ' + token(), 'Content-Type': 'application/json' }; };

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
  }

  function loadStreak() {
    fetch('/api/accountability/streak', { headers: authHeaders() })
      .then(function (r) { if (r.status === 401) throw new Error('unauthorized'); return r.json(); })
      .then(renderStreak)
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
  function renderMomentum(m) {
    var card = el('momentumCard');
    var host = el('momentum');
    if (!host || !card) return;
    if (!m || !m.buckets || !m.buckets.length || !(Number(m.total) > 0)) {
      card.classList.add('hidden');
      host.innerHTML = '';
      return;
    }
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
    host.innerHTML = '<div class="momentum-intro">' + esc(m.intro || '') + '</div>'
      + '<div class="spark" role="img" aria-label="' + esc(label) + '">' + bars + '</div>'
      + '<div class="momentum-summary">' + esc(m.summary || '') + '</div>';
    card.classList.remove('hidden');
  }

  function loadKept() {
    fetch('/api/accountability/kept', { headers: authHeaders() })
      .then(function (r) { if (r.status === 401) throw new Error('unauthorized'); return r.json(); })
      .then(function (data) { renderKept(data); renderMomentum(data && data.momentum); })
      .catch(function () {});
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
        +     '<div class="when">' + esc(fmtWhen(c.start_at)) + esc(cadence) + '</div></div>'
        +   '<span class="pill ' + p.tone + '">' + esc(p.label) + '</span>'
        + '</div>';
      if (c.status === 'active') {
        // Pause is the "life happens" flex for a repeating rhythm only.
        var isRecur = (c.recurrence === 'daily' || c.recurrence === 'weekdays');
        html += '<div class="actions">'
          + '<button class="small" data-act="kept" data-id="' + esc(c.id) + '">' + esc(${JSON.stringify(A.kept)}) + '</button>'
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
        // Kept / rescheduled / released — no live actions, but you can still look
        // back at this word's momentum (its kept timeline). Never a miss list.
        html += '<div class="actions">'
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
  function updateFirstRun(commitments) {
    var state = entryState(commitments);
    var first = el('firstRun');
    var back = el('reentry');
    if (first) { if (state === 'first-word') show(first); else hide(first); }
    if (back) { if (state === 'welcome-back') show(back); else hide(back); }
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

  function enterApp() { hide(el('signin')); show(el('app')); loadStreak(); loadList(); loadKept(); loadConsent(); }

  var CONSENT_COPY = ${JSON.stringify(consentPanelCopy())};

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
        if (res.ok) { loadStreak(); loadList(); loadKept(); }
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

  // "I'm on it" — keep the bro coming back a few minutes out without moving the
  // word or touching the streak. Nothing in the list changes, so just show the
  // warm confirmation on the card.
  function snooze(id) {
    var msgHost = document.querySelector('[data-msg="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    fetch('/api/commitments/' + encodeURIComponent(id) + '/snooze', {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({})
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
    if (next) { html += '<div class="when">' + esc(DETAIL_NEXT_LABEL) + ': ' + esc(fmtWhen(next)) + '</div>'; }
    if (d && d.message) { html += '<p class="streakmsg">' + esc(d.message) + '</p>'; }
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
    if (act === 'kept') { resolve(id, 'kept'); return; }
    if (act === 'snooze') { snooze(id); return; }
    if (act === 'pause') { pause(id); return; }
    if (act === 'resume') { resume(id); return; }
    if (act === 'edit') { openEdit(id); return; }
    if (act === 'view') { openDetail(id); return; }
    if (act === 'edit-save') { saveEdit(id); return; }
    if (act === 'edit-cancel') { closeEdit(id); return; }
    if (act === 'missed') { resolve(id, 'missed'); return; }
    if (act === 'release') {
      if (window.confirm('Set this word down? No problem at all — your streak stays as it is, and you can start a new one whenever you’re ready.')) { release(id); }
      return;
    }
    if (act === 'reschedule') {
      var when = prompt('No problem — when do you want to try again? (e.g. in 30 min, tomorrow 9am, 3pm)');
      if (!when || !when.trim()) return;
      // Send the words as typed — the server reads them with the SAME parser as a
      // text reply, so "in 30 min" / "tomorrow 9am" / "3pm" all work in-app too.
      // A warm nudge comes back if the time can't be read; never a rigid format.
      resolve(id, 'reschedule', { when_text: when.trim() });
    }
  });

  el('toggleMode').addEventListener('click', function () {
    mode = (mode === 'login') ? 'register' : 'login';
    el('signinTitle').textContent = (mode === 'register') ? 'Create an account' : 'Sign in';
    el('signinSubmit').textContent = (mode === 'register') ? 'Create account' : 'Sign in';
    el('toggleMode').textContent = (mode === 'register') ? 'I already have an account' : 'Create an account';
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
        if (!res.ok || !res.b.token) { throw new Error(res.b.error || 'Sign in failed'); }
        try { localStorage.setItem(TOKEN_KEY, res.b.token); } catch (e) {}
        enterApp();
      })
      .catch(function (e) { var n = el('signinErr'); n.textContent = e.message || 'Sign in failed'; show(n); });
  });

  el('commitForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    hide(el('commitMsg')); hide(el('commitErr'));
    // The very first "when" now speaks the same warm language as the reschedule
    // and the text channel — "in 30 min", "tomorrow 9am", "3pm". The server runs
    // the shared parseWhenReply; for a repeating word it derives the same-time-
    // each-day anchor from the resolved instant, so no separate local_time here.
    var whenText = el('startAt').value.trim();
    if (!whenText) { var e = el('commitErr'); e.textContent = 'When do you want to start? Try “in 30 min”, “tomorrow 9am”, or “3pm”.'; show(e); return; }
    var tz = 'UTC';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (x) {}
    var repeat = el('repeat').value;
    fetch('/api/commitments', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({
        title: el('title').value.trim(),
        when_text: whenText,
        persona: el('persona').value,
        channel: el('channel').value,
        recurrence: repeat,
        timezone: tz
      })
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
      .then(function (res) {
        if (!res.ok) { var e = el('commitErr'); e.textContent = res.b.error || 'Could not save that.'; show(e); return; }
        var m = el('commitMsg'); m.textContent = res.b.message || 'Got it — I’ll check in.'; show(m);
        el('title').value = ''; el('startAt').value = '';
        loadStreak(); loadList();
      })
      .catch(function () { var e = el('commitErr'); e.textContent = 'Could not save that commitment. Try again in a moment.'; show(e); });
  });

  el('signout').addEventListener('click', function (ev) { ev.preventDefault(); toSignin(); });

  if (token()) { enterApp(); } else { toSignin(); }
})();
</script>
</body></html>`;
}
