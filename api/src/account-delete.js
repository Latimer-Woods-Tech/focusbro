// ════════════════════════════════════════════════════════════
// ACCOUNT DELETION — the in-app path and the public request page (Google Play)
// ════════════════════════════════════════════════════════════
// Google Play's User Data policy requires two things of an app with accounts:
//   1. a way, inside the app, to delete the account AND the data stored with it;
//   2. a web page where someone can request that deletion (the URL entered in
//      Play Console → Data safety → "Delete account URL").
// Partial retention is allowed only when it is disclosed.
//
//   POST /api/account/delete  — the signed-in person deletes their own account.
//                               ONE D1 batch: every row that belongs to them, in
//                               every table, goes — except a Pro purchase, whose
//                               money facts are kept for tax records with the
//                               link to the person replaced by a tombstone.
//   GET  /account/delete      — public: how to delete in the app/site, and the
//                               email path for someone who cannot sign in.
//   GET  /account/deleted     — "Your account is gone." (where the flow lands)
//   GET  /account-delete.js   — the /me/ section's clicks (first-party script;
//                               no inline script, so CSP can be enforced).
//
// The plan below is the single source of truth for WHAT is deleted. It names
// every table the schema has. account-delete.test.js builds the real schema
// (migrations/ + the Worker's runtime init) and FAILS when a table exists that
// the plan does not name — so a new migration that adds a user-keyed table
// cannot ship without deciding what deletion does with it.
//
// Copy follows the design law: plain, no guilt, no "are you sure you want to
// leave us", no "AI".

import { pageShellStyle, pageNav } from './page-shell.js';
import { returnNudgeKey } from './checkins-cron.js';

export const ACCOUNT_DELETE_CONFIRM_WORD = 'DELETE';
export const ACCOUNT_DELETE_SUPPORT_EMAIL = 'support@focusbro.net';
export const ACCOUNT_DELETE_PUBLIC_PATH = '/account/delete';
export const ACCOUNT_DELETED_PATH = '/account/deleted';
/** Prefix of the value that replaces user_id on a kept purchase record. */
export const DELETED_USER_TOMBSTONE_PREFIX = 'deleted:';

/**
 * EVERY table in the schema, and what account deletion does with it.
 *   action 'delete'      — the person's rows are deleted (`where` names them).
 *   action 'anonymise'   — rows are kept, the link to the person is removed.
 *   action 'none'        — the table holds nothing that belongs to a person
 *                          (`why` says so); nothing to do.
 * `where` uses ?1 = the user id. `needs` lists every table the statement reads
 * or writes: a statement whose tables are not all present in the live database
 * is skipped (production may lack a table that only the Worker's old runtime
 * init created), because one missing table would abort the whole batch.
 * Order matters: children before parents, `users` last.
 */
