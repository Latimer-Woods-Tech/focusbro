import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  runEscalations,
  MAX_ESCALATION_LATENESS_MIN,
  MAX_CHECKIN_LATENESS_MIN,
  ESCALATION_DELAY_MIN,
} from '../checkins-cron.js';

// runDueCheckins already retires a nudge whose moment has aged past
// MAX_CHECKIN_LATENESS_MIN, because a nudge that arrives that late is "a nag
// about a gone moment — the exact opposite of the on-time ally the design LAW
// requires" (R-290). The escalation ladder fires the MORE intrusive SMS knock,
// yet its scan had only a lower bound (quiet ≥ ESCALATION_DELAY_MIN) and no
// upper bound — so after a recovered escalation-cron outage (the #74 crons-death
// class the file keeps citing) a push that went quiet days ago would still get
// "still haven't started the taxes you said you'd do at 2?" hours or days late.
// This suite pins the symmetric upper bound that closes that hole.

// D1-shaped stub that captures the escalation scan's SQL + bound params. The
// escalation query is the one that filters on `escalated_at IS NULL`.
function makeCaptureDB() {
  const cap = { sql: null, params: null };
  const db = {
    cap,
    prepare(sql) {
      const stmt = {
        bind(...a) {
          if (/escalated_at IS NULL/.test(sql)) { cap.sql = sql; cap.params = a; }
          return stmt;
        },
        async all() { return { results: [] }; },
        async first() { return null; },
        async run() { return { success: true }; },
      };
      return stmt;
    },
  };
  return db;
}

afterEach(() => vi.unstubAllGlobals());

describe('runEscalations — the knock is bounded by age, never a stale nag (design LAW)', () => {
  const NOW = '2026-07-06T14:00:00.000Z';

  it('exposes a max-lateness bound mirroring the nudge guard', () => {
    expect(typeof MAX_ESCALATION_LATENESS_MIN).toBe('number');
    expect(MAX_ESCALATION_LATENESS_MIN).toBeGreaterThan(ESCALATION_DELAY_MIN);
    // Symmetric with runDueCheckins' "the moment is gone" threshold.
    expect(MAX_ESCALATION_LATENESS_MIN).toBe(MAX_CHECKIN_LATENESS_MIN);
  });

  it('scan has an UPPER age bound on delivered_at, not only the quiet-delay lower bound', async () => {
    const db = makeCaptureDB();
    await runEscalations({ DB: db }, { now: NOW });
    expect(db.cap.sql, 'escalation scan SQL was not captured').toBeTruthy();
    // The pre-existing lower bound (quiet at least ESCALATION_DELAY_MIN).
    expect(db.cap.sql).toMatch(/delivered_at\s*<=\s*\?/);
    // The new upper bound (not so old the moment is gone).
    expect(db.cap.sql).toMatch(/delivered_at\s*>=\s*\?/);
  });

  it('binds the stale cutoff at exactly now − MAX_ESCALATION_LATENESS_MIN', async () => {
    const db = makeCaptureDB();
    await runEscalations({ DB: db }, { now: NOW });
    const staleCutoff = new Date(
      new Date(NOW).getTime() - MAX_ESCALATION_LATENESS_MIN * 60 * 1000,
    ).toISOString();
    expect(db.cap.params).toContain(staleCutoff);
    // And the quiet-delay cutoff is still bound (both edges of the window).
    const delayCutoff = new Date(
      new Date(NOW).getTime() - ESCALATION_DELAY_MIN * 60 * 1000,
    ).toISOString();
    expect(db.cap.params).toContain(delayCutoff);
  });
});
