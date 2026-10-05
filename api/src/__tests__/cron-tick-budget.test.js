/**
 * FBQ-09 (P2, focusbro#391) — one cron tick has a subrequest budget, and what it
 * did NOT do is visible on /health.
 *
 * A delivery cost ~6-8 D1 calls + a push fetch, so a worst-case tick (100
 * deliveries + 50 escalations + 50 return nudges) made well over the 1,000
 * subrequest cap (50 on the free plan). The late stages sit in try/catch, so
 * they would have died silently while the heartbeat still stamped OK. Driven on a
 * REAL migrated SQLite; every D1 call, push and Telnyx fetch is counted from the
 * outside by a wrapper that knows nothing about the budget under test.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import worker from '../index.js';
import {
  runDueCheckins, runEscalations, runReturnNudges, makeTickBudget, TICK_BUDGET, readCronHealth,
} from '../checkins-cron.js';
import { DatabaseSync, makeMigratedD1, makeKV } from './helpers/real-d1.js';

const push = vi.hoisted(() => ({ calls: 0, perUser: new Map() }));
vi.mock('../webpush.js', async (importOriginal) => ({
  ...(await importOriginal()),
  vapidConfigured: () => true,
  sendWebPush: async (_env, sub) => {
    push.calls++;
    push.perUser.set(sub.endpoint, (push.perUser.get(sub.endpoint) || 0) + 1);
    return { ok: true };
  },
}));

const suite = DatabaseSync ? describe : describe.skip;
const NOW = '2026-10-05T15:00:00.000Z'; // 11:00 New York, 15:00 UTC (daytime in both)
const DUE = '2026-10-05T14:30:00.000Z';
const SENT_AT = '2026-10-05T14:20:00.000Z'; // 40 min before NOW: past the escalation delay
const TZ = 'America/New_York';
let fetchSpy;

function makeEnv() {
  return {
    DB: makeMigratedD1(), KV_CACHE: makeKV(), BUILD_SHA: 'abc1234',
    JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256-0123456789',
    VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv',
    TELNYX_API_KEY: 'k', TELNYX_FROM_NUMBER: '+15550001111',
  };
}

/** Wrap env so every executed D1 statement (a batch counts once) is tallied from outside. */
function counted(env) {
  const n = { d1: 0 };
  const wrap = (st) => ({
    raw: st,
    bind: (...a) => wrap(st.bind(...a)),
    run: () => { n.d1++; return st.run(); },
    first: () => { n.d1++; return st.first(); },
    all: () => { n.d1++; return st.all(); },
  });
  const DB = {
    sqlite: env.DB.sqlite,
    prepare: (sql) => wrap(env.DB.prepare(sql)),
    batch: (l) => { n.d1++; return env.DB.batch(l.map((x) => x.raw || x)); },
  };
  return { n, env: { ...env, DB } };
}
const total = (n) => n.d1 + push.calls + fetchSpy.mock.calls.length;

