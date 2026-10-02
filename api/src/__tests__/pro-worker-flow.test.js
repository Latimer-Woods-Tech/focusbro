/**
 * FocusBro Pro — the whole purchase loop, driven through the WORKER's own
 * fetch() against a REAL SQLite schema built from migrations/ (0008 included),
 * with Stripe stubbed at `fetch`. Nothing here calls the live Stripe API.
 *
 * The paths a unit test cannot prove:
 *   - a guest starts, checks out, and is granted Pro by READING the session back
 *     (no webhook exists — the restricted key cannot create one);
 *   - the CLOSED-TAB buyer: never reaches the return page, and is Pro the next
 *     time anything checks status;
 *   - a session that names someone else, or a different app, never grants;
 *   - with no STRIPE_SECRET_KEY the surfaces are calm (200 page, 503 API), never 500;
 *   - the native app is never sold to (Google Play): status-only page, API refuses.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../index.js';
import { DatabaseSync, makeMigratedD1, makeKV } from './helpers/real-d1.js';

const suite = DatabaseSync ? describe : describe.skip;
const ORIGIN = 'https://focusbro.net';
const APP_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128 Mobile Safari/537.36 FocusBroApp/0.1';
const ctx = { waitUntil() {}, passThroughOnException() {} };

function makeEnv(over = {}) {
  return {
    DB: makeMigratedD1(),
    KV_CACHE: makeKV(),
    JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256-0123456789',
    STRIPE_SECRET_KEY: 'rk_test_stub_never_sent_anywhere',
    PRO_PRICE_ID: 'price_test_pro',
    BUILD_SHA: 'abc1234',
    ...over,
  };
}

// The Stripe double. `sessions` is what GET /v1/checkout/sessions/{id} answers.
function stubStripe() {
  const state = { created: [], expired: [], sessions: {}, nextId: 1, failCreate: false };
  const fetchSpy = vi.fn(async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith('https://api.stripe.com/v1/')) throw new Error('unexpected fetch ' + u);
    const method = (init.method || 'GET').toUpperCase();
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (method === 'POST' && u === 'https://api.stripe.com/v1/checkout/sessions') {
      if (state.failCreate) return json({ error: { type: 'api_error' } }, 500);
      const form = Object.fromEntries(new URLSearchParams(init.body));
      const id = `cs_test_${state.nextId++}`;
      state.created.push({ id, form, auth: init.headers.Authorization });
      state.sessions[id] = {
        id, status: 'open', payment_status: 'unpaid',
        client_reference_id: form.client_reference_id,
        metadata: { app: form['metadata[app]'], user_id: form['metadata[user_id]'] },
        amount_total: 999, currency: 'usd',
      };
      return json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
    }
    const exp = u.match(/\/checkout\/sessions\/([^/]+)\/expire$/);
    if (method === 'POST' && exp) {
      state.expired.push(exp[1]);
      state.sessions[exp[1]].status = 'expired';
      return json(state.sessions[exp[1]]);
    }
    const get = u.match(/\/checkout\/sessions\/([^/]+)$/);
    if (method === 'GET' && get && state.sessions[get[1]]) return json(state.sessions[get[1]]);
    return json({ error: { type: 'invalid_request_error' } }, 404);
  });
  return { state, fetchSpy };
}

function req(method, path, { cookie, ua, body, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.Cookie = cookie;
  if (ua) h['User-Agent'] = ua;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; h.Origin = ORIGIN; }
  return new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function startGuest(env) {
  const res = await worker.fetch(req('POST', '/auth/guest', { body: {} }), env, ctx);
  expect(res.status).toBe(201);
  const cookie = res.headers.get('Set-Cookie').split(';')[0];
  const { user_id: userId } = await res.json();
  return { cookie, userId };
}

const rows = (env, userId) => env.DB.sqlite.prepare('SELECT * FROM pro_purchases WHERE user_id = ? ORDER BY created_at').all(userId);

suite('FocusBro Pro — the purchase loop through the Worker', () => {
  let stripe;
  beforeEach(() => { stripe = stubStripe(); vi.stubGlobal('fetch', stripe.fetchSpy); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('a guest checks out, closes the tab, and is Pro the next time status is checked', async () => {
    const env = makeEnv();
    const { cookie, userId } = await startGuest(env);

    // Before buying: signed in, not Pro.
    let s = await (await worker.fetch(req('GET', '/api/pro/status', { cookie }), env, ctx)).json();
    expect(s).toMatchObject({ pro: false, signedIn: true });

    // Checkout: a one-time payment session for THIS user, THIS app.
    const co = await worker.fetch(req('POST', '/api/pro/checkout', { cookie, body: {} }), env, ctx);
    expect(co.status).toBe(200);
    const { url } = await co.json();
    expect(url).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
    const { form } = stripe.state.created[0];
    expect(form).toMatchObject({
      mode: 'payment',
      'line_items[0][price]': 'price_test_pro',
      'line_items[0][quantity]': '1',
      client_reference_id: userId,
      'metadata[app]': 'focusbro',
      'metadata[user_id]': userId,
      success_url: 'https://focusbro.net/pro/?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://focusbro.net/pro/',
      allow_promotion_codes: 'true',
    });
    expect(form).not.toHaveProperty('customer_email'); // a guest has no real address
    expect(rows(env, userId)).toEqual([expect.objectContaining({ stripe_session_id: 'cs_test_1', status: 'pending', paid_at: null })]);

    // Still open at Stripe → still not Pro, still pending.
    s = await (await worker.fetch(req('GET', '/api/pro/status', { cookie }), env, ctx)).json();
    expect(s.pro).toBe(false);

    // They pay, and close the tab before the return page loads.
    Object.assign(stripe.state.sessions.cs_test_1, { status: 'complete', payment_status: 'paid' });

    // The next status check — from any surface — reconciles and grants.
    s = await (await worker.fetch(req('GET', '/api/pro/status', { cookie }), env, ctx)).json();
    expect(s).toMatchObject({ pro: true, signedIn: true });
    expect(s.since).toBeTruthy();
    const [paid] = rows(env, userId);
    expect(paid).toMatchObject({ status: 'paid', amount_total: 999, currency: 'usd' });

    // Idempotent: checking again changes nothing and asks Stripe nothing.
    const callsBefore = stripe.fetchSpy.mock.calls.length;
    s = await (await worker.fetch(req('GET', '/api/pro/status', { cookie }), env, ctx)).json();
    expect(s.pro).toBe(true);
    expect(stripe.fetchSpy.mock.calls.length).toBe(callsBefore);
    expect(rows(env, userId)).toHaveLength(1);

    // Never sold twice.
    const again = await worker.fetch(req('POST', '/api/pro/checkout', { cookie, body: {} }), env, ctx);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ pro: true });

    // The page: Pro, and — for a guest — the prompt to claim so Pro is never lost.
    const page = await (await worker.fetch(req('GET', '/pro/', { cookie }), env, ctx)).text();
    expect(page).toContain('You’re Pro.');
    expect(page).toContain('id="proClaimForm"');
    expect(page).not.toContain('id="proBuy"');
  });

  it('the return page itself reconciles (session_id in the URL) and shows the Pro state', async () => {
    const env = makeEnv();
    const { cookie } = await startGuest(env);
    await worker.fetch(req('POST', '/api/pro/checkout', { cookie, body: {} }), env, ctx);
    Object.assign(stripe.state.sessions.cs_test_1, { status: 'complete', payment_status: 'paid' });
    const res = await worker.fetch(req('GET', '/pro/?session_id=cs_test_1', { cookie }), env, ctx);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-view="pro"');
  });

  it('a second open checkout tab is expired at Stripe once Pro is granted', async () => {
    const env = makeEnv();
    const { cookie, userId } = await startGuest(env);
    await worker.fetch(req('POST', '/api/pro/checkout', { cookie, body: {} }), env, ctx);
    await worker.fetch(req('POST', '/api/pro/checkout', { cookie, body: {} }), env, ctx);
    Object.assign(stripe.state.sessions.cs_test_2, { status: 'complete', payment_status: 'paid' });
    const s = await (await worker.fetch(req('GET', '/api/pro/status', { cookie }), env, ctx)).json();
    expect(s.pro).toBe(true);
    expect(stripe.state.expired).toEqual(['cs_test_1']);
    const byId = Object.fromEntries(rows(env, userId).map((r) => [r.stripe_session_id, r.status]));
    expect(byId).toEqual({ cs_test_1: 'expired', cs_test_2: 'paid' });
  });

  it('never grants on a session that names another user or another app, or is unpaid', async () => {
    const env = makeEnv();
    const { cookie, userId } = await startGuest(env);
    await worker.fetch(req('POST', '/api/pro/checkout', { cookie, body: {} }), env, ctx);
    const sess = stripe.state.sessions.cs_test_1;

    Object.assign(sess, { status: 'complete', payment_status: 'paid', client_reference_id: 'someone-else' });
    expect((await (await worker.fetch(req('GET', '/api/pro/status', { cookie }), env, ctx)).json()).pro).toBe(false);

    Object.assign(sess, { client_reference_id: userId, metadata: { app: 'another-app' } });
    expect((await (await worker.fetch(req('GET', '/api/pro/status', { cookie }), env, ctx)).json()).pro).toBe(false);

    Object.assign(sess, { metadata: { app: 'focusbro' }, payment_status: 'unpaid' });
    expect((await (await worker.fetch(req('GET', '/api/pro/status', { cookie }), env, ctx)).json()).pro).toBe(false);
    expect(rows(env, userId)[0].status).toBe('pending');

    // Stripe says the session lapsed → the row is closed as expired, still not Pro.
    Object.assign(sess, { status: 'expired' });
    expect((await (await worker.fetch(req('GET', '/api/pro/status', { cookie }), env, ctx)).json()).pro).toBe(false);
    expect(rows(env, userId)[0].status).toBe('expired');
  });

  it('a signed-out visitor gets 200 {pro:false, signedIn:false}, never a 401', async () => {
    const res = await worker.fetch(req('GET', '/api/pro/status'), makeEnv(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pro: false, signedIn: false });
  });

  it('checkout needs a session, JSON, and the same origin', async () => {
    const env = makeEnv();
    expect((await worker.fetch(req('POST', '/api/pro/checkout', { body: {} }), env, ctx)).status).toBe(401);
    const { cookie } = await startGuest(env);
    const notJson = new Request(ORIGIN + '/api/pro/checkout', { method: 'POST', headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'text/plain' }, body: '{}' });
    expect((await worker.fetch(notJson, env, ctx)).status).toBe(415);
    const crossSite = new Request(ORIGIN + '/api/pro/checkout', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
    expect((await worker.fetch(crossSite, env, ctx)).status).toBe(403);
    expect(stripe.state.created).toHaveLength(0);
  });

  it('fails closed and calm with no STRIPE_SECRET_KEY — 200 page, 503 API, never a 500', async () => {
    const env = makeEnv({ STRIPE_SECRET_KEY: undefined });
    const { cookie } = await startGuest(env);
    const page = await worker.fetch(req('GET', '/pro/', { cookie }), env, ctx);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Pro is not available right now.');
    expect(html).not.toContain('id="proBuy"');
    const co = await worker.fetch(req('POST', '/api/pro/checkout', { cookie, body: {} }), env, ctx);
    expect(co.status).toBe(503);
    expect((await co.json()).available).toBe(false);
    const st = await worker.fetch(req('GET', '/api/pro/status', { cookie }), env, ctx);
    expect(st.status).toBe(200);
    expect(stripe.fetchSpy).not.toHaveBeenCalled();
  });

  it('a Stripe failure creates no pending row and charges nothing (502, not 500)', async () => {
    const env = makeEnv();
    const { cookie, userId } = await startGuest(env);
    stripe.state.failCreate = true;
    const co = await worker.fetch(req('POST', '/api/pro/checkout', { cookie, body: {} }), env, ctx);
    expect(co.status).toBe(502);
    expect(rows(env, userId)).toHaveLength(0);
    // and a network error / timeout is handled the same way
    vi.stubGlobal('fetch', vi.fn(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }));
    const co2 = await worker.fetch(req('POST', '/api/pro/checkout', { cookie, body: {} }), env, ctx);
    expect(co2.status).toBe(502);
  });

  it('a real (claimed) account gets customer_email; a guest never does', async () => {
    const env = makeEnv();
    const { cookie, userId } = await startGuest(env);
    const claim = await worker.fetch(req('POST', '/auth/claim', { cookie, body: { email: 'pro-buyer@example.com', password: 'longenough1' } }), env, ctx);
    expect(claim.status).toBe(200);
    await worker.fetch(req('POST', '/api/pro/checkout', { cookie, body: {} }), env, ctx);
    expect(stripe.state.created[0].form.customer_email).toBe('pro-buyer@example.com');
    expect(stripe.state.created[0].form.client_reference_id).toBe(userId);
  });
});

suite('FocusBro Pro — website-only purchase (Google Play): the app is never sold to', () => {
  let stripe;
  beforeEach(() => { stripe = stubStripe(); vi.stubGlobal('fetch', stripe.fetchSpy); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('/pro/ in the app shows status only — no price, no buy control, no purchase link', async () => {
    const env = makeEnv();
    const { cookie } = await startGuest(env);
    const res = await worker.fetch(req('GET', '/pro/', { cookie, ua: APP_UA }), env, ctx);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Pro isn’t active on this account.');
    expect(html).not.toMatch(/\$\d/);
    expect(html).not.toContain('id="proBuy"');
    expect(html).not.toContain('id="proOffer"');
    const visible = html.replace(/<style[\s\S]*?<\/style>/g, '');
    expect(visible).not.toMatch(/checkout|stripe|subscription|\bbuy\b|purchase|price/i);
    expect(html).toContain('data-native-app');
  });

  it('Pro bought on the web still shows as active in the app', async () => {
    const env = makeEnv();
    const { cookie } = await startGuest(env);
    await worker.fetch(req('POST', '/api/pro/checkout', { cookie, body: {} }), env, ctx);
    Object.assign(stripe.state.sessions.cs_test_1, { status: 'complete', payment_status: 'paid' });
    const html = await (await worker.fetch(req('GET', '/pro/', { cookie, ua: APP_UA }), env, ctx)).text();
    expect(html).toContain('Pro is active on this account.');
    expect(html).not.toMatch(/\$\d/);
  });

  it('the checkout API refuses the app, and never reaches Stripe', async () => {
    const env = makeEnv();
    const { cookie } = await startGuest(env);
    const res = await worker.fetch(req('POST', '/api/pro/checkout', { cookie, ua: APP_UA, body: {} }), env, ctx);
    expect(res.status).toBe(403);
    expect(stripe.state.created).toHaveLength(0);
  });

  it('every surface that can show a buy/upgrade control hides .pro-buy inside the app', async () => {
    const env = makeEnv();
    const css = 'html[data-native-app] .pro-buy{display:none !important}';
    for (const path of ['/pro/', '/me/', '/me/report', '/']) {
      const html = await (await worker.fetch(req('GET', path), env, ctx)).text();
      expect(html, path).toContain(css);
      expect(html, path).toContain('/native-bridge.js');
    }
    // and the web /pro/ (not the app) DOES carry the offer, as a .pro-buy control
    const { cookie } = await startGuest(env);
    const web = await (await worker.fetch(req('GET', '/pro/', { cookie }), env, ctx)).text();
    expect(web).toMatch(/<button[^>]*id="proBuy"[^>]*class="pro-buy"/);
    expect(web).toContain('$9.99');
  });

  it('/pro/ and /pro.js run under the ENFORCED CSP with no inline script', async () => {
    const env = makeEnv();
    const page = await worker.fetch(req('GET', '/pro/'), env, ctx);
    expect(page.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
    const html = await page.text();
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).toContain('<script src="/pro.js?v=abc1234" defer></script>');
    const js = await worker.fetch(req('GET', '/pro.js?v=abc1234'), env, ctx);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toMatch(/^application\/javascript/);
    expect(await js.text()).toContain('/api/pro/checkout');
    const bare = await worker.fetch(req('GET', '/pro'), env, ctx);
    expect(bare.status).toBe(301);
    expect(bare.headers.get('Location')).toBe('/pro/');
  });
});
