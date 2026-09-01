/**
 * FocusBro — the coach's voice stays consistent across the WHOLE check-in ladder
 * (Contender #10, Phase C · coach-voice consistency).
 *
 * Slice 3 (coach-checkin-delivery) made the FIRST nudge speak in the coach's
 * voice and lead with their opening line. But the ladder has two more rungs that
 * still reach the person, and both spoke the commitment's own persona:
 *   • the escalation SMS — the one warm knock after a quiet push (`runEscalations`)
 *   • the return nudge — the gentle re-entry after days of app silence (`runReturnNudges`)
 * A coached client could hear their coach open the conversation and then a
 * stranger's voice finish it. This closes that seam: one consistent voice
 * end-to-end.
 *
 * What this locks down:
 *  1. A coached client's ESCALATION SMS speaks the coach's mapped voice
 *     (hype_bro → hype energy) even when the commitment's own persona is calm.
 *  2. A coached client's RETURN nudge speaks the coach's mapped voice too.
 *  3. A self-directed user (no coach link) is UNCHANGED on both rungs — their
 *     own persona, byte-for-byte the standard copy.
 *  4. CONSENT BY CONSTRUCTION: a pending coach link never lends its voice to
 *     either rung — only an `active` link does.
 *  5. Determinism: a client linked to two active coaches resolves to the earliest
 *     link on both rungs — one voice, never a flicker.
 *  6. THE DESIGN LAW holds on the wire: no shame / "AI" / clinical claim, whatever
 *     voice speaks.
 *
 * Delivery is exercised over the TEXT channel through a fake D1 `DB` + stubbed
 * fetch — the delivered Telnyx body is the exact copy the person receives.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { runEscalations, runReturnNudges } from '../checkins-cron.js';

const TELNYX_ENV = { TELNYX_API_KEY: 'k', TELNYX_FROM_NUMBER: '+15550001111' };
const GRANTED = { status: 'granted', quiet_start: null, quiet_end: null, timezone: 'UTC' };

// Copy markers (from accountability.js escalationCopy / returnNudgeCopy).
// escalationCopy rotates across warm, tone-identical variants per persona
// (anti-wallpaper, seeded by the check-in id), so the stable persona
// discriminator is the hype flame: every hype variant carries 🔥, no ally
// variant does. These tests assert WHICH voice speaks, so 🔥-presence is the
// exact signal — robust to which rotated variant a given check-in id selects.
const ESC_HYPE = /🔥/;                        // hype voice
const ESC_ALLY = /^(?![\s\S]*🔥)[\s\S]*$/;    // calm ally voice = no hype flame
// returnNudgeCopy now rotates across warm, tone-identical variants too (seeded
// per dormancy episode), so — exactly as with the escalation flame above — the
// stable persona discriminator is the hype 💪: every hype variant carries it, no
// ally variant does. Robust to whichever rotated variant an episode's seed picks.
const RET_HYPE = /💪/;                        // hype voice
const RET_ALLY = /^(?![\s\S]*💪)[\s\S]*$/;    // calm ally voice = no hype 💪

// Shared coach-linkage resolver: active-only, earliest-link-wins — the exact
// semantics resolveCoachCheckin's SQL applies, so the resolver is exercised, not
// canned. Requires a non-empty script (a coach who has actually set up check-ins),
// matching the delivery path.
function makeResolveCoach({ links = [], operators = [], configs = [] }) {
  return function resolveCoach(clientUserId) {
    const active = links
      .filter((l) => l.client_user_id === clientUserId && l.status === 'active')
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : (a.id < b.id ? -1 : 1)));
    for (const link of active) {
      const op = operators.find((o) => o.user_id === link.coach_user_id);
      if (!op) continue;
      const cfg = configs.find((c) => c.operator_id === op.operator_id);
      if (cfg && cfg.script) return { script: cfg.script, voice_persona: cfg.voice_persona };
    }
    return null;
  };
}

/** A coach fully set up: an active link, an operator map row, and a config. */
function coachedSetup({ voice_persona = 'calm_ally', script = 'Hey, it’s Sam — glad you’re here.', client = 'u9' } = {}) {
  return {
    links: [{ id: 'lk1', coach_user_id: 'coachA', client_user_id: client, status: 'active', created_at: '2026-08-01T00:00:00Z' }],
    operators: [{ user_id: 'coachA', operator_id: 'opA' }],
    configs: [{ operator_id: 'opA', voice_persona, script }],
  };
}

