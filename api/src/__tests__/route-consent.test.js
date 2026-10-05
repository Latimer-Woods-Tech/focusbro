/**
 * FBQ-24 R2 — the contact-consent routes (GET/POST /api/consent and
 * POST /api/consent/opt-out). QA found the TCPA opt-out handler with zero hits.
 * Driven through the Worker's fetch() over a REAL migrated SQLite D1: each test
 * reads contact_consent / users back, and the opt-out tests close the loop by
 * asking the delivery gate the cron uses (evaluateContactGate) whether a text
 * may go out afterwards. Phone verification (FBQ-12) has its own suite.
 */
import { describe, expect, it } from 'vitest';
import { CONSENT_VERSION, consentLanguage, evaluateContactGate } from '../consent.js';
import { DatabaseSync } from './helpers/real-d1.js';
import { call, count, makeEnv, register, row } from './helpers/route-kit.js';

const suite = DatabaseSync ? describe : describe.skip;
const PHONE = '+1 (555) 010-4477';
const E164 = '+15550104477';
const get = (env, user) => call(env, '/api/consent', { cookie: user?.cookie });
const grant = (env, user, body) => call(env, '/api/consent', { method: 'POST', cookie: user?.cookie, body });
const optOut = (env, user, body = { channel: 'text' }) => call(env, '/api/consent/opt-out', { method: 'POST', cookie: user?.cookie, body });
const consentRow = (env, userId, channel = 'text') => row(env, 'SELECT * FROM contact_consent WHERE user_id = ? AND channel = ?', userId, channel);

suite('GET /api/consent (real D1)', () => {
  it('is 401 with no session and 401 with a forged one', async () => {
    const env = makeEnv();
    expect((await get(env, null)).status).toBe(401);
    expect((await get(env, { cookie: '__Host-focusbro_session=forged.token.value' })).status).toBe(401);
  });

  it('reports no consent for a new account, and the disclosure the person would agree to', async () => {
    const env = makeEnv();
    const me = await register(env, 'consent-new@example.com');
    const res = await get(env, me);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      channels: {}, phone_present: false, phone_verified: false,
      consent_version: CONSENT_VERSION, disclosure: { text: consentLanguage('text') },
    });
  });

  it('shows only the caller\'s own consent, never another account\'s', async () => {
    const env = makeEnv();
    const a = await register(env, 'consent-a@example.com');
    const b = await register(env, 'consent-b@example.com');
    expect((await grant(env, a, { channel: 'text', agree: true, phone: PHONE })).status).toBe(200);

    const seenByB = await (await get(env, b)).json();
    expect(seenByB.channels).toEqual({});
    expect(seenByB.phone_present).toBe(false);
    const seenByA = await (await get(env, a)).json();
    expect(seenByA.channels.text).toMatchObject({ status: 'granted', consent_version: CONSENT_VERSION });
    expect(seenByA.phone_present).toBe(true);
    expect(seenByA.phone_verified).toBe(false);
  });
});

