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

/** The commitment lifecycle states the consumer view can render. */
export const COMMITMENT_STATUSES = ['active', 'kept', 'missed', 'rescheduled', 'released'];

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

/** Empty state — an invitation, never a scold about having done nothing. */
export function emptyCommitmentsCopy() {
  return "No words given yet. What’s one thing you’ll do — and when? I’ll check in.";
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
    emptyCommitmentsCopy(),
    streakHeadingCopy(),
    labels.kept, labels.missed, labels.reschedule,
    releaseActionLabel(),
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
          <input id="startAt" type="datetime-local" required />
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

  var STATUS = {
    active: { label: ${JSON.stringify(statusPresentation('active').label)}, tone: 'active' },
    kept: { label: ${JSON.stringify(statusPresentation('kept').label)}, tone: 'kept' },
    rescheduled: { label: ${JSON.stringify(statusPresentation('rescheduled').label)}, tone: 'moved' },
    missed: { label: ${JSON.stringify(statusPresentation('missed').label)}, tone: 'open' },
    released: { label: ${JSON.stringify(statusPresentation('released').label)}, tone: 'open' }
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
        html += '<div class="actions">'
          + '<button class="small" data-act="kept" data-id="' + esc(c.id) + '">' + esc(${JSON.stringify(A.kept)}) + '</button>'
          + '<button class="small secondary" data-act="missed" data-id="' + esc(c.id) + '">' + esc(${JSON.stringify(A.missed)}) + '</button>'
          + '<button class="small secondary" data-act="reschedule" data-id="' + esc(c.id) + '">' + esc(${JSON.stringify(A.reschedule)}) + '</button>'
          + '<button class="small secondary" data-act="release" data-id="' + esc(c.id) + '">' + esc(${JSON.stringify(RELEASE)}) + '</button>'
          + '</div>';
      } else if (c.status === 'missed') {
        // The open door — one tap to try again, never a dead end.
        html += '<div class="actions">'
          + '<button class="small" data-act="reschedule" data-id="' + esc(c.id) + '">Try again</button>'
          + '</div>';
      }
      html += '<div class="msg" data-msg="' + esc(c.id) + '"></div>';
      html += '</div>';
    }
    host.innerHTML = html;
  }

  function loadList() {
    fetch('/api/commitments', { headers: authHeaders() })
      .then(function (r) { if (r.status === 401) throw new Error('unauthorized'); return r.json(); })
      .then(function (data) { renderList((data && data.commitments) || []); })
      .catch(function () {});
  }

  function enterApp() { hide(el('signin')); show(el('app')); loadStreak(); loadList(); loadConsent(); }

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
        if (res.ok) { loadStreak(); loadList(); }
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

  // Action buttons (delegated).
  el('list').addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('button[data-act]') : null;
    if (!btn) return;
    ev.preventDefault();
    var id = btn.getAttribute('data-id');
    var act = btn.getAttribute('data-act');
    if (act === 'kept') { resolve(id, 'kept'); return; }
    if (act === 'missed') { resolve(id, 'missed'); return; }
    if (act === 'release') {
      if (window.confirm('Set this word down? No problem at all — your streak stays as it is, and you can start a new one whenever you’re ready.')) { release(id); }
      return;
    }
    if (act === 'reschedule') {
      var when = prompt('No problem — when do you want to try again? (e.g. 2026-07-07 14:00)');
      if (!when) return;
      var iso = toISO(when);
      if (!iso) { alert('Couldn’t read that time — try a format like 2026-07-07 14:00.'); return; }
      resolve(id, 'reschedule', { new_start_at: iso });
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
    var iso = toISO(el('startAt').value);
    if (!iso) { var e = el('commitErr'); e.textContent = 'When do you want to start? Pick a time.'; show(e); return; }
    var tz = 'UTC';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (x) {}
    // For a repeating check-in, anchor to the local time-of-day the picker holds
    // ("YYYY-MM-DDTHH:MM") so every occurrence lands at the same wall-clock time.
    var repeat = el('repeat').value;
    var localTime = (el('startAt').value || '').slice(11, 16);
    fetch('/api/commitments', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({
        title: el('title').value.trim(),
        start_at: iso,
        persona: el('persona').value,
        channel: el('channel').value,
        recurrence: repeat,
        local_time: localTime,
        timezone: tz
      })
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
      .then(function (res) {
        if (!res.ok) { var e = el('commitErr'); e.textContent = res.b.error || 'Could not save that.'; show(e); return; }
        var m = el('commitMsg'); m.textContent = res.b.message || 'Got it — I’ll check in.'; show(m);
        el('title').value = '';
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