export const ACCOUNT_DELETION_PLAN = Object.freeze([
  // ── the accountability core ──
  { table: 'commitment_checkins', action: 'delete', where: 'user_id = ?1 OR commitment_id IN (SELECT id FROM commitments WHERE user_id = ?1)', needs: ['commitments'], what: 'check-ins, replies and notes' },
  { table: 'commitments', action: 'delete', where: 'user_id = ?1', what: 'the words they gave' },
  { table: 'accountability_streaks', action: 'delete', where: 'user_id = ?1', what: 'kept-word streak' },
  { table: 'escalation_prefs', action: 'delete', where: 'user_id = ?1', what: 'follow-up ceiling and default tone' },
  // ── phone + texts (Telnyx) ──
  { table: 'contact_consent', action: 'delete', where: 'user_id = ?1', what: 'text consent record, phone number, quiet hours' },
  { table: 'webhook_inbox', action: 'delete', where: null, phoneMatched: true, what: 'inbound texts from their phone number (Telnyx payloads)' },
  // ── coach links (both sides) ──
  { table: 'coach_clients', action: 'delete', where: 'coach_user_id = ?1 OR client_user_id = ?1', what: 'coach ↔ client links, as coach and as client' },
  { table: 'coach_note_consent', action: 'delete', where: 'user_id = ?1', what: 'note-sharing choice' },
  { table: 'operator_clients', action: 'delete', where: 'external_org_id = ?1 OR operator_id IN (SELECT operator_id FROM coach_operators WHERE user_id = ?1 AND operator_id NOT IN (SELECT operator_id FROM coach_operators WHERE user_id <> ?1))', needs: ['coach_operators'], what: 'their seat on a coach roster; a coach’s own roster' },
  { table: 'coach_checkin_config', action: 'delete', where: 'operator_id IN (SELECT operator_id FROM coach_operators WHERE user_id = ?1 AND operator_id NOT IN (SELECT operator_id FROM coach_operators WHERE user_id <> ?1))', needs: ['coach_operators'], what: 'a coach’s check-in script' },
  { table: 'operators', action: 'delete', where: 'id IN (SELECT operator_id FROM coach_operators WHERE user_id = ?1 AND operator_id NOT IN (SELECT operator_id FROM coach_operators WHERE user_id <> ?1))', needs: ['coach_operators'], what: 'a coach’s operator record (only when no other coach shares it)' },
  { table: 'coach_operators', action: 'delete', where: 'user_id = ?1', what: 'coach ↔ operator map' },
  // ── sync, devices, notifications ──
  { table: 'user_data_snapshots', action: 'delete', where: 'user_id = ?1', what: 'synced app data' },
  { table: 'sync_logs', action: 'delete', where: 'user_id = ?1', what: 'sync history' },
  { table: 'devices', action: 'delete', where: 'user_id = ?1', what: 'device names' },
  { table: 'push_subscriptions', action: 'delete', where: 'user_id = ?1', what: 'browser push addresses' },
  { table: 'notification_prefs', action: 'delete', where: 'user_id = ?1', what: 'notification settings' },
  { table: 'focus_events', action: 'delete', where: 'user_id = ?1', what: 'synced focus sessions' },
  { table: 'user_streaks', action: 'delete', where: 'user_id = ?1', what: 'focus streak' },
  // A sent return nudge is recorded with user_id NULL (so it never counts as the
  // person's own activity) and their id in event_data — match that too (FBQ-07).
  // json_valid guards the extract: one malformed row must not fail the batch.
  { table: 'analytics_events', action: 'delete', where: "user_id = ?1 OR (user_id IS NULL AND event_type = 'return_nudge_sent' AND CASE WHEN json_valid(event_data) THEN json_extract(event_data, '$.user_id') END = ?1)", what: 'usage events tied to the account' },
  { table: 'return_nudge_latch', action: 'delete', where: 'user_id = ?1', what: 'when we last reached out after a quiet stretch' },
  // ── sign-in ──
  { table: 'sessions', action: 'delete', where: 'user_id = ?1', what: 'sign-in sessions' },
  { table: 'auth_action_tokens', action: 'delete', where: 'user_id = ?1', what: 'password-reset / verification tokens' },
  { table: 'api_keys', action: 'delete', where: 'user_id = ?1', what: 'API keys' },
  { table: 'audit_logs', action: 'delete', where: 'user_id = ?1', what: 'account audit trail' },
  { table: 'slack_integrations', action: 'delete', where: 'user_id = ?1', what: 'Slack connection' },
  // ── money ──
  { table: 'subscriptions', action: 'delete', where: 'user_id = ?1', what: 'dormant subscription record (never sold)' },
  { table: 'pro_purchases', action: 'anonymise', where: 'user_id = ?1', what: 'Pro purchase: amount, currency, Stripe session id, paid date kept for tax records; user link replaced by a tombstone' },
  // ── the account itself, last ──
  { table: 'users', action: 'delete', where: 'id = ?1', what: 'email, password hash, name, phone number' },
  // ── nothing personal ──
  { table: 'focus_presence', action: 'none', why: 'anonymous focus-room heartbeat (random client id, no account link), pruned on write' },
  { table: 'rate_limits', action: 'none', why: 'abuse-limit counters keyed by SHA-256 of an email or IP, no user link; each window lasts 15 minutes and dead rows are swept (FBQ-13)' },
  { table: 'd1_migrations', action: 'none', why: 'D1 migration ledger' },
  { table: 'sqlite_sequence', action: 'none', why: 'SQLite internal' },
]);