const sql = (env, q, ...a) => env.DB.sqlite.prepare(q).run(...a);
function user(env, id, phone = null) {
  sql(env, `INSERT INTO users (id, email, password_hash, phone) VALUES (?, ?, 'x', ?)`, id, `${id}@example.test`, phone);
  sql(env, `UPDATE users SET phone_verified_at = datetime('now') WHERE id = ? AND phone IS NOT NULL`, id); // FBQ-12: fixtures hold a VERIFIED number
}
function subscription(env, id) {
  sql(env, `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, is_active) VALUES (?, ?, ?, 'p', 'a', 1)`,
    `sub-${id}`, id, `https://fcm.googleapis.com/fcm/send/${id}`);
}
/** A due, recurring push check-in with one subscription. */
function dueDelivery(env, i) {
  const id = `d${i}`;
  user(env, id); subscription(env, id);
  sql(env, `INSERT INTO commitments (id, user_id, title, start_at, checkin_at, channel, timezone, recurrence, local_time)
            VALUES (?, ?, 'stretch', ?, ?, 'push', ?, 'daily', '10:30')`, `w-${id}`, id, DUE, DUE, TZ);
  // Spread the due instants so the order is deterministic.
  sql(env, `INSERT INTO commitment_checkins (id, commitment_id, user_id, scheduled_for, channel, status)
            VALUES (?, ?, ?, ?, 'push', 'pending')`, `c-${id}`, `w-${id}`, id, new Date(Date.parse(DUE) - i * 1000).toISOString());
  return `c-${id}`;
}
/** A delivered-but-quiet push check-in whose owner is Pro with text consent (it earns the SMS knock). */
function escalationCandidate(env, i) {
  const id = `e${i}`;
  user(env, id, `+1555${String(1000000 + i)}`); // FBQ-12: a verified number is unique per account
  sql(env, `INSERT INTO pro_purchases (id, user_id, stripe_session_id, status, paid_at) VALUES (?, ?, ?, 'paid', ?)`, `pp-${id}`, id, `cs-${id}`, NOW);
  sql(env, `INSERT INTO contact_consent (id, user_id, channel, status, quiet_start, quiet_end, timezone) VALUES (?, ?, 'text', 'granted', 3, 3, ?)`, `cc-${id}`, id, TZ);
  sql(env, `INSERT INTO commitments (id, user_id, title, start_at, checkin_at, channel, timezone) VALUES (?, ?, 'stretch', ?, ?, 'push', ?)`, `w-${id}`, id, SENT_AT, SENT_AT, TZ);
  sql(env, `INSERT INTO commitment_checkins (id, commitment_id, user_id, scheduled_for, channel, status, delivered_at)
            VALUES (?, ?, ?, ?, 'push', 'sent', ?)`, `c-${id}`, `w-${id}`, id, SENT_AT, SENT_AT);
  return `c-${id}`;
}
/** A person gone quiet for weeks, reachable by push, nothing pending. */
function dormant(env, i) {
  const id = `n${i}`;
  user(env, id); subscription(env, id);
  sql(env, `INSERT INTO commitments (id, user_id, title, start_at, channel, timezone, status) VALUES (?, ?, 'stretch', '2026-08-01T15:00:00.000Z', 'push', 'UTC', 'active')`, `w-${id}`, id);
  sql(env, `INSERT INTO analytics_events (user_id, event_type, created_at) VALUES (?, 'commitment_created', '2026-08-01 15:00:00')`, id);
  return id;
}
const status = (env, cid) => env.DB.sqlite.prepare('SELECT status FROM commitment_checkins WHERE id = ?').get(cid).status;
const count = (env, where) => env.DB.sqlite.prepare(`SELECT COUNT(*) AS n FROM commitment_checkins WHERE ${where}`).get().n;

