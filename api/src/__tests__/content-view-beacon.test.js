/**
 * FBQ-15b — POST /api/content/view (the guide-view beacon) is same-origin only
 * and rate limited per IP. Real D1 (migrated in-memory SQLite) through the Worker.
 */
import { describe, it, expect } from 'vitest';
import worker from '../index.js';
import { guides } from '../guides/index.js';
import { DatabaseSync, makeMigratedD1, makeKV } from './helpers/real-d1.js';

const suite = DatabaseSync ? describe : describe.skip;
const ORIGIN = 'https://focusbro.net';
const ctx = { waitUntil() {}, passThroughOnException() {} };
const SLUG = guides[0].slug;

const makeEnv = () => ({ DB: makeMigratedD1(), KV_CACHE: makeKV(), JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256-0123456789', BUILD_SHA: 'abc1234' });

function view(env, { origin = ORIGIN, ip = '203.0.113.7', body = { slug: SLUG } } = {}) {
  const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip };
  if (origin) headers.Origin = origin;
  return worker.fetch(new Request(ORIGIN + '/api/content/view', { method: 'POST', headers, body: JSON.stringify(body) }), env, ctx);
}
const viewRows = (env) => env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM analytics_events WHERE event_type = 'guide_view'").get().n;

suite('FBQ-15b — /api/content/view', () => {
  it('a same-site Origin is accepted and recorded', async () => {
    const env = makeEnv();
    expect((await view(env)).status).toBe(202);
    expect(viewRows(env)).toBe(1);
  });

  it('a request with no Origin header is 403 and records nothing', async () => {
    const env = makeEnv();
    expect((await view(env, { origin: null })).status).toBe(403);
    expect(viewRows(env)).toBe(0);
  });

  it('a foreign Origin is 403 and records nothing', async () => {
    const env = makeEnv();
    expect((await view(env, { origin: 'https://evil.example' })).status).toBe(403);
    expect(viewRows(env)).toBe(0);
  });

  it('a flood from one IP trips the limit (429 + Retry-After); another IP is unaffected', async () => {
    const env = makeEnv();
    const res = [];
    for (let i = 0; i < 70; i++) res.push(await view(env));
    const statuses = res.map((r) => r.status);
    expect(statuses.filter((s) => s === 202)).toHaveLength(60);
    expect(statuses.slice(60).every((s) => s === 429)).toBe(true);
    expect(Number(res[60].headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(viewRows(env)).toBe(60);
    expect((await view(env, { ip: '198.51.100.9' })).status).toBe(202);
  });

  it('concurrent views cannot overshoot the limit (atomic D1 spend)', async () => {
    const env = makeEnv();
    const statuses = (await Promise.all(Array.from({ length: 80 }, () => view(env)))).map((r) => r.status);
    expect(statuses.filter((s) => s === 202)).toHaveLength(60);
    expect(viewRows(env)).toBe(60);
  });
});
