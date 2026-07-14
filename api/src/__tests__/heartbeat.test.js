import { describe, expect, it } from 'vitest';
import worker from '../index.js';

// The delivery-loop heartbeat. scheduled() stamps `cron:last_tick` in KV on every
// successful pass; /health reads it back and reports staleness so an external
// monitor can catch a silent outage (the crontab->crons bug ran dead ~5 weeks).
// These tests drive that staleness math deterministically by injecting the tick.
function makeEnv(lastTick) {
  const stmt = {
    bind() { return stmt; },
    first: async () => ({ count: 1 }),
    all: async () => ({ results: [] }),
    run: async () => ({ success: true })
  };
  return {
    JWT_SECRET: 'test-secret',
    KV_CACHE: {
      get: async (k) => (k === 'cron:last_tick' ? lastTick : null),
      put: async () => {}
    },
    DB: { prepare: () => stmt }
  };
}
function health(lastTick) {
  return worker.fetch(new Request('https://focusbro.net/health'), makeEnv(lastTick), {});
}

describe('delivery-loop heartbeat (/health cron block)', () => {
  it('stays 200 for worker liveness whatever the cron state', async () => {
    const res = await health(null);
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.status).toBe('ok');
    expect(b.cron).toBeTruthy();
    expect(typeof b.cron.threshold_seconds).toBe('number');
  });

  it('reads STALE when no tick has ever been recorded (never healthy-by-default)', async () => {
    const b = await (await health(null)).json();
    expect(b.cron.last_tick).toBeNull();
    expect(b.cron.age_seconds).toBeNull();
    expect(b.cron.stale).toBe(true);
  });

  it('reads healthy for a recent tick', async () => {
    const recent = new Date(Date.now() - 30 * 1000).toISOString();
    const b = await (await health(recent)).json();
    expect(b.cron.stale).toBe(false);
    expect(b.cron.age_seconds).toBeGreaterThanOrEqual(0);
    expect(b.cron.age_seconds).toBeLessThan(b.cron.threshold_seconds);
  });

  it('reads STALE for a tick older than the threshold', async () => {
    const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const b = await (await health(old)).json();
    expect(b.cron.stale).toBe(true);
    expect(b.cron.age_seconds).toBeGreaterThan(b.cron.threshold_seconds);
  });

  it('reads STALE for an unparseable tick value', async () => {
    const b = await (await health('not-a-date')).json();
    expect(b.cron.stale).toBe(true);
    expect(b.cron.age_seconds).toBeNull();
  });
});
