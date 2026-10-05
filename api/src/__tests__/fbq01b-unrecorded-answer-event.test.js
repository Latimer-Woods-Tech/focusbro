/**
 * FBQ-01b — an answer that returns `recorded: false` is a counted event.
 *
 * The FBQ-01 P0 (an answer that silently wrote nothing) lived for months because
 * nothing counted it. Every `recorded: false` reply now records one
 * `checkin_answer_unrecorded` event (closed-vocabulary reason, no title/text),
 * surfaced as `totals.answers_unrecorded` in the loop metrics. A recorded answer
 * adds none. Real migrated SQLite, real cron, real routes.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import worker from '../index.js';
import { runDueCheckins } from '../checkins-cron.js';
import { computeLoopMetrics } from '../events.js';
import { DatabaseSync, makeMigratedD1, makeKV } from './helpers/real-d1.js';

const suite = DatabaseSync ? describe : describe.skip;
const ORIGIN = 'https://focusbro.net';
const ctx = { waitUntil() {}, passThroughOnException() {} };
const RUNTIME_CREATES = [...readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  .matchAll(/`(CREATE TABLE IF NOT EXISTS[\s\S]*?)`/g)].map((m) => m[1]);
const NOW = '2026-10-05T15:00:00.000Z';
const DUE = '2026-10-05T14:30:00.000Z';
const TYPE = 'checkin_answer_unrecorded';

function makeEnv() {
  const DB = makeMigratedD1();
  for (const sql of RUNTIME_CREATES) DB.sqlite.exec(sql);
  return {
    DB, KV_CACHE: makeKV(), BUILD_SHA: 'abc1234',
    JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256-0123456789',
    VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv',
  };
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
async function guestWord(env) {
  const g = await worker.fetch(req('POST', '/auth/guest', { body: {} }), env, ctx);
  const cookie = g.headers.get('Set-Cookie').split(';')[0];
  const { user_id: userId } = await g.json();
  const c = await call(env, 'POST', '/api/commitments', {
    cookie, body: { title: 'stretch', start_at: DUE, checkin_at: DUE, persona: 'ally', timezone: 'America/New_York' },
  });
  expect(c.status).toBe(201);
  return { cookie, userId, id: c.body.commitment.id };
}
const events = (env) => env.DB.sqlite.prepare(
  'SELECT user_id, event_data FROM analytics_events WHERE event_type = ?').all(TYPE);

suite('FBQ-01b: recorded:false is observable', () => {
  afterEach(() => vi.useRealTimers());

  it('a recorded answer adds no event; the double tap (recorded:false) adds exactly one, with a reason', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    const env = makeEnv();
    const { cookie, userId, id } = await guestWord(env);
    await runDueCheckins(env);
    const first = await call(env, 'POST', `/api/commitments/${id}/checkin`, { cookie, body: { outcome: 'kept' } });
    expect(first.body.recorded).toBe(true);
    expect(events(env)).toHaveLength(0);

    const second = await call(env, 'POST', `/api/commitments/${id}/checkin`, { cookie, body: { outcome: 'kept' } });
    expect(second.body.recorded).toBe(false);
    const rows = events(env);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(userId);
    const data = JSON.parse(rows[0].event_data);
    expect(data).toMatchObject({ commitment_id: id, outcome: 'kept' });
    expect(['word_settled', 'occurrence_settled', 'nothing_to_resolve', 'restart_already_made']).toContain(data.reason);
    expect(JSON.stringify(data)).not.toContain('stretch');
  });

  it('a stale skip (nothing to resolve) is counted, and the loop metrics expose it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-06T16:00:00.000Z'));
    const env = makeEnv();
    const { cookie, id } = await guestWord(env);
    await runDueCheckins(env);
    const r = await call(env, 'POST', `/api/commitments/${id}/checkin`, { cookie, body: { outcome: 'kept' } });
    expect(r.body.recorded).toBe(false);
    expect(events(env)).toHaveLength(1);
    const m = await computeLoopMetrics(env, {});
    expect(m.totals.answers_unrecorded).toBe(1);
    // A diagnostic, never a resolution: the kept-word rate is untouched.
    expect(m.kept_word_rate ?? m.totals.kept_word_rate ?? null).toBeNull();
  });
});
