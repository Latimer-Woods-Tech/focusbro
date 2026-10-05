/**
 * FBQ-12 (focusbro#391): texts go only to VERIFIED, UNIQUE numbers.
 *
 * Driven through the real routes and the real inbound handler on a real migrated
 * SQLite (migration 0015). The code SMS goes through an INJECTED sender and
 * global fetch is stubbed to throw, so nothing here can reach a carrier. Every
 * number is a 555-01xx fiction.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Router } from 'itty-router';
import { registerConsentRoutes, evaluateContactGate } from '../consent.js';
import { runDueCheckins, runEscalations } from '../checkins-cron.js';
import { hasVerifiedTextChannel, phoneVerifyCopy, verifyCodeSms, CODE_TTL_SECONDS } from '../phone-verify.js';
import { generateUUID } from '../middleware.js';
import { bytesToB64url, b64ToBytes } from '../webpush.js';
import { scanDesignLaw } from '../design-law.js';
import { DatabaseSync, makeMigratedD1 } from './helpers/real-d1.js';

const suite = DatabaseSync ? describe : describe.skip;
const NOW = '2026-10-05T16:00:00.000Z';
const A_PHONE = '+15550100001';
const B_PHONE = '+15550100002';

function makeEnv() {
  const DB = makeMigratedD1();
  DB.sqlite.exec(`INSERT INTO users (id, email, password_hash) VALUES ('a', 'a@x.test', 'x'), ('b', 'b@x.test', 'x')`);
  return { DB, JWT_SECRET: 'test-secret', TELNYX_API_KEY: 'k', TELNYX_FROM_NUMBER: '+15550109999', TELNYX_PUBLIC_KEY: 'test' };
}

let sent;
let evt = 0;
function app(sendVerificationSms) {
  const router = Router();
  registerConsentRoutes(router, {
    getAuthToken: (req) => req.headers.get('x-user'),
    verifyToken: async (t) => ({ sub: t }),
    generateUUID,
    jsonResponse: (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }),
    verifyInboundSignature: async () => true,
    sendVerificationSms: sendVerificationSms || (async (_env, to, text) => { sent.push({ to, text }); return true; }),
  });
  return router;
}
async function call(env, path, body, user = 'a', router = app()) {
  const res = await router.handle(new Request(`https://focusbro.net${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user': user }, body: JSON.stringify(body),
  }), env);
  return { status: res.status, body: await res.json() };
}
const requestCode = (env, phone, user = 'a') => call(env, '/api/consent/phone/code', { phone }, user);
const confirm = (env, code, user = 'a') => call(env, '/api/consent/phone/verify', { code }, user);
const lastCode = () => /(\d{6})/.exec(sent[sent.length - 1].text)[1];
async function inbound(env, text, from) {
  const res = await app().handle(new Request('https://focusbro.net/api/webhooks/telnyx/inbound', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'telnyx-timestamp': '1', 'telnyx-signature-ed25519': 's' },
    body: JSON.stringify({ data: { id: `evt-${++evt}`, event_type: 'message.received', payload: { from: { phone_number: from }, text } } }),
  }), env);
  return res.json();
}
const user = (env, id) => env.DB.sqlite.prepare('SELECT phone, phone_verified_at FROM users WHERE id = ?').get(id);
const consentOf = (env, id) => (env.DB.sqlite.prepare(`SELECT status FROM contact_consent WHERE user_id = ? AND channel = 'text'`).get(id) || {}).status;
function giveConsent(env, id, phone) {
  env.DB.sqlite.prepare(`INSERT INTO contact_consent (id, user_id, channel, status, phone) VALUES (?, ?, 'text', 'granted', ?)`).run(`cc-${id}`, id, phone);
}
function setPhone(env, id, phone, verified) {
  env.DB.sqlite.prepare(`UPDATE users SET phone = ?, phone_verified_at = ${verified ? "datetime('now')" : 'NULL'} WHERE id = ?`).run(phone, id);
}
function openCheckin(env, id, { channel = 'text' } = {}) {
  env.DB.sqlite.prepare(
    `INSERT OR IGNORE INTO commitments (id, user_id, title, recurrence, timezone, local_time, channel, persona, status, start_at)
     VALUES (?, ?, 'stretch', 'none', 'UTC', '10:00', ?, 'ally', 'active', '2026-10-05T14:00:00.000Z')`).run(`cm-${id}`, id, channel);
  env.DB.sqlite.prepare(
    `INSERT INTO commitment_checkins (id, commitment_id, user_id, scheduled_for, channel, status, delivered_at)
     VALUES (?, ?, ?, '2026-10-05T14:00:00.000Z', ?, 'sent', '2026-10-05T14:00:00.000Z')`).run(`ck-${id}`, `cm-${id}`, id, channel);
}
const ckStatus = (env, id) => env.DB.sqlite.prepare('SELECT status FROM commitment_checkins WHERE id = ?').get(`ck-${id}`).status;

suite('FBQ-12: phone verification', () => {
  beforeEach(() => {
    sent = [];
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    // Any real network call from these tests is a bug: fail loudly.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network is off in tests'); }));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  describe('request a code → confirm it', () => {
    it('a right code verifies the number; the code is stored hashed, never clear', async () => {
      const env = makeEnv();
      const r = await requestCode(env, A_PHONE);
      expect(r.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe(A_PHONE);
      const code = lastCode();
      expect(code).toMatch(/^\d{6}$/);
      const row = env.DB.sqlite.prepare('SELECT * FROM phone_verifications WHERE user_id = ?').get('a');
      expect(row.code_hash).not.toContain(code);
      expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.expires_at).toBe(Math.floor(Date.parse(NOW) / 1000) + CODE_TTL_SECONDS);
      expect(user(env, 'a').phone_verified_at).toBeNull(); // not yet
      expect((await confirm(env, code)).status).toBe(200);
      expect(user(env, 'a')).toMatchObject({ phone: A_PHONE });
      expect(user(env, 'a').phone_verified_at).toBeTruthy();
    });

    it('a wrong code fails and does not verify', async () => {
      const env = makeEnv();
      await requestCode(env, A_PHONE);
      const wrong = lastCode() === '000000' ? '000001' : '000000';
      const r = await confirm(env, wrong);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('wrong_code');
      expect(user(env, 'a').phone_verified_at).toBeNull();
    });

    it('a code is locked after 5 wrong guesses (the right one no longer works)', async () => {
      const env = makeEnv();
      await requestCode(env, A_PHONE);
      const good = lastCode();
      const wrong = good === '000000' ? '000001' : '000000';
      for (let i = 0; i < 5; i++) expect((await confirm(env, wrong)).status).toBe(400);
      expect((await confirm(env, good)).body.code).toBe('expired');
      expect(user(env, 'a').phone_verified_at).toBeNull();
    });

    it('an expired code fails', async () => {
      const env = makeEnv();
      await requestCode(env, A_PHONE);
      const code = lastCode();
      vi.setSystemTime(new Date(Date.parse(NOW) + (CODE_TTL_SECONDS + 1) * 1000));
      const r = await confirm(env, code);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('expired');
      expect(user(env, 'a').phone_verified_at).toBeNull();
    });

    it('a code is single-use', async () => {
      const env = makeEnv();
      await requestCode(env, A_PHONE);
      const code = lastCode();
      expect((await confirm(env, code)).status).toBe(200);
      expect((await confirm(env, code)).status).toBe(400);
      // and two racing confirms verify once
      const env2 = makeEnv();
      await requestCode(env2, A_PHONE);
      const c2 = lastCode();
      const both = await Promise.all([confirm(env2, c2), confirm(env2, c2)]);
      expect(both.map((x) => x.status).sort()).toEqual([200, 400]);
    });

    it('a code for one account does not verify another', async () => {
      const env = makeEnv();
      await requestCode(env, A_PHONE, 'a');
      const code = lastCode();
      expect((await confirm(env, code, 'b')).status).toBe(400);
      expect(user(env, 'b').phone_verified_at).toBeNull();
    });

    it('requests are rate-limited per user and per number', async () => {
      const env = makeEnv();
      // per number: 3 per hour (even across accounts)
      expect((await requestCode(env, A_PHONE, 'a')).status).toBe(200);
      expect((await requestCode(env, A_PHONE, 'a')).status).toBe(200);
      expect((await requestCode(env, A_PHONE, 'b')).status).toBe(200);
      const limited = await requestCode(env, A_PHONE, 'b');
      expect(limited.status).toBe(429);
      expect(sent).toHaveLength(3);
      // per user: 5 per hour across different numbers
      const env2 = makeEnv();
      for (let i = 0; i < 5; i++) expect((await requestCode(env2, `+155501001${i}0`)).status).toBe(200);
      expect((await requestCode(env2, '+15550100199')).status).toBe(429);
      expect(sent).toHaveLength(8);
    });

    it('a failed send is a clean 503 and leaves no usable code', async () => {
      const env = makeEnv();
      const r = await call(env, '/api/consent/phone/code', { phone: A_PHONE }, 'a', app(async () => false));
      expect(r.status).toBe(503);
      expect(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM phone_verifications').get().n).toBe(0);
    });

    it('requires a signed-in user and a plausible number', async () => {
      const env = makeEnv();
      const noAuth = await app().handle(new Request('https://focusbro.net/api/consent/phone/code', { method: 'POST', body: '{}' }), env);
      expect(noAuth.status).toBe(401);
      expect((await requestCode(env, 'nope')).status).toBe(400);
      expect(sent).toHaveLength(0);
    });
  });

  describe('a verified number is unique', () => {
    it('the second account cannot verify (or even be texted a code for) a verified number', async () => {
      const env = makeEnv();
      await requestCode(env, A_PHONE, 'a');
      await confirm(env, lastCode(), 'a');
      const r = await requestCode(env, A_PHONE, 'b');
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('phone_taken');
      expect(sent).toHaveLength(1); // no second SMS went to the number
    });

    it('the database itself refuses two verified holders (race backstop)', () => {
      const env = makeEnv();
      setPhone(env, 'a', A_PHONE, true);
      expect(() => setPhone(env, 'b', A_PHONE, true)).toThrow(/UNIQUE/);
      setPhone(env, 'b', A_PHONE, false); // unverified duplicates are allowed (existing rows keep working)
    });

    it('typing a number into the consent form never marks it verified, and changing it clears verification', async () => {
      const env = makeEnv();
      setPhone(env, 'a', A_PHONE, true);
      const same = await call(env, '/api/consent', { channel: 'text', agree: true, phone: A_PHONE });
      expect(same.body).toMatchObject({ phone_verified: true, needs_verification: false });
      const changed = await call(env, '/api/consent', { channel: 'text', agree: true, phone: B_PHONE });
      expect(changed.body).toMatchObject({ phone_verified: false, needs_verification: true });
      expect(user(env, 'a').phone_verified_at).toBeNull();
      expect((await call(env, '/api/consent', { channel: 'text', agree: true, phone: A_PHONE }, 'b')).body.needs_verification).toBe(true);
    });
  });

  describe('inbound texts', () => {
    it('STOP from a number revokes EVERY account holding it, verified or not', async () => {
      const env = makeEnv();
      setPhone(env, 'a', A_PHONE, true); giveConsent(env, 'a', A_PHONE);
      setPhone(env, 'b', A_PHONE, false); giveConsent(env, 'b', A_PHONE);
      const r = await inbound(env, 'STOP', A_PHONE);
      expect(r.action).toBe('opted_out');
      expect(consentOf(env, 'a')).toBe('revoked');
      expect(consentOf(env, 'b')).toBe('revoked');
    });

    it('STOP revokes two UNVERIFIED holders too (no arbitrary first match)', async () => {
      const env = makeEnv();
      setPhone(env, 'a', A_PHONE, false); giveConsent(env, 'a', A_PHONE);
      setPhone(env, 'b', A_PHONE, false); giveConsent(env, 'b', A_PHONE);
      await inbound(env, 'STOP', A_PHONE);
      expect([consentOf(env, 'a'), consentOf(env, 'b')]).toEqual(['revoked', 'revoked']);
    });

    it('a check-in reply from an UNVERIFIED number resolves nothing', async () => {
      const env = makeEnv();
      setPhone(env, 'a', A_PHONE, false); giveConsent(env, 'a', A_PHONE); openCheckin(env, 'a');
      const r = await inbound(env, 'done', A_PHONE);
      expect(r.action).toBeUndefined();
      expect(r.ignored).toBe('unverified_number');
      expect(ckStatus(env, 'a')).toBe('sent');
    });

    it('two accounts with the same UNVERIFIED number: a reply credits neither', async () => {
      const env = makeEnv();
      setPhone(env, 'a', A_PHONE, false); giveConsent(env, 'a', A_PHONE); openCheckin(env, 'a');
      setPhone(env, 'b', A_PHONE, false); giveConsent(env, 'b', A_PHONE); openCheckin(env, 'b');
      await inbound(env, 'done', A_PHONE);
      expect([ckStatus(env, 'a'), ckStatus(env, 'b')]).toEqual(['sent', 'sent']);
    });

    it('B typing A\'s verified number cannot capture A\'s replies, and A still resolves', async () => {
      const env = makeEnv();
      setPhone(env, 'a', A_PHONE, true); giveConsent(env, 'a', A_PHONE); openCheckin(env, 'a');
      setPhone(env, 'b', A_PHONE, false); giveConsent(env, 'b', A_PHONE); openCheckin(env, 'b');
      const r = await inbound(env, 'done', A_PHONE);
      expect(r.action).toBe('checkin_kept');
      expect(ckStatus(env, 'a')).toBe('kept');
      expect(ckStatus(env, 'b')).toBe('sent');
    });

    it('a reply from a VERIFIED number whose consent is revoked resolves nothing', async () => {
      const env = makeEnv();
      setPhone(env, 'a', A_PHONE, true); giveConsent(env, 'a', A_PHONE); openCheckin(env, 'a');
      env.DB.sqlite.exec(`UPDATE contact_consent SET status = 'revoked' WHERE user_id = 'a'`);
      const r = await inbound(env, 'done', A_PHONE);
      expect(r.ignored).toBe('no_active_consent');
      expect(ckStatus(env, 'a')).toBe('sent');
    });

    it('a verified number with consent still resolves a reply', async () => {
      const env = makeEnv();
      setPhone(env, 'a', A_PHONE, true); giveConsent(env, 'a', A_PHONE); openCheckin(env, 'a');
      expect((await inbound(env, 'done', A_PHONE)).action).toBe('checkin_kept');
    });

    it('START resumes only the verified holder', async () => {
      const env = makeEnv();
      setPhone(env, 'a', A_PHONE, true); giveConsent(env, 'a', A_PHONE);
      setPhone(env, 'b', A_PHONE, false); giveConsent(env, 'b', A_PHONE);
      await inbound(env, 'STOP', A_PHONE);
      expect((await inbound(env, 'START', A_PHONE)).action).toBe('opted_in');
      expect(consentOf(env, 'a')).toBe('granted');
      expect(consentOf(env, 'b')).toBe('revoked');
    });
  });

  describe('delivery: an unverified number has no text channel', () => {
    function cronEnv() {
      const env = makeEnv();
      setPhone(env, 'a', A_PHONE, false); giveConsent(env, 'a', A_PHONE);
      env.DB.sqlite.exec(`INSERT INTO pro_purchases (id, user_id, stripe_session_id, status, paid_at) VALUES ('pp', 'a', 'cs', 'paid', '2026-07-01T00:00:00.000Z')`);
      return env;
    }
    const telnyx = (spy) => spy.mock.calls.filter(([u]) => String(u).includes('telnyx.com'));

    it('the gate names the reason, and a verified number passes', async () => {
      const env = cronEnv();
      expect(await evaluateContactGate(env, { userId: 'a', channel: 'text', nowISO: NOW })).toEqual({ skip: 'phone_unverified' });
      setPhone(env, 'a', A_PHONE, true);
      expect(await evaluateContactGate(env, { userId: 'a', channel: 'text', nowISO: NOW })).toEqual({ allow: true });
    });

    it('a scheduled TEXT check-in to an unverified number goes out as PUSH (parks with a reason, never texts, never throws)', async () => {
      const env = cronEnv();
      env.DB.sqlite.prepare(
        `INSERT INTO commitments (id, user_id, title, recurrence, timezone, local_time, channel, persona, status, start_at)
         VALUES ('cm', 'a', 'stretch', 'none', 'UTC', '16:00', 'text', 'ally', 'active', '2026-10-05T15:59:00.000Z')`).run();
      env.DB.sqlite.prepare(
        `INSERT INTO commitment_checkins (id, commitment_id, user_id, scheduled_for, channel, status)
         VALUES ('ck', 'cm', 'a', '2026-10-05T15:59:00.000Z', 'text', 'pending')`).run();
      const spy = vi.fn(async () => ({ ok: true, status: 200 }));
      vi.stubGlobal('fetch', spy);
      const s = await runDueCheckins(env, { now: NOW });
      expect(telnyx(spy)).toHaveLength(0);
      expect(s.skipped).toBe(1); // no push channel configured here: the named, terminal park
      const row = env.DB.sqlite.prepare(`SELECT status, last_error, channel FROM commitment_checkins WHERE id = 'ck'`).get();
      expect(row).toMatchObject({ status: 'skipped', last_error: expect.stringMatching(/^phone_unverified_/), channel: 'text' });
    });

    it('with a push subscription the same check-in is delivered as PUSH, and no text leaves', async () => {
      const env = cronEnv();
      env.DB.sqlite.prepare(
        `INSERT INTO commitments (id, user_id, title, recurrence, timezone, local_time, channel, persona, status, start_at)
         VALUES ('cm', 'a', 'stretch', 'none', 'UTC', '16:00', 'text', 'ally', 'active', '2026-10-05T15:59:00.000Z')`).run();
      env.DB.sqlite.prepare(
        `INSERT INTO commitment_checkins (id, commitment_id, user_id, scheduled_for, channel, status)
         VALUES ('ck', 'cm', 'a', '2026-10-05T15:59:00.000Z', 'text', 'pending')`).run();
      const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
      const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
      const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      env.VAPID_PUBLIC_KEY = bytesToB64url(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
      env.VAPID_PRIVATE_KEY = bytesToB64url(b64ToBytes(jwk.d));
      env.DB.sqlite.prepare(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES ('ps', 'a', 'https://fcm.googleapis.com/fcm/send/abc', ?, ?)`)
        .run(bytesToB64url(new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey))), bytesToB64url(crypto.getRandomValues(new Uint8Array(16))));
      const spy = vi.fn(async () => ({ ok: true, status: 201 }));
      vi.stubGlobal('fetch', spy);
      const s = await runDueCheckins(env, { now: NOW });
      expect(telnyx(spy)).toHaveLength(0);
      expect(spy.mock.calls.filter(([u]) => String(u).startsWith('https://fcm.googleapis.com/'))).toHaveLength(1);
      expect(s.sent).toBe(1);
    });

    it('the escalation text skips an unverified number (latched, not a failure) and texts a verified one', async () => {
      const env = cronEnv();
      env.DB.sqlite.exec(`INSERT INTO escalation_prefs (user_id, ceiling) VALUES ('a', 'text')`);
      openCheckin(env, 'a', { channel: 'push' });
      env.DB.sqlite.exec(`UPDATE commitment_checkins SET delivered_at = '2026-10-05T15:00:00.000Z', scheduled_for = '2026-10-05T15:00:00.000Z' WHERE id = 'ck-a'`);
      const spy = vi.fn(async () => ({ ok: true, status: 200 }));
      vi.stubGlobal('fetch', spy);
      const s = await runEscalations(env, { now: NOW });
      expect(telnyx(spy)).toHaveLength(0);
      expect(s).toMatchObject({ escalated: 0, skipped: 1, failed: 0 });
      expect(env.DB.sqlite.prepare(`SELECT escalated_at FROM commitment_checkins WHERE id = 'ck-a'`).get().escalated_at).toBe(NOW);

      // control: the same row with a VERIFIED number is texted (the test can fail the other way)
      const env2 = cronEnv();
      setPhone(env2, 'a', A_PHONE, true);
      env2.DB.sqlite.exec(`INSERT INTO escalation_prefs (user_id, ceiling) VALUES ('a', 'text')`);
      openCheckin(env2, 'a', { channel: 'push' });
      env2.DB.sqlite.exec(`UPDATE commitment_checkins SET delivered_at = '2026-10-05T15:00:00.000Z', scheduled_for = '2026-10-05T15:00:00.000Z' WHERE id = 'ck-a'`);
      const spy2 = vi.fn(async () => ({ ok: true, status: 200 }));
      vi.stubGlobal('fetch', spy2);
      expect((await runEscalations(env2, { now: NOW })).escalated).toBe(1);
      expect(telnyx(spy2)).toHaveLength(1);
    });
  });

  it('hasVerifiedTextChannel needs both a number and a verification stamp', () => {
    expect(hasVerifiedTextChannel(null)).toBe(false);
    expect(hasVerifiedTextChannel({ phone: A_PHONE })).toBe(false);
    expect(hasVerifiedTextChannel({ phone_verified_at: 'x' })).toBe(false);
    expect(hasVerifiedTextChannel({ phone: '  ', phone_verified_at: 'x' })).toBe(false);
    expect(hasVerifiedTextChannel({ phone: A_PHONE, phone_verified_at: 'x' })).toBe(true);
  });

  it('every word of the verify flow passes the design law', () => {
    const copy = [...Object.values(phoneVerifyCopy()), verifyCodeSms('123456')];
    for (const text of copy) expect(scanDesignLaw(text), text).toEqual([]);
  });
});
