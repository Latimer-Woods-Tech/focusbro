// ════════════════════════════════════════════════════════════
// FOCUSBRO PRO — a $9.99 ONE-TIME unlock, sold on the WEBSITE only
// ════════════════════════════════════════════════════════════
// Approved by the founder 2026-10-01. Stripe product prod_VMZ14lnJeKeFIM, one-time
// price in `PRO_PRICE_ID` (wrangler.toml [vars], not a secret). The worker secret
// `STRIPE_SECRET_KEY` is a RESTRICTED live key that can create / read / expire
// Checkout Sessions and can NOT create a webhook endpoint. So there is no
// webhook here, by design:
//
//   1. POST /api/pro/checkout creates a Checkout Session and records a
//      `pending` row in pro_purchases (migrations/0008_pro_purchases.sql).
//   2. reconcileProPurchases() READS each pending session back from Stripe and
//      grants Pro only when Stripe says it is paid AND the session names this
//      user AND carries metadata.app = 'focusbro'. It runs whenever anything
//      checks status (GET /api/pro/status, GET /pro/), so a buyer who closed the
//      tab before the return page loaded is Pro the next time they look.
//
// Fails CLOSED and calmly: with no key (or no price id) the page shows "Pro is
// not available right now" and the API answers 503 — never a 500, never a
// half-made session. Nothing here is the dormant subscription module
// (billing.js, "Cloud Sync Pro $3/mo", gated by BILLING_ENABLED) — that stays
// untouched beside this one.
//
// Google Play policy: the native app (mobile/, a Capacitor shell of this site,
// UA suffix `FocusBroApp/…`, and `html[data-native-app]` set by
// /native-bridge.js) must not sell, price, or point at a purchase. /pro/ renders
// a status-only page for the app, the checkout API refuses the app, and every
// buy/upgrade control carries `.pro-buy`, which the app hides with CSS. Pro
// bought on the web still unlocks in the app — it lives on the account.

import { pageShellStyle, pageNav, PRO_BUY_HIDE_CSS } from './page-shell.js';

export { PRO_BUY_HIDE_CSS };

export const PRO_PRICE_LABEL = '$9.99';
export const PRO_SITE_ORIGIN = 'https://focusbro.net';
export const PRO_SUCCESS_URL = `${PRO_SITE_ORIGIN}/pro/?session_id={CHECKOUT_SESSION_ID}`;
export const PRO_CANCEL_URL = `${PRO_SITE_ORIGIN}/pro/`;
export const PRO_METADATA_APP = 'focusbro';
export const STRIPE_API_BASE = 'https://api.stripe.com/v1';
/** Every Stripe call is bounded: a hung Stripe must never hang a page. */
export const STRIPE_TIMEOUT_MS = 8000;
/** Pending sessions examined per reconcile — bounds Stripe calls per request. */
export const RECONCILE_LIMIT = 5;
/** A paid purchase is re-read for refunds/disputes at most this often. */
export const REFUND_RECHECK_MS = 24 * 60 * 60 * 1000;
/** After a failed read, retry sooner than a day but not on every request. */
export const REFUND_RETRY_MS = 60 * 60 * 1000;
/** The native app's user-agent marker (mobile/capacitor.config.json appendUserAgent). */
export const NATIVE_APP_UA = /\bFocusBroApp\//;

// ── COPY (plain, warm; no "AI", no shame, no medical claims — design-law tested) ──