/** Tables the plan names, for the drift test. */
export function plannedTables() {
  return ACCOUNT_DELETION_PLAN.map((p) => p.table);
}

function randomToken() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function existingTables(env) {
  const res = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  return new Set(((res && res.results) || []).map((r) => r.name));
}

async function phonesFor(env, userId, tables) {
  const phones = new Set();
  const add = (v) => { if (typeof v === 'string' && v.trim()) phones.add(v.trim()); };
  try {
    if (tables.has('users')) add((await env.DB.prepare('SELECT phone FROM users WHERE id = ?').bind(userId).first() || {}).phone);
    if (tables.has('contact_consent')) {
      const rows = await env.DB.prepare('SELECT phone FROM contact_consent WHERE user_id = ?').bind(userId).all();
      for (const r of (rows && rows.results) || []) add(r.phone);
    }
  } catch (err) {
    console.warn('[account-delete] phone lookup failed:', err && err.message);
  }
  return [...phones];
}

/**
 * Build the statements for one person's deletion against the tables that exist.
 * Pure apart from the prepared statements; exported for the tests.
 * @returns {{ statements: object[], tombstone: string, plan: Array<{table:string, action:string}> }}
 */
export function buildDeletionStatements(env, userId, tables, phones = []) {
  const tombstone = `${DELETED_USER_TOMBSTONE_PREFIX}${randomToken()}`;
  const statements = [];
  const plan = [];
  for (const step of ACCOUNT_DELETION_PLAN) {
    if (step.action === 'none') continue;
    if (!tables.has(step.table)) continue;
    if ((step.needs || []).some((t) => !tables.has(t))) continue;
    if (step.phoneMatched) {
      if (!phones.length) continue;
      // A Telnyx inbound payload is the person's number + their message text.
      // Match the stored number as a whole JSON string value ("+1555…"), so a
      // longer number that merely contains it is never caught.
      const clauses = phones.map((_, i) => `instr(raw_payload, '"' || ?${i + 1} || '"') > 0`).join(' OR ');
      statements.push(env.DB.prepare(`DELETE FROM webhook_inbox WHERE provider = 'telnyx' AND (${clauses})`).bind(...phones));
    } else if (step.action === 'anonymise') {
      statements.push(env.DB.prepare(`UPDATE ${step.table} SET user_id = ?2 WHERE ${step.where}`).bind(userId, tombstone));
    } else {
      statements.push(env.DB.prepare(`DELETE FROM ${step.table} WHERE ${step.where}`).bind(userId));
    }
    plan.push({ table: step.table, action: step.action });
  }
  return { statements, tombstone, plan };
}

/**
 * Delete one account and everything stored with it, in ONE D1 batch (all or
 * nothing). KV entries keyed by the user are cleared afterwards, best-effort
 * (each expires on its own anyway).
 * @returns {Promise<{ deleted: boolean, tombstone: string, plan: object[] }>}
 */
export async function deleteAccount(env, userId) {
  if (!userId) throw new Error('userId required');
  const tables = await existingTables(env);
  const phones = await phonesFor(env, userId, tables);
  const { statements, tombstone, plan } = buildDeletionStatements(env, userId, tables, phones);
  await env.DB.batch(statements);
  const kv = env.KV_CACHE;
  if (kv && typeof kv.delete === 'function') {
    await Promise.all([`user:${userId}:latest`, `sync:upload:${userId}`, returnNudgeKey(userId)]
      .map((k) => kv.delete(k).catch(() => {})));
  }
  return { deleted: true, tombstone, plan };
}

// ── COPY (plain; no guilt; no "AI"; design-law tested) ──

