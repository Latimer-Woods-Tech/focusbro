/**
 * FocusBro Pro — what Pro unlocks, enforced on the SERVER.
 *
 *   Text follow-ups  — the escalation ladder reaches SMS only for a Pro person.
 *                      A free person's quiet check-in NEVER sends a text, whatever
 *                      ceiling they stored. Enforced in the cron (runEscalations)
 *                      and shown honestly by /api/escalation (effective ceiling).
 *   Weekly report    — /api/me/report sends a free person the headline + this
 *                      week's number only; momentum, rhythms, notes and the
 *                      shareable text never cross the wire.
 *
 * Proof-of-rejection: the SMS tests below send a text on the pre-Pro tree (no
 * gate), so they FAIL there; with the gate they pass.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import worker from '../index.js';
import { runEscalations, runDueCheckins, runReturnNudges } from '../checkins-cron.js';
import { bytesToB64url, b64ToBytes } from '../webpush.js';
import { registerConsentRoutes, proCeilingView } from '../consent.js';
import { previewWeeklyReport, buildWeeklyReport } from '../report.js';
import {
  proCopySurface, readProStatus, stripeRequest, isStripeCheckoutUrl, proConfigured,
  renderProPage, isNativeAppRequest, PRO_PAGE_SCRIPT,
} from '../pro.js';
import { meCopySurface } from '../me.js';
import { scanDesignLaw } from '../design-law.js';
import { DatabaseSync, makeMigratedD1, makeKV } from './helpers/real-d1.js';

const realSuite = DatabaseSync ? describe : describe.skip;
const TELNYX_ENV = { TELNYX_API_KEY: 'k', TELNYX_FROM_NUMBER: '+15550001111' };
const DAYTIME = '2026-07-06T16:00:00.000Z'; // 16:00 UTC — inside the unscheduled-daytime window
const telnyxCalls = (spy) => spy.mock.calls.filter(([u]) => String(u).includes('telnyx.com'));

afterEach(() => { vi.unstubAllGlobals(); });

// ── Text follow-ups: the cron, against the REAL migrated schema ──
realSuite('text follow-ups are Pro — the escalation cron on the real schema', () => {
  let db;
  beforeEach(() => {
    db = makeMigratedD1();
    const s = db.sqlite;
    s.exec(`INSERT INTO users (id, email, password_hash, phone) VALUES ('free', 'f@example.com', 'x', '+15557650001'), ('paid', 'p@example.com', 'x', '+15557650002')`);
    s.exec(`UPDATE users SET phone_verified_at = datetime('now')`); // FBQ-12: verified fixtures
    for (const u of ['free', 'paid']) {
      s.prepare(`INSERT INTO commitments (id, user_id, title, start_at, channel, timezone, status) VALUES (?, ?, 'start the taxes', '2026-07-06T15:00:00.000Z', 'push', 'UTC', 'active')`).run('cm-' + u, u);
      s.prepare(`INSERT INTO commitment_checkins (id, commitment_id, user_id, scheduled_for, channel, status, delivered_at) VALUES (?, ?, ?, '2026-07-06T15:30:00.000Z', 'push', 'sent', '2026-07-06T15:30:00.000Z')`).run('ci-' + u, 'cm-' + u, u);
      s.prepare(`INSERT INTO contact_consent (id, user_id, channel, status, timezone, granted_at) VALUES (?, ?, 'text', 'granted', 'UTC', '2026-07-01T00:00:00Z')`).run('cc-' + u, u);
      // Both chose the text rung — the stored choice is identical; only Pro differs.
      s.prepare(`INSERT INTO escalation_prefs (user_id, ceiling) VALUES (?, 'text')`).run(u);
    }
    s.exec(`INSERT INTO pro_purchases (id, user_id, stripe_session_id, status, amount_total, currency, paid_at) VALUES ('pp1', 'paid', 'cs_paid', 'paid', 999, 'usd', '2026-07-01T00:00:00.000Z')`);
  });

  it('a FREE person\'s quiet check-in never sends an SMS — latched as a skip, not a failure', async () => {
    db.sqlite.exec(`DELETE FROM commitment_checkins WHERE user_id = 'paid'`);
    const spy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', spy);
    const s = await runEscalations({ DB: db, ...TELNYX_ENV }, { now: DAYTIME });
    expect(telnyxCalls(spy)).toHaveLength(0);
    expect(s).toMatchObject({ scanned: 1, escalated: 0, skipped: 1, failed: 0 });
    const row = db.sqlite.prepare(`SELECT escalated_at FROM commitment_checkins WHERE id = 'ci-free'`).get();
    expect(row.escalated_at).toBe(DAYTIME); // one-shot latch: never rescanned
  });

  it('a PRO person\'s quiet check-in gets its one warm SMS', async () => {
    db.sqlite.exec(`DELETE FROM commitment_checkins WHERE user_id = 'free'`);
    const spy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', spy);
    const s = await runEscalations({ DB: db, ...TELNYX_ENV }, { now: DAYTIME });
    const calls = telnyxCalls(spy);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0][1].body).to).toBe('+15557650002');
    expect(s.escalated).toBe(1);
  });

  it('in one pass: only the Pro person is texted', async () => {
    const spy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', spy);
    await runEscalations({ DB: db, ...TELNYX_ENV }, { now: DAYTIME });
    expect(telnyxCalls(spy).map(([, init]) => JSON.parse(init.body).to)).toEqual(['+15557650002']);
  });

  it('a pending or expired purchase is not Pro', async () => {
    db.sqlite.exec(`DELETE FROM commitment_checkins WHERE user_id = 'paid'`);
    db.sqlite.exec(`INSERT INTO pro_purchases (id, user_id, stripe_session_id, status) VALUES ('pp2', 'free', 'cs_p', 'pending'), ('pp3', 'free', 'cs_e', 'expired')`);
    const spy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', spy);
    await runEscalations({ DB: db, ...TELNYX_ENV }, { now: DAYTIME });
    expect(telnyxCalls(spy)).toHaveLength(0);
  });

  it('the consent gate still holds for a Pro person — no consent, no text', async () => {
    db.sqlite.exec(`DELETE FROM commitment_checkins WHERE user_id = 'free'`);
    db.sqlite.exec(`UPDATE contact_consent SET status = 'revoked' WHERE user_id = 'paid'`);
    const spy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', spy);
    const s = await runEscalations({ DB: db, ...TELNYX_ENV }, { now: DAYTIME });
    expect(telnyxCalls(spy)).toHaveLength(0);
    expect(s.skipped).toBe(1);
  });

  it('the schema refuses a status outside pending / paid / expired', () => {
    expect(() => db.sqlite.exec(`INSERT INTO pro_purchases (id, user_id, stripe_session_id, status) VALUES ('x', 'free', 'cs_x', 'refunded')`)).toThrow(/CHECK/);
  });
});

// ── Text follow-ups: what /api/escalation tells the person ──
describe('/api/escalation shows the text rung as Pro for a free person', () => {
  function routes({ stored, paid }) {
    const handlers = {};
    const router = { get: (p, h) => { handlers['GET ' + p] = h; }, post: (p, h) => { handlers['POST ' + p] = h; } };
    registerConsentRoutes(router, {
      getAuthToken: () => 'tok', verifyToken: async () => ({ sub: 'u1' }),
      jsonResponse: (body, status = 200) => ({ body, status }), generateUUID: () => 'id',
    });
    const writes = [];
    const DB = {
      prepare(sql) {
        return {
          bind() { return this; },
          first: async () => (/FROM escalation_prefs/.test(sql) ? (stored ? { ceiling: stored } : null)
            : /FROM pro_purchases/.test(sql) ? (paid ? { paid_at: '2026-07-01T00:00:00Z' } : null) : null),
          run: async () => { writes.push(sql); return { success: true }; },
        };
      },
    };
    const env = { DB, JWT_SECRET: 's' };
    return {
      writes,
      get: () => handlers['GET /api/escalation']({ headers: { get: () => null } }, env),
      post: (b) => handlers['POST /api/escalation']({ json: async () => b }, env),
    };
  }

  it('free + text: stored as chosen, effective none, with the /pro/ link', async () => {
    const r = routes({ stored: 'text', paid: false });
    const post = await r.post({ ceiling: 'text' });
    expect(post.status).toBe(200);
    expect(post.body).toEqual({ ok: true, ceiling: 'text', pro: false, effective: 'none', upgrade: '/pro/' });
    expect(r.writes.some((s) => /INSERT INTO escalation_prefs/.test(s))).toBe(true);
    const get = await r.get();
    expect(get.body).toMatchObject({ ceiling: 'text', pro: false, effective: 'none', upgrade: '/pro/' });
  });

  it('Pro + text: effective text, no upgrade link', async () => {
    const get = await routes({ stored: 'text', paid: true }).get();
    expect(get.body).toMatchObject({ ceiling: 'text', pro: true, effective: 'text' });
    expect(get.body).not.toHaveProperty('upgrade');
  });

  it('a chosen "none" is just none — never framed as a Pro upsell', () => {
    expect(proCeilingView('none', false)).toEqual({ pro: false, effective: 'none' });
  });
});

// ── Weekly report: preview for free, full for Pro — through the Worker ──
realSuite('the weekly report is Pro — /api/me/report through the Worker', () => {
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  async function signedIn(env) {
    const res = await worker.fetch(new Request('https://focusbro.net/auth/guest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), env, ctx);
    const { user_id: userId } = await res.json();
    return { cookie: res.headers.get('Set-Cookie').split(';')[0], userId };
  }
  const getReport = (env, cookie) => worker.fetch(new Request('https://focusbro.net/api/me/report', { headers: { Cookie: cookie } }), env, ctx);

  it('free: headline + this week\'s number, and nothing else crosses the wire', async () => {
    const env = { DB: makeMigratedD1(), KV_CACHE: makeKV(), JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256-0123456789' };
    const { cookie, userId } = await signedIn(env);
    env.DB.sqlite.prepare(`INSERT INTO commitments (id, user_id, title, start_at, status, recurrence, local_time) VALUES ('c1', ?, 'read 10 pages', '2026-07-01T09:00:00Z', 'active', 'daily', '09:00')`).run(userId);
    const res = await getReport(env, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.preview).toBe(true);
    expect(body.pro).toBe(false);
    expect(body.text).toBe('');
    expect(Object.keys(body.report).sort()).toEqual(['headline', 'intro', 'kept_this_week', 'pro_preview']);
    expect(JSON.stringify(body)).not.toContain('read 10 pages'); // rhythms never sent
  });

  it('Pro: the full report and its shareable text', async () => {
    const env = { DB: makeMigratedD1(), KV_CACHE: makeKV(), JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256-0123456789' };
    const { cookie, userId } = await signedIn(env);
    env.DB.sqlite.prepare(`INSERT INTO commitments (id, user_id, title, start_at, status, recurrence, local_time) VALUES ('c1', ?, 'read 10 pages', '2026-07-01T09:00:00Z', 'active', 'daily', '09:00')`).run(userId);
    env.DB.sqlite.prepare(`INSERT INTO pro_purchases (id, user_id, stripe_session_id, status, paid_at) VALUES ('pp', ?, 'cs_1', 'paid', '2026-07-01T00:00:00Z')`).run(userId);
    const body = await (await getReport(env, cookie)).json();
    expect(body.preview).toBe(false);
    expect(body.report.rhythms).toEqual([expect.objectContaining({ title: 'read 10 pages' })]);
    expect(body.text).toContain('FocusBro — weekly report');
  });

  it('the page knows the preview shape and links Pro as a .pro-buy control', async () => {
    const env = { DB: makeMigratedD1(), KV_CACHE: makeKV(), JWT_SECRET: 'x'.repeat(40) };
    const html = await (await worker.fetch(new Request('https://focusbro.net/me/report'), env, ctx)).text();
    expect(html).toContain('if (data.preview)');
    expect(html).toMatch(/<a class="pro-buy" href="\/pro\/">/);
  });
});

describe('previewWeeklyReport carries only the preview fields', () => {
  it('drops everything but the headline and the number', () => {
    const full = buildWeeklyReport({ streak: { current_streak: 2, total_kept: 9 }, keptTimestamps: [], rhythms: [{ title: 't', recurrence: 'daily', local_time: '09:00', timezone: 'UTC' }], timezone: 'UTC', nowISO: '2026-07-06T12:00:00Z' });
    const p = previewWeeklyReport(full);
    expect(Object.keys(p).sort()).toEqual(['headline', 'intro', 'kept_this_week', 'pro_preview']);
    expect(p.headline).toBe(full.headline);
  });
});

// ── Copy law + small units ──
describe('Pro copy keeps the design law', () => {
  it('no shame, no "AI", no clinical claim, no ADHD in consumer copy', () => {
    for (const line of proCopySurface()) expect(scanDesignLaw(line), line).toEqual([]);
    expect(meCopySurface()).toContain(proCopySurface().find((l) => l.startsWith('Text follow-ups are part of Pro')));
  });
  it('rendered pages carry no violations in their visible copy', () => {
    for (const state of [
      { available: true }, { available: true, signedIn: true }, { available: true, signedIn: true, returning: true },
      { available: false }, { pro: true, guest: true, signedIn: true }, { native: true }, { native: true, pro: true },
    ]) {
      const visible = renderProPage(state).replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
      expect(scanDesignLaw(visible), JSON.stringify(state)).toEqual([]);
    }
  });
});

describe('Pro units', () => {
  it('readProStatus fails closed on a broken DB', async () => {
    expect(await readProStatus({ DB: { prepare() { throw new Error('down'); } } }, 'u')).toEqual({ pro: false, since: null });
    expect(await readProStatus({}, 'u')).toEqual({ pro: false, since: null });
  });
  it('proConfigured needs both the key and the price id', () => {
    expect(proConfigured({ STRIPE_SECRET_KEY: 'rk', PRO_PRICE_ID: 'price' })).toBe(true);
    expect(proConfigured({ STRIPE_SECRET_KEY: 'rk' })).toBe(false);
    expect(proConfigured({ PRO_PRICE_ID: 'price' })).toBe(false);
    expect(proConfigured(null)).toBe(false);
  });
  it('only a Stripe https URL is ever handed to the browser', () => {
    expect(isStripeCheckoutUrl('https://checkout.stripe.com/c/pay/cs_1')).toBe(true);
    expect(isStripeCheckoutUrl('http://checkout.stripe.com/c/pay/cs_1')).toBe(false);
    expect(isStripeCheckoutUrl('https://evil.example/stripe.com')).toBe(false);
    expect(isStripeCheckoutUrl('https://stripe.com.evil.example/')).toBe(false);
    expect(isStripeCheckoutUrl(undefined)).toBe(false);
  });
  it('stripeRequest times out instead of hanging, and never throws', async () => {
    vi.stubGlobal('fetch', (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
    }));
    const r = await stripeRequest({ STRIPE_SECRET_KEY: 'rk' }, '/checkout/sessions/cs_1', { timeoutMs: 20 });
    expect(r).toMatchObject({ ok: false, status: 0, error: 'timeout' });
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }));
    expect((await stripeRequest({ STRIPE_SECRET_KEY: 'rk' }, '/x')).ok).toBe(false);
  });
  it('detects the native app by its user-agent marker', () => {
    expect(isNativeAppRequest(new Request('https://focusbro.net/', { headers: { 'User-Agent': 'Mozilla/5.0 FocusBroApp/0.1' } }))).toBe(true);
    expect(isNativeAppRequest(new Request('https://focusbro.net/', { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/128' } }))).toBe(false);
  });
  it('signed-out web visitors are offered the existing guest door, not a new auth', () => {
    const html = renderProPage({ available: true, signedIn: false });
    expect(html).toContain('id="proStart"');
    expect(html).toContain('href="/me/"');
    expect(html).not.toContain('id="proBuy"');
    expect(PRO_PAGE_SCRIPT).toContain("postJSON('/auth/guest'");
    expect(PRO_PAGE_SCRIPT).toContain("postJSON('/auth/claim'");
  });
});

// ── Check-ins by text and the return-nudge text fallback are Pro too ──
// Every SMS costs money, so a free person is never texted on ANY path: a text
// check-in arrives as a PUSH instead (or parks with a named reason when there is
// no push subscription), and the return nudge never falls back to text.
async function realPushKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  return {
    env: { VAPID_PUBLIC_KEY: bytesToB64url(pubRaw), VAPID_PRIVATE_KEY: bytesToB64url(b64ToBytes(jwk.d)) },
    sub: { p256dh: bytesToB64url(uaRaw), auth: bytesToB64url(crypto.getRandomValues(new Uint8Array(16))) },
  };
}

realSuite('check-ins by text are Pro — runDueCheckins on the real schema', () => {
  const NOW = DAYTIME;
  let db;
  beforeEach(() => {
    db = makeMigratedD1();
    const s = db.sqlite;
    s.exec(`INSERT INTO users (id, email, password_hash, phone) VALUES ('free', 'f@example.com', 'x', '+15557650001'), ('paid', 'p@example.com', 'x', '+15557650002')`);
    s.exec(`UPDATE users SET phone_verified_at = datetime('now')`); // FBQ-12: verified fixtures
    for (const u of ['free', 'paid']) {
      s.prepare(`INSERT INTO commitments (id, user_id, title, start_at, channel, timezone, status) VALUES (?, ?, 'open the tax folder', '2026-07-06T15:59:00.000Z', 'text', 'UTC', 'active')`).run('cm-' + u, u);
      s.prepare(`INSERT INTO commitment_checkins (id, commitment_id, user_id, scheduled_for, channel, status) VALUES (?, ?, ?, '2026-07-06T15:59:00.000Z', 'text', 'pending')`).run('ci-' + u, 'cm-' + u, u);
      s.prepare(`INSERT INTO contact_consent (id, user_id, channel, status, timezone, granted_at) VALUES (?, ?, 'text', 'granted', 'UTC', '2026-07-01T00:00:00Z')`).run('cc-' + u, u);
    }
    s.exec(`INSERT INTO pro_purchases (id, user_id, stripe_session_id, status, paid_at) VALUES ('pp1', 'paid', 'cs_paid', 'paid', '2026-07-01T00:00:00.000Z')`);
  });
  const only = (u) => db.sqlite.exec(`DELETE FROM commitment_checkins WHERE user_id <> '${u}'`);
  const checkin = (u) => db.sqlite.prepare(`SELECT status, last_error, channel FROM commitment_checkins WHERE id = ?`).get('ci-' + u);

  it('FREE + text channel + a push subscription → delivered as PUSH, no Telnyx call', async () => {
    only('free');
    const keys = await realPushKeys();
    db.sqlite.prepare(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES ('ps1', 'free', 'https://fcm.googleapis.com/fcm/send/abc', ?, ?)`).run(keys.sub.p256dh, keys.sub.auth);
    const spy = vi.fn(async () => ({ ok: true, status: 201 }));
    vi.stubGlobal('fetch', spy);
    const s = await runDueCheckins({ DB: db, ...TELNYX_ENV, ...keys.env }, { now: NOW });
    expect(telnyxCalls(spy)).toHaveLength(0);
    expect(spy.mock.calls.filter(([u]) => String(u).startsWith('https://fcm.googleapis.com/'))).toHaveLength(1);
    expect(s.sent).toBe(1);
    expect(checkin('free')).toMatchObject({ status: 'sent', channel: 'text' }); // their choice is kept for when Pro is on
  });

  it('FREE + text channel + no push subscription → parked with a named reason, never texted', async () => {
    only('free');
    const keys = await realPushKeys();
    const spy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', spy);
    const s = await runDueCheckins({ DB: db, ...TELNYX_ENV, ...keys.env }, { now: NOW });
    expect(spy).not.toHaveBeenCalled();
    expect(s.skipped).toBe(1);
    expect(checkin('free')).toMatchObject({ status: 'skipped', last_error: 'text_is_pro_no_subscription' });
  });

  it('PRO + text channel → exactly one SMS', async () => {
    only('paid');
    const spy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', spy);
    const s = await runDueCheckins({ DB: db, ...TELNYX_ENV }, { now: NOW });
    const calls = telnyxCalls(spy);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0][1].body).to).toBe('+15557650002');
    expect(s.sent).toBe(1);
  });

  it('in one pass: only the Pro person is texted', async () => {
    const spy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', spy);
    await runDueCheckins({ DB: db, ...TELNYX_ENV }, { now: NOW });
    expect(telnyxCalls(spy).map(([, init]) => JSON.parse(init.body).to)).toEqual(['+15557650002']);
  });
});

realSuite('the return-nudge text fallback is Pro — runReturnNudges on the real schema', () => {
  let db;
  beforeEach(() => {
    db = makeMigratedD1();
    const s = db.sqlite;
    s.exec(`INSERT INTO users (id, email, password_hash, phone) VALUES ('free', 'f@example.com', 'x', '+15557650001'), ('paid', 'p@example.com', 'x', '+15557650002')`);
    s.exec(`UPDATE users SET phone_verified_at = datetime('now')`); // FBQ-12: verified fixtures
    for (const u of ['free', 'paid']) {
      s.prepare(`INSERT INTO commitments (id, user_id, title, start_at, channel, timezone, status) VALUES (?, ?, 'stretch', '2026-06-20T15:00:00.000Z', 'push', 'UTC', 'active')`).run('cm-' + u, u);
      s.prepare(`INSERT INTO analytics_events (user_id, event_type, created_at) VALUES (?, 'commitment_created', '2026-06-20 15:00:00')`).run(u);
      s.prepare(`INSERT INTO contact_consent (id, user_id, channel, status, timezone, granted_at) VALUES (?, ?, 'text', 'granted', 'UTC', '2026-06-01T00:00:00Z')`).run('cc-' + u, u);
    }
    s.exec(`INSERT INTO pro_purchases (id, user_id, stripe_session_id, status, paid_at) VALUES ('pp1', 'paid', 'cs_paid', 'paid', '2026-06-01T00:00:00.000Z')`);
  });

  it('a FREE person with no push subscription is never texted; a PRO person is', async () => {
    const spy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', spy);
    const s = await runReturnNudges({ DB: db, KV_CACHE: makeKV(), ...TELNYX_ENV }, { now: DAYTIME });
    expect(s.scanned).toBe(2);
    expect(telnyxCalls(spy).map(([, init]) => JSON.parse(init.body).to)).toEqual(['+15557650002']);
  });
});