export function proFeatureList() {
  return [
    { title: 'Check-ins by text', desc: 'Get check-ins as a text, and if a nudge goes quiet, one warm text follow-up — only with your OK to texts, and never more than one.' },
    { title: 'Your full weekly report', desc: 'The shape of your week, your rhythms and what’s next, your own notes read back, and a copy you can share with a coach.' },
    { title: 'Saved mixes', desc: 'Name the soundscapes that work for you and bring them back in one tap.' },
  ];
}
export function proPriceCopy() { return `${PRO_PRICE_LABEL}, once. No subscription — it’s yours to keep.`; }
export function proFreeStaysCopy() { return 'Everything you use for free today stays free.'; }
export function proUnavailableCopy() { return 'Pro is not available right now. Everything you already use keeps working — check back soon.'; }
export function proActiveCopy() { return 'You’re Pro. Text follow-ups, the full weekly report, and saved mixes are on.'; }
export function proActiveNativeCopy() { return 'Pro is active on this account.'; }
export function proInactiveNativeCopy() { return 'Pro isn’t active on this account.'; }
export function proSignedOutCopy() { return 'Pro lives on your account, so it follows you to every device. Start one in a second — no email needed.'; }
export function proConfirmingCopy() { return 'Thanks — confirming your payment now. This page updates on its own.'; }
export function proClaimCopy() { return 'Add an email and a password so Pro stays with you on every device, even if this browser forgets you.'; }
export function proCheckoutErrorCopy() { return 'Checkout could not start just now — nothing was charged. Try again in a moment.'; }
export function proReportPreviewCopy() { return 'The full weekly report is part of Pro: the shape of your week, your rhythms and what’s next, your own notes read back, and a copy you can share with a coach.'; }
export function proCeilingNoteCopy() { return 'Text follow-ups are part of Pro. Your choice is saved, and it starts working the moment Pro is on.'; }
export function proChannelNoteCopy() { return 'Text check-ins are part of Pro. Until then this check-in arrives as a push notification.'; }

/** Every user-facing Pro string — scanned by the design-law test. */
export function proCopySurface() {
  return [
    ...proFeatureList().flatMap((f) => [f.title, f.desc]),
    proPriceCopy(), proFreeStaysCopy(), proUnavailableCopy(), proActiveCopy(),
    proActiveNativeCopy(), proInactiveNativeCopy(), proSignedOutCopy(),
    proConfirmingCopy(), proClaimCopy(), proCheckoutErrorCopy(),
    proReportPreviewCopy(), proCeilingNoteCopy(), proChannelNoteCopy(),
  ];
}

// ── ENTITLEMENT ──

/** True when this request comes from the FocusBro native app shell. */
export function isNativeAppRequest(request) {
  try { return NATIVE_APP_UA.test((request && request.headers && request.headers.get('user-agent')) || ''); } catch { return false; }
}

/** Pro can be SOLD only with both the restricted key and the price id present. */
export function proConfigured(env) {
  return Boolean(env && typeof env.STRIPE_SECRET_KEY === 'string' && env.STRIPE_SECRET_KEY
    && typeof env.PRO_PRICE_ID === 'string' && env.PRO_PRICE_ID);
}

/**
 * Read a user's Pro status from D1 alone (no Stripe call). Fails closed: a read
 * error reads as "not Pro" — the free product is never broken by this lookup.
 * @returns {Promise<{pro:boolean, since:string|null}>}
 */
export async function readProStatus(env, userId) {
  if (!userId || !env || !env.DB) return { pro: false, since: null };
  try {
    let row;
    try {
      row = await env.DB.prepare(
        `SELECT paid_at FROM pro_purchases
          WHERE user_id = ? AND status = 'paid' AND refunded_at IS NULL
          ORDER BY paid_at ASC LIMIT 1`
      ).bind(userId).first();
    } catch (colErr) {
      // Migration 0016 not applied yet: behave exactly as before it (never lock paid people out).
      if (!/refunded_at/.test(String(colErr && colErr.message))) throw colErr;
      row = await env.DB.prepare(
        `SELECT paid_at FROM pro_purchases WHERE user_id = ? AND status = 'paid' ORDER BY paid_at ASC LIMIT 1`
      ).bind(userId).first();
    }
    return row ? { pro: true, since: row.paid_at || null } : { pro: false, since: null };
  } catch (err) {
    console.warn('[pro] status read unavailable:', err && err.message);
    return { pro: false, since: null };
  }
}

/** Convenience: is this user Pro? (D1 only, fails closed.) */
export async function isProUser(env, userId) {
  return (await readProStatus(env, userId)).pro;
}

// ── STRIPE (restricted key; form-encoded; every call bounded + caught) ──

/**
 * One Stripe API call. Never throws: a network error, timeout, or non-JSON body
 * comes back as { ok:false, status, error }. The key is never logged.
 */
