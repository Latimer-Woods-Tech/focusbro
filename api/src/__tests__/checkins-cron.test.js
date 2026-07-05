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
import { runDueCheckins, deliverCheckin, MAX_ATTEMPTS } from '../checkins-cron.js';

// ── a minimal D1-shaped fake keyed off SQL substrings ──
function makeDB({ due = [], subs = [], phone = null }) {
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
          if (/FROM commitment_checkins c/.test(sql)) return { results: due, _params: params };
          if (/FROM push_subscriptions/.test(sql)) return { results: subs };
          return { results: [] };
        },
        async first() {
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
    expect(s).toEqual({ scanned: 0, sent: 0, skipped: 0, failed: 0, retry: 0 });
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
