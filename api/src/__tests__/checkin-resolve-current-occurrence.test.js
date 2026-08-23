/**
 * FocusBro — an in-app resolve lands on the CURRENT occurrence, never a
 * freshly-materialized future one (Contender #10, Phase A).
 *
 * The bug this pins: for a recurring word, the delivery cron marks today's
 * check-in `sent` and immediately materializes tomorrow's as `pending`
 * (checkins-cron.js). So at the moment a person taps "I did it" on /me/, TWO
 * check-in rows exist — today's delivered `sent` row and tomorrow's `pending`
 * row. The resolve route's old ordering (`(status='pending') DESC,
 * scheduled_for DESC`) picked TOMORROW's not-yet-due row, stamped the
 * resolution on it, and left today's genuinely-completed check-in orphaned as
 * an unanswered `sent` row — so the /me/ card kept reading "still here whenever
 * you're ready" right after the person marked it done, and 15 min later the
 * escalation ladder texted a false "still here about <word>" nudge for a task
 * they had ALREADY completed. A shame-by-accident defect on the exact channel
 * that is supposed to celebrate the win.
 *
 * The fix orders by `scheduled_for ASC` over the open set — the SAME occurrence
 * the /me/ card surfaces as `next_checkin` (MIN(scheduled_for), accountability
 * `outstanding` query) — so resolve and card always agree, and the current
 * occurrence is the one that gets resolved.
 *
 * The DB double below is order-faithful: it reads the ORDER BY / status filter
 * out of the actual UPDATE SQL and selects the row exactly as SQLite would, so
 * reverting the source flips which row is stamped and these tests fail
 * (proof-of-rejection, Factory Standing Law 1).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Router } from 'itty-router';
import { registerAccountabilityRoutes } from '../accountability.js';
import { generateUUID } from '../middleware.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
const ctx = {
  getAuthToken: (request) => {
    const h = request.headers.get('Authorization');
    return h && h.startsWith('Bearer ') ? h.slice(7) : null;
  },
  verifyToken: async (token) => (token === 'good' ? { sub: 'u1' } : null),
  jsonResponse,
  generateUUID,
};

const RECURRING = {
  id: 'cm1', title: 'take meds', persona: 'ally', channel: 'push',
  timezone: 'America/New_York', recurrence: 'daily', local_time: '09:00', status: 'active',
};

// An order-faithful in-memory D1 double over a set of commitment_checkins rows.
// The resolve UPDATE embeds `SELECT id ... ORDER BY ...`; this reproduces both
// the fixed (`scheduled_for ASC` + open-status filter) and the old
// (`(status='pending') DESC, scheduled_for DESC`, no filter) shapes so the same
// test passes on the fix and fails on a revert.
function makeDB(rows) {
  const runs = [];
  // Faithful to whatever open-status set the subquery actually enumerates — so a
  // revert that drops 'awaiting_time' genuinely excludes an awaiting_time row and
  // ASC then skips to the future occurrence, failing the awaiting_time cases
  // (proof-of-rejection, Standing Law 1).
  function openSetFromSql(sql) {
    const m = sql.match(/status IN \(([^)]*)\)/);
    if (!m) return null;
    return new Set(m[1].split(',').map((s) => s.trim().replace(/'/g, '')));
  }
  // Faithful to the resolve subquery's WHERE. The FIXED source enumerates a
  // DELIVERED set — status IN ('sent','deferred','awaiting_time') — OR a `pending`
  // row due today: `status = 'pending' AND scheduled_for < ?` (the bound
  // `dueBefore` = tomorrow-local-midnight). The old / reverted shapes (a bare
  // `status IN ('pending','sent','deferred','awaiting_time')`, ASC or the
  // pre-R-284 pending-first DESC) are modeled too, so a revert flips which row is
  // stamped and these tests fail (proof-of-rejection, Standing Law 1).
  function selectResolveTarget(sql, commitmentId, dueBefore) {
    const open = openSetFromSql(sql);
    const hasDueClause = /status = 'pending' AND scheduled_for < \?/.test(sql);
    let pool = rows.filter((r) => r.commitment_id === commitmentId).filter((r) => {
      if (open && open.has(r.status)) return true;
      if (open && !hasDueClause) return false; // reverted shape: IN-set is the whole filter
      if (!open && !hasDueClause) return true; // no filter at all (defensive)
      // fixed shape: pending admitted only when due before tomorrow.
      return r.status === 'pending' && dueBefore != null && r.scheduled_for < dueBefore;
    });
    if (/ORDER BY scheduled_for ASC/.test(sql)) {
      pool = pool.slice().sort((a, b) => a.scheduled_for.localeCompare(b.scheduled_for));
    } else {
      // pre-R-284: pending-first, then scheduled_for DESC
      pool = pool.slice().sort((a, b) => {
        const ap = a.status === 'pending' ? 1 : 0;
        const bp = b.status === 'pending' ? 1 : 0;
        if (ap !== bp) return bp - ap;
        return b.scheduled_for.localeCompare(a.scheduled_for);
      });
    }
    return pool[0] || null;
  }
  const db = {
    runs,
    rows,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a; return stmt; },
        async first() {
          if (/FROM commitments WHERE id = \? AND user_id = \?/.test(sql)) return RECURRING;
          // ensureNextOccurrence: an existing future pending row → no insert.
          if (/status = 'pending' AND scheduled_for > \?/.test(sql)) {
            return rows.find((r) => r.status === 'pending' && r.scheduled_for > params[1]) || null;
          }
          return null; // accountability_streaks → defaults
        },
        async all() { return { results: [] }; },
        async run() {
          runs.push({ sql, params });
          // The resolve UPDATE: stamp the selected occurrence, faithfully — and
          // report changes:0 when nothing due matched, so the source's
          // no-double-resolve guard (meta.changes > 0) is exercised for real.
          if (/UPDATE commitment_checkins[\s\S]*SET status = \?, responded_at/.test(sql)
              && /SELECT id FROM commitment_checkins/.test(sql)) {
            const dueBefore = params.length >= 7 ? params[6] : null;
            const target = selectResolveTarget(sql, params[4], dueBefore);
            if (target) { target.status = params[0]; target.responded_at = 'now'; target.resolved = true; }
            return { success: true, meta: { changes: target ? 1 : 0 } };
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return db;
}

function buildCall(db) {
  const router = Router();
  registerAccountabilityRoutes(router, ctx);
  const env = { DB: db, JWT_SECRET: 'test' };
  return (method, path, { token = 'good', body } = {}) => {
    const headers = { Authorization: 'Bearer ' + token };
    const init = { method, headers };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    return router.handle(new Request('https://x' + path, init), env);
  };
}

describe('in-app resolve targets the current occurrence, never a future one', () => {
  it('stamps TODAY\'s delivered check-in kept and leaves TOMORROW\'s pending row untouched', async () => {
    const now = Date.now();
    const today = { id: 'ckA', commitment_id: 'cm1', user_id: 'u1', status: 'sent',
      scheduled_for: new Date(now - 3 * 3600 * 1000).toISOString(), responded_at: null };
    const tomorrow = { id: 'ckB', commitment_id: 'cm1', user_id: 'u1', status: 'pending',
      scheduled_for: new Date(now + 21 * 3600 * 1000).toISOString(), responded_at: null };
    const db = makeDB([today, tomorrow]);
    const call = buildCall(db);

    const res = await call('POST', '/api/commitments/cm1/checkin', { body: { outcome: 'kept' } });
    expect(res.status).toBe(200);

    // The occurrence the person actually completed is the one credited...
    expect(today.status).toBe('kept');
    expect(today.responded_at).not.toBeNull();
    // ...and tomorrow's not-yet-due check-in is left alone to fire tomorrow —
    // never pre-resolved, never orphaning today's into a false escalation.
    expect(tomorrow.status).toBe('pending');
    expect(tomorrow.responded_at).toBeNull();
  });

  it('a miss also resolves today\'s occurrence, not tomorrow\'s', async () => {
    const now = Date.now();
    const today = { id: 'ckA', commitment_id: 'cm1', user_id: 'u1', status: 'sent',
      scheduled_for: new Date(now - 2 * 3600 * 1000).toISOString(), responded_at: null };
    const tomorrow = { id: 'ckB', commitment_id: 'cm1', user_id: 'u1', status: 'pending',
      scheduled_for: new Date(now + 22 * 3600 * 1000).toISOString(), responded_at: null };
    const db = makeDB([today, tomorrow]);
    const call = buildCall(db);

    const res = await call('POST', '/api/commitments/cm1/checkin', { body: { outcome: 'missed' } });
    expect(res.status).toBe(200);
    expect(today.status).toBe('missed');
    expect(tomorrow.status).toBe('pending');
  });

  it('an early/undelivered resolve still lands on the single today-due pending row (no regression)', async () => {
    const now = Date.now();
    // Today's occurrence: its scheduled time has arrived but the delivery cron
    // hasn't run yet (or push isn't configured) — still a today-due `pending`
    // row the person can mark done in-app. A past scheduled_for is always before
    // tomorrow's midnight boundary, so this stays deterministic at any clock time.
    const onlyPending = { id: 'ckA', commitment_id: 'cm1', user_id: 'u1', status: 'pending',
      scheduled_for: new Date(now - 30 * 60 * 1000).toISOString(), responded_at: null };
    const db = makeDB([onlyPending]);
    const call = buildCall(db);

    const res = await call('POST', '/api/commitments/cm1/checkin', { body: { outcome: 'kept' } });
    expect(res.status).toBe(200);
    expect(onlyPending.status).toBe('kept');
  });

  // ── awaiting_time: a text nudge answered "later" (the bro asked "when?") is an
  // OPEN occurrence and must be the one an in-app resolve lands on (R-308). Before
  // the open set included it, ASC skipped the awaiting_time row and stamped a
  // future/none row — the R-284 wrong-row/orphan defect, one substate over.
  it('recurring: an in-app Done lands on TODAY\'s awaiting_time row, never TOMORROW\'s pending one', async () => {
    const now = Date.now();
    // today's text nudge was delivered, answered "later" → parked awaiting_time.
    const today = { id: 'ckA', commitment_id: 'cm1', user_id: 'u1', status: 'awaiting_time',
      scheduled_for: new Date(now - 3 * 3600 * 1000).toISOString(), responded_at: null };
    const tomorrow = { id: 'ckB', commitment_id: 'cm1', user_id: 'u1', status: 'pending',
      scheduled_for: new Date(now + 21 * 3600 * 1000).toISOString(), responded_at: null };
    const db = makeDB([today, tomorrow]);
    const call = buildCall(db);

    const res = await call('POST', '/api/commitments/cm1/checkin', { body: { outcome: 'kept' } });
    expect(res.status).toBe(200);
    // the occurrence the person is actually acting on is credited...
    expect(today.status).toBe('kept');
    expect(today.responded_at).not.toBeNull();
    // ...and tomorrow's not-yet-due row is left untouched — no streak credit for a
    // day that hasn't happened, no orphaned "still here" thread on today's.
    expect(tomorrow.status).toBe('pending');
    expect(tomorrow.responded_at).toBeNull();
  });

  it('one-shot: an in-app Done resolves the lone awaiting_time row (no orphan, no later re-nag)', async () => {
    const now = Date.now();
    const only = { id: 'ckA', commitment_id: 'cm1', user_id: 'u1', status: 'awaiting_time',
      scheduled_for: new Date(now - 1 * 3600 * 1000).toISOString(), responded_at: null };
    const db = makeDB([only]);
    const call = buildCall(db);

    const res = await call('POST', '/api/commitments/cm1/checkin', { body: { outcome: 'kept' } });
    expect(res.status).toBe(200);
    // the row is stamped (responded_at set) rather than left an eternal orphan the
    // inbound-SMS path could later re-pend into a nag on an already-kept word.
    expect(only.status).toBe('kept');
    expect(only.responded_at).not.toBeNull();
  });

  it('SQL-shape lock: the resolve subquery filters to the open set and orders scheduled_for ASC', async () => {
    const now = Date.now();
    const today = { id: 'ckA', commitment_id: 'cm1', user_id: 'u1', status: 'sent',
      scheduled_for: new Date(now - 1 * 3600 * 1000).toISOString(), responded_at: null };
    const db = makeDB([today]);
    const call = buildCall(db);
    await call('POST', '/api/commitments/cm1/checkin', { body: { outcome: 'kept' } });

    const resolve = db.runs.find((x) => /UPDATE commitment_checkins[\s\S]*SET status = \?, responded_at/.test(x.sql)
      && /SELECT id FROM commitment_checkins/.test(x.sql));
    expect(resolve).toBeTruthy();
    // Delivered rows are always open; a pending row is open only when due today.
    expect(resolve.sql).toMatch(/status IN \('sent', 'deferred', 'awaiting_time'\)/);
    expect(resolve.sql).toMatch(/status = 'pending' AND scheduled_for < \?/);
    expect(resolve.sql).toMatch(/ORDER BY scheduled_for ASC/);
    // The old future-picking ordering is gone.
    expect(resolve.sql).not.toMatch(/\(status = 'pending'\) DESC/);
    // A bare pending-in-the-open-set (the pre-due-filter shape) is gone — a
    // pending row is no longer unconditionally resolvable regardless of its day.
    expect(resolve.sql).not.toMatch(/status IN \('pending', 'sent', 'deferred', 'awaiting_time'\)/);
  });
});

// ── The double-resolve twin of R-284 (Contender #10, Phase A) ─────────────────
// R-284 fixed the CRON-ordering case: today's delivered `sent` row + tomorrow's
// freshly-materialized `pending` row are both open, and an in-app resolve must
// land on today's, not tomorrow's. This block pins the OTHER way the same two
// rows can mislead the resolver: once today's occurrence is ALREADY resolved, the
// only open row for a recurring word is tomorrow's not-yet-due `pending` one. A
// SECOND resolve — a double-tap, a stale card, a second device — used to stamp IT,
// which (a) credited the kept-word streak for a day that hasn't happened and
// (b) swallowed tomorrow's check-in so the bro never showed up tomorrow. Both are
// design-LAW defects: an inflated count the coach pitch rests on, and a silently
// dropped nudge on the exact channel that is the product.
//
// Time is frozen so the "today vs. tomorrow" local-calendar boundary the fix uses
// (tomorrow-midnight in the recipient's zone, not a fixed offset) is deterministic
// regardless of when CI runs. Only Date is faked; timers stay real so the async
// route resolves normally.
describe('a second in-app resolve never consumes tomorrow\'s occurrence', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 2026-07-08 12:00 America/New_York (EDT, UTC-4). "Today" = Jul 8.
    vi.setSystemTime(new Date('2026-07-08T16:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('leaves TOMORROW\'s pending row untouched and writes no second streak credit', async () => {
    // today's word already kept earlier today; tomorrow's occurrence pending.
    const today = { id: 'ckA', commitment_id: 'cm1', user_id: 'u1', status: 'kept',
      scheduled_for: '2026-07-08T13:00:00Z', responded_at: 'earlier' };
    const tomorrow = { id: 'ckB', commitment_id: 'cm1', user_id: 'u1', status: 'pending',
      scheduled_for: '2026-07-09T13:00:00Z', responded_at: null };
    const db = makeDB([today, tomorrow]);
    const call = buildCall(db);

    const res = await call('POST', '/api/commitments/cm1/checkin', { body: { outcome: 'kept' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Warm, blameless, and NOT a second streak number.
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);

    // Tomorrow's check-in is still there to fire tomorrow — never pre-resolved.
    expect(tomorrow.status).toBe('pending');
    expect(tomorrow.responded_at).toBeNull();
    // Nothing was written: no commitment move, no streak credit, no re-arm.
    expect(db.runs.some((x) => /UPDATE commitments SET status/.test(x.sql))).toBe(false);
    expect(db.runs.some((x) => /INSERT INTO accountability_streaks/.test(x.sql))).toBe(false);
    expect(db.runs.some((x) => /INSERT INTO commitment_checkins/.test(x.sql))).toBe(false);
  });

  it('still resolves a future-scheduled occurrence that is due LATER TODAY (early completion)', async () => {
    // finished the taxes at noon though the check-in is set for 6pm today.
    const todayLater = { id: 'ckA', commitment_id: 'cm1', user_id: 'u1', status: 'pending',
      scheduled_for: '2026-07-08T22:00:00Z', responded_at: null }; // 18:00 EDT, still Jul 8
    const db = makeDB([todayLater]);
    const call = buildCall(db);

    const res = await call('POST', '/api/commitments/cm1/checkin', { body: { outcome: 'kept' } });
    expect(res.status).toBe(200);
    // A later-today pending row is before tomorrow's midnight boundary → resolvable.
    expect(todayLater.status).toBe('kept');
    expect(todayLater.responded_at).not.toBeNull();
    expect(db.runs.some((x) => /UPDATE commitments SET status/.test(x.sql))).toBe(true);
  });
});

// ── A settled word is never resurrected by an in-app resolve (Contender #10) ──
// Setting a word DOWN (release), pausing a rhythm, or resolving a one-shot moves
// the commitment off `active` and cancels its WAITING check-ins — but not a nudge
// already DELIVERED (status='sent'). A stale tab, or a second device tapping "I
// did it" after the word was closed elsewhere, would then POST a resolve at a
// non-active word. Before the guard the main path stamped the leftover sent row,
// moved the commitment's status, and (for a recurring word) re-armed the next
// occurrence — ringing the bro again on a word the person explicitly closed, the
// exact guilt-engine the design LAW forbids. The guard replies warmly and writes
// nothing. Proof-of-rejection (Standing Law 1): removing the `status !== 'active'`
// guard lets `UPDATE commitments SET status` + the streak write run again, failing
// these assertions.
function makeSettledDB(commitment) {
  const runs = [];
  const db = {
    runs,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a; return stmt; },
        async first() {
          if (/FROM commitments WHERE id = \? AND user_id = \?/.test(sql)) return commitment;
          if (/status = 'pending' AND scheduled_for > \?/.test(sql)) return null;
          return null;
        },
        async all() { return { results: [] }; },
        async run() { runs.push({ sql, params }); return { success: true, meta: { changes: 1 } }; },
      };
      return stmt;
    },
  };
  return db;
}

describe('an in-app resolve never resurrects a settled word', () => {
  for (const status of ['released', 'paused', 'kept', 'missed']) {
    it(`a resolve on a ${status} word writes nothing and answers warmly, streak untouched`, async () => {
      const commitment = {
        id: 'cm1', title: 'file the taxes', persona: 'ally', channel: 'text',
        timezone: 'UTC', recurrence: 'daily', local_time: '09:00', status,
      };
      // In reality a leftover DELIVERED nudge still lives on this word
      // (release/pause cancel only pending/deferred/awaiting_time) — without the
      // guard the resolve subquery would find it and stamp it. The guard returns
      // before any check-in query runs, so the double need only serve the
      // ownership SELECT.
      const db = makeSettledDB(commitment);
      const call = buildCall(db);

      const res = await call('POST', '/api/commitments/cm1/checkin', { body: { outcome: 'kept' } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe(status);
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);

      // Nothing resolved: no check-in stamped, no commitment status moved, no
      // streak write, no next-occurrence re-arm.
      expect(db.runs.some((x) => /UPDATE commitment_checkins[\s\S]*SET status = \?, responded_at/.test(x.sql))).toBe(false);
      expect(db.runs.some((x) => /UPDATE commitments SET status/.test(x.sql))).toBe(false);
      expect(db.runs.some((x) => /INSERT INTO accountability_streaks/.test(x.sql))).toBe(false);
      expect(db.runs.some((x) => /INSERT INTO commitment_checkins/.test(x.sql))).toBe(false);
    });
  }

  it('an ACTIVE word still resolves normally (the guard does not over-block)', async () => {
    const commitment = {
      id: 'cm1', title: 'file the taxes', persona: 'ally', channel: 'text',
      timezone: 'UTC', recurrence: 'none', local_time: null, status: 'active',
    };
    const db = makeSettledDB(commitment);
    const call = buildCall(db);

    const res = await call('POST', '/api/commitments/cm1/checkin', { body: { outcome: 'kept' } });
    expect(res.status).toBe(200);
    // The resolve path ran: the check-in stamp + commitment move both fire.
    expect(db.runs.some((x) => /UPDATE commitment_checkins[\s\S]*SET status = \?, responded_at/.test(x.sql))).toBe(true);
    expect(db.runs.some((x) => /UPDATE commitments SET status/.test(x.sql))).toBe(true);
  });
});
