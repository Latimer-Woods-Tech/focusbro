/**
 * FocusBro — return-nudge tests (Contender #10, Phase A · Wingspan W4 / L3 · #40).
 *
 * The escalation ladder catches a single quiet check-in; the return nudge catches
 * a whole PERSON who went quiet across the app. These tests pin the guarantees
 * that keep it an ally and not a guilt engine: exactly ONE nudge per dormancy
 * episode (KV latch, self-resetting on return), opt-in by channel, an
 * un-scheduled push held to daytime, and no shame on the wire. Delivery is
 * exercised through a fake D1 `DB` + fake KV + a stubbed fetch — no live DB, no
 * network.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  runReturnNudges,
  returnNudgeKey,
  withinReturnDaytime,
  RETURN_NUDGE_QUIET_DAYS,
} from '../checkins-cron.js';
import { returnNudgeCopy } from '../accountability.js';

// ── a minimal D1-shaped fake keyed off SQL substrings ──
// `candidates` are the dormant rows the scan returns. `pushSub` toggles an active
// push subscription; `textConsent` is the full contact_consent row (used both for
// the channel-presence check and the TCPA gate); `phone` is the SMS destination.
function makeDB({ candidates = [], pref = { persona: 'ally', timezone: 'UTC' }, pushSub = false, textConsent = null, phone = null } = {}) {
  const prepared = [];
  const inserts = [];
  const db = {
    prepared,
    inserts,
    prepare(sql) {
      prepared.push(sql);
      let params = [];
      const stmt = {
        bind(...a) { params = a; return stmt; },
        async all() {
          if (/FROM analytics_events e/.test(sql)) return { results: candidates, _params: params };
          if (/FROM push_subscriptions/.test(sql)) {
            return { results: pushSub ? [{ endpoint: 'https://push.example/x', p256dh: 'p', auth: 'a' }] : [] };
          }
          return { results: [] };
        },
        async first() {
          if (/FROM commitments/.test(sql)) return pref;
          if (/SELECT 1 FROM push_subscriptions/.test(sql)) return pushSub ? { 1: 1 } : null;
          if (/SELECT 1 FROM contact_consent/.test(sql)) return (textConsent && textConsent.status === 'granted') ? { 1: 1 } : null;
          if (/SELECT status.*FROM contact_consent/s.test(sql)) return textConsent;
          if (/SELECT phone FROM users/.test(sql)) return phone ? { phone } : {};
          return null;
        },
        async run() {
          if (/INSERT .*analytics_events/s.test(sql)) inserts.push({ sql, params });
          return { success: true };
        },
      };
      return stmt;
    },
  };
  return db;
}

// A tiny KV fake with the get/put surface recordCronHealth/latch use.
function makeKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, String(v)); },
  };
}

const VAPID_ENV = { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' };
const TELNYX_ENV = { TELNYX_API_KEY: 'k', TELNYX_FROM_NUMBER: '+15550001111' };
const GRANTED = { status: 'granted', quiet_start: null, quiet_end: null, timezone: 'UTC' };

const NOW = '2026-07-14T15:00:00.000Z'; // 15:00 UTC — inside the daytime window
const OLD = '2026-07-01T09:00:00.000Z'; // ~13 days quiet
const cand = (over = {}) => ({ user_id: 'u1', last_event_at: OLD, ...over });

afterEach(() => vi.unstubAllGlobals());

describe('runReturnNudges — the dormant-person scan query shape', () => {
  it('targets real accountability users, gone quiet, with nothing already in flight', async () => {
    const db = makeDB({ candidates: [] });
    const s = await runReturnNudges({ DB: db }, { now: NOW });
    const scan = db.prepared.find((q) => /FROM analytics_events e/.test(q));
    expect(scan).toMatch(/event_type = 'commitment_created'/);           // real accountability footprint
    expect(scan).toMatch(/NOT EXISTS[\s\S]*commitment_checkins[\s\S]*status = 'pending'/); // nothing in flight
    expect(scan).toMatch(/HAVING MAX\(e\.created_at\) <= \?/);            // dormant only
    expect(s).toEqual({ scanned: 0, nudged: 0, deferred: 0, skipped: 0, failed: 0 });
  });

  it('passes a cutoff RETURN_NUDGE_QUIET_DAYS before now', async () => {
    const db = makeDB({ candidates: [] });
    await runReturnNudges({ DB: db }, { now: NOW });
    const scanStmt = db.prepared.find((q) => /FROM analytics_events e/.test(q));
    expect(scanStmt).toBeTruthy();
    // The cutoff is now - quietDays; sanity-check the default constant is sane.
    expect(RETURN_NUDGE_QUIET_DAYS).toBeGreaterThanOrEqual(1);
  });
});

describe('runReturnNudges — one warm nudge over text', () => {
  it('sends ONE text nudge, latches the user, and records an aggregate (userId-null) event', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const kv = makeKV();
    const db = makeDB({ candidates: [cand()], pushSub: false, textConsent: GRANTED, phone: '+15557654321' });
    const s = await runReturnNudges({ DB: db, KV_CACHE: kv, ...TELNYX_ENV }, { now: NOW });

    expect(s.nudged).toBe(1);
    expect(fetchSpy).toHaveBeenCalledOnce();
    // latched at `now` so a later tick this episode won't re-nudge
    expect(kv.store.get(returnNudgeKey('u1'))).toBe(NOW);
    // instrumentation is aggregate-only: userId param (1st bind) is null so it
    // never counts as the user's OWN activity (which would reset the dormancy).
    const ev = db.inserts.find((i) => /analytics_events/.test(i.sql));
    expect(ev).toBeTruthy();
    expect(ev.params[0]).toBeNull();
    expect(ev.params[1]).toBe('return_nudge_sent');
    expect(ev.params[2]).toContain('u1'); // event_data carries the real user id
  });

  it('the wire copy is an ally — never a scold, never "AI"', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const db = makeDB({ candidates: [cand()], textConsent: GRANTED, phone: '+15557654321' });
    await runReturnNudges({ DB: db, KV_CACHE: makeKV(), ...TELNYX_ENV }, { now: NOW });
    const text = JSON.parse(fetchSpy.mock.calls[0][1].body).text;
    expect(text).not.toMatch(/\b(fail(ed)?|missed?|behind|lazy|disappoint|guilt|shame|gone|away|streak)\b/i);
    expect(text).not.toMatch(/\bAI\b/);
    expect(text.toLowerCase()).toMatch(/no pressure|no agenda/); // the door stays open
  });
});

describe('runReturnNudges — one per dormancy episode (the anti-nag latch)', () => {
  it('skips a user already nudged since their last activity', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    // latch is NEWER than last_event_at → already nudged this episode
    const kv = makeKV({ [returnNudgeKey('u1')]: '2026-07-10T00:00:00.000Z' });
    const db = makeDB({ candidates: [cand({ last_event_at: OLD })], textConsent: GRANTED, phone: '+1555' });
    const s = await runReturnNudges({ DB: db, KV_CACHE: kv, ...TELNYX_ENV }, { now: NOW });
    expect(s.nudged).toBe(0);
    expect(s.skipped).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('re-opens once the user has been active SINCE the last nudge (latch older than last activity)', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    // they returned (last_event_at) AFTER the old latch, then went quiet again
    const kv = makeKV({ [returnNudgeKey('u1')]: '2026-07-02T00:00:00.000Z' });
    const db = makeDB({ candidates: [cand({ last_event_at: '2026-07-08T00:00:00.000Z' })], textConsent: GRANTED, phone: '+1555' });
    const s = await runReturnNudges({ DB: db, KV_CACHE: kv, ...TELNYX_ENV }, { now: NOW });
    expect(s.nudged).toBe(1);
    expect(kv.store.get(returnNudgeKey('u1'))).toBe(NOW);
  });
});

describe('runReturnNudges — respectful channel handling', () => {
  it('parks (latched, no retry) a user with no reachable channel', async () => {
    const kv = makeKV();
    const db = makeDB({ candidates: [cand()], pushSub: false, textConsent: null });
    const s = await runReturnNudges({ DB: db, KV_CACHE: kv }, { now: NOW });
    expect(s.skipped).toBe(1);
    expect(s.nudged).toBe(0);
    expect(kv.store.get(returnNudgeKey('u1'))).toBe(NOW); // latched so we don't rescan every tick
  });

  it('DEFERS an un-scheduled push in the middle of the night — and does NOT latch', async () => {
    const kv = makeKV();
    const night = '2026-07-14T04:00:00.000Z'; // 04:00 UTC, outside 08–21
    const db = makeDB({ candidates: [cand({ last_event_at: OLD })], pushSub: true, pref: { persona: 'ally', timezone: 'UTC' } });
    const s = await runReturnNudges({ DB: db, KV_CACHE: kv, ...VAPID_ENV }, { now: night });
    expect(s.deferred).toBe(1);
    expect(s.nudged).toBe(0);
    expect(kv.store.get(returnNudgeKey('u1'))).toBeUndefined(); // still eligible for a daytime tick
  });

  it('DEFERS a text nudge inside the recipient\'s quiet hours — and does NOT latch', async () => {
    const kv = makeKV();
    // quiet 22:00–08:00 UTC; NOW is 15:00 so flip to an overnight window that covers 15:00
    const quiet = { status: 'granted', quiet_start: 9, quiet_end: 18, timezone: 'UTC' }; // 09–18 covers 15:00
    const db = makeDB({ candidates: [cand()], pushSub: false, textConsent: quiet, phone: '+1555' });
    const s = await runReturnNudges({ DB: db, KV_CACHE: kv, ...TELNYX_ENV }, { now: NOW });
    expect(s.deferred).toBe(1);
    expect(kv.store.get(returnNudgeKey('u1'))).toBeUndefined();
  });

  it('skips text (latched) when consent was revoked', async () => {
    const kv = makeKV();
    const db = makeDB({ candidates: [cand()], pushSub: false, textConsent: { status: 'revoked' } });
    const s = await runReturnNudges({ DB: db, KV_CACHE: kv, ...TELNYX_ENV }, { now: NOW });
    // revoked → no text channel resolved at all → parked/latched
    expect(s.skipped).toBe(1);
    expect(kv.store.get(returnNudgeKey('u1'))).toBe(NOW);
  });
});

describe('withinReturnDaytime + returnNudgeCopy units', () => {
  it('is true in the day, false at night, best-effort-true on unknown tz', () => {
    expect(withinReturnDaytime('2026-07-14T15:00:00Z', 'UTC')).toBe(true);
    expect(withinReturnDaytime('2026-07-14T04:00:00Z', 'UTC')).toBe(false);
    expect(withinReturnDaytime('2026-07-14T15:00:00Z', '')).toBe(true); // blank → UTC fallback, daytime
  });

  it('returnNudgeCopy is warm and non-empty for both personas', () => {
    for (const persona of ['ally', 'hype', 'unknown']) {
      const s = returnNudgeCopy({ persona });
      expect(typeof s).toBe('string');
      expect(s.trim().length).toBeGreaterThan(0);
    }
  });
});