export function accountDeleteCopy() {
  return {
    heading: 'Delete my account',
    intro: 'This deletes your account and everything stored with it, right away. It can’t be undone.',
    deletedLabel: 'What gets deleted',
    deleted: [
      'Your email, password, and name',
      'Every word you gave, its check-ins, your replies and notes, and your kept-word streak',
      'Your phone number, your OK to texts, and the texts you sent us',
      'Notification settings and the browser push addresses we send reminders to',
      'Synced data, devices, and sign-in sessions',
      'Coach connections, on both sides',
      'Usage events tied to your account',
    ],
    keptLabel: 'What we keep',
    kept: 'If you bought Pro, we keep the purchase record (amount, currency, date, and the Stripe receipt reference) because tax law requires it. It is no longer linked to you. Pro ends with the account.',
    deviceNote: 'Anything FocusBro saved only in this browser — timer history, local notes — stays on this device until you clear your browser data.',
    startButton: 'Delete my account',
    confirmLabel: 'Type DELETE to confirm',
    confirmButton: 'Delete everything',
    cancelButton: 'Keep my account',
    working: 'Deleting…',
    error: 'That didn’t go through, and nothing was deleted. Try again in a moment.',
    goneTitle: 'Your account is gone',
    goneBody: 'We deleted your account and the data stored with it.',
    goneKept: 'If you bought Pro, the purchase record stays for tax records, with no link to you.',
    goneAfter: 'The timer, sounds, and guides still work without an account.',
  };
}

/** Every user-facing string on the deletion surfaces — scanned by the design-law test. */
export function accountDeleteCopySurface() {
  const c = accountDeleteCopy();
  return [
    c.heading, c.intro, c.deletedLabel, ...c.deleted, c.keptLabel, c.kept, c.deviceNote,
    c.startButton, c.confirmLabel, c.confirmButton, c.cancelButton, c.working, c.error,
    c.goneTitle, c.goneBody, c.goneKept, c.goneAfter,
    ...publicPageStrings(),
  ];
}

/**
 * A document head with the shared skin but NO third-party stylesheet: these
 * pages run under the ENFORCED CSP (style-src 'self'), so the Google Fonts link
 * pageHead() carries would be refused. The font stack falls back cleanly.
 */
