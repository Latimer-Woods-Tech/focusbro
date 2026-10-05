/**
 * FBQ-24 R3 — the real home of what auth.test.js claimed to check. That file
 * imported nothing from src/ and asserted on literals (`expect(!!existing).toBe(true)`);
 * every behaviour it named is exercised here against the Worker over a REAL
 * migrated SQLite D1:
 *   login: missing credentials, unknown user, wrong password, success w/o a token in the body
 *   session: JWT-shaped credential, forged token, logout really ends the session
 *   CORS: allowed origin echoed, untrusted origin refused
 *   cross-site cookie mutation rejected (the missing-Origin case)
 * Register + recovery live in route-auth-register-recovery.test.js; the
 * login rate limit in login-limit.test.js.
 */
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from './helpers/real-d1.js';
import { call, count, makeEnv, register, row } from './helpers/route-kit.js';

const suite = DatabaseSync ? describe : describe.skip;
const PASSWORD = 'correct-horse-battery';
const login = (env, body, opts = {}) => call(env, '/auth/login', { method: 'POST', body, ...opts });

suite('POST /auth/login (real D1)', () => {
  it.each([
    ['no fields', {}],
    ['no password', { email: 'a@example.com' }],
    ['no email', { password: PASSWORD }],
  ])('rejects %s with 400 and opens no session', async (_n, body) => {
    const env = makeEnv();
    expect((await login(env, body)).status).toBe(400);
    expect(count(env, 'SELECT COUNT(*) AS n FROM sessions')).toBe(0);
  });

  it('rejects a body that is not JSON with 400', async () => {
    const env = makeEnv();
    const res = await login(env, 'nope', { headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(400);
  });

  it('answers an unknown user and a wrong password with the SAME 401 body (no enumeration) and opens no session', async () => {
    const env = makeEnv();
    await register(env, 'real@example.com');
    const sessionsBefore = count(env, 'SELECT COUNT(*) AS n FROM sessions');
    const unknown = await login(env, { email: 'ghost@example.com', password: PASSWORD });
    const wrong = await login(env, { email: 'real@example.com', password: 'not-the-password' });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await unknown.json()).toEqual({ error: 'Invalid email or password' });
    expect(await wrong.json()).toEqual({ error: 'Invalid email or password' });
    expect(count(env, 'SELECT COUNT(*) AS n FROM sessions')).toBe(sessionsBefore);
    expect(unknown.headers.get('Set-Cookie')).toBeNull();
    expect(wrong.headers.get('Set-Cookie')).toBeNull();
  });

  it('refuses a deactivated account even with the right password', async () => {
    const env = makeEnv();
    const me = await register(env, 'closed@example.com');
    env.DB.sqlite.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(me.id);
    expect((await login(env, { email: 'closed@example.com', password: PASSWORD })).status).toBe(401);
  });

  it('succeeds with a session cookie and NO credential in the JSON body, and records the login', async () => {
    const env = makeEnv();
    const me = await register(env, 'Real@Example.com ');
    const res = await login(env, { email: ' REAL@example.com', password: PASSWORD });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, user_id: me.id, email: 'real@example.com' });
    expect(body.session_id).toBeTruthy();
    expect(body).not.toHaveProperty('token');
    expect(JSON.stringify(body)).not.toMatch(/eyJ|\.[A-Za-z0-9_-]{20,}\./);

    const cookie = res.headers.get('Set-Cookie');
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    const jwt = decodeURIComponent(cookie.split(';')[0].split('=').slice(1).join('='));
    expect(jwt.split('.')).toHaveLength(3); // header.payload.signature
    expect(count(env, "SELECT COUNT(*) AS n FROM audit_logs WHERE user_id = ? AND action = 'login'", me.id)).toBe(1);
    expect(row(env, 'SELECT last_login FROM users WHERE id = ?', me.id).last_login).toBeTruthy();
    expect(count(env, 'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND is_active = 1', me.id)).toBe(2);
  });
});

suite('session validation and logout (real D1)', () => {
  const session = (env, cookie) => call(env, '/auth/session', { cookie });

  it('a registered session is valid; no cookie, a malformed token and a tampered signature are 401', async () => {
    const env = makeEnv();
    const me = await register(env, 'session@example.com');
    expect((await session(env, me.cookie)).status).toBe(200);
    expect((await session(env, undefined)).status).toBe(401);
    expect((await session(env, '__Host-focusbro_session=not-a-jwt')).status).toBe(401);
    // flip the last character of the signature
    const last = me.cookie.slice(-1);
    const tampered = me.cookie.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    expect((await session(env, tampered)).status).toBe(401);
  });

  it('logout ends THAT session in the database and the cookie stops working; other sessions survive', async () => {
    const env = makeEnv();
    const me = await register(env, 'logout@example.com');
    const second = (await login(env, { email: 'logout@example.com', password: PASSWORD })).headers.get('Set-Cookie').split(';')[0];

    const out = await call(env, '/auth/logout', { method: 'POST', cookie: me.cookie });
    expect(out.status).toBe(200);
    expect(count(env, 'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND is_active = 1', me.id)).toBe(1);
    expect((await session(env, me.cookie)).status).toBe(401);
    expect((await session(env, second)).status).toBe(200);
  });

  it('logout without a valid session is 401 and clears the cookie', async () => {
    const env = makeEnv();
    const res = await call(env, '/auth/logout', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(res.headers.get('Set-Cookie')).toMatch(/Max-Age=0/);
  });
});

suite('CORS and cross-site cookie mutation (real D1)', () => {
  const preflight = (env, origin) => call(env, '/api/commitments', { method: 'OPTIONS', origin });

  it('echoes an allowed origin and grants its methods', async () => {
    const res = await preflight(makeEnv(), 'https://www.focusbro.net');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://www.focusbro.net');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  it('gives an untrusted origin the literal "null" and no methods or headers', async () => {
    const res = await preflight(makeEnv(), 'https://malicious.example');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('null');
    expect(res.headers.get('Access-Control-Allow-Methods') || '').toBe('');
    expect(res.headers.get('Access-Control-Allow-Headers') || '').toBe('');
  });

  it('rejects a cookie-authenticated write from another site, or with no Origin, with 403 and changes nothing', async () => {
    const env = makeEnv();
    const me = await register(env, 'csrf@example.com');
    const attempt = (origin) => call(env, '/api/coach/note-consent', { method: 'POST', cookie: me.cookie, origin, body: { shared: true } });
    expect((await attempt('https://evil.example')).status).toBe(403);
    expect((await attempt(null)).status).toBe(403);
    expect(count(env, 'SELECT COUNT(*) AS n FROM coach_note_consent')).toBe(0);
    expect((await attempt('https://focusbro.net')).status).toBe(200);
    expect(row(env, 'SELECT shared FROM coach_note_consent WHERE user_id = ?', me.id).shared).toBe(1);
  });
});
