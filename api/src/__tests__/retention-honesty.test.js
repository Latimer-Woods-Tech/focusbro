/**
 * FocusBro — retention honesty (Contender #10, Phase A).
 *
 * L1 (docs/IMPROVEMENT_PLAN.md) is the whole product's binding constraint: prove
 * the accountability loop RETAINS. That proof is only worth anything if a
 * "return" means the PERSON came back — not the bro reaching out to them. A
 * delivered check-in / escalation knock is the bro showing up; it carries the
 * person's real user_id (delivery-rate, response-rate, and coach-roster queries
 * legitimately attribute a showing-up to them), but it must NEVER count as the
 * person being active or returning. Counting it inflates exactly the D1/D7
 * retention, active-user, and returning-user numbers the coach pitch and the
 * voice-moat thesis both rest on — the same failure the return-nudge path already
 * avoids by recording `return_nudge_sent` with a NULL user_id.
 *
 * These assertions FAIL before the userActivityPredicate() exclusion lands (a
 * bro-only "return" is scored as a real one), so they are a live guard, not a
 * tautology. They run against a real in-memory SQLite so the actual SQL — the
 * CTEs, the date math, the NOT IN filter — is executed, not a substring fake.
 * Skipped only on a Node without node:sqlite (< 22.5; engines still allow ^20.19).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { computeReturnCohorts, computeLoopMetrics, recordEvent } from '../events.js';

// node:sqlite is stable on the CI Node (24.x) and present on 22.5+. Degrade to a
// skipped suite rather than a hard crash on an older local Node the engines field
// still permits.
let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* older node */ }
const suite = DatabaseSync ? describe : describe.skip;

/**
 * A minimal D1-shaped adapter over a real in-memory SQLite database. Enough of
 * the `prepare().bind().first()/.all()/.run()` surface for the events queries.
 * Numbered params (`?1`) are bound by an index→value object; anonymous `?` are
 * bound positionally — matching how the two query styles in events.js are shaped.
 */
function makeRealD1() {
  const sdb = new DatabaseSync(':memory:');
  sdb.exec(`
    CREATE TABLE analytics_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT, event_type TEXT NOT NULL, event_data TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')), client_event_id TEXT
    );
    CREATE TABLE commitment_checkins (
      id TEXT PRIMARY KEY, commitment_id TEXT, user_id TEXT, channel TEXT,
      scheduled_for TEXT, status TEXT, attempts INTEGER DEFAULT 0, delivered_at TEXT
    );
  `);
  const numbered = (sql) => /\?\d/.test(sql);
  return {
    prepare(sql) {
      const stmt = sdb.prepare(sql);
      let params = [];
      const args = () => (numbered(sql)
        ? [Object.fromEntries(params.map((v, i) => [String(i + 1), v]))]
        : params);
      return {
        bind(...a) { params = a; return this; },
        async all() { return { results: stmt.all(...args()) }; },
        async first() { const r = stmt.get(...args()); return r === undefined ? null : r; },
        async run() { stmt.run(...args()); return { success: true }; },
      };
    },
  };
}

suite('retention honesty — the bro reaching out is not the person returning', () => {
  let env;
  beforeEach(() => { env = { DB: makeRealD1() }; });

  it('computeReturnCohorts: a bro-only second day is NOT a return; a real reply is', async () => {
    const now = '2026-07-20T00:00:00.000Z';
    // P — gave one word, never came back at all (eligible, not returned).
    await recordEvent(env, { userId: 'P', type: 'commitment_created', at: '2026-07-10T09:00:00Z' });
    // R — gave a word, genuinely came back the next day and kept it (a real D1 return).
    await recordEvent(env, { userId: 'R', type: 'commitment_created', at: '2026-07-10T09:00:00Z' });
    await recordEvent(env, { userId: 'R', type: 'commitment_kept', at: '2026-07-11T18:00:00Z' });
    // X — gave a word, then the BRO delivered + escalated a check-in the next day.
    // The person did nothing. Pre-fix this scored as a D1 return; it must not.
    await recordEvent(env, { userId: 'X', type: 'commitment_created', at: '2026-07-10T09:00:00Z' });
    await recordEvent(env, { userId: 'X', type: 'checkin_delivered', at: '2026-07-11T14:00:00Z' });
    await recordEvent(env, { userId: 'X', type: 'checkin_escalated', at: '2026-07-11T14:20:00Z' });

    const r = await computeReturnCohorts(env, { nowISO: now });
    expect(r.d1.eligible).toBe(3);       // P, R, X all first-worded ≥1 day ago
    expect(r.d1.returned).toBe(1);       // only R — X's "return" was the bro, not X
    expect(r.d1.rate).toBe(0.33);
  });

  it('computeReturnCohorts: outreach never seeds a cohort first-day either', async () => {
    // A user whose earliest row is a bro-delivered check-in (e.g. a direct/backfill
    // write) is not "activated" by the bro reaching out — no user activity, no cohort.
    await recordEvent(env, { userId: 'Y', type: 'checkin_delivered', at: '2026-07-01T09:00:00Z' });
    const r = await computeReturnCohorts(env, { nowISO: '2026-07-20T00:00:00.000Z' });
    expect(r.d1.eligible).toBe(0);
    expect(r.d7.eligible).toBe(0);
  });

  it('active_users / returning_users count the person acting, not the bro', async () => {
    const now = '2026-07-20T00:00:00.000Z';
    // A — real user activity inside the window, on two distinct days → active AND returning.
    await recordEvent(env, { userId: 'A', type: 'commitment_created', at: '2026-07-12T09:00:00Z' });
    await recordEvent(env, { userId: 'A', type: 'commitment_kept', at: '2026-07-14T09:00:00Z' });
    // B — inside the window the ONLY rows are bro outreach (their word predates the
    // window). B is not active and not returning: the bro talking is not B returning.
    await recordEvent(env, { userId: 'B', type: 'commitment_created', at: '2026-05-01T09:00:00Z' });
    await recordEvent(env, { userId: 'B', type: 'checkin_delivered', at: '2026-07-13T14:00:00Z' });
    await recordEvent(env, { userId: 'B', type: 'checkin_delivered', at: '2026-07-15T14:00:00Z' });

    const m = await computeLoopMetrics(env, { sinceDays: 30, nowISO: now });
    expect(m.active_users).toBe(1);      // only A; B's in-window rows are all outreach
    expect(m.returning_users).toBe(1);   // only A (two OWN days); B's two days are the bro's
  });
});