function head({ title, description, robots = 'noindex, nofollow', maxWidth = 680 }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="${robots}" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
${pageShellStyle({ maxWidth })}</head>`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The "Delete my account" card for the bottom of /me/. Hidden until
 * /account-delete.js confirms there is a signed-in account (guest included).
 */
export function renderMeDeleteSection() {
  const c = accountDeleteCopy();
  return `<div class="card hidden" id="deleteAccount">
  <h2 id="delete">${esc(c.heading)}</h2>
  <p class="muted">${esc(c.intro)}</p>
  <p class="line"><b>${esc(c.deletedLabel)}</b></p>
  <ul class="line">${c.deleted.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>
  <p class="line"><b>${esc(c.keptLabel)}</b></p>
  <p class="line">${esc(c.kept)}</p>
  <p class="muted">${esc(c.deviceNote)}</p>
  <div class="actions"><button type="button" class="secondary" id="deleteStart">${esc(c.startButton)}</button></div>
  <form id="deleteConfirmForm" class="hidden" autocomplete="off">
    <label for="deleteConfirmInput">${esc(c.confirmLabel)}</label>
    <input id="deleteConfirmInput" type="text" autocapitalize="characters" spellcheck="false" inputmode="text" />
    <div class="actions">
      <button type="submit" id="deleteConfirm" disabled>${esc(c.confirmButton)}</button>
      <button type="button" class="secondary" id="deleteCancel">${esc(c.cancelButton)}</button>
    </div>
  </form>
  <p class="err hidden" id="deleteErr"></p>
</div>`;
}

/**
 * /account-delete.js — the /me/ card's clicks. Shipped as a STRING (never
 * fn.toString(); the Worker bundler rewrites declarations — see guides/scripts.js).
 */
export const ACCOUNT_DELETE_SCRIPT = `(function () {
  'use strict';
  var d = document;
  var card = d.getElementById('deleteAccount');
  if (!card) return;
  var start = d.getElementById('deleteStart');
  var form = d.getElementById('deleteConfirmForm');
  var input = d.getElementById('deleteConfirmInput');
  var confirmBtn = d.getElementById('deleteConfirm');
  var cancel = d.getElementById('deleteCancel');
  var err = d.getElementById('deleteErr');
  var WORD = ${JSON.stringify(ACCOUNT_DELETE_CONFIRM_WORD)};
  var label = confirmBtn.textContent;
  function show(n) { if (n) n.classList.remove('hidden'); }
  function hide(n) { if (n) n.classList.add('hidden'); }
  function check() {
    // ?probe=1: a signed-out visitor gets 200 {authenticated:false}, not a 401 console error (FBQ-23).
    fetch('/auth/session?probe=1', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (b) {
      if (!b || !b.authenticated) { hide(card); return; }
      show(card);
      if (window.location.hash === '#delete') { try { card.scrollIntoView(); } catch (e) {} }
    }).catch(function () {});
  }
  start.addEventListener('click', function () { hide(start); show(form); hide(err); input.value = ''; confirmBtn.disabled = true; input.focus(); });
  cancel.addEventListener('click', function () { hide(form); show(start); hide(err); input.value = ''; });
  input.addEventListener('input', function () { confirmBtn.disabled = input.value.trim().toUpperCase() !== WORD; });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (input.value.trim().toUpperCase() !== WORD) return;
    confirmBtn.disabled = true; cancel.disabled = true; hide(err);
    confirmBtn.textContent = ${JSON.stringify(accountDeleteCopy().working)};
    fetch('/api/account/delete', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: WORD })
    }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      try { window.localStorage.removeItem('focusbro_token'); } catch (e2) {}
      // The server already deleted the push rows; this empties the caches, the
      // browser's subscription and the phone's schedule (FBQ-04 R3).
      return (window.FocusBroSW ? window.FocusBroSW.forget({}) : Promise.resolve()).then(function () {
        window.location.assign(${JSON.stringify(ACCOUNT_DELETED_PATH)});
      });
    }).catch(function () {
      confirmBtn.textContent = label; confirmBtn.disabled = false; cancel.disabled = false;
      err.textContent = ${JSON.stringify(accountDeleteCopy().error)};
      show(err);
    });
  });
  window.addEventListener('pageshow', check);
  check();
})();
`;

function publicPageStrings() {
  return [
    'Delete your FocusBro account',
    'You can delete your account yourself, at any time, in the app or on the website. It takes effect right away.',
    'In the app or on the website',
    'Sign in (or open the FocusBro app).',
    'Open Your word.',
    'Scroll to the bottom, tap Delete my account, type DELETE, and confirm.',
    'If you can’t sign in',
    `Email ${ACCOUNT_DELETE_SUPPORT_EMAIL} with the subject “Delete my account”. Send it from the email address on the account, and include the phone number you added for texts, if you added one. We delete the account and reply to confirm within 30 days. We never ask for your password.`,
    'A guest account (one started without an email) lives in the browser or app that started it: open Your word there and delete it the same way. If that browser or phone is gone, email us the phone number you added for texts, if any, and we’ll find and delete it.',
  ];
}

/** GET /account/delete — public, script-free, the URL for Play Console. */
export function renderAccountDeletePublicPage() {
  const c = accountDeleteCopy();
  const s = publicPageStrings();
  return `${head({ title: 'Delete your account — FocusBro', description: 'How to delete your FocusBro account and the data stored with it.', robots: 'index, follow' })}
<body>
${pageNav([{ href: '/', label: 'Home' }, { href: '/me/', label: 'Your word' }, { href: '/privacy.html', label: 'Privacy' }, { href: '/contact.html', label: 'Contact' }])}
<h1>${esc(s[0])}</h1>
<p class="intro">${esc(s[1])}</p>
<div class="card">
  <h2>${esc(s[2])}</h2>
  <ol class="line"><li>${esc(s[3])}</li><li>${esc(s[4]).replace('Your word', '<a href="/me/#delete">Your word</a>')}</li><li>${esc(s[5])}</li></ol>
