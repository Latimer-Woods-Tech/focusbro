import { describe, expect, it } from 'vitest';
import worker from '../index.js';
import {
  isDeliveryFailingTick,
  recordCronHealth,
  readCronHealth,
  DELIVERY_DEGRADED_STREAK,
  CRON_HEALTH_KEYS,
} from '../checkins-cron.js';

// Delivery-loop CORRECTNESS SLO (extends R-242's liveness signal). R-242 caught
// a total cron death (crontab→crons, #74); this catches the next silent-failure
// class — a cron that ticks fresh while EVERY send fails, which would otherwise
// read healthy. All math is pure over an injected KV, so it's deterministic.

/** Minimal in-memory KV_CACHE double. */
function makeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => { store.set(k, v); },
  };
}

describe('isDeliveryFailingTick', () => {
  it('is true when a real send/DB attempt errored (failed or will-retry)', () => {
    expect(isDeliveryFailingTick({ failed: 1 })).toBe(true);
    expect(isDeliveryFailingTick({ retry: 2 })).toBe(true);
    expect(isDeliveryFailingTick({ sent: 5, failed: 1 })).toBe(true);
  });

  it('is FALSE for healthy states — deferred (quiet hours) and skipped (no consent/channel) never count', () => {
    expect(isDeliveryFailingTick({ deferred: 9 })).toBe(false);
    expect(isDeliveryFailingTick({ skipped: 4 })).toBe(false);
    expect(isDeliveryFailingTick({ sent: 3 })).toBe(false);
    expect(isDeliveryFailingTick({})).toBe(false);
    expect(isDeliveryFailingTick()).toBe(false);
  });
});

describe('recordCronHealth', () => {
  it('stamps liveness (last_tick) and a summary every pass', async () => {
    const kv = makeKv();
    const now = '2026-07-14T10:00:00.000Z';
    await recordCronHealth({ KV_CACHE: kv }, { nowISO: now, delivery: { sent: 2 }, escalation: { escalated: 1 } });
    expect(kv.store.get(CRON_HEALTH_KEYS.lastTick)).toBe(now);
    const summary = JSON.parse(kv.store.get(CRON_HEALTH_KEYS.lastSummary));
    expect(summary.at).toBe(now);
    expect(summary.delivery).toEqual({ sent: 2 });
    expect(summary.escalation).toEqual({ escalated: 1 });
  });

  it('bumps the fail streak on a failing tick and RESETS it on a clean one', async () => {
    const kv = makeKv();
    const env = { KV_CACHE: kv };
    expect(await recordCronHealth(env, { delivery: { failed: 1 } })).toBe(1);
    expect(await recordCronHealth(env, { delivery: { retry: 1 } })).toBe(2);
    expect(await recordCronHealth(env, { delivery: { failed: 3 } })).toBe(3);
    // a clean tick (only sent / nothing due) zeroes the streak
    expect(await recordCronHealth(env, { delivery: { sent: 1 } })).toBe(0);
    expect(kv.store.get(CRON_HEALTH_KEYS.failStreak)).toBe('0');
  });

  it('a deferred/skipped-only tick does NOT bump the streak', async () => {
    const kv = makeKv({ [CRON_HEALTH_KEYS.failStreak]: '2' });
    const streak = await recordCronHealth({ KV_CACHE: kv }, { delivery: { deferred: 5, skipped: 1 } });
    expect(streak).toBe(0);
  });

  it('is a safe no-op when KV is unavailable (never throws)', async () => {
    await expect(recordCronHealth({}, { delivery: { failed: 1 } })).resolves.toBe(0);
  });
});

describe('readCronHealth', () => {
  const NOW = Date.parse('2026-07-14T10:00:00.000Z');

  it('reports delivery_degraded once the streak reaches the threshold', async () => {
    const recent = new Date(NOW - 30 * 1000).toISOString();
    const kv = makeKv({
      [CRON_HEALTH_KEYS.lastTick]: recent,
      [CRON_HEALTH_KEYS.failStreak]: String(DELIVERY_DEGRADED_STREAK),
    });
    const cron = await readCronHealth({ KV_CACHE: kv }, { nowMs: NOW, staleSeconds: 600 });
    expect(cron.stale).toBe(false);            // the loop IS ticking...
    expect(cron.delivery_degraded).toBe(true); // ...but every send is failing
    expect(cron.fail_streak).toBe(DELIVERY_DEGRADED_STREAK);
  });

  it('is NOT degraded below the threshold', async () => {
    const kv = makeKv({ [CRON_HEALTH_KEYS.failStreak]: String(DELIVERY_DEGRADED_STREAK - 1) });
    const cron = await readCronHealth({ KV_CACHE: kv }, { nowMs: NOW });
    expect(cron.delivery_degraded).toBe(false);
  });

  it('defaults to SAFE values when signals are missing (stale, not degraded)', async () => {
    const cron = await readCronHealth({ KV_CACHE: makeKv() }, { nowMs: NOW });
    expect(cron.stale).toBe(true);            // never healthy-by-default
    expect(cron.delivery_degraded).toBe(false); // a blip must not fabricate an outage
    expect(cron.fail_streak).toBe(0);
    expect(cron.last_summary).toBeNull();
  });

  it('never reports degraded from a monitoring blip — a bad streak value reads 0', async () => {
    const kv = makeKv({ [CRON_HEALTH_KEYS.failStreak]: 'not-a-number' });
    const cron = await readCronHealth({ KV_CACHE: kv }, { nowMs: NOW });
    expect(cron.fail_streak).toBe(0);
    expect(cron.delivery_degraded).toBe(false);
  });
});

// End-to-end through the real /health route (mirrors heartbeat.test.js), so the
// off-platform heartbeat.yml probe's `body.cron.delivery_degraded` field is real.
describe('/health delivery_degraded surface', () => {
  function health(kvInit) {
    const stmt = { bind() { return stmt; }, first: async () => ({}), all: async () => ({ results: [] }), run: async () => ({}) };
    const env = { JWT_SECRET: 'test-secret', KV_CACHE: makeKv(kvInit), DB: { prepare: () => stmt } };
    return worker.fetch(new Request('https://focusbro.net/health'), env, {});
  }

  it('exposes delivery_degraded:true when the fail streak is at threshold', async () => {
    const recent = new Date(Date.now() - 30 * 1000).toISOString();
    const b = await (await health({
      [CRON_HEALTH_KEYS.lastTick]: recent,
      [CRON_HEALTH_KEYS.failStreak]: String(DELIVERY_DEGRADED_STREAK),
    })).json();
    expect(b.cron.delivery_degraded).toBe(true);
    expect(b.cron.stale).toBe(false);
    expect(typeof b.cron.degraded_streak_threshold).toBe('number');
  });

  it('exposes delivery_degraded:false on a healthy loop', async () => {
    const recent = new Date(Date.now() - 30 * 1000).toISOString();
    const b = await (await health({ [CRON_HEALTH_KEYS.lastTick]: recent })).json();
    expect(b.cron.delivery_degraded).toBe(false);
    expect(b.cron.fail_streak).toBe(0);
  });
});
