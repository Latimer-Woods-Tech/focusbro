/**
 * FocusBro — scheduled check-in delivery tests (Contender #10, Phase A · R-205).
 *
 * Covers the cron's job: find due check-ins, deliver them over the right
 * channel, and transition their status so nothing is ever sent twice. Delivery
 * is exercised through a fake D1 `DB` and a stubbed fetch — no live database,
 * no network. The design LAW is re-asserted here too: the copy this cron puts
 * on the wire is an ally, never a scold.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { runDueCheckins, runEscalations, deliverCheckin, MAX_ATTEMPTS, ESCALATION_DELAY_MIN } from '../checkins-cron.js';

// ── a minimal D1-shaped fake keyed off SQL substrings ──
// `consent` is the row returned for the contact_consent gate query. It defaults
// to a granted text consent with no quiet hours so the pre-consent text tests
// still exercise the delivery path; pass `consent: null` to simulate no consent,
// or a quiet-hours window to exercise the defer path.
function makeDB({ due = [], subs = [], esc = [], phone = null, consent = { status: 'granted', quiet_start: null, quiet_end: null, timezone: 'UTC' } }) {
  const runs = [];
  const prepared = [];
  const db = {
    runs,
    prepared,
    prepare(sql) {
      prepared.push(sql);
      let params = [];
      const stmt = {
        bind(...a) { params = a; return stmt; },
        async all() {
          // The escalation scan is the more specific commitment_checkins query.
          if (/escalated_at IS NULL/.test(sql)) return { results: esc, _params: params };
          if (/FROM commitment_checkins c/.test(sql)) return { results: due, _params: params };
          if (/FROM push_subscriptions/.test(sql)) return { results: subs };
          return { results: [] };
        },
        async first() {
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

const VAPID_ENV = { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' };
const TELNYX_ENV = { TELNYX_API_KEY: 'k', TELNYX_FROM_NUMBER: '+15550001111' };

const pushRow = (over = {}) => ({
  checkin_id: 'ci1', commitment_id: 'cm1', user_id: 'u1', channel: 'push',
  attempts: 0, title: 'start the taxes', persona: 'ally', ...over,
});
const textRow = (over = {}) => ({ ...pushRow(), channel: 'text', ...over });

function updateFor(db, checkinId) {
  return db.runs.find((r) => /UPDATE commitment_checkins/.test(r.sql) && r.params.includes(checkinId));
}

afterEach(() => vi.unstubAllGlobals());

describe('runDueCheckins — scan query shape', () => {
  it('scans only pending, due rows and passes now + limit', async () => {
    const db = makeDB({ due: [] });
    await runDueCheckins({ DB: db }, { now: '2026-07-06T14:00:00.000Z', limit: 25 });
    const scanSql = db.prepared.find((s) => /FROM commitment_checkins c/.test(s));
    expect(scanSql).toMatch(/status\s*=\s*'pending'/);
    expect(scanSql).toMatch(/scheduled_for\s*<=\s*\?/);
    expect(scanSql).toMatch(/JOIN commitments/);
  });

  it('reports an all-zero summary when nothing is due', async () => {
    const db = makeDB({ due: [] });
    const s = await runDueCheckins({ DB: db }, { now: '2026-07-06T14:00:00.000Z' });
    expect(s).toEqual({ scanned: 0, sent: 0, skipped: 0, failed: 0, retry: 0, deferred: 0, materialized: 0 });
  });
});

describe('recurring cadence — materialize the next occurrence', () => {
  // A recurring row that gets delivered (or skipped for lack of a channel)
  // should queue its next occurrence so the daily rhythm never stalls.
  const recurringRow = (over = {}) => pushRow({
    recurrence: 'daily', timezone: 'UTC', local_time: '09:00', commitment_status: 'active', ...over,
  });

  function insertFor(db, commitmentId) {
    return db.runs.find((r) => /INSERT INTO commitment_checkins/.test(r.sql) && r.params.includes(commitmentId));
  }

  it('queues the next pending check-in after a recurring row is skipped (no channel configured)', async () => {
    // Push with no VAPID config → skipped; the row leaves pending, so materialize fires.
    const db = makeDB({ due: [recurringRow()] });
    const s = await runDueCheckins({ DB: db }, { now: '2026-07-06T09:00:00.000Z' });
    expect(s.skipped).toBe(1);
    expect(s.materialized).toBe(1);
    const ins = insertFor(db, 'cm1');
    expect(ins).toBeTruthy();
    // Next daily occurrence at 09:00Z is the following day.
    expect(ins.params).toContain('2026-07-07T09:00:00.000Z');
  });

  it('does NOT materialize a one-shot commitment', async () => {
    const db = makeDB({ due: [pushRow({ recurrence: 'none', commitment_status: 'active' })] });
    const s = await runDueCheckins({ DB: db }, { now: '2026-07-06T09:00:00.000Z' });
    expect(s.materialized).toBe(0);
    expect(insertFor(db, 'cm1')).toBeFalsy();
  });

  it('does NOT materialize when the commitment is no longer active', async () => {
    const db = makeDB({ due: [recurringRow({ commitment_status: 'cancelled' })] });
    const s = await runDueCheckins({ DB: db }, { now: '2026-07-06T09:00:00.000Z' });
    expect(s.materialized).toBe(0);
  });

  it('is idempotent: skips materializing when a future pending check-in already exists', async () => {
    const db = makeDB({ due: [recurringRow()] });
    // The existence probe (SELECT id FROM commitment_checkins ... scheduled_for > ?) uses .first().
    // Override it to report an already-queued occurrence.
    const origPrepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      const stmt = origPrepare(sql);
      if (/SELECT id FROM commitment_checkins/.test(sql) && /scheduled_for\s*>/.test(sql)) {
        const origFirst = stmt.first.bind(stmt);
        stmt.first = async () => ({ id: 'already-queued' });
        void origFirst;
      }
      return stmt;
    };
    const s = await runDueCheckins({ DB: db }, { now: '2026-07-06T09:00:00.000Z' });
    expect(s.materialized).toBe(0);
    expect(insertFor(db, 'cm1')).toBeFalsy();
  });
});

describe('consent-by-construction gate (TCPA)', () => {
  it('skips a text check-in with NO consent on record (never sends)', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const db = makeDB({ due: [textRow()], phone: '+15557654321', consent: null, ...{} });
    const s = await runDueCheckins({ DB: db, ...TELNYX_ENV }, { now: '2026-07-06T14:00:00.000Z' });
    expect(s.skipped).toBe(1);
    expect(s.sent).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(updateFor(db, 'ci1').params).toContain('no_consent');
  });

  it('skips a text check-in after the user opted out (revoked)', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const db = makeDB({ due: [textRow()], phone: '+15557654321', consent: { status: 'revoked' } });
    const s = await runDueCheckins({ DB: db, ...TELNYX_ENV }, { now: '2026-07-06T14:00:00.000Z' });
    expect(s.skipped).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(updateFor(db, 'ci1').params).toContain('opted_out');
  });

  it('DEFERS (holds, no send, no attempt bump) inside recipient quiet hours', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    // 02:00 UTC, quiet 22→08 UTC → inside the window → held.
    const db = makeDB({
      due: [textRow()], phone: '+15557654321',
      consent: { status: 'granted', quiet_start: 22, quiet_end: 8, timezone: 'UTC' },
    });
    const s = await runDueCheckins({ DB: db, ...TELNYX_ENV }, { now: '2026-07-06T02:00:00.000Z' });
    expect(s.deferred).toBe(1);
    expect(s.sent).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    // The row is untouched (still pending, no attempt bump) so a later tick delivers it.
    expect(updateFor(db, 'ci1')).toBeUndefined();
  });

  it('sends once quiet hours have passed', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    // 14:00 UTC, quiet 22→08 UTC → outside the window → delivers.
    const db = makeDB({
      due: [textRow()], phone: '+15557654321',
      consent: { status: 'granted', quiet_start: 22, quiet_end: 8, timezone: 'UTC' },
    });
    const s = await runDueCheckins({ DB: db, ...TELNYX_ENV }, { now: '2026-07-06T14:00:00.000Z' });
    expect(s.sent).toBe(1);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('never gates push (app UX, not TCPA-scoped) even with no consent row', async () => {
    const db = makeDB({ due: [pushRow()], subs: [], consent: null });
    const s = await runDueCheckins({ DB: db, ...VAPID_ENV }, { now: '2026-07-06T14:00:00.000Z' });
    // Reaches the push path (skips only for no_subscription, not for consent).
    expect(updateFor(db, 'ci1').params).toContain('no_subscription');
  });
});

describe('status transitions', () => {
  it('marks skipped when push is unconfigured (no VAPID)', async () => {
    const db = makeDB({ due: [pushRow()], subs: [{ endpoint: 'e', p256dh: 'p', auth: 'a' }] });
    const s = await runDueCheckins({ DB: db }, { now: '2026-07-06T14:00:00.000Z' });
    expect(s.skipped).toBe(1);
    expect(updateFor(db, 'ci1').sql).toMatch(/status = 'skipped'/);
    expect(updateFor(db, 'ci1').params).toContain('push_not_configured');
  });

  it('marks skipped when VAPID is configured but the user has no active subscription', async () => {
    const db = makeDB({ due: [pushRow()], subs: [] });
    const s = await runDueCheckins({ DB: db, ...VAPID_ENV }, { now: '2026-07-06T14:00:00.000Z' });
    expect(s.skipped).toBe(1);
    expect(updateFor(db, 'ci1').params).toContain('no_subscription');
  });

  it('marks skipped for text when Telnyx is unconfigured', async () => {
    const db = makeDB({ due: [textRow()] });
    const s = await runDueCheckins({ DB: db }, { now: '2026-07-06T14:00:00.000Z' });
    expect(s.skipped).toBe(1);
    expect(updateFor(db, 'ci1').params).toContain('text_not_configured');
  });

  it('marks skipped for text when the user has no phone', async () => {
    const db = makeDB({ due: [textRow()], phone: null });
    const s = await runDueCheckins({ DB: db, ...TELNYX_ENV }, { now: '2026-07-06T14:00:00.000Z' });
    expect(s.skipped).toBe(1);
    expect(updateFor(db, 'ci1').params).toContain('no_phone');
  });

  it('sends over text and marks delivered when Telnyx + phone are present', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const db = makeDB({ due: [textRow()], phone: '+15557654321' });
    const s = await runDueCheckins({ DB: db, ...TELNYX_ENV }, { now: '2026-07-06T14:00:00.000Z' });
    expect(s.sent).toBe(1);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const up = updateFor(db, 'ci1');
    expect(up.sql).toMatch(/status = 'sent'/);
    expect(up.sql).toMatch(/delivered_at = \?/);
  });

  it('a TEXT nudge invites a reply so the two-way loop is discoverable (push stays clean)', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const db = makeDB({ due: [textRow()], phone: '+15557654321' });
    await runDueCheckins({ DB: db, ...TELNYX_ENV }, { now: '2026-07-06T14:00:00.000Z' });
    const sentText = JSON.parse(fetchSpy.mock.calls[0][1].body).text;
    expect(sentText.toLowerCase()).toMatch(/reply done/);
    expect(sentText.toLowerCase()).toMatch(/later/);
    expect(sentText.toLowerCase()).toMatch(/try again/);
    // never a scold
    expect(sentText).not.toMatch(/\b(fail|missed|behind|lazy)\b/i);
  });
});

describe('failure + retry cap', () => {
  it('keeps a row pending on the first transient failure (retry)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
    const db = makeDB({ due: [textRow({ attempts: 0 })], phone: '+15557654321' });
    const s = await runDueCheckins({ DB: db, ...TELNYX_ENV }, { now: '2026-07-06T14:00:00.000Z' });
    expect(s.retry).toBe(1);
    expect(s.failed).toBe(0);
    const up = updateFor(db, 'ci1');
    expect(up.params[0]).toBe('pending');
    expect(up.params[1]).toBe(1); // attempts bumped to 1
  });

  it(`parks a row as failed once attempts reach ${MAX_ATTEMPTS}`, async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
    const db = makeDB({ due: [textRow({ attempts: MAX_ATTEMPTS - 1 })], phone: '+15557654321' });
    const s = await runDueCheckins({ DB: db, ...TELNYX_ENV }, { now: '2026-07-06T14:00:00.000Z' });
    expect(s.failed).toBe(1);
    expect(s.retry).toBe(0);
    expect(updateFor(db, 'ci1').params[0]).toBe('failed');
  });

  it('does not abort the batch when one row throws', async () => {
    // Two due rows; first delivery throws, second should still be processed.
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call++;
      if (call === 1) throw new Error('boom');
      return { ok: true, status: 200 };
    }));
    const db = makeDB({
      due: [textRow({ checkin_id: 'ciA' }), textRow({ checkin_id: 'ciB' })],
      phone: '+15557654321',
    });
    const s = await runDueCheckins({ DB: db, ...TELNYX_ENV }, { now: '2026-07-06T14:00:00.000Z' });
    expect(s.scanned).toBe(2);
    expect(s.sent).toBe(1);
    expect(updateFor(db, 'ciB').sql).toMatch(/status = 'sent'/);
  });
});

describe('THE DESIGN LAW — the delivered copy never shames', () => {
  const BANNED = [
    'fail', 'failed', 'failure', 'missed', 'miss', 'behind', 'lazy', 'again you',
    'disappointed', 'streak lost', 'you didn', 'guilt', 'shame', 'should have',
  ];
  const CLINICAL = ['treat', 'treatment', 'cure', 'diagnos', 'disorder', 'symptom', 'patient', 'therapy'];

  it('puts only ally copy on the wire (both personas), with no AI/clinical words', async () => {
    for (const persona of ['ally', 'hype']) {
      const bodies = [];
      vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        bodies.push(JSON.parse(init.body).text);
        return { ok: true, status: 200 };
      }));
      const db = makeDB({ due: [textRow({ persona })], phone: '+15557654321' });
      await runDueCheckins({ DB: db, ...TELNYX_ENV }, { now: '2026-07-06T14:00:00.000Z' });
      vi.unstubAllGlobals();

      expect(bodies.length).toBe(1);
      const text = bodies[0].toLowerCase();
      for (const w of BANNED) expect(text, `banned "${w}" in: ${bodies[0]}`).not.toContain(w);
      for (const w of CLINICAL) expect(text, `clinical "${w}" in: ${bodies[0]}`).not.toContain(w);
      expect(text).not.toMatch(/\bai\b/);
    }
  });
});

describe('deliverCheckin (unit)', () => {
  it('returns skipped without a channel and never throws', async () => {
    const db = makeDB({ subs: [] });
    const out = await deliverCheckin({ DB: db, ...VAPID_ENV }, pushRow());
    expect(out.status).toBe('skipped');
    expect(out.detail).toBe('no_subscription');
  });
});

// ── ESCALATION LADDER (Wingspan W1): push → ONE SMS, consent-gated ──
describe('runEscalations — the one warm knock after a quiet push', () => {
  const NOW = '2026-07-06T14:00:00.000Z';
  const escRow = (over = {}) => ({
    checkin_id: 'ci9', commitment_id: 'cm9', user_id: 'u9',
    delivered_at: '2026-07-06T13:30:00.000Z', title: 'start the taxes', persona: 'ally', ...over,
  });
  const okFetch = () => vi.fn(async () => ({ ok: true, status: 200 }));

  function escalationLatch(db, checkinId) {
    return db.runs.find((r) => /SET escalated_at = \?/.test(r.sql) && r.params.includes(checkinId));
  }

  it('scans only quiet, un-escalated, active push check-ins past the delay', async () => {
    const db = makeDB({ esc: [] });
    await runEscalations({ DB: db }, { now: NOW });
    const scanSql = db.prepared.find((s) => /escalated_at IS NULL/.test(s));
    expect(scanSql).toMatch(/status\s*=\s*'sent'/);
    expect(scanSql).toMatch(/channel\s*=\s*'push'/);
    expect(scanSql).toMatch(/responded_at IS NULL/);
    expect(scanSql).toMatch(/m\.status\s*=\s*'active'/);
  });

  it('passes a cutoff exactly ESCALATION_DELAY_MIN before now', async () => {
    const db = makeDB({ esc: [] });
    let boundParams = null;
    const origPrepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      const stmt = origPrepare(sql);
      if (/escalated_at IS NULL/.test(sql)) {
        const origBind = stmt.bind.bind(stmt);
        stmt.bind = (...a) => { boundParams = a; return origBind(...a); };
      }
      return stmt;
    };
    await runEscalations({ DB: db }, { now: NOW });
    const expected = new Date(new Date(NOW).getTime() - ESCALATION_DELAY_MIN * 60 * 1000).toISOString();
    expect(boundParams[0]).toBe(expected);
  });

  it('sends the ONE warm SMS, latches escalated_at, and records the event', async () => {
    const fetchSpy = okFetch();
    vi.stubGlobal('fetch', fetchSpy);
    const db = makeDB({ esc: [escRow()], phone: '+15550002222' });
    const s = await runEscalations({ DB: db, ...TELNYX_ENV }, { now: NOW });

    expect(s).toEqual({ scanned: 1, escalated: 1, deferred: 0, skipped: 0, failed: 0 });
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toContain('telnyx.com');
    const body = JSON.parse(opts.body);
    expect(body.to).toBe('+15550002222');
    expect(body.text).toContain('start the taxes'); // escalationCopy names the thing
    expect(body.text).toMatch(/DONE/); // reply hint keeps the two-way loop discoverable
    expect(escalationLatch(db, 'ci9')).toBeTruthy();
    const evt = db.runs.find((r) => /INSERT (OR IGNORE )?INTO analytics_events/.test(r.sql));
    expect(evt).toBeTruthy();
    expect(evt.params).toContain('checkin_escalated');
  });

  it('without granted text consent: no SMS, but the latch still closes (never rescanned)', async () => {
    const fetchSpy = okFetch();
    vi.stubGlobal('fetch', fetchSpy);
    const db = makeDB({ esc: [escRow()], phone: '+15550002222', consent: null });
    const s = await runEscalations({ DB: db, ...TELNYX_ENV }, { now: NOW });

    expect(s.skipped).toBe(1);
    expect(s.escalated).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(escalationLatch(db, 'ci9')).toBeTruthy();
  });

  it('inside quiet hours: defers and leaves the row untouched for a later tick', async () => {
    const fetchSpy = okFetch();
    vi.stubGlobal('fetch', fetchSpy);
    const db = makeDB({
      esc: [escRow()], phone: '+15550002222',
      consent: { status: 'granted', quiet_start: 22, quiet_end: 8, timezone: 'UTC' },
    });
    // 23:00 UTC is inside the 22→8 quiet window.
    const s = await runEscalations({ DB: db, ...TELNYX_ENV }, { now: '2026-07-06T23:00:00.000Z' });

    expect(s.deferred).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(escalationLatch(db, 'ci9')).toBeUndefined(); // still eligible later
  });

  it('is one-shot even when the SMS fails: the latch closes, no retry storm', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: false, status: 500 }));
    vi.stubGlobal('fetch', fetchSpy);
    const db = makeDB({ esc: [escRow()], phone: '+15550002222' });
    const s = await runEscalations({ DB: db, ...TELNYX_ENV }, { now: NOW });

    expect(s.failed).toBe(1);
    expect(escalationLatch(db, 'ci9')).toBeTruthy();
  });

  it('no phone on file: skipped, latched, never throws', async () => {
    const fetchSpy = okFetch();
    vi.stubGlobal('fetch', fetchSpy);
    const db = makeDB({ esc: [escRow()], phone: null });
    const s = await runEscalations({ DB: db, ...TELNYX_ENV }, { now: NOW });

    expect(s.skipped).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(escalationLatch(db, 'ci9')).toBeTruthy();
  });
});