</div>
<div class="card">
  <h2>${esc(c.deletedLabel)}</h2>
  <ul class="line">${c.deleted.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
  <h2>${esc(c.keptLabel)}</h2>
  <p class="line">${esc(c.kept)}</p>
  <p class="muted">${esc(c.deviceNote)}</p>
</div>
<div class="card" id="email">
  <h2>${esc(s[6])}</h2>
  <p class="line">${esc(s[7]).replace(ACCOUNT_DELETE_SUPPORT_EMAIL, `<a href="mailto:${ACCOUNT_DELETE_SUPPORT_EMAIL}?subject=Delete%20my%20account">${ACCOUNT_DELETE_SUPPORT_EMAIL}</a>`)}</p>
  <p class="muted">${esc(s[8])}</p>
</div>
<p class="footnote">FocusBro is built by Latimer Woods Tech. See the <a href="/privacy.html">Privacy Policy</a> for what we store and why.</p>
</body></html>`;
}

/** GET /account/deleted — where the in-app flow lands. */
export function renderAccountDeletedPage() {
  const c = accountDeleteCopy();
  return `${head({ title: 'Your account is gone — FocusBro', description: 'Your FocusBro account was deleted.', maxWidth: 640 })}
<body>
${pageNav([{ href: '/', label: 'Home' }, { href: '/guides/', label: 'Guides' }])}
<h1 id="accountGone">${esc(c.goneTitle)}</h1>
<div class="card">
  <p>${esc(c.goneBody)}</p>
  <p class="muted">${esc(c.goneKept)}</p>
  <p class="muted">${esc(c.deviceNote)}</p>
  <p>${esc(c.goneAfter)} <a href="/">Open the timer</a></p>
</div>
<p class="footnote">Questions: <a href="mailto:${ACCOUNT_DELETE_SUPPORT_EMAIL}">${ACCOUNT_DELETE_SUPPORT_EMAIL}</a></p>
<script src="/native-bridge.js" defer></script>
</body></html>`;
}

/**
 * Register the deletion routes.
 * @param {object} router itty-router
 * @param {object} ctx { getAuthToken, verifyToken, jsonResponse, responseWithCookie, expiredSessionCookie, scriptResponse }
 */
export function registerAccountDeleteRoutes(router, ctx) {
  const { getAuthToken, verifyToken, jsonResponse, responseWithCookie, expiredSessionCookie, scriptResponse } = ctx;
  const html = (body, cache) => new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': cache } });

  router.post('/api/account/delete', async (request, env) => {
    try {
      // Same-origin only (a cookie-authed mutation): the global guard already
      // rejects a cross-site cookie request; this also covers a bearer caller.
      const origin = request.headers.get('origin');
      if (origin && origin !== new URL(request.url).origin) return jsonResponse({ error: 'Forbidden' }, 403);
      if ((request.headers.get('sec-fetch-site') || '').toLowerCase() === 'cross-site') return jsonResponse({ error: 'Forbidden' }, 403);
      const contentType = request.headers.get('content-type') || '';
      if (!contentType.toLowerCase().startsWith('application/json')) {
        return jsonResponse({ error: 'Content-Type must be application/json' }, 415);
      }
      const token = getAuthToken(request);
      if (!token) return jsonResponse({ error: 'Unauthorized' }, 401);
      const payload = await verifyToken(token, env.JWT_SECRET, env);
      if (!payload || !payload.sub) return jsonResponse({ error: 'Invalid token' }, 401);
      let body = null;
      try { body = await request.json(); } catch { body = null; }
      if (!body || body.confirm !== ACCOUNT_DELETE_CONFIRM_WORD) {
        return jsonResponse({ error: `Send {"confirm":"${ACCOUNT_DELETE_CONFIRM_WORD}"} to delete this account.` }, 400);
      }
      await deleteAccount(env, payload.sub);
      return responseWithCookie(jsonResponse({ deleted: true }, 200), expiredSessionCookie());
    } catch (err) {
      console.error('[account-delete] failed:', err && err.message);
      return jsonResponse({ error: accountDeleteCopy().error }, 500);
    }
  });

  router.get(ACCOUNT_DELETE_PUBLIC_PATH, () => html(renderAccountDeletePublicPage(), 'public, max-age=300'));
  router.get(`${ACCOUNT_DELETE_PUBLIC_PATH}/`, () => new Response(null, { status: 301, headers: { Location: ACCOUNT_DELETE_PUBLIC_PATH } }));
  router.get(ACCOUNT_DELETED_PATH, () => html(renderAccountDeletedPage(), 'no-store'));
  router.get('/account-delete.js', (request, env) => scriptResponse(request, env, ACCOUNT_DELETE_SCRIPT));
}