export async function stripeRequest(env, path, { method = 'GET', form = null, timeoutMs = STRIPE_TIMEOUT_MS } = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`${STRIPE_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: controller ? controller.signal : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { ok: Boolean(res.ok) && data !== null, status: res.status, data };
  } catch (err) {
    const timedOut = err && err.name === 'AbortError';
    return { ok: false, status: 0, data: null, error: timedOut ? 'timeout' : 'network' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A Checkout Session URL we are willing to send a browser to. */
export function isStripeCheckoutUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'checkout.stripe.com' || u.hostname.endsWith('.stripe.com'));
  } catch { return false; }
}

/**
 * Reconcile this user's pending purchases by reading each session back from
 * Stripe. Idempotent: every write is guarded by `status = 'pending'`, so a
 * replay changes nothing. Grants only on payment_status 'paid' + matching
 * client_reference_id + metadata.app; marks 'expired' when Stripe says so. Once
 * the user is Pro, any still-OPEN session of theirs is expired at Stripe so a
 * second tab can never take a second payment.
 * @returns {Promise<{checked:number, granted:number, expired:number}>}
 */
export async function reconcileProPurchases(env, userId, { nowISO } = {}) {
  const summary = { checked: 0, granted: 0, expired: 0 };
  if (!userId || !env || !env.DB) return summary;
  const now = nowISO || new Date().toISOString();
  let rows = [];
  try {
    const res = await env.DB.prepare(
      `SELECT id, stripe_session_id FROM pro_purchases
        WHERE user_id = ? AND status = 'pending'
        ORDER BY created_at DESC LIMIT ?`
    ).bind(userId, RECONCILE_LIMIT).all();
    rows = (res && res.results) || [];
  } catch (err) {
    console.warn('[pro] pending read unavailable:', err && err.message);
    return summary;
  }
  if (!env.STRIPE_SECRET_KEY) return summary;
  if (!rows.length) { await recheckPaidPurchases(env, userId, { nowISO }); return summary; }

  const stillOpen = [];
  for (const row of rows) {
    const res = await stripeRequest(env, `/checkout/sessions/${encodeURIComponent(row.stripe_session_id)}`);
    if (!res.ok) continue; // Stripe unreachable: leave it pending, check again next time
    summary.checked++;
    const s = res.data || {};
    const ours = s.id === row.stripe_session_id
      && s.client_reference_id === userId
      && s.metadata && s.metadata.app === PRO_METADATA_APP;
    try {
      if (ours && (s.payment_status === 'paid' || s.payment_status === 'no_payment_required')) {
        const amount = Number.isFinite(Number(s.amount_total)) ? Number(s.amount_total) : null;
        const currency = typeof s.currency === 'string' ? s.currency : null;
        await env.DB.prepare(
          `UPDATE pro_purchases SET status = 'paid', paid_at = ?, amount_total = ?, currency = ?
            WHERE id = ? AND status = 'pending'`
        ).bind(now, amount, currency, row.id).run();
        summary.granted++;
      } else if (s.status === 'expired') {
        await env.DB.prepare(
          `UPDATE pro_purchases SET status = 'expired' WHERE id = ? AND status = 'pending'`
        ).bind(row.id).run();
        summary.expired++;
      } else if (ours && s.status === 'open') {
        stillOpen.push(row);
      }
    } catch (err) {
      console.error('[pro] reconcile write failed:', err && err.message);
    }
  }

  if (stillOpen.length && (await isProUser(env, userId))) {
    for (const row of stillOpen) {
      const res = await stripeRequest(env, `/checkout/sessions/${encodeURIComponent(row.stripe_session_id)}/expire`, { method: 'POST', form: {} });
      if (!res.ok) continue;
      try {
        await env.DB.prepare(
          `UPDATE pro_purchases SET status = 'expired' WHERE id = ? AND status = 'pending'`
        ).bind(row.id).run();
        summary.expired++;
      } catch (err) {
        console.error('[pro] expire write failed:', err && err.message);
      }
    }
  }
  await recheckPaidPurchases(env, userId, { nowISO });
  return summary;
}

/**
 * Decide from an expanded Checkout Session whether the money came back:
 * a FULL refund (Stripe sets charge.refunded only when the whole amount is
 * refunded) or a dispute the customer won. A partial refund, an open dispute, a
 * missing/unexpanded payment (e.g. a 100%-off code has no charge) is NOT a revoke.
 */
export function chargeWasReturned(session) {
  const pi = session && session.payment_intent;
  const charge = pi && typeof pi === 'object' ? pi.latest_charge : null;
  if (!charge || typeof charge !== 'object') return false;
  if (charge.refunded === true) return true;
  if (Number(charge.amount) > 0 && Number(charge.amount_refunded) >= Number(charge.amount)) return true;
  const d = charge.dispute;
  return Boolean(d && typeof d === 'object' && (d.status === 'lost' || d.status === 'charge_refunded'));
}

/**
 * Re-read each PAID purchase (at most once per REFUND_RECHECK_MS) and revoke on
 * a full refund / lost dispute. READ-ONLY at Stripe. Fail safe: a failed or
 * unrecognisable read changes nothing about Pro (it only schedules an earlier retry).
 * @returns {Promise<{checked:number, revoked:number}>}
 */
export async function recheckPaidPurchases(env, userId, { nowISO } = {}) {
  const summary = { checked: 0, revoked: 0 };
  if (!userId || !env || !env.DB || !env.STRIPE_SECRET_KEY) return summary;
  const nowMs = nowISO ? Date.parse(nowISO) : Date.now();
  const now = new Date(nowMs).toISOString();
  let rows = [];
  try {
    const res = await env.DB.prepare(
      `SELECT id, stripe_session_id FROM pro_purchases
        WHERE user_id = ? AND status = 'paid' AND refunded_at IS NULL
          AND (refund_checked_at IS NULL OR refund_checked_at < ?)
        ORDER BY paid_at ASC LIMIT ?`
    ).bind(userId, new Date(nowMs - REFUND_RECHECK_MS).toISOString(), RECONCILE_LIMIT).all();
    rows = (res && res.results) || [];
  } catch (err) {
    console.warn('[pro] refund check unavailable:', err && err.message);
    return summary;
  }
  for (const row of rows) {
    const res = await stripeRequest(env, `/checkout/sessions/${encodeURIComponent(row.stripe_session_id)}?expand[]=payment_intent.latest_charge.dispute`);
    const s = res.data || {};
    const ours = res.ok && s.id === row.stripe_session_id && s.client_reference_id === userId
      && s.metadata && s.metadata.app === PRO_METADATA_APP;
    try {
      if (ours && chargeWasReturned(s)) {
        await env.DB.prepare(`UPDATE pro_purchases SET refunded_at = ?, refund_checked_at = ? WHERE id = ? AND refunded_at IS NULL`).bind(now, now, row.id).run();
        summary.revoked++;
      } else {
        // Checked and still good — or the read failed (never revoke on an error): retry sooner.
        const stamp = ours ? now : new Date(nowMs - REFUND_RECHECK_MS + REFUND_RETRY_MS).toISOString();
        await env.DB.prepare(`UPDATE pro_purchases SET refund_checked_at = ? WHERE id = ?`).bind(stamp, row.id).run();
      }
      if (ours) summary.checked++;
    } catch (err) {
      console.error('[pro] refund write failed:', err && err.message);
    }
  }
  return summary;
}

/**
 * Start a Pro checkout for a signed-in user.
 * @returns {Promise<{status:number, body:object}>}
 */
export async function startProCheckout(env, { userId, generateUUID, nowISO } = {}) {
  if (!proConfigured(env)) return { status: 503, body: { error: proUnavailableCopy(), available: false } };
  // Reconcile FIRST: a buyer who paid and closed the tab must never be sold Pro twice.
  await reconcileProPurchases(env, userId, { nowISO });
  const current = await readProStatus(env, userId);
  if (current.pro) return { status: 409, body: { pro: true, since: current.since } };

  let user = null;
  try {
    user = await env.DB.prepare('SELECT email, is_guest FROM users WHERE id = ?').bind(userId).first();
  } catch (err) {
    console.error('[pro] user read failed:', err && err.message);
    return { status: 503, body: { error: proCheckoutErrorCopy() } };
  }
  const realEmail = user && !Number(user.is_guest) && typeof user.email === 'string'
    && !user.email.endsWith('.invalid') ? user.email : null;

  const form = {
    mode: 'payment',
    'line_items[0][price]': env.PRO_PRICE_ID,
    'line_items[0][quantity]': '1',
    client_reference_id: userId,
    'metadata[app]': PRO_METADATA_APP,
    'metadata[user_id]': userId,
    success_url: PRO_SUCCESS_URL,
    cancel_url: PRO_CANCEL_URL,
    allow_promotion_codes: 'true',
  };
  if (realEmail) form.customer_email = realEmail;

  const res = await stripeRequest(env, '/checkout/sessions', { method: 'POST', form });
  const session = res.data || {};
  if (!res.ok || typeof session.id !== 'string' || !isStripeCheckoutUrl(session.url)) {
    console.error('[pro] checkout session not created:', res.status, res.error || (session.error && session.error.type) || '');
    return { status: 502, body: { error: proCheckoutErrorCopy() } };
  }
  try {
    await env.DB.prepare(
      `INSERT INTO pro_purchases (id, user_id, stripe_session_id, status, created_at)
       VALUES (?, ?, ?, 'pending', ?)`
    ).bind(generateUUID(), userId, session.id, nowISO || new Date().toISOString()).run();
  } catch (err) {
    // Without the pending row we could not reconcile this payment — do not send them to pay.
    console.error('[pro] pending row write failed:', err && err.message);
    return { status: 503, body: { error: proCheckoutErrorCopy() } };
  }
  return { status: 200, body: { url: session.url } };
}

// ── /pro/ PAGE (server-rendered; no inline script — /pro.js does the clicks) ──

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sinceLine(since) {
  if (!since) return '';
  const d = new Date(String(since).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(since)) ? '' : 'Z'));
  if (Number.isNaN(d.getTime())) return '';
  return `<p class="muted">Since ${esc(d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }))}.</p>`;
}

/**
 * Render /pro/ for one state. Pure (no I/O) so the Worker and the smoke server
 * render the same bytes.
 * @param {{native?:boolean, available?:boolean, signedIn?:boolean, guest?:boolean,
 *          pro?:boolean, since?:string|null, returning?:boolean, buildSha?:string}} state
 */
export function renderProPage(state = {}) {
  const { native = false, available = false, signedIn = false, guest = false, pro = false, since = null, returning = false, buildSha = 'development' } = state;
  const view = pro ? 'pro' : native ? 'native-inactive' : !available ? 'unavailable' : !signedIn ? 'signed-out' : returning ? 'confirming' : 'buy';

  let body = '';
  if (pro) {
    body += `<div class="card"><h2>${esc(native ? proActiveNativeCopy() : proActiveCopy())}</h2>${sinceLine(since)}
  <div class="actions"><a href="/me/">Your words</a> <span aria-hidden="true">·</span> <a href="/me/report">Weekly report</a> <span aria-hidden="true">·</span> <a href="/">Sounds &amp; timer</a></div></div>`;
    if (guest) {
      body += `<div class="card" id="proClaim"><h2>Keep Pro on every device</h2><p class="muted">${esc(proClaimCopy())}</p>
  <form id="proClaimForm">
    <label for="proClaimEmail">Email</label>
    <input id="proClaimEmail" type="email" autocomplete="email" placeholder="you@example.com" required />
    <label for="proClaimPassword">Password</label>
    <input id="proClaimPassword" type="password" autocomplete="new-password" minlength="8" placeholder="at least 8 characters" required />
    <div class="actions"><button type="submit" id="proClaimSubmit">Save my account</button></div>
  </form>
  <p class="err hidden" id="proClaimErr"></p><p class="ok hidden" id="proClaimMsg"></p></div>`;
    }
  } else if (native) {
    // Google Play: status only — no price, no purchase control, no link elsewhere.
    body += `<div class="card"><h2>${esc(proInactiveNativeCopy())}</h2>${signedIn ? '' : '<p class="muted"><a href="/me/">Sign in</a> to see this account’s status.</p>'}</div>`;
  } else {
    body += `<div class="card"><h2>What Pro adds</h2><ul class="pro-list">${proFeatureList()
      .map((f) => `<li><b>${esc(f.title)}</b><br><span class="muted">${esc(f.desc)}</span></li>`).join('')}</ul>
  <p class="muted">${esc(proFreeStaysCopy())}</p></div>`;
    if (!available) {
      body += `<div class="card"><p>${esc(proUnavailableCopy())}</p></div>`;
    } else {
      body += `<div class="card pro-buy" id="proOffer"><p class="pro-price">${esc(proPriceCopy())}</p>`;
      if (returning) body += `<p class="ok" id="proConfirming">${esc(proConfirmingCopy())}</p>`;
      if (signedIn) {
        body += `<div class="actions"><button type="button" id="proBuy" class="pro-buy">Get Pro — ${esc(PRO_PRICE_LABEL)} once</button></div>`;
      } else {
        body += `<p class="muted">${esc(proSignedOutCopy())}</p>
  <div class="actions"><button type="button" id="proStart">Start my account</button></div>
  <p class="muted"><a href="/me/">Have an account? Sign in</a>, then come back here.</p>`;
      }
      body += `<p class="err hidden" id="proErr"></p></div>`;
    }
  }

  return `<!doctype html>
