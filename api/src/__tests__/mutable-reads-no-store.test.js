/**
 * FBQ-03 — mutable reads are never served stale.
 *
 * QA (2026-10-05, Chromium) found the commitments, word, detail, streak and
 * kept-log reads answering `Cache-Control: private, max-age=300` with no Vary.
 * After "I did it" the card still offered the button; after "Not yet" the moved
 * word was missing; after sign-out the native bridge could re-sync the previous
 * person's reminders from the browser cache — for up to five minutes.
 *
 * Every authenticated read whose answer changes when the person acts must be
 * `no-store`. Driven end to end through the real worker on a real migrated
 * SQLite, with the same guest cookie a first visitor gets. Public responses
 * keep their caching (R3).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import worker from '../index.js';
import { DatabaseSync, makeMigratedD1, makeKV } from './helpers/real-d1.js';

const suite = DatabaseSync ? describe : describe.skip;
const ORIGIN = 'https://focusbro.net';
const SECRET = 'test-secret-that-is-long-enough-for-hs256-0123456789';
const ctx = { waitUntil() {}, passThroughOnException() {} };
const RUNTIME_CREATES = [...readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  .matchAll(/`(CREATE TABLE IF NOT EXISTS[\s\S]*?)`/g)].map((m) => m[1]);

function makeEnv() {
  const DB = makeMigratedD1();
  for (const sql of RUNTIME_CREATES) DB.sqlite.exec(sql);
  return { DB, KV_CACHE: makeKV(), JWT_SECRET: SECRET, BUILD_SHA: 'abc1234' };
}
function req(method, path, { cookie, body } = {}) {
  const h = {};
  if (cookie) h.Cookie = cookie;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; h.Origin = ORIGIN; }
  return new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
}

suite('FBQ-03: authenticated mutable reads send Cache-Control: no-store', () => {
  it('every per-person read the app re-fetches after an action is no-store', async () => {
    const env = makeEnv();
    const g = await worker.fetch(req('POST', '/auth/guest', { body: {} }), env, ctx);
    expect(g.status).toBe(201);
    const cookie = g.headers.get('Set-Cookie').split(';')[0];
    const c = await worker.fetch(req('POST', '/api/commitments', {
      cookie, body: { title: 'start the taxes', start_at: '2099-01-01T15:00:00.000Z', persona: 'ally', channel: 'push' },
    }), env, ctx);
    expect(c.status).toBe(201);
    const { id } = (await c.json()).commitment;

    const reads = [
      '/api/commitments',
      `/api/commitments/${id}`,
      `/api/commitments/${id}/detail`,
      '/api/accountability/streak',
      '/api/accountability/kept',
      '/api/accountability/homecoming',
      '/api/consent',
      '/api/coach/note-consent',
    ];
    for (const path of reads) {
      const r = await worker.fetch(req('GET', path, { cookie }), env, ctx);
      expect(r.status, path).toBe(200);
      const cc = r.headers.get('Cache-Control') || '';
      expect(cc, path).toMatch(/\bno-store\b/);
      expect(cc, path).not.toMatch(/max-age=[1-9]/);
    }
  });

  it('a per-person write answer is no-store too (privacy delete)', async () => {
    const env = makeEnv();
    const g = await worker.fetch(req('POST', '/auth/guest', { body: {} }), env, ctx);
    const cookie = g.headers.get('Set-Cookie').split(';')[0];
    const r = await worker.fetch(req('POST', '/privacy/delete', { cookie, body: {} }), env, ctx);
    expect(r.status).toBe(200);
    expect(r.headers.get('Cache-Control')).toMatch(/\bno-store\b/);
  });

  it('the page scripts and the native bridge fetch those reads with cache: no-store (R2)', () => {
    // A plain GET of a mutable read (no `method:` in its options) must opt out
    // of the HTTP cache on the client too — defence in depth beside the header.
    const READ = /fetch\('(\/api\/commitments|\/api\/commitments\/' \+ encodeURIComponent\(id\) \+ '\/detail|\/api\/accountability\/(?:streak|kept|homecoming)|\/api\/consent|\/api\/coach\/note-consent|\/api\/coach\/clients|\/api\/escalation|\/api\/me\/report|\/api\/pro\/status|\/auth\/session)'(\)|, \{[^}]*\})/g;
    const sources = ['../me.js', '../native-bridge.js', '../report.js', '../index.js', '../pro.js', '../account-delete.js', '../../../public/index.html'];
    let seen = 0;
    for (const rel of sources) {
      const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
      for (const m of src.matchAll(READ)) {
        if (/method:/.test(m[2])) continue;
        seen += 1;
        expect(m[2], `${rel}: ${m[0]}`).toMatch(/cache: 'no-store'/);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(20);
  });

  it('public responses keep their caching (R3)', async () => {
    const env = makeEnv();
    const pub = await worker.fetch(req('GET', '/api/public/follow-through'), env, ctx);
    expect(pub.headers.get('Cache-Control')).toMatch(/^public, max-age=\d+/);
    const guide = await worker.fetch(req('GET', '/guides/'), env, ctx);
    expect(guide.headers.get('Cache-Control')).toBe('public, max-age=300');
  });
});