suite('POST /api/consent (real D1)', () => {
  it('is 401 unauthenticated and writes nothing', async () => {
    const env = makeEnv();
    expect((await grant(env, null, { channel: 'text', agree: true, phone: PHONE })).status).toBe(401);
    expect(count(env, 'SELECT COUNT(*) AS n FROM contact_consent')).toBe(0);
  });

  it('records express consent with the exact language, normalized phone, quiet hours and timezone', async () => {
    const env = makeEnv();
    const me = await register(env, 'grant@example.com');
    const res = await grant(env, me, { channel: 'TEXT', agree: true, phone: PHONE, quiet_start: 22, quiet_end: 7, timezone: ' America/Chicago ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true, channel: 'text', status: 'granted', consent_version: CONSENT_VERSION,
      quiet_hours: { start: 22, end: 7, timezone: 'America/Chicago' },
      phone_verified: false, needs_verification: true,
    });

    const c = consentRow(env, me.id);
    expect(c).toMatchObject({
      status: 'granted', consent_version: CONSENT_VERSION, consent_text: consentLanguage('text'),
      phone: E164, quiet_start: 22, quiet_end: 7, timezone: 'America/Chicago', revoked_at: null, revoke_source: null,
    });
    expect(c.granted_at).toBeTruthy();
    const user = row(env, 'SELECT phone, phone_verified_at FROM users WHERE id = ?', me.id);
    expect(user).toEqual({ phone: E164, phone_verified_at: null });
    // consent is not enough: the number is unverified, so the gate holds the text
    expect(await evaluateContactGate(env, { userId: me.id, channel: 'text', nowISO: new Date().toISOString() }))
      .toEqual({ skip: 'phone_unverified' });
  });

  it('defaults timezone to UTC and drops out-of-range quiet hours', async () => {
    const env = makeEnv();
    const me = await register(env, 'defaults@example.com');
    const res = await grant(env, me, { agree: true, phone: PHONE, quiet_start: 99, quiet_end: -1 });
    expect(res.status).toBe(200);
    expect((await res.json()).quiet_hours).toBeNull();
    expect(consentRow(env, me.id)).toMatchObject({ timezone: 'UTC', quiet_start: null, quiet_end: null });
  });

  it.each([
    ['a body that is not an object', 'null'],
    ['a body that is not JSON', 'nope'],
  ])('rejects %s with 400 and records nothing', async (_n, raw) => {
    const env = makeEnv();
    const me = await register(env, 'badjson@example.com');
    const res = await call(env, '/api/consent', { method: 'POST', cookie: me.cookie, body: raw, headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(400);
    expect(count(env, 'SELECT COUNT(*) AS n FROM contact_consent')).toBe(0);
  });

  it.each([
    ['consent not affirmed (agree missing)', { channel: 'text', phone: PHONE }],
    ['consent given as the string "true"', { channel: 'text', agree: 'true', phone: PHONE }],
    ['consent given as 1', { channel: 'text', agree: 1, phone: PHONE }],
    ['agree:false', { channel: 'text', agree: false, phone: PHONE }],
    ['no phone', { channel: 'text', agree: true }],
    ['a phone too short', { channel: 'text', agree: true, phone: '12345' }],
    ['a phone too long', { channel: 'text', agree: true, phone: '1'.repeat(16) }],
    ['an unknown channel', { channel: 'carrier-pigeon', agree: true, phone: PHONE }],
    ['voice, which is not grantable yet', { channel: 'voice', agree: true, phone: PHONE }],
  ])('rejects %s with 400 and stores neither consent nor the number', async (_n, body) => {
    const env = makeEnv();
    const me = await register(env, 'reject@example.com');
    const res = await grant(env, me, body);
    expect(res.status).toBe(400);
    expect(count(env, 'SELECT COUNT(*) AS n FROM contact_consent')).toBe(0);
    expect(row(env, 'SELECT phone FROM users WHERE id = ?', me.id).phone).toBeNull();
  });

  it('writes only the caller\'s row: A granting does not touch B', async () => {
    const env = makeEnv();
    const a = await register(env, 'iso-a@example.com');
    const b = await register(env, 'iso-b@example.com');
    await grant(env, a, { channel: 'text', agree: true, phone: PHONE });
    expect(consentRow(env, b.id)).toBeUndefined();
    expect(row(env, 'SELECT phone FROM users WHERE id = ?', b.id).phone).toBeNull();
  });

  it('re-granting is an upsert (one row) that clears a prior opt-out', async () => {
    const env = makeEnv();
    const me = await register(env, 'regrant@example.com');
    await grant(env, me, { channel: 'text', agree: true, phone: PHONE });
    await optOut(env, me);
    expect(consentRow(env, me.id).status).toBe('revoked');

    expect((await grant(env, me, { channel: 'text', agree: true, phone: PHONE })).status).toBe(200);
    expect(count(env, 'SELECT COUNT(*) AS n FROM contact_consent WHERE user_id = ?', me.id)).toBe(1);
    expect(consentRow(env, me.id)).toMatchObject({ status: 'granted', revoked_at: null, revoke_source: null });
  });
});

suite('POST /api/consent/opt-out (real D1) — the TCPA stop', () => {
  let n = 0; // the verified-phone index is unique, so every account gets its own number
  async function grantedAndVerified(env, email) {
    const me = await register(env, email);
    await grant(env, me, { channel: 'text', agree: true, phone: `+1555010${String(5000 + (n += 1))}` });
    env.DB.sqlite.prepare("UPDATE users SET phone_verified_at = datetime('now') WHERE id = ?").run(me.id);
    return me;
  }
  const gate = (env, me) => evaluateContactGate(env, { userId: me.id, channel: 'text', nowISO: '2026-10-05T15:00:00.000Z' });

  it('is 401 unauthenticated and leaves consent granted', async () => {
    const env = makeEnv();
    const me = await grantedAndVerified(env, 'stop-401@example.com');
    expect((await optOut(env, null)).status).toBe(401);
    expect((await optOut(env, { cookie: '__Host-focusbro_session=forged.token.value' })).status).toBe(401);
    expect(consentRow(env, me.id).status).toBe('granted');
    expect(await gate(env, me)).toEqual({ allow: true });
  });

  it('revokes durably (status, timestamp, source) and the delivery gate then refuses the text', async () => {
    const env = makeEnv();
    const me = await grantedAndVerified(env, 'stop@example.com');
    expect(await gate(env, me)).toEqual({ allow: true });

    const res = await optOut(env, me);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, channel: 'text', status: 'revoked' });
    expect(consentRow(env, me.id)).toMatchObject({ status: 'revoked', revoke_source: 'user' });
    expect(consentRow(env, me.id).revoked_at).toBeTruthy();
    expect(await gate(env, me)).toEqual({ skip: 'opted_out' });
  });

  it('defaults to the text channel when the body is empty or not JSON', async () => {
    const env = makeEnv();
    const me = await grantedAndVerified(env, 'stop-default@example.com');
    const res = await call(env, '/api/consent/opt-out', { method: 'POST', cookie: me.cookie, body: 'not json', headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(200);
    expect(consentRow(env, me.id).status).toBe('revoked');
  });

  it('rejects an unknown channel with 400 and revokes nothing', async () => {
    const env = makeEnv();
    const me = await grantedAndVerified(env, 'stop-bad@example.com');
    const res = await optOut(env, me, { channel: 'carrier-pigeon' });
    expect(res.status).toBe(400);
    expect(consentRow(env, me.id).status).toBe('granted');
  });

  it('only revokes the caller: another person\'s consent stays granted', async () => {
    const env = makeEnv();
    const a = await grantedAndVerified(env, 'stop-a@example.com');
    const b = await grantedAndVerified(env, 'stop-b@example.com');
    expect((await optOut(env, a)).status).toBe(200);
    expect(consentRow(env, a.id).status).toBe('revoked');
    expect(consentRow(env, b.id)).toMatchObject({ status: 'granted', revoked_at: null });
    expect(await gate(env, b)).toEqual({ allow: true });
  });

  it('is idempotent and invents no consent row for someone who never opted in', async () => {
    const env = makeEnv();
    const me = await register(env, 'never@example.com');
    expect((await optOut(env, me)).status).toBe(200);
    expect(consentRow(env, me.id)).toBeUndefined();
    expect(await gate(env, me)).toEqual({ skip: 'no_consent' });

    const opted = await grantedAndVerified(env, 'twice@example.com');
    await optOut(env, opted);
    const first = consentRow(env, opted.id).revoked_at;
    expect((await optOut(env, opted)).status).toBe(200);
    expect(consentRow(env, opted.id).status).toBe('revoked');
    expect(first).toBeTruthy();
  });
});
