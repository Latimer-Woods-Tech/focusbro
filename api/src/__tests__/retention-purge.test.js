/**
 * FBQ-26a (focusbro#391) — dead rows are purged by the existing cron, a bounded
 * slice per tick. Real SQLite built from migrations/ (real-d1.js); driven through
 * the Worker's own scheduled() so the wiring is under test, not just the helper.
 *
 * Before this change nothing deleted expired sessions, expired auth tokens or old
 * analytics events: every row in these tests survived any number of ticks.
 */
import { describe, expect, it } from 'vitest';
import worker from '../index.js';
import { runRetentionPurge, analyticsRetentionDays, PURGE_BATCH } from '../retention-purge.js';
import { DatabaseSync, makeMigratedD1, makeKV } from './helpers/real-d1.js';

const suite = DatabaseSync ? describe : describe.skip;
const ctx = { waitUntil() {}, passThroughOnException() {} };

function makeEnv(extra = {}) {
  const env = {
    DB: makeMigratedD1(),
    KV_CACHE: makeKV(),
    JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256-0123456789',
    ...extra,
  };
  env.DB.sqlite.exec(`INSERT INTO users (id, email, password_hash) VALUES ('u1', 'u1@example.com', 'x')`);
  return env;
}
const run = (env, sql, ...a) => env.DB.sqlite.prepare(sql).run(...a);
const count = (env, table, where = '1=1') =>
  env.DB.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get().n;

function seed(env) {
  const s = `INSERT INTO sessions (id, user_id, token, token_hash, expires_at) VALUES (?, 'u1', '', ?, datetime('now', ?))`;
  run(env, s, 's-dead', 'h1', '-3 days');
  run(env, s, 's-just-expired', 'h2', '-1 hour'); // inside the 5-minute refresh window's grace
  run(env, s, 's-live', 'h3', '+10 days');
  const t = `INSERT INTO auth_action_tokens (id, user_id, purpose, token_hash, expires_at, consumed_at)
             VALUES (?, 'u1', ?, ?, datetime('now', ?), ?)`;
  run(env, t, 't-dead', 'password_reset', 'th1', '-3 days', null);
  run(env, t, 't-dead-consumed', 'password_reset', 'th2', '-3 days', "2026-01-01 00:00:00");
  run(env, t, 't-live', 'email_verification', 'th3', '+1 hour', null);
  const a = `INSERT INTO analytics_events (user_id, event_type, event_data, created_at) VALUES ('u1', 'x', '{}', datetime('now', ?))`;
  run(env, a, '-400 days');
  run(env, a, '-10 days');
}

suite('retention purge on the cron tick', () => {
  it('deletes long-expired sessions and tokens, keeps live and just-expired ones', async () => {
    const env = makeEnv();
    seed(env);
    await worker.scheduled({}, env, ctx);
    expect(count(env, 'sessions', "id = 's-dead'")).toBe(0);
    expect(count(env, 'sessions', "id IN ('s-live','s-just-expired')")).toBe(2);
    expect(count(env, 'auth_action_tokens', "id IN ('t-dead','t-dead-consumed')")).toBe(0);
    expect(count(env, 'auth_action_tokens', "id = 't-live'")).toBe(1);
  });

  it('does NOT purge analytics_events when no period is configured (RETENTION.md states none)', async () => {
    const env = makeEnv();
    seed(env);
    await worker.scheduled({}, env, ctx);
    expect(count(env, 'analytics_events')).toBe(2);
  });

  it('purges analytics_events older than ANALYTICS_RETENTION_DAYS when it is set', async () => {
    const env = makeEnv({ ANALYTICS_RETENTION_DAYS: '90' });
    seed(env);
    await worker.scheduled({}, env, ctx);
    expect(count(env, 'analytics_events')).toBe(1);
    expect(count(env, 'analytics_events', "created_at > datetime('now', '-30 days')")).toBe(1);
  });

  it('ignores a retention value below the floor or malformed (never a surprise wipe)', () => {
    for (const v of ['1', '0', '-5', 'abc', '', '30.5', undefined]) {
      expect(analyticsRetentionDays({ ANALYTICS_RETENTION_DAYS: v }), String(v)).toBeNull();
    }
    expect(analyticsRetentionDays({ ANALYTICS_RETENTION_DAYS: '30' })).toBe(30);
  });

  it('is bounded: a backlog larger than one batch drains over several ticks', async () => {
    const env = makeEnv();
    const n = 25;
    for (let i = 0; i < n; i++) {
      run(env, `INSERT INTO sessions (id, user_id, token, token_hash, expires_at) VALUES (?, 'u1', '', ?, datetime('now', '-9 days'))`, `b${i}`, `bh${i}`);
    }
    const first = await runRetentionPurge(env, { batch: 10 });
    expect(first.sessions).toBe(10);
    expect(count(env, 'sessions')).toBe(15);
    await runRetentionPurge(env, { batch: 10 });
    await runRetentionPurge(env, { batch: 10 });
    expect(count(env, 'sessions')).toBe(0);
    expect(PURGE_BATCH).toBeLessThanOrEqual(1000);
  });

  it('a purge failure never stops the heartbeat', async () => {
    const env = makeEnv();
    env.DB.sqlite.exec('DROP TABLE auth_action_tokens');
    await worker.scheduled({}, env, ctx);
    expect(await env.KV_CACHE.get('cron:last_tick')).not.toBeNull();
  });
});