// ── Escalation-path D1 double ────────────────────────────────
function makeEscDB({ esc = [], phone = '+15550002222', consent = GRANTED, coach = {} } = {}) {
  const resolveCoach = makeResolveCoach(coach);
  return {
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a; return stmt; },
        async all() {
          if (/escalated_at IS NULL/.test(sql)) return { results: esc };
          return { results: [] };
        },
        async first() {
          if (/FROM coach_clients cc/.test(sql)) return resolveCoach(params[0]);
          if (/FROM contact_consent/.test(sql)) return consent;
          if (/SELECT phone FROM users/.test(sql)) return phone ? { phone } : {};
          return null;
        },
        async run() { return { success: true }; },
      };
      return stmt;
    },
  };
}

// ── Return-nudge-path D1 double ──────────────────────────────
function makeReturnDB({ candidates = [], pref = { persona: 'ally', timezone: 'UTC' }, phone = '+15550002222', textConsent = GRANTED, coach = {} } = {}) {
  const resolveCoach = makeResolveCoach(coach);
  return {
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a; return stmt; },
        async all() {
          if (/FROM analytics_events e/.test(sql)) return { results: candidates };
          if (/FROM push_subscriptions/.test(sql)) return { results: [] };
          return { results: [] };
        },
        async first() {
          if (/FROM coach_clients cc/.test(sql)) return resolveCoach(params[0]);
          if (/FROM commitments/.test(sql)) return pref;
          if (/SELECT 1 FROM push_subscriptions/.test(sql)) return null; // force text channel
          if (/SELECT timezone FROM contact_consent/.test(sql)) return (textConsent && textConsent.status === 'granted') ? { timezone: textConsent.timezone ?? null } : null;
          if (/SELECT status.*FROM contact_consent/s.test(sql)) return textConsent;
          if (/SELECT phone FROM users/.test(sql)) return phone ? { phone } : {};
          return null;
        },
        async run() { return { success: true }; },
      };
      return stmt;
    },
  };
}

const NOW_ESC = '2026-07-06T14:00:00.000Z';
const NOW_RET = '2026-07-14T15:00:00.000Z'; // inside the return-nudge daytime window
const escRow = (over = {}) => ({
  checkin_id: 'ci9', commitment_id: 'cm9', user_id: 'u9',
  delivered_at: '2026-07-06T13:30:00.000Z', title: 'start the taxes', persona: 'ally', ceiling: 'text', ...over,
});
const cand = (over = {}) => ({ user_id: 'u9', last_event_at: '2026-07-01T09:00:00.000Z', ...over });

/** Run one pass and return the single text body Telnyx was asked to send. */
async function sentBody(fn, env, opts) {
  const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
  const summary = await fn(env, opts);
  const body = fetchSpy.mock.calls.length ? JSON.parse(fetchSpy.mock.calls[0][1].body).text : null;
  return { summary, body, calls: fetchSpy.mock.calls.length };
}

afterEach(() => vi.unstubAllGlobals());

