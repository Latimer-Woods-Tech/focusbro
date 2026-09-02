import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  runEscalations,
  withinUnscheduledDaytime,
  withinReturnDaytime,
  RETURN_NUDGE_DAY_START,
  RETURN_NUDGE_DAY_END,
} from '../checkins-cron.js';

// THE DESIGN LAW at the most intrusive rung. The escalation ladder fires the
// SECOND, more intrusive SMS knock on a moment the person did not pick for THIS
// instant. The return nudge (the OTHER unscheduled outreach) is held out of the
// middle of the night by a structural daytime floor, precisely because the only
// other night guard — the opt-in TCPA quiet-hours gate — is unset for a
// text-consented user who never chose a window (quiet_start === quiet_end → no
// quiet hours). The escalation knock had NO such structural floor: after a
// recovered escalation-cron outage (the #74 crons-death class), an evening
// check-in that went quiet could earn its "still waiting on you" text hours
// later, at 3am. That is the exact trust-breaking intrusion the LAW forbids.
//
// This suite is the proof-of-rejection (Standing Law #1): against the pre-guard
// code the 3am case SENDS, so this test FAILS; with the guard it defers. It also
// pins that the daytime case is unchanged, so the guard narrows nothing it
// should not.

const TELNYX_ENV = { TELNYX_API_KEY: 'k', TELNYX_FROM_NUMBER: '+15550001111' };

// A text-consented client in America/New_York who NEVER set quiet hours
// (quiet_start === quiet_end → the TCPA gate is a no-op — the whole point).
const CONSENT_NO_QUIET = {
  status: 'granted', quiet_start: null, quiet_end: null, timezone: 'America/New_York',
};

// One quiet, un-escalated push check-in whose commitment is in New York. Its
// delivered_at is inside the escalation window [now−24h, now−15min] for BOTH
// clocks the two cases use — a real evening check-in that went unanswered.
function escalationRow(delivered_at) {
  return {
    checkin_id: 'ck1', commitment_id: 'c1', user_id: 'u1',
    delivered_at, title: 'file the taxes', persona: 'calm_ally',
    commitment_timezone: 'America/New_York', ceiling: 'text',
  };
}

// D1-shaped stub. The escalation scan (`escalated_at IS NULL`) yields the row;
// the consent-tz probe and the TCPA gate both see a granted-no-quiet-hours
// consent; there is a reachable phone; coach lookups resolve to none. Every
// `run()` is captured so we can assert whether the one-shot escalated_at latch
// was written.
function makeDB(row) {
  const runs = [];
  const db = {
    runs,
    prepare(sql) {
      const stmt = {
        _params: [],
        bind(...a) { this._params = a; return this; },
        async all() {
          if (/escalated_at IS NULL/.test(sql)) return { results: [row] };
          return { results: [] };
        },
        async first() {
          // My new recipient-clock probe.
          if (/SELECT\s+timezone\s+FROM contact_consent/.test(sql)) {
            return { timezone: CONSENT_NO_QUIET.timezone };
          }
          // evaluateContactGate's read.
          if (/FROM contact_consent/.test(sql)) return CONSENT_NO_QUIET;
          // deliverText's phone read.
          if (/FROM users/.test(sql)) return { phone: '+15557654321' };
          // resolveCoachCheckin → none (self-directed).
          return null;
        },
        async run() { runs.push({ sql, params: this._params }); return { success: true }; },
      };
      return stmt;
    },
  };
  return db;
}

afterEach(() => vi.unstubAllGlobals());

describe('withinUnscheduledDaytime — the shared structural night guard', () => {
  it('is the SAME guard the return nudge uses (one source, never drifts)', () => {
    expect(withinUnscheduledDaytime).toBe(withinReturnDaytime);
    expect(RETURN_NUDGE_DAY_START).toBe(8);
    expect(RETURN_NUDGE_DAY_END).toBe(21);
  });

  it('bites at 3am and allows 10am in the recipient zone', () => {
    // 07:00Z = 03:00 America/New_York (EDT) → night.
    expect(withinUnscheduledDaytime('2026-07-06T07:00:00.000Z', 'America/New_York')).toBe(false);
    // 14:00Z = 10:00 EDT → daytime.
    expect(withinUnscheduledDaytime('2026-07-06T14:00:00.000Z', 'America/New_York')).toBe(true);
  });
});

describe('runEscalations — the second knock never lands at 3am (design LAW)', () => {
  it('DEFERS a 3am escalation for a consented user with no quiet hours, without latching', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    // 07:00Z = 03:00 EDT. delivered_at 23:00Z the previous evening (7pm EDT) —
    // a real evening check-in, well inside the 24h window, cron recovered at 3am.
    const db = makeDB(escalationRow('2026-07-05T23:00:00.000Z'));
    const summary = await runEscalations({ DB: db, ...TELNYX_ENV }, { now: '2026-07-06T07:00:00.000Z' });

    expect(summary.deferred).toBe(1);
    expect(summary.escalated).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
    // Not one SMS left the building in the middle of the night.
    expect(fetchSpy).not.toHaveBeenCalled();
    // Deferred WITHOUT latching → escalated_at stays NULL, still eligible for a
    // later daytime tick (no one-shot UPDATE was written).
    expect(db.runs.some((r) => /UPDATE commitment_checkins SET escalated_at/.test(r.sql))).toBe(false);
  });

  it('SENDS the same escalation in the daytime (the guard narrows nothing it should not)', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    // 14:00Z = 10:00 EDT. delivered_at 12:00Z (08:00 EDT), 2h earlier.
    const db = makeDB(escalationRow('2026-07-06T12:00:00.000Z'));
    const summary = await runEscalations({ DB: db, ...TELNYX_ENV }, { now: '2026-07-06T14:00:00.000Z' });

    expect(summary.escalated).toBe(1);
    expect(summary.deferred).toBe(0);
    // The knock went out over the carrier once, and the one-shot latch was written.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(db.runs.some((r) => /UPDATE commitment_checkins SET escalated_at/.test(r.sql))).toBe(true);
  });
});
