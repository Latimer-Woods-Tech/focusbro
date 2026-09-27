import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  runDueCheckins,
  withinUnscheduledDaytime,
  RETURN_NUDGE_DAY_START,
  RETURN_NUDGE_DAY_END,
} from '../checkins-cron.js';

// THE DESIGN LAW at the FIRST rung. #335 (R-291) held the UNSCHEDULED escalation
// knock out of the middle of the night by a structural daytime floor, because the
// only other night guard — the opt-in TCPA quiet-hours gate — is a no-op for a
// text-consented user who never chose a window (quiet_start === quiet_end → NO
// quiet hours). The PRIMARY scheduled check-in delivery had no such structural
// floor: it leaned on that same opt-in gate plus a 24h staleness cap. A person
// picks their check-in for a DAYTIME hour, but a recovered-cron backlog / stuck
// gate / provider backlog can slip the delivery hours late — and a text scheduled
// for 8pm could land as a 3am buzz for a no-window user, the exact trust-breaking
// intrusion the LAW forbids.
//
// This suite is the proof-of-rejection (Standing Law #1): against the pre-guard
// code the late-3am case SENDS, so this test FAILS; with the guard it defers. It
// also pins that an on-time daytime delivery is unchanged, that a check-in the
// person DELIBERATELY scheduled at night is still honored (the guard narrows
// nothing they chose), and that a night push is untouched (push is silent app UX,
// not a ring) — so the guard bites exactly where the harm is and nowhere else.

const TELNYX_ENV = { TELNYX_API_KEY: 'k', TELNYX_FROM_NUMBER: '+15550001111' };

// A text-consented user in America/New_York who NEVER set quiet hours
// (quiet_start === quiet_end → the TCPA gate is a no-op — the whole point).
const CONSENT_NO_QUIET = {
  status: 'granted', quiet_start: null, quiet_end: null, timezone: 'America/New_York',
};

// A minimal D1-shaped fake keyed off SQL substrings, matching the shape the rest
// of the cron suite uses. The due scan yields the one row; the night-guard clock
// probe and the TCPA gate both see the granted-no-quiet consent; there is a
// reachable phone; coach lookups resolve to none. Every run() is captured.
function makeDB({ due = [], consent = CONSENT_NO_QUIET, phone = '+15557654321' }) {
  const runs = [];
  const db = {
    runs,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a; return stmt; },
        async all() {
          if (/escalated_at IS NULL/.test(sql)) return { results: [] };
          if (/FROM commitment_checkins c/.test(sql)) return { results: due };
          return { results: [] };
        },
        async first() {
          // Both the night-guard clock probe (SELECT timezone ...) and
          // evaluateContactGate read contact_consent — both want this row.
          if (/FROM contact_consent/.test(sql)) return consent;
          if (/SELECT phone FROM users/.test(sql)) return phone ? { phone } : {};
          return null;
        },
        async run() { runs.push({ sql, params }); return { success: true }; },
      };
      return stmt;
    },
  };
  return db;
}

// A due check-in row shaped like the runDueCheckins scan (commitments joined).
const dueRow = (over = {}) => ({
  checkin_id: 'ck1', commitment_id: 'c1', user_id: 'u1', channel: 'text',
  attempts: 0, title: 'file the taxes', persona: 'calm_ally',
  recurrence: 'none', timezone: 'America/New_York', local_time: null,
  commitment_status: 'active', ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe('withinUnscheduledDaytime — the shared structural window (one source)', () => {
  it('bites at 3am and allows 10am in the recipient zone', () => {
    expect(RETURN_NUDGE_DAY_START).toBe(8);
    expect(RETURN_NUDGE_DAY_END).toBe(21);
    // 07:00Z = 03:00 America/New_York (EDT) → night.
    expect(withinUnscheduledDaytime('2026-07-06T07:00:00.000Z', 'America/New_York')).toBe(false);
    // 14:00Z = 10:00 EDT → daytime.
    expect(withinUnscheduledDaytime('2026-07-06T14:00:00.000Z', 'America/New_York')).toBe(true);
  });
});

describe('runDueCheckins — a late scheduled text never lands at 3am (design LAW)', () => {
  it('DEFERS a daytime-scheduled text whose delivery slipped to 3am, for a no-quiet-hours user', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    // scheduled_for 2026-07-06T00:00:00Z = 20:00 EDT (8pm, daytime) the prior
    // evening; now 07:00Z = 03:00 EDT — 7h late (well inside the 24h cap), cron
    // recovered at 3am. The chosen hour was daytime; the night is pure lateness.
    const db = makeDB({ due: [dueRow({ scheduled_for: '2026-07-06T00:00:00.000Z' })] });
    const s = await runDueCheckins({ DB: db, ...TELNYX_ENV }, { now: '2026-07-06T07:00:00.000Z' });

    expect(s.deferred).toBe(1);
    expect(s.sent).toBe(0);
    expect(s.stale).toBe(0);
    expect(s.skipped).toBe(0);
    // Not one SMS left the building in the middle of the night.
    expect(fetchSpy).not.toHaveBeenCalled();
    // Deferred → the row is left pending (no status UPDATE written), so a later
    // daytime tick delivers it. Never dropped.
    expect(db.runs.some((r) => /UPDATE commitment_checkins/.test(r.sql))).toBe(false);
  });

  it('SENDS the same text on time in the daytime (the guard narrows nothing it should not)', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    // scheduled_for 12:00Z = 08:00 EDT (daytime); now 14:00Z = 10:00 EDT — on time.
    const db = makeDB({ due: [dueRow({ scheduled_for: '2026-07-06T12:00:00.000Z' })] });
    const s = await runDueCheckins({ DB: db, ...TELNYX_ENV }, { now: '2026-07-06T14:00:00.000Z' });

    expect(s.sent).toBe(1);
    expect(s.deferred).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('HONORS a check-in the person deliberately scheduled at night — sends, not deferred', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    // scheduled_for 06:00Z = 02:00 EDT (the person CHOSE 2am); now 07:00Z = 03:00
    // EDT. The chosen local hour is itself night → the guard must not fire; the
    // person asked for a night check-in and gets one.
    const db = makeDB({ due: [dueRow({ scheduled_for: '2026-07-06T06:00:00.000Z' })] });
    const s = await runDueCheckins({ DB: db, ...TELNYX_ENV }, { now: '2026-07-06T07:00:00.000Z' });

    expect(s.deferred).toBe(0);
    expect(s.sent).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('leaves a night PUSH untouched — push is silent app UX, not a 3am ring', async () => {
    // A push check-in at 3am: the text-only night guard must not defer it. With no
    // subscription it parks no-shame (skipped 'no_subscription'), proving only that
    // the guard did not fire on push (deferred stays 0).
    const db = makeDB({ due: [dueRow({ channel: 'push', scheduled_for: '2026-07-06T00:00:00.000Z' })] });
    const s = await runDueCheckins({ DB: db }, { now: '2026-07-06T07:00:00.000Z' });

    expect(s.deferred).toBe(0);
  });
});