beforeEach(() => {
  push.calls = 0; push.perUser.clear();
  fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function worstCase() {
  const env = makeEnv();
  for (let i = 0; i < 100; i++) dueDelivery(env, i);
  for (let i = 0; i < 50; i++) escalationCandidate(env, i);
  for (let i = 0; i < 50; i++) dormant(env, i);
  return env;
}

/** The three stages as the scheduled handler runs them, on one shared budget. */
async function tick(env, budget = makeTickBudget()) {
  const delivery = await runDueCheckins(env, { now: NOW, limit: 100, budget });
  const escalation = await runEscalations(env, { now: NOW, budget });
  const nudges = await runReturnNudges(env, { now: NOW, budget });
  return { delivery, escalation, nudges, budget };
}

suite('FBQ-09 R1: the tick stays inside its subrequest budget', () => {
  it('a worst-case tick (100 + 50 + 50) stays under the budget, and every stage still works', async () => {
    const { n, env } = counted(worstCase());
    const t = await tick(env);
    expect(TICK_BUDGET).toBeLessThan(1000);
    expect(total(n)).toBeLessThanOrEqual(TICK_BUDGET);
    expect(t.budget.summary().used).toBe(total(n)); // the internal counter matches the outside count
    expect(t.delivery.sent).toBeGreaterThan(0);
    expect(t.escalation.escalated).toBeGreaterThan(0); // a starved stage still gets its slice
    expect(t.nudges.nudged).toBeGreaterThan(0);
    expect(t.delivery.skipped_for_budget).toBeGreaterThan(0);
    expect(t.budget.summary().exhausted).toBe(true);
  });

  it('rows the budget left behind stay pending and go out on the next tick, each exactly once', async () => {
    const { env } = counted(makeEnv());
    for (let i = 0; i < 100; i++) dueDelivery(env, i);
    const t1 = await runDueCheckins(env, { now: NOW, limit: 100, budget: makeTickBudget(300) });
    expect(t1.sent).toBeGreaterThan(0);
    expect(t1.sent).toBeLessThan(100);
    expect(count(env, `status = 'pending' AND id LIKE 'c-d%' AND scheduled_for <= '${NOW}'`)).toBe(100 - t1.sent);
    let sent = t1.sent;
    for (let k = 0; k < 10 && sent < 100; k++) sent += (await runDueCheckins(env, { now: NOW, limit: 100, budget: makeTickBudget(300) })).sent;
    expect(sent).toBe(100);
    expect(push.calls).toBe(100);
    for (const c of push.perUser.values()) expect(c).toBe(1);
  });

  it('a budget stop never leaves a claimed row in `sending`', async () => {
    const { env } = counted(makeEnv());
    for (let i = 0; i < 30; i++) dueDelivery(env, i);
    for (const limit of [20, 33, 47, 61, 90]) {
      await runDueCheckins(env, { now: NOW, limit: 100, budget: makeTickBudget(limit) });
      expect(count(env, `status = 'sending'`)).toBe(0);
    }
  });

  it('a deliveries backlog cannot starve escalations: they get their reserved slice', async () => {
    const { env } = counted(makeEnv());
    for (let i = 0; i < 100; i++) dueDelivery(env, i);
    for (let i = 0; i < 5; i++) escalationCandidate(env, i);
    const budget = makeTickBudget(200); // deliveries stop at 140 of 200; escalations may spend up to 170
    const delivery = await runDueCheckins(env, { now: NOW, limit: 100, budget });
    expect(delivery.skipped_for_budget).toBeGreaterThan(0);
    const usedByDeliveries = budget.used;
    expect(usedByDeliveries).toBeLessThanOrEqual(140);
    const escalation = await runEscalations(env, { now: NOW, budget });
    expect(escalation.escalated).toBeGreaterThan(0);
    expect(budget.used).toBeLessThanOrEqual(170);
    expect(budget.used).toBeGreaterThan(usedByDeliveries);
  });

  it('an unspent early stage leaves its slice to the later ones (no escalation limit on a quiet tick)', async () => {
    const { env } = counted(makeEnv());
    for (let i = 0; i < 40; i++) escalationCandidate(env, i);
    const esc = await runEscalations(env, { now: NOW, budget: makeTickBudget() });
    expect(esc.escalated).toBe(40);
    expect(esc.skipped_for_budget).toBe(0);
  });
});

suite('FBQ-09 R2: fewer calls per delivery, same behaviour', () => {
  it('a recurring push delivery costs <= 6 subrequests (main: 8), and queues the next occurrence', async () => {
    const { n, env } = counted(makeEnv());
    dueDelivery(env, 0);
    const s = await runDueCheckins(env, { now: NOW, limit: 100, budget: makeTickBudget() });
    expect(s).toMatchObject({ sent: 1, materialized: 1 });
    // lease sweep + scan are the tick's fixed cost; the rest is the one delivery
    expect(total(n) - 2).toBeLessThanOrEqual(6);
    expect(count(env, `status = 'pending' AND commitment_id = 'w-d0' AND scheduled_for > '${NOW}'`)).toBe(1);
  });

  it('100 deliveries stay near 6 per row', async () => {
    const { n, env } = counted(makeEnv());
    for (let i = 0; i < 100; i++) dueDelivery(env, i);
    const budget = makeTickBudget(5000);
    const s = await runDueCheckins(env, { now: NOW, limit: 100, budget });
    expect(s.sent).toBe(100);
    expect(total(n)).toBeLessThanOrEqual(2 + 100 * 6);
  });

  it('answered mid-send: the answer stands and the batch queues NO next occurrence', async () => {
    const { env } = counted(makeEnv());
    const cid = dueDelivery(env, 0);
    // The answer lands while the push is in flight.
    const real = fetchSpy;
    push.calls = 0;
    const origPrepare = env.DB.prepare;
    let answered = false;
    env.DB.prepare = (q) => {
      if (/INSERT INTO analytics_events/.test(q) && !answered) { // recordEvent runs after the send, before the finish
        answered = true;
        sql(env, `UPDATE commitment_checkins SET status = 'kept', responded_at = ? WHERE id = ?`, NOW, cid);
      }
      return origPrepare(q);
    };
    const s = await runDueCheckins(env, { now: NOW, limit: 100, budget: makeTickBudget() });
    void real;
    expect(status(env, cid)).toBe('kept');
    expect(s).toMatchObject({ sent: 0, superseded: 1, materialized: 0 });
    expect(count(env, `commitment_id = 'w-d0' AND status = 'pending'`)).toBe(0);
  });

  it('if the finishing batch throws, the row is still marked sent (never re-sent)', async () => {
    const { env } = counted(makeEnv());
    const cid = dueDelivery(env, 0);
    env.DB.batch = async () => { throw new Error('batch down'); };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = await runDueCheckins(env, { now: NOW, limit: 100, budget: makeTickBudget() });
    expect(status(env, cid)).toBe('sent');
    expect(s.sent).toBe(1);
    expect(s.materialized).toBe(1); // the plain materialize path took over
    expect(push.calls).toBe(1);
  });
});

suite('FBQ-09 R3: /health shows what the tick did not do', () => {
  const ev = { cron: '* * * * *', scheduledTime: Date.parse(NOW) };
  async function run(env) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    await worker.scheduled(ev, env, {});
    vi.useRealTimers();
  }
  const summary = async (env) => JSON.parse(await env.KV_CACHE.get('cron:last_summary'));

  it('last_summary carries the budget and per-stage skipped_for_budget', async () => {
    const env = worstCase();
    await run(env);
    const s = await summary(env);
    expect(s.budget).toMatchObject({ limit: TICK_BUDGET, exhausted: true });
    expect(s.budget.used).toBeLessThanOrEqual(TICK_BUDGET + 20); // + heartbeat/schema reads happen after the snapshot
    expect(s.delivery.skipped_for_budget).toBeGreaterThan(0);
    expect(s.escalation).toHaveProperty('skipped_for_budget');
    expect(s.return_nudges).toHaveProperty('skipped_for_budget');
    expect(s.stage_errors).toEqual([]);
    const h = await readCronHealth(env, { nowMs: Date.parse(NOW) });
    expect(h.fail_streak).toBe(0);
    expect(h.stage_error_streak).toBe(0);
  });

  it('a stage that throws shows in stage_errors and its own streak, not fail_streak; a clean tick resets it', async () => {
    const env = worstCase();
    const real = env.DB.prepare;
    let broken = true;
    env.DB.prepare = (q) => {
      if (broken && /escalated_at IS NULL/.test(q)) throw new TypeError('escalation scan exploded');
      return real(q);
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await run(env);
    let s = await summary(env);
    expect(s.stage_errors).toEqual([{ stage: 'escalation', error: 'TypeError' }]);
    let h = await readCronHealth(env, { nowMs: Date.parse(NOW) });
    expect(h.stage_error_streak).toBe(1);
    expect(h.fail_streak).toBe(0); // delivery succeeded: its streak keeps its meaning
    expect(h.delivery_degraded).toBe(false);
    expect(h.stale).toBe(false); // the heartbeat still stamped; the failure is visible, not hidden

    await run(env);
    h = await readCronHealth(env, { nowMs: Date.parse(NOW) });
    expect(h.stage_error_streak).toBe(2);

    broken = false;
    await run(env);
    s = await summary(env);
    expect(s.stage_errors).toEqual([]);
    h = await readCronHealth(env, { nowMs: Date.parse(NOW) });
    expect(h.stage_error_streak).toBe(0);
  });

  it('a return-nudge stage error is reported too', async () => {
    const env = makeEnv();
    const real = env.DB.prepare;
    env.DB.prepare = (q) => {
      if (/return_nudge_latch/.test(q) && /WITH people/.test(q)) throw new RangeError('nudge scan exploded');
      return real(q);
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await run(env);
    expect((await summary(env)).stage_errors).toEqual([{ stage: 'return_nudge', error: 'RangeError' }]);
  });
});
