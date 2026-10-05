/**
 * FBQ-24 R2 — the account-creation and recovery routes QA found with no real
 * test: POST /auth/register, POST /auth/confirm-password-reset and
 * POST /auth/request-email-verification. Driven through the Worker's own fetch()
 * over a REAL migrated SQLite D1; every test reads the database back, because a
 * 200 proves nothing about whether the password, session or token row moved.
 *
 * (The single-use replay of a reset link lives in password-reset-replay.test.js.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyPassword } from '../index.js';
import { passwordPolicyError } from '../account-recovery.js';
import { config } from '../config.js';
import { DatabaseSync } from './helpers/real-d1.js';
import { call, count, makeEnv, register, row, rows } from './helpers/route-kit.js';

const suite = DatabaseSync ? describe : describe.skip;
const MAIL = { AUTH_EMAIL_FROM: 'support@example.com', RESEND_API_KEY: 're_test_key' };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Capture outbound mail instead of sending it. */
function captureMail() {
  const sent = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response('{}', { status: 200 });
  }));
  return sent;
}
const tokenFrom = (mail) => mail.body.text.match(/#token=([A-Za-z0-9_-]+)/)[1];
const post = (env, path, body, opts = {}) => call(env, path, { method: 'POST', body, ...opts });

suite('POST /auth/register (real D1)', () => {
  it('creates the account, a hashed password, a session and an audit row, and the new login works', async () => {
    const env = makeEnv();
    const res = await post(env, '/auth/register', { email: 'new@example.com', password: 'correct-horse-battery' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, email: 'new@example.com', email_verified: false });
    expect(body).not.toHaveProperty('token'); // the credential travels only in the HttpOnly cookie
    expect(res.headers.get('Set-Cookie')).toMatch(/focusbro_session=.+HttpOnly/);

    const user = row(env, 'SELECT id, email, password_hash, email_verified_at FROM users WHERE email = ?', 'new@example.com');
    expect(user.id).toBe(body.user_id);
    expect(user.email_verified_at).toBeNull();
    expect(user.password_hash).not.toContain('correct-horse-battery');
    expect(await verifyPassword('correct-horse-battery', user.password_hash)).toBe(true);
    expect(await verifyPassword('wrong-password-here', user.password_hash)).toBe(false);
    expect(count(env, 'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND is_active = 1', user.id)).toBe(1);
    expect(count(env, "SELECT COUNT(*) AS n FROM audit_logs WHERE user_id = ? AND action = 'register'", user.id)).toBe(1);

    // the cookie it handed out is a working session
    const session = await call(env, '/auth/session', { cookie: res.headers.get('Set-Cookie').split(';')[0] });
    expect(session.status).toBe(200);
    // and the password it set logs in
    const login = await post(env, '/auth/login', { email: 'new@example.com', password: 'correct-horse-battery' });
    expect(login.status).toBe(200);
  });

  it('normalizes the email: stored lower-case and trimmed, and a differently-cased repeat is a 409', async () => {
    const env = makeEnv();
    const first = await post(env, '/auth/register', { email: '  Mixed.Case@Example.COM ', password: 'correct-horse-battery' });
    expect(first.status).toBe(201);
    expect(row(env, 'SELECT email FROM users').email).toBe('mixed.case@example.com');

    const again = await post(env, '/auth/register', { email: 'MIXED.CASE@example.com', password: 'a-different-password-1' });
    expect(again.status).toBe(409);
    expect(count(env, 'SELECT COUNT(*) AS n FROM users')).toBe(1);
    // the squatter did not overwrite the owner's password
    const hash = row(env, 'SELECT password_hash FROM users').password_hash;
    expect(await verifyPassword('correct-horse-battery', hash)).toBe(true);
    expect(await verifyPassword('a-different-password-1', hash)).toBe(false);
  });

  it.each([
    ['no body fields', {}, 'Email and password required'],
    ['no password', { email: 'a@example.com' }, 'Email and password required'],
    ['no email', { password: 'correct-horse-battery' }, 'Email and password required'],
    ['malformed email', { email: 'not-an-email', password: 'correct-horse-battery' }, 'Invalid email format'],
    ['short password', { email: 'a@example.com', password: 'short' }, 'Password must be at least 8 characters'],
    ['digits-only password under 12', { email: 'a@example.com', password: '12345678' }, 'A password of only numbers must be at least 12 digits'],
    ['password over 1024 chars', { email: 'a@example.com', password: 'x'.repeat(1025) }, 'Password must be at most 1024 characters'],
  ])('rejects %s with 400 and creates nothing', async (_name, body, error) => {
    const env = makeEnv();
    const res = await post(env, '/auth/register', body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
    expect(count(env, 'SELECT COUNT(*) AS n FROM users')).toBe(0);
    expect(count(env, 'SELECT COUNT(*) AS n FROM sessions')).toBe(0);
  });

  it('rejects a body that is not JSON with 400 and creates nothing', async () => {
    const env = makeEnv();
    const res = await post(env, '/auth/register', '{not json', { headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(400);
    expect(count(env, 'SELECT COUNT(*) AS n FROM users')).toBe(0);
  });

  it('answers 429 with Retry-After past the per-IP budget and stops creating accounts', async () => {
    const env = makeEnv();
    const ip = '203.0.113.77';
    for (let i = 0; i < config.auth.maxLoginAttempts; i += 1) {
      expect((await post(env, '/auth/register', { email: `u${i}@example.com`, password: 'correct-horse-battery' }, { ip })).status).toBe(201);
    }
    const over = await post(env, '/auth/register', { email: 'over@example.com', password: 'correct-horse-battery' }, { ip });
    expect(over.status).toBe(429);
    expect(Number(over.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(count(env, 'SELECT COUNT(*) AS n FROM users')).toBe(config.auth.maxLoginAttempts);
    expect(row(env, "SELECT id FROM users WHERE email = 'over@example.com'")).toBeUndefined();
    // another address is unaffected
    expect((await post(env, '/auth/register', { email: 'other@example.com', password: 'correct-horse-battery' }, { ip: '203.0.113.78' })).status).toBe(201);
  });

  it('emails a verification link when mail is configured, and leaves no live token when it is not', async () => {
    const mail = captureMail();
    const env = makeEnv(MAIL);
    await register(env, 'mailed@example.com');
    expect(mail).toHaveLength(1);
    expect(mail[0].body.to).toEqual(['mailed@example.com']);
    expect(tokenFrom(mail[0])).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(count(env, "SELECT COUNT(*) AS n FROM auth_action_tokens WHERE purpose = 'email_verification' AND consumed_at IS NULL")).toBe(1);

    const unconfigured = makeEnv();
    await register(unconfigured, 'quiet@example.com');
    expect(count(unconfigured, "SELECT COUNT(*) AS n FROM auth_action_tokens WHERE consumed_at IS NULL")).toBe(0);
  });
});

suite('POST /auth/confirm-password-reset (real D1)', () => {
  async function requestReset(env, mail, email) {
    const res = await post(env, '/auth/request-password-reset', { email });
    expect(res.status).toBe(202);
    return tokenFrom(mail[mail.length - 1]);
  }

  it('sets the new password, revokes every session and clears the cookie', async () => {
    const mail = captureMail();
    const env = makeEnv(MAIL);
    const user = await register(env, 'reset@example.com');
    const second = await post(env, '/auth/login', { email: 'reset@example.com', password: 'correct-horse-battery' });
    const secondCookie = second.headers.get('Set-Cookie').split(';')[0];
    expect(count(env, 'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND is_active = 1', user.id)).toBe(2);
    mail.length = 0;

    const token = await requestReset(env, mail, 'reset@example.com');
    const res = await post(env, '/auth/confirm-password-reset', { token, password: 'brand-new-password' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(res.headers.get('Set-Cookie')).toMatch(/Max-Age=0/);

    const hash = row(env, 'SELECT password_hash FROM users WHERE id = ?', user.id).password_hash;
    expect(await verifyPassword('brand-new-password', hash)).toBe(true);
    expect(await verifyPassword('correct-horse-battery', hash)).toBe(false);
    expect(count(env, 'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND is_active = 1', user.id)).toBe(0);
    // the sessions that existed before the reset no longer open the app
    expect((await call(env, '/auth/session', { cookie: user.cookie })).status).toBe(401);
    expect((await call(env, '/auth/session', { cookie: secondCookie })).status).toBe(401);
    // old password is dead, new one logs in
    expect((await post(env, '/auth/login', { email: 'reset@example.com', password: 'correct-horse-battery' })).status).toBe(401);
    expect((await post(env, '/auth/login', { email: 'reset@example.com', password: 'brand-new-password' })).status).toBe(200);
  });

  it.each([
    ['a token of the wrong shape', 'short'],
    ['a well-formed token that was never issued', 'A'.repeat(43)],
    ['no token at all', undefined],
  ])('rejects %s with 400 and moves nothing', async (_n, token) => {
    const mail = captureMail();
    const env = makeEnv(MAIL);
    const user = await register(env, 'victim@example.com');
    mail.length = 0;
    const before = row(env, 'SELECT password_hash FROM users WHERE id = ?', user.id).password_hash;
    const res = await post(env, '/auth/confirm-password-reset', { token, password: 'attacker-chosen-password' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid or expired reset link' });
    expect(row(env, 'SELECT password_hash FROM users WHERE id = ?', user.id).password_hash).toBe(before);
    expect(count(env, 'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND is_active = 1', user.id)).toBe(1);
    expect(mail).toHaveLength(0);
  });

  it('rejects an expired token and leaves the password and sessions alone', async () => {
    const mail = captureMail();
    const env = makeEnv(MAIL);
    const user = await register(env, 'late@example.com');
    mail.length = 0;
    const token = await requestReset(env, mail, 'late@example.com');
    env.DB.sqlite.prepare("UPDATE auth_action_tokens SET expires_at = datetime('now', '-1 minute') WHERE user_id = ? AND purpose = 'password_reset'").run(user.id);
    const before = row(env, 'SELECT password_hash FROM users WHERE id = ?', user.id).password_hash;

    const res = await post(env, '/auth/confirm-password-reset', { token, password: 'too-late-password' });
    expect(res.status).toBe(400);
    expect(row(env, 'SELECT password_hash FROM users WHERE id = ?', user.id).password_hash).toBe(before);
    expect(row(env, "SELECT consumed_at FROM auth_action_tokens WHERE purpose = 'password_reset'").consumed_at).toBeNull();
    expect(count(env, 'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND is_active = 1', user.id)).toBe(1);
  });

  it('a weak new password gets 400 with the policy message and does NOT burn the link', async () => {
    const mail = captureMail();
    const env = makeEnv(MAIL);
    const user = await register(env, 'weak@example.com');
    mail.length = 0;
    const token = await requestReset(env, mail, 'weak@example.com');
    const before = row(env, 'SELECT password_hash FROM users WHERE id = ?', user.id).password_hash;

    const weak = await post(env, '/auth/confirm-password-reset', { token, password: 'short' });
    expect(weak.status).toBe(400);
    expect(await weak.json()).toEqual({ error: 'Password must be at least 8 characters' });
    expect(row(env, 'SELECT password_hash FROM users WHERE id = ?', user.id).password_hash).toBe(before);
    expect(row(env, "SELECT consumed_at FROM auth_action_tokens WHERE purpose = 'password_reset'").consumed_at).toBeNull();

    // the same link still works with an acceptable password
    expect((await post(env, '/auth/confirm-password-reset', { token, password: 'a-strong-enough-one' })).status).toBe(200);
  });

  it('rejects a body that is not JSON with 400', async () => {
    const env = makeEnv();
    const res = await post(env, '/auth/confirm-password-reset', 'nope', { headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(400);
  });

  it('will not turn an email-verification token into a password reset (purpose is checked)', async () => {
    const mail = captureMail();
    const env = makeEnv(MAIL);
    const user = await register(env, 'purpose@example.com');
    const verifyToken = tokenFrom(mail[0]);
    const before = row(env, 'SELECT password_hash FROM users WHERE id = ?', user.id).password_hash;

    const res = await post(env, '/auth/confirm-password-reset', { token: verifyToken, password: 'attacker-chosen-password' });
    expect(res.status).toBe(400);
    expect(row(env, 'SELECT password_hash FROM users WHERE id = ?', user.id).password_hash).toBe(before);
  });

  it('refuses a deactivated account even with a live token', async () => {
    const mail = captureMail();
    const env = makeEnv(MAIL);
    const user = await register(env, 'gone@example.com');
    mail.length = 0;
    const token = await requestReset(env, mail, 'gone@example.com');
    env.DB.sqlite.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(user.id);
    const before = row(env, 'SELECT password_hash FROM users WHERE id = ?', user.id).password_hash;

    const res = await post(env, '/auth/confirm-password-reset', { token, password: 'revive-me-password' });
    expect(res.status).toBe(400);
    expect(row(env, 'SELECT password_hash FROM users WHERE id = ?', user.id).password_hash).toBe(before);
  });
});

suite('POST /auth/request-email-verification (real D1)', () => {
  it('is 401 without a session, and 401 for a forged cookie, and sends nothing', async () => {
    const mail = captureMail();
    const env = makeEnv(MAIL);
    await register(env, 'unverified@example.com');
    mail.length = 0;
    expect((await post(env, '/auth/request-email-verification', {})).status).toBe(401);
    expect((await post(env, '/auth/request-email-verification', {}, { cookie: '__Host-focusbro_session=not.a.jwt' })).status).toBe(401);
    expect(mail).toHaveLength(0);
  });

  it('for an unverified account answers 202, mails a fresh link to THAT account and retires the old one', async () => {
    const mail = captureMail();
    const env = makeEnv(MAIL);
    const user = await register(env, 'unverified@example.com');
    const stale = tokenFrom(mail[0]);
    mail.length = 0;

    const res = await post(env, '/auth/request-email-verification', {}, { cookie: user.cookie });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ success: true, verified: false });
    expect(mail).toHaveLength(1);
    expect(mail[0].body.to).toEqual(['unverified@example.com']);
    const fresh = tokenFrom(mail[0]);
    expect(fresh).not.toBe(stale);
    expect(count(env, "SELECT COUNT(*) AS n FROM auth_action_tokens WHERE user_id = ? AND purpose = 'email_verification' AND consumed_at IS NULL", user.id)).toBe(1);

    // the old link is dead, the new one verifies the address
    expect((await post(env, '/auth/confirm-email-verification', { token: stale })).status).toBe(400);
    expect(row(env, 'SELECT email_verified_at FROM users WHERE id = ?', user.id).email_verified_at).toBeNull();
    expect((await post(env, '/auth/confirm-email-verification', { token: fresh })).status).toBe(200);
    expect(row(env, 'SELECT email_verified_at FROM users WHERE id = ?', user.id).email_verified_at).toBeTruthy();
  });

  it('for an already-verified account answers 200 verified:true and sends nothing', async () => {
    const mail = captureMail();
    const env = makeEnv(MAIL);
    const user = await register(env, 'done@example.com');
    env.DB.sqlite.prepare("UPDATE users SET email_verified_at = datetime('now') WHERE id = ?").run(user.id);
    mail.length = 0;
    const res = await post(env, '/auth/request-email-verification', {}, { cookie: user.cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, verified: true });
    expect(mail).toHaveLength(0);
  });

  it('is throttled per account: past the budget it still answers 202 but stops sending', async () => {
    const mail = captureMail();
    const env = makeEnv(MAIL);
    const user = await register(env, 'spam@example.com');
    mail.length = 0;
    for (let i = 0; i < 12; i += 1) {
      expect((await post(env, '/auth/request-email-verification', {}, { cookie: user.cookie })).status).toBe(202);
    }
    // each call comes from a new address, so the account-wide budget (5) is what binds
    expect(mail).toHaveLength(5);
  });

  it('refuses a session whose account has been deactivated', async () => {
    const mail = captureMail();
    const env = makeEnv(MAIL);
    const user = await register(env, 'deact@example.com');
    env.DB.sqlite.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(user.id);
    mail.length = 0;
    const res = await post(env, '/auth/request-email-verification', {}, { cookie: user.cookie });
    expect(res.status).toBe(401);
    expect(mail).toHaveLength(0);
    expect(rows(env, 'SELECT id FROM users WHERE is_active = 1')).toHaveLength(0);
  });
});

// The real password rule (validation.test.js claimed an upper/lower/digit rule that production never had).
describe('passwordPolicyError — the one password rule register and reset share', () => {
  it.each([
    ['short', 'Password must be at least 8 characters'],
    ['1234567', 'Password must be at least 8 characters'],
    [undefined, 'Password must be at least 8 characters'],
    [12345678, 'Password must be at least 8 characters'],
    ['12345678', 'A password of only numbers must be at least 12 digits'],
    ['12345678901', 'A password of only numbers must be at least 12 digits'],
    ['x'.repeat(1025), 'Password must be at most 1024 characters'],
  ])('refuses %j', (password, message) => {
    expect(passwordPolicyError(password)).toBe(message);
  });

  it.each([
    ['12345678 9012'.replace(' ', '')], // 12 digits
    ['alllowercase'], // no upper/number needed: length is the rule
    ['x'.repeat(8)],
    ['x'.repeat(1024)],
  ])('accepts %j', (password) => {
    expect(passwordPolicyError(password)).toBeNull();
  });
});
