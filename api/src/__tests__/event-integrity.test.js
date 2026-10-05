/**
 * FBQ-15 — client events cannot forge public or founder metrics.
 *
 * Real D1 (the repo's migrations on in-memory SQLite) driven through the Worker:
 * a free guest posts to `/sync/events` exactly as an attacker would, and the
 * anonymous `/api/acquisition/*` beacons are hit without an Origin and in a
 * flood. Every assertion reads the rows back from the database.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import worker from '../index.js';
import { computeLoopMetrics, CLIENT_EVENT_TYPES, EVENTS } from '../events.js';
import { followThroughFigures } from '../guides/follow-through.js';
import { DatabaseSync, makeMigratedD1, makeKV } from './helpers/real-d1.js';

const suite = DatabaseSync ? describe : describe.skip;
const ORIGIN = 'https://focusbro.net';
const ctx = { waitUntil() {}, passThroughOnException() {} };
const RUNTIME_CREATES = [...readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  .matchAll(/`(CREATE TABLE IF NOT EXISTS[\s\S]*?)`/g)].map((m) => m[1]);

function makeEnv() {
  const DB = makeMigratedD1();
  for (const sql of RUNTIME_CREATES) DB.sqlite.exec(sql);
  return { DB, KV_CACHE: makeKV(), JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256-0123456789', BUILD_SHA: 'abc1234' };
}

function req(method, path, { cookie, body, origin = ORIGIN, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.Cookie = cookie;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; if (origin) h.Origin = origin; }
  return new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
}

async function startGuest(env) {
  const res = await worker.fetch(req('POST', '/auth/guest', { body: {} }), env, ctx);
  expect(res.status).toBe(201);
  const cookie = res.headers.get('Set-Cookie').split(';')[0];
  const { user_id: userId } = await res.json();
  return { cookie, userId };
}

async function postEvents(env, cookie, events) {
  const res = await worker.fetch(req('POST', '/sync/events', { cookie, body: { events } }), env, ctx);
  expect(res.status).toBe(200);
  return res.json();
}

const rowsOfType = (env, type) => env.DB.sqlite
  .prepare('SELECT user_id, event_type, event_data, created_at FROM analytics_events WHERE event_type = ?').all(type);
const iso = (ms) => new Date(ms).toISOString();

// Every type the server records itself — a client must never be able to post one.
const EXPECTED_CLIENT = ['push_permission', 'session_complete', 'sound_share', 'sound_start', 'sound_stop'];
const SERVER_ONLY = Object.values(EVENTS).filter((t) => !EXPECTED_CLIENT.includes(t));

suite('FBQ-15 R1 — /sync/events accepts only client-originated types', () => {
  it('the allowlist is exactly what the real clients send', () => {
    expect([...(CLIENT_EVENT_TYPES || [])].sort()).toEqual(EXPECTED_CLIENT);
    for (const t of ['commitment_kept', 'checkin_delivered', 'return_nudge_sent', 'acquisition_visit', 'word_offered']) {
      expect(SERVER_ONLY).toContain(t);
    }
  });

  it.each(SERVER_ONLY)('a guest posting %s is refused and nothing is stored', async (type) => {
    const env = makeEnv();
    const { cookie } = await startGuest(env);
    const before = rowsOfType(env, type).length;
    const out = await postEvents(env, cookie, [{ id: 'forged-1', type, at: iso(Date.now()) }]);
    expect(out).toMatchObject({ success: true, accepted: 0, rejected: 1 });
    expect(rowsOfType(env, type).length).toBe(before);
  });

  it('an allowed type is stored, against the session user', async () => {
    const env = makeEnv();
    const { cookie, userId } = await startGuest(env);
    const out = await postEvents(env, cookie, [
      { id: 's1', type: 'session_complete', tool: 'pomodoro', duration_seconds: 1500, at: iso(Date.now() - 60_000) },
      { id: 'k1', type: 'commitment_kept', at: iso(Date.now()) },
    ]);
    expect(out).toMatchObject({ accepted: 1, rejected: 1 });
    const rows = rowsOfType(env, 'session_complete');
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(userId);
  });

  it('a user_id in the payload is ignored — the row belongs to the session, the payload carries no user_id', async () => {
    const env = makeEnv();
    const attacker = await startGuest(env);
    const victim = await startGuest(env);
    await postEvents(env, attacker.cookie, [
      { id: 'sp1', type: 'session_complete', tool: 'pomodoro', user_id: victim.userId, userId: victim.userId, at: iso(Date.now()) },
      { id: 'sp2', type: 'return_nudge_sent', user_id: victim.userId, channel: 'push', at: iso(Date.now()) },
    ]);
    const rows = rowsOfType(env, 'session_complete');
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(attacker.userId);
    expect(JSON.parse(rows[0].event_data)).toEqual({ tool: 'pomodoro' });
    // No "welcomed back" marker can now name the victim.
    const cues = env.DB.sqlite.prepare(
      "SELECT COUNT(*) AS n FROM analytics_events WHERE json_extract(event_data, '$.user_id') = ?").get(victim.userId).n;
    expect(cues).toBe(0);
  });
});

suite('FBQ-15 R2 — the event time is clamped to [now − 7d, now + 5min]', () => {
  const DAY = 24 * 60 * 60 * 1000;
  it('refuses an event older than 7 days and one more than 5 minutes ahead; keeps the in-range ones', async () => {
    const env = makeEnv();
    const { cookie } = await startGuest(env);
    const now = Date.now();
    const out = await postEvents(env, cookie, [
      { id: 'old', type: 'session_complete', at: iso(now - 8 * DAY) },
      { id: 'future', type: 'session_complete', at: iso(now + 10 * 60 * 1000) },
      { id: 'garbage', type: 'session_complete', at: 'not-a-date' },
      { id: 'recent', type: 'session_complete', at: iso(now - 6 * DAY) },
      { id: 'skew', type: 'session_complete', at: iso(now + 60 * 1000) },
    ]);
    expect(out).toMatchObject({ accepted: 2, rejected: 3 });
    const kept = rowsOfType(env, 'session_complete').map((r) => r.created_at.slice(0, 10)).sort();
    expect(kept).toEqual([iso(now - 6 * DAY).slice(0, 10), iso(now + 60 * 1000).slice(0, 10)].sort());
  });
});

suite('FBQ-15 — the public follow-through index cannot be moved by a client', () => {
  it('forged commitment_kept / reschedule / missed from guests leave the metrics and the public figures unchanged', async () => {
    const env = makeEnv();
    const at = new Date(Date.now() + 60_000);
    const publicFigures = () => followThroughFigures({ DB: env.DB }, { now: () => at });
    const before = await computeLoopMetrics(env, { sinceDays: 30 });
    const beforePublic = await publicFigures();
    for (let g = 0; g < 3; g++) {
      const { cookie } = await startGuest(env);
      await postEvents(env, cookie, Array.from({ length: 40 }, (_, i) => ({
        id: `f-${g}-${i}`, type: i % 3 === 0 ? 'commitment_reschedule' : 'commitment_kept', at: iso(Date.now() - i * 1000),
      })));
    }
    const after = await computeLoopMetrics(env, { sinceDays: 30 });
    expect(after.totals.commitments_kept).toBe(before.totals.commitments_kept);
    expect(after.resolved).toBe(before.resolved);
    expect(after.kept_word_rate).toBe(before.kept_word_rate);
    const afterPublic = await publicFigures();
    expect(afterPublic).toEqual(beforePublic);
    expect(afterPublic.resolved ?? 0).toBe(beforePublic.resolved ?? 0);
  });
});

suite('FBQ-15 R3/R4 — the anonymous acquisition beacons', () => {
  const visit = (env, { origin = ORIGIN, ip = '203.0.113.7', body = { attribution: { source: 'tiktok' } } } = {}) =>
    worker.fetch(req('POST', '/api/acquisition/visit', { body, origin, headers: { 'CF-Connecting-IP': ip } }), env, ctx);

  it.each(['/api/acquisition/visit', '/api/acquisition/word-offered'])('%s without an Origin header is 403 and records nothing', async (path) => {
    const env = makeEnv();
    const res = await worker.fetch(req('POST', path, { body: { attribution: { source: 'x' }, when: 't-10m' }, origin: null }), env, ctx);
    expect(res.status).toBe(403);
    expect(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM analytics_events WHERE event_type IN ('acquisition_visit','word_offered')").get().n).toBe(0);
  });

  it('a same-site Origin is still accepted', async () => {
    const env = makeEnv();
    expect((await visit(env)).status).toBe(202);
    expect(rowsOfType(env, 'acquisition_visit')).toHaveLength(1);
  });

  it('a flood from one IP trips the limit (429); another IP is unaffected', async () => {
    const env = makeEnv();
    const statuses = [];
    for (let i = 0; i < 40; i++) statuses.push((await visit(env)).status);
    expect(statuses.filter((s) => s === 202).length).toBe(30);
    expect(statuses.slice(30).every((s) => s === 429)).toBe(true);
    expect(rowsOfType(env, 'acquisition_visit')).toHaveLength(30);
    expect((await visit(env, { ip: '198.51.100.9' })).status).toBe(202);
  });

  it('an oversized body is refused by the bytes read, not just the declared length', async () => {
    const env = makeEnv();
    const big = JSON.stringify({ attribution: { source: 'x' }, pad: 'a'.repeat(4000) });
    const res = await visit(env, { body: big });
    expect(res.status).toBe(413);
    expect(rowsOfType(env, 'acquisition_visit')).toHaveLength(0);
  });
});
