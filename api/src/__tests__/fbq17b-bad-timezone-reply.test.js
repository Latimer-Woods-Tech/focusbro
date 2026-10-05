/**
 * FBQ-17b — an invalid time zone gets its own honest reply.
 *
 * `parseWhenReply` returns null for a zone Intl rejects, and every caller turned
 * that null into "I didn't catch a time there" — blaming the words the person
 * typed for a problem in the zone. The reply now names the zone, in the app's
 * warm voice, and (as always) writes nothing. Real migrated SQLite, real routes.
 */
import { describe, it, expect } from 'vitest';
import worker from '../index.js';
import { DatabaseSync, makeMigratedD1, makeKV } from './helpers/real-d1.js';
import { readFileSync } from 'node:fs';

const suite = DatabaseSync ? describe : describe.skip;
const ORIGIN = 'https://focusbro.net';
const ctx = { waitUntil() {}, passThroughOnException() {} };
const RUNTIME_CREATES = [...readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  .matchAll(/`(CREATE TABLE IF NOT EXISTS[\s\S]*?)`/g)].map((m) => m[1]);

function makeEnv() {
  const DB = makeMigratedD1();
  for (const sql of RUNTIME_CREATES) DB.sqlite.exec(sql);
  return { DB, KV_CACHE: makeKV(), BUILD_SHA: 'abc1234', JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256-0123456789' };
}
function req(method, path, { cookie, body } = {}) {
  const h = {};
  if (cookie) h.Cookie = cookie;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; h.Origin = ORIGIN; }
  return new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function call(env, method, path, opts) {
  const res = await worker.fetch(req(method, path, opts), env, ctx);
  return { status: res.status, body: await res.json() };
}
async function guest(env) {
  const g = await worker.fetch(req('POST', '/auth/guest', { body: {} }), env, ctx);
  expect(g.status).toBe(201);
  return g.headers.get('Set-Cookie').split(';')[0];
}
const count = (env) => env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM commitments').get().n;

suite('FBQ-17b: bad time zone is not "I didn\'t catch a time"', () => {
  it('a plain-words time with an invalid zone says the zone is the problem, and writes nothing', async () => {
    const env = makeEnv();
    const cookie = await guest(env);
    const r = await call(env, 'POST', '/api/commitments', {
      cookie, body: { title: 'stretch', when_text: 'tomorrow 9am', timezone: 'Mars/Olympus' },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/time zone/i);
    expect(r.body.error).not.toMatch(/catch a time/i);
    expect(r.body.error).not.toMatch(/\bAI\b|sorry|fail|wrong|should have/i);
    expect(count(env)).toBe(0);
  });

  it('a valid zone with an unreadable time still gets the "catch a time" re-ask', async () => {
    const env = makeEnv();
    const cookie = await guest(env);
    const r = await call(env, 'POST', '/api/commitments', {
      cookie, body: { title: 'stretch', when_text: 'blorp', timezone: 'America/Chicago' },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/catch a time/i);
  });

  it('a valid zone with a readable time still creates the word', async () => {
    const env = makeEnv();
    const cookie = await guest(env);
    const r = await call(env, 'POST', '/api/commitments', {
      cookie, body: { title: 'stretch', when_text: 'in 2 hours', timezone: 'America/Chicago' },
    });
    expect(r.status).toBe(201);
    expect(count(env)).toBe(1);
  });
});