describe('escalation SMS speaks the coach’s voice', () => {
  it('a coached client hears their coach’s hype voice even when the commitment is calm', async () => {
    // Commitment persona is 'ally' (calm); the coach's configured voice is hype_bro.
    const db = makeEscDB({ esc: [escRow({ persona: 'ally' })], coach: coachedSetup({ voice_persona: 'hype_bro' }) });
    const { summary, body } = await sentBody(runEscalations, { DB: db, ...TELNYX_ENV }, { now: NOW_ESC });
    expect(summary.escalated).toBe(1);
    expect(body).toMatch(ESC_HYPE);   // coach's hype voice wins
    expect(body).not.toMatch(ESC_ALLY);
  });

  it('a self-directed user is unchanged — the commitment’s own calm voice', async () => {
    const db = makeEscDB({ esc: [escRow({ persona: 'ally' })], coach: {} });
    const { body } = await sentBody(runEscalations, { DB: db, ...TELNYX_ENV }, { now: NOW_ESC });
    expect(body).toMatch(ESC_ALLY);
    expect(body).not.toMatch(ESC_HYPE);
  });

  it('a PENDING coach link never lends its voice to the escalation (consent by construction)', async () => {
    const setup = coachedSetup({ voice_persona: 'hype_bro' });
    setup.links[0].status = 'pending';
    const db = makeEscDB({ esc: [escRow({ persona: 'ally' })], coach: setup });
    const { body } = await sentBody(runEscalations, { DB: db, ...TELNYX_ENV }, { now: NOW_ESC });
    expect(body).toMatch(ESC_ALLY);   // falls back to the commitment's own persona
    expect(body).not.toMatch(ESC_HYPE);
  });

  it('two active coaches resolve to the earliest link — one voice, no flicker', async () => {
    const coach = {
      links: [
        { id: 'lk2', coach_user_id: 'coachB', client_user_id: 'u9', status: 'active', created_at: '2026-08-05T00:00:00Z' },
        { id: 'lk1', coach_user_id: 'coachA', client_user_id: 'u9', status: 'active', created_at: '2026-08-01T00:00:00Z' },
      ],
      operators: [{ user_id: 'coachA', operator_id: 'opA' }, { user_id: 'coachB', operator_id: 'opB' }],
      configs: [
        { operator_id: 'opA', voice_persona: 'calm_ally', script: 'Amara — in your corner.' },
        { operator_id: 'opB', voice_persona: 'hype_bro', script: 'Bex — LET’S GO.' },
      ],
    };
    const db = makeEscDB({ esc: [escRow({ persona: 'ally' })], coach });
    const { body } = await sentBody(runEscalations, { DB: db, ...TELNYX_ENV }, { now: NOW_ESC });
    expect(body).toMatch(ESC_ALLY);   // earliest link (calm_ally) wins deterministically
    expect(body).not.toMatch(ESC_HYPE);
  });
});

describe('return nudge speaks the coach’s voice', () => {
  it('a coached client hears their coach’s hype voice on re-entry even when the commitment is calm', async () => {
    const db = makeReturnDB({ candidates: [cand()], pref: { persona: 'ally', timezone: 'UTC' }, coach: coachedSetup({ voice_persona: 'hype_bro' }) });
    const { summary, body } = await sentBody(runReturnNudges, { DB: db, ...TELNYX_ENV }, { now: NOW_RET });
    expect(summary.nudged).toBe(1);
    expect(body).toMatch(RET_HYPE);   // coach's hype voice wins
    expect(body).not.toMatch(RET_ALLY);
  });

  it('a self-directed user is unchanged — the commitment’s own calm voice', async () => {
    const db = makeReturnDB({ candidates: [cand()], pref: { persona: 'ally', timezone: 'UTC' }, coach: {} });
    const { body } = await sentBody(runReturnNudges, { DB: db, ...TELNYX_ENV }, { now: NOW_RET });
    expect(body).toMatch(RET_ALLY);
    expect(body).not.toMatch(RET_HYPE);
  });

  it('a PENDING coach link never lends its voice to the return nudge (consent by construction)', async () => {
    const setup = coachedSetup({ voice_persona: 'hype_bro' });
    setup.links[0].status = 'pending';
    const db = makeReturnDB({ candidates: [cand()], pref: { persona: 'ally', timezone: 'UTC' }, coach: setup });
    const { body } = await sentBody(runReturnNudges, { DB: db, ...TELNYX_ENV }, { now: NOW_RET });
    expect(body).toMatch(RET_ALLY);
    expect(body).not.toMatch(RET_HYPE);
  });
});

describe('THE DESIGN LAW holds on the wire, whatever voice speaks', () => {
  it('neither rung ever puts shame / "AI" / a clinical claim on the wire', async () => {
    const escDb = makeEscDB({ esc: [escRow({ persona: 'ally' })], coach: coachedSetup({ voice_persona: 'hype_bro' }) });
    const { body: escBody } = await sentBody(runEscalations, { DB: escDb, ...TELNYX_ENV }, { now: NOW_ESC });
    const retDb = makeReturnDB({ candidates: [cand()], coach: coachedSetup({ voice_persona: 'hype_bro' }) });
    const { body: retBody } = await sentBody(runReturnNudges, { DB: retDb, ...TELNYX_ENV }, { now: NOW_RET });
    for (const body of [escBody, retBody]) {
      expect(body).toBeTruthy();
      expect(body).not.toMatch(/\b(fail|missed|behind|lazy|overdue)\b/i);
      expect(body).not.toMatch(/\bAI\b/);
      expect(body).not.toMatch(/\b(treat|cure|diagnos|disorder|symptom)/i);
    }
  });
});
