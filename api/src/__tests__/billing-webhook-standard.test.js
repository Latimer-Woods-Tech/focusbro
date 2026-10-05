/**
 * FBQ-26b (focusbro#391) — the dormant billing webhook meets the repo's webhook
 * standard: raw body read ONCE, constant-time signature compare, timestamp bounded
 * both ways. The route stays unreachable unless BILLING_ENABLED === 'true'
 * (worker-routing.test.js pins that); these tests enable it only inside the test env.
 *
 * Before: verifyWebhookSignature(request) consumed the body and the route read it
 * again, so a VALIDLY signed event always threw "Body is unusable" after
 * verification and was swallowed as a 200 with an error; a future-dated signed
 * timestamp was accepted; `===` string compare.
 */
import { describe, expect, it } from 'vitest';
import worker from '../index.js';

const SECRET = 'whsec_test_secret_0123456789';
const ORIGIN = 'https://focusbro.net';

async function sign(body, t, secret = SECRET) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}

const stmt = { bind() { return stmt; }, first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }) };
const env = {
  JWT_SECRET: 'test-secret', BILLING_ENABLED: 'true', STRIPE_WEBHOOK_SECRET: SECRET,
  KV_CACHE: { get: async () => null, put: async () => {} }, DB: { prepare: () => stmt },
};

const post = (body, header) => worker.fetch(
  new Request(`${ORIGIN}/api/billing/webhook`, { method: 'POST', body, headers: header ? { 'stripe-signature': header } : {} }),
  env, {},
);
const now = () => Math.floor(Date.now() / 1000);
const BODY = JSON.stringify({ id: 'evt_1', type: 'ping.ignored', data: { object: {} } });

describe('billing webhook standard (dormant route, enabled only in this test env)', () => {
  it('accepts a validly signed event and actually processes the body (no double read)', async () => {
    const t = now();
    const res = await post(BODY, `t=${t},v1=${await sign(BODY, t)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, processed: false });
  });

  it('accepts when one of several v1 signatures matches (secret rotation)', async () => {
    const t = now();
    const res = await post(BODY, `t=${t},v1=${'0'.repeat(64)},v1=${await sign(BODY, t)}`);
    expect(res.status).toBe(200);
    expect((await res.json()).received).toBe(true);
  });

  it('rejects a wrong signature, a tampered body, a missing header and a malformed header with 401', async () => {
    const t = now();
    const good = await sign(BODY, t);
    for (const [body, header] of [
      [BODY, `t=${t},v1=${'0'.repeat(64)}`],
      [BODY + ' ', `t=${t},v1=${good}`],
      [BODY, null],
      [BODY, 'garbage'],
      [BODY, `t=${t}`],
      [BODY, `t=abc,v1=${good}`],
      [BODY, `t=${t},v1=zz`],
    ]) {
      const res = await post(body, header);
      expect(res.status, String(header)).toBe(401);
    }
  });

  it('rejects a stale AND a future-dated timestamp, even with a correct signature', async () => {
    for (const t of [now() - 3600, now() + 3600]) {
      const res = await post(BODY, `t=${t},v1=${await sign(BODY, t)}`);
      expect(res.status, String(t)).toBe(401);
    }
  });

  it('rejects everything when the webhook secret is not configured', async () => {
    const t = now();
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/billing/webhook`, { method: 'POST', body: BODY, headers: { 'stripe-signature': `t=${t},v1=${await sign(BODY, t)}` } }),
      { ...env, STRIPE_WEBHOOK_SECRET: undefined }, {},
    );
    expect(res.status).toBe(401);
  });
});
