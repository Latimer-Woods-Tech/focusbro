// Shared driver for route tests that go through the Worker's own fetch() over a
// REAL migrated SQLite D1 (see real-d1.js). Every account is made the way a
// person makes one: POST /auth/register, then the session cookie it sets.
import worker from '../../index.js';
import { makeMigratedD1, makeKV } from './real-d1.js';

export const ORIGIN = 'https://focusbro.net';
export const JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256-0123456789';
export const ctx = { waitUntil() {}, passThroughOnException() {} };

export function makeEnv(extra = {}) {
  return {
    DB: makeMigratedD1(),
    KV_CACHE: makeKV(),
    JWT_SECRET,
    AUDIO: { head: async () => null, get: async () => null },
    ...extra,
  };
}

let ipCounter = 0;
/** One request through worker.fetch. A fresh client IP each call keeps per-IP limiters out of the way. */
export function call(env, path, { method = 'GET', body, headers = {}, cookie, ip, origin = ORIGIN } = {}) {
  const h = { 'CF-Connecting-IP': ip || `198.51.100.${(ipCounter += 1) % 250}`, ...headers };
  if (origin) h.Origin = origin;
  if (cookie) h.Cookie = cookie;
  if (body !== undefined && typeof body !== 'string') h['Content-Type'] = 'application/json';
  return worker.fetch(new Request(ORIGIN + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  }), env, ctx);
}

/** Register an account and return { id, email, cookie }. */
export async function register(env, email, password = 'correct-horse-battery') {
  const res = await call(env, '/auth/register', { method: 'POST', body: { email, password } });
  if (res.status !== 201) throw new Error(`register ${email} -> ${res.status}`);
  const body = await res.json();
  return { id: body.user_id, email, cookie: res.headers.get('Set-Cookie').split(';')[0] };
}

export const row = (env, sql, ...args) => env.DB.sqlite.prepare(sql).get(...args);
export const rows = (env, sql, ...args) => env.DB.sqlite.prepare(sql).all(...args);
export const count = (env, sql, ...args) => row(env, sql, ...args).n;
