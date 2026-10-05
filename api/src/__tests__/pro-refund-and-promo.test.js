/**
 * FBQ-21 R3 + R4 (focusbro#391): the money truth, through the Worker against a
 * REAL SQLite schema (migrations/ incl. 0016) with Stripe stubbed at `fetch`.
 * Nothing here calls the live Stripe API.
 *   R3 — a FULL refund or a LOST dispute revokes Pro; a partial refund, an open
 *        dispute, and a failed read do not; the re-read is throttled to once a day.
 *   R4 — a 100%-off promo code (payment_status 'no_payment_required') grants Pro.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../index.js';
import { DatabaseSync, makeMigratedD1, makeKV } from './helpers/real-d1.js';

const suite = DatabaseSync ? describe : describe.skip;
const ORIGIN = 'https://focusbro.net';
const ctx = { waitUntil() {}, passThroughOnException() {} };
const DAY = 24 * 60 * 60 * 1000;

function makeEnv() {
  return {
    DB: makeMigratedD1(), KV_CACHE: makeKV(),
    JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256-0123456789',
    STRIPE_SECRET_KEY: 'rk_test_stub_never_sent_anywhere', PRO_PRICE_ID: 'price_test_pro', BUILD_SHA: 'abc1234',
  };
}

// Stripe double. GET /checkout/sessions/{id}[?expand...] answers state.sessions[id];
// when expanded, payment_intent comes back as an object carrying state.charge.
function stubStripe() {
  const state = { sessions: {}, charge: null, readFails: false, urls: [], methods: [], n: 1 };
  const fetchSpy = vi.fn(async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith('https://api.stripe.com/v1/')) throw new Error('unexpected fetch ' + u);
    const method = (init.method || 'GET').toUpperCase();
    state.urls.push(u); state.methods.push(method);
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (method === 'POST' && u.endsWith('/checkout/sessions')) {
      const form = Object.fromEntries(new URLSearchParams(init.body));
      const id = `cs_test_${state.n++}`;
      state.sessions[id] = { id, status: 'open', payment_status: 'unpaid', client_reference_id: form.client_reference_id,
        metadata: { app: form['metadata[app]'], user_id: form['metadata[user_id]'] }, amount_total: 999, currency: 'usd', payment_intent: 'pi_1' };
      return json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
    }
    const m = u.match(/\/checkout\/sessions\/([^/?]+)(\?.*)?$/);
    if (method === 'GET' && m && state.sessions[m[1]]) {
      if (state.readFails && m[2]) return json({ error: { type: 'api_error' } }, 500);
      const s = { ...state.sessions[m[1]] };
      if (m[2] && s.payment_intent && state.charge) s.payment_intent = { id: 'pi_1', latest_charge: state.charge };
      return json(s);
    }
    return json({ error: { type: 'invalid_request_error' } }, 404);
  });
  return { state, fetchSpy };
}

function req(method, path, { cookie, body } = {}) {
  const h = {};
  if (cookie) h.Cookie = cookie;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; h.Origin = ORIGIN; }
  return new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
}
const call = (env, r) => worker.fetch(r, env, ctx);
async function startGuest(env) {
  const res = await call(env, req('POST', '/auth/guest', { body: {} }));
  return { cookie: res.headers.get('Set-Cookie').split(';')[0], userId: (await res.json()).user_id };
}
const status = async (env, cookie) => (await (await call(env, req('GET', '/api/pro/status', { cookie }))).json());
const row = (env, userId) => env.DB.sqlite.prepare('SELECT * FROM pro_purchases WHERE user_id = ?').get(userId);
const ageCheck = (env, userId, ms) => env.DB.sqlite.prepare('UPDATE pro_purchases SET refund_checked_at = ? WHERE user_id = ?')
  .run(new Date(Date.now() - ms).toISOString(), userId);

async function buy(env, stripe, paymentStatus = 'paid') {
  const g = await startGuest(env);
  await call(env, req('POST', '/api/pro/checkout', { cookie: g.cookie, body: {} }));
  Object.assign(stripe.state.sessions.cs_test_1, { status: 'complete', payment_status: paymentStatus });
  expect((await status(env, g.cookie)).pro).toBe(true);
  return g;
}

suite('FBQ-21 R3/R4 — refunds revoke Pro, a 100%-off code grants it', () => {
  let stripe;
  beforeEach(() => { stripe = stubStripe(); vi.stubGlobal('fetch', stripe.fetchSpy); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('R4: payment_status no_payment_required (100%-off promo) grants Pro', async () => {
    const env = makeEnv();
    const { cookie, userId } = await startGuest(env);
    await call(env, req('POST', '/api/pro/checkout', { cookie, body: {} }));
    Object.assign(stripe.state.sessions.cs_test_1, { status: 'complete', payment_status: 'no_payment_required', amount_total: 0 });
    expect((await status(env, cookie)).pro).toBe(true);
    expect(row(env, userId)).toMatchObject({ status: 'paid', amount_total: 0 });
  });

  it("R4: no_payment_required for someone else's session never grants", async () => {
    const env = makeEnv();
    const { cookie } = await startGuest(env);
    await call(env, req('POST', '/api/pro/checkout', { cookie, body: {} }));
    Object.assign(stripe.state.sessions.cs_test_1, { status: 'complete', payment_status: 'no_payment_required', client_reference_id: 'someone-else' });
    expect((await status(env, cookie)).pro).toBe(false);
  });

  it('R3: a FULL refund revokes Pro (and the row stays as the receipt)', async () => {
    const env = makeEnv();
    const { cookie, userId } = await buy(env, stripe);
    stripe.state.charge = { id: 'ch_1', amount: 999, amount_refunded: 999, refunded: true, dispute: null };
    ageCheck(env, userId, 2 * DAY);
    expect((await status(env, cookie)).pro).toBe(false);
    expect(row(env, userId)).toMatchObject({ status: 'paid' });
    expect(row(env, userId).refunded_at).toBeTruthy();
    const page = await (await call(env, req('GET', '/pro/', { cookie }))).text();
    expect(page).not.toContain('You’re Pro.');
  });

  it('R3: a LOST dispute revokes Pro; an OPEN dispute and a PARTIAL refund do not', async () => {
    const env = makeEnv();
    const { cookie, userId } = await buy(env, stripe);
    stripe.state.charge = { id: 'ch_1', amount: 999, amount_refunded: 0, refunded: false, dispute: { id: 'dp_1', status: 'needs_response' } };
    ageCheck(env, userId, 2 * DAY);
    expect((await status(env, cookie)).pro).toBe(true);
    stripe.state.charge = { id: 'ch_1', amount: 999, amount_refunded: 500, refunded: false, dispute: null };
    ageCheck(env, userId, 2 * DAY);
    expect((await status(env, cookie)).pro).toBe(true);
    stripe.state.charge = { id: 'ch_1', amount: 999, amount_refunded: 0, refunded: false, dispute: { id: 'dp_1', status: 'lost' } };
    ageCheck(env, userId, 2 * DAY);
    expect((await status(env, cookie)).pro).toBe(false);
  });

  it('R3: a failed Stripe read NEVER revokes, and backs off instead of retrying every request', async () => {
    const env = makeEnv();
    const { cookie, userId } = await buy(env, stripe);
    stripe.state.charge = { id: 'ch_1', amount: 999, amount_refunded: 999, refunded: true };
    stripe.state.readFails = true;
    ageCheck(env, userId, 2 * DAY);
    expect((await status(env, cookie)).pro).toBe(true);
    const calls = stripe.fetchSpy.mock.calls.length;
    expect((await status(env, cookie)).pro).toBe(true);
    expect(stripe.fetchSpy.mock.calls.length).toBe(calls);
    stripe.state.readFails = false;
    ageCheck(env, userId, 2 * DAY);
    expect((await status(env, cookie)).pro).toBe(false); // the next successful read does revoke
  });

  it('R3: the refund read is throttled to once a day and is a read-only session GET', async () => {
    const env = makeEnv();
    const { cookie, userId } = await buy(env, stripe);
    stripe.state.charge = { id: 'ch_1', amount: 999, amount_refunded: 0, refunded: false, dispute: null };
    ageCheck(env, userId, 2 * DAY);
    await status(env, cookie);
    const calls = stripe.fetchSpy.mock.calls.length;
    for (let i = 0; i < 3; i++) await status(env, cookie);
    expect(stripe.fetchSpy.mock.calls.length).toBe(calls);
    expect(stripe.state.urls.some((u) => /\/(refunds|disputes|charges)/.test(u.split('?')[0]))).toBe(false);
  });

  it('R3: a 100%-off purchase (no charge to read) is never revoked', async () => {
    const env = makeEnv();
    const { cookie, userId } = await startGuest(env);
    await call(env, req('POST', '/api/pro/checkout', { cookie, body: {} }));
    Object.assign(stripe.state.sessions.cs_test_1, { status: 'complete', payment_status: 'no_payment_required', payment_intent: null });
    expect((await status(env, cookie)).pro).toBe(true);
    ageCheck(env, userId, 2 * DAY);
    expect((await status(env, cookie)).pro).toBe(true);
  });
});