<html lang="en"${native ? ' data-native-app="app"' : ''}><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex, nofollow" />
<title>FocusBro Pro</title>
<meta name="description" content="FocusBro Pro — text follow-ups, the full weekly report, and saved mixes." />
${pageShellStyle({ maxWidth: 640 })}
<style>.pro-list{padding-left:18px;margin:6px 0}.pro-list li{margin:8px 0}.pro-price{font-size:18px;font-weight:600;color:var(--text);margin:0 0 6px}</style>
</head>
<body>
${pageNav([{ href: '/', label: 'Home' }, { href: '/me/', label: 'Your words' }, { href: '/me/report', label: 'Weekly report' }])}
<main id="pro" data-view="${view}" data-pro="${pro ? '1' : '0'}" data-signed-in="${signedIn ? '1' : '0'}">
<h1>FocusBro Pro</h1>
${body}
</main>
<script src="/pro.js?v=${esc(buildSha)}" defer></script>
<script src="/native-bridge.js" defer></script>
</body></html>`;
}

/**
 * /pro.js — the page's clicks. Shipped as a STRING (never fn.toString(); the
 * Worker bundler rewrites declarations — see guides/scripts.js).
 */
export const PRO_PAGE_SCRIPT = `(function () {
  'use strict';
  var d = document;
  var root = d.getElementById('pro');
  if (!root) return;
  var view = root.getAttribute('data-view');
  try {
    window.sessionStorage.setItem('fb_pro_status', JSON.stringify({ pro: root.getAttribute('data-pro') === '1', signedIn: root.getAttribute('data-signed-in') === '1', at: Date.now() }));
  } catch (e) {}
  if (window.location.search.indexOf('session_id=') !== -1 && view === 'pro') {
    try { window.history.replaceState(null, '', '/pro/'); } catch (e) {}
  }
  function show(el, text) { if (!el) return; if (text != null) el.textContent = text; el.classList.remove('hidden'); }
  function postJSON(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { status: r.status, ok: r.ok, b: b || {} }; }); });
  }
  var err = d.getElementById('proErr');
  var buy = d.getElementById('proBuy');
  if (buy) buy.addEventListener('click', function () {
    buy.disabled = true;
    postJSON('/api/pro/checkout', {}).then(function (res) {
      if (res.status === 409) { window.location.replace('/pro/'); return; }
      if (res.ok && res.b.url) { window.location.assign(res.b.url); return; }
      buy.disabled = false;
      show(err, res.b.error || ${JSON.stringify(proCheckoutErrorCopy())});
    }).catch(function () { buy.disabled = false; show(err, ${JSON.stringify(proCheckoutErrorCopy())}); });
  });
  var start = d.getElementById('proStart');
  if (start) start.addEventListener('click', function () {
    start.disabled = true;
    postJSON('/auth/guest', {}).then(function (res) {
      if (res.ok) { window.location.reload(); return; }
      start.disabled = false;
      show(err, res.b.error || 'Could not start just now — try again in a moment.');
    }).catch(function () { start.disabled = false; show(err, 'Could not start just now — try again in a moment.'); });
  });
  var claim = d.getElementById('proClaimForm');
  if (claim) claim.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var cerr = d.getElementById('proClaimErr');
    if (cerr) cerr.classList.add('hidden');
    postJSON('/auth/claim', { email: d.getElementById('proClaimEmail').value.trim(), password: d.getElementById('proClaimPassword').value })
      .then(function (res) {
        if (!res.ok) { show(cerr, res.b.error || 'Could not save the account.'); return; }
        claim.classList.add('hidden');
        show(d.getElementById('proClaimMsg'), 'Saved. Pro is on this account wherever you sign in.');
      }).catch(function () { show(cerr, 'Could not save the account.'); });
  });
  if (view === 'confirming') {
    var tries = 0;
    var poll = function () {
      tries++;
      fetch('/api/pro/status', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (s) {
        if (s && s.pro) { window.location.replace('/pro/'); return; }
        if (tries < 10) setTimeout(poll, 3000);
      }).catch(function () { if (tries < 10) setTimeout(poll, 3000); });
    };
    setTimeout(poll, 2000);
  }
})();`;

// ── ROUTES ──

/**
 * Register /api/pro/*, /pro/ and /pro.js.
 * @param {object} router itty-router instance
 * @param {object} ctx { getAuthToken, verifyToken, jsonResponse, generateUUID, scriptResponse }
 */
export function registerProRoutes(router, ctx) {
  const { getAuthToken, verifyToken, jsonResponse, generateUUID, scriptResponse } = ctx;

  async function currentUserId(request, env) {
    const token = getAuthToken(request);
    if (!token) return null;
    try {
      const payload = await verifyToken(token, env.JWT_SECRET, env);
      return payload && payload.sub ? payload.sub : null;
    } catch { return null; }
  }

  async function isGuest(env, userId) {
    try {
      const row = await env.DB.prepare('SELECT is_guest FROM users WHERE id = ?').bind(userId).first();
      return Boolean(row && Number(row.is_guest));
    } catch { return false; }
  }

  router.post('/api/pro/checkout', async (request, env) => {
    try {
      if (isNativeAppRequest(request)) return jsonResponse({ error: 'Not available here.' }, 403);
      const contentType = request.headers.get('content-type') || '';
      if (!contentType.toLowerCase().startsWith('application/json')) {
        return jsonResponse({ error: 'Content-Type must be application/json' }, 415);
      }
      const origin = request.headers.get('origin');
      if (origin && origin !== new URL(request.url).origin) return jsonResponse({ error: 'Forbidden' }, 403);
      const userId = await currentUserId(request, env);
      if (!userId) return jsonResponse({ error: 'Unauthorized' }, 401);
      const result = await startProCheckout(env, { userId, generateUUID });
      return jsonResponse(result.body, result.status);
    } catch (err) {
      console.error('[pro] checkout error:', err && err.message);
      return jsonResponse({ error: proCheckoutErrorCopy() }, 503);
    }
  });

  router.get('/api/pro/status', async (request, env) => {
    try {
      const userId = await currentUserId(request, env);
      if (!userId) return jsonResponse({ pro: false, signedIn: false }, 200);
      try { await reconcileProPurchases(env, userId); } catch (err) { console.error('[pro] reconcile error:', err && err.message); }
      const { pro, since } = await readProStatus(env, userId);
      return jsonResponse({ pro, since, signedIn: true }, 200);
    } catch (err) {
      console.error('[pro] status error:', err && err.message);
      return jsonResponse({ pro: false, signedIn: false }, 200);
    }
  });

  router.get('/pro/', async (request, env) => {
    const url = new URL(request.url);
    if (url.pathname !== '/pro/') return new Response(null, { status: 301, headers: { Location: '/pro/' } });
    const native = isNativeAppRequest(request);
    let signedIn = false; let guest = false; let pro = false; let since = null;
    try {
      const userId = await currentUserId(request, env);
      if (userId) {
        signedIn = true;
        try { await reconcileProPurchases(env, userId); } catch (err) { console.error('[pro] reconcile error:', err && err.message); }
        ({ pro, since } = await readProStatus(env, userId));
        guest = await isGuest(env, userId);
      }
    } catch (err) {
      console.error('[pro] page state error:', err && err.message);
    }
    const html = renderProPage({
      native, available: proConfigured(env), signedIn, guest, pro, since,
      returning: url.searchParams.has('session_id'),
      buildSha: (env && env.BUILD_SHA) || 'development',
    });
    return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'User-Agent, Cookie' } });
  });
  router.get('/pro', async () => new Response(null, { status: 301, headers: { Location: '/pro/' } }));
  router.get('/pro.js', (request, env) => scriptResponse(request, env, PRO_PAGE_SCRIPT));
}
