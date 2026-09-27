/**
 * FocusBro — the coach's authored opening LINE greets a returning client, not just
 * their voice (Contender #10, Phase C · coach-voice-in-delivery, the last rung).
 *
 * Slice 3 (coach-checkin-delivery) let a coach's opening line lead the FIRST
 * check-in, and R-317 carried the coach's VOICE across the escalation + return
 * rungs. But the return nudge — a fresh re-entry after days of app silence — is
 * the natural place for the coach's authored GREETING, not only their voice. This
 * closes that: the return nudge now leads with the coach's opening line, exactly
 * as the first-nudge delivery path does.
 *
 * The escalation stays deliberately voice-only: it is a mid-conversation knock
 * after a quiet push, where a fresh greeting would be redundant. This file pins
 * that boundary too — the coach's line reaches the RETURN nudge and never the
 * escalation.
 *
 * What this locks down:
 *  1. A coached client's RETURN nudge LEADS with the coach's authored opening
 *     line, and the standard return copy still follows it.
 *  2. A self-directed user (no coach link) is byte-for-byte the standard return
 *     copy — no opener, nothing added.
 *  3. CONSENT BY CONSTRUCTION: a pending coach link lends neither voice nor
 *     opener — only an `active` link does.
 *  4. PROOF-OF-REJECTION / THE DESIGN LAW at read: a shaming line planted
 *     out-of-band is dropped (safeCoachOpener), and the returning person still
 *     gets the warm standard nudge — a shaming line can never reach them.
 *  5. Determinism: a client linked to two active coaches gets the EARLIEST link's
 *     opening line — one greeting, never a flicker.
 *  6. BOUNDARY: the escalation SMS stays voice-only — the coach's authored line
 *     never leads the escalation knock.
 *  7. THE DESIGN LAW holds on the wire: no shame / "AI" / clinical claim in the
 *     composed return body, whatever line greets.
 *
 * Delivery is exercised over the TEXT channel through a fake D1 `DB` + stubbed
 * fetch — the delivered Telnyx body is the exact copy the person receives.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { runEscalations, runReturnNudges } from '../checkins-cron.js';
import { returnNudgeCopy } from '../accountability.js';

const TELNYX_ENV = { TELNYX_API_KEY: 'k', TELNYX_FROM_NUMBER: '+15550001111' };
const GRANTED = { status: 'granted', quiet_start: null, quiet_end: null, timezone: 'UTC' };

// Standard-copy markers (from accountability.js returnNudgeCopy). The return
// copy rotates across warm, tone-identical variants (seeded per dormancy
// episode), so the stable persona discriminator is the hype 💪 — every hype
// variant carries it, no ally variant does (mirrors escalationCopy's flame).
const RET_ALLY = /^(?![\s\S]*💪)[\s\S]*$/;    // calm ally voice = no hype 💪
const RET_HYPE = /💪/;                        // hype voice

// A distinctive coach greeting — matched verbatim so we know the AUTHORED line
// (not just the voice) reached the wire.
const COACH_LINE = 'Hey, it’s Sam — so glad to see you back.';

// Shared coach-linkage resolver: active-only, earliest-link-wins — the exact
// semantics resolveCoachCheckin's SQL applies, so the resolver is exercised, not
// canned. Requires a non-empty script (a coach who has actually set up check-ins).
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
function coachedSetup({ voice_persona = 'calm_ally', script = COACH_LINE, client = 'u9' } = {}) {
  return {
    links: [{ id: 'lk1', coach_user_id: 'coachA', client_user_id: client, status: 'active', created_at: '2026-08-01T00:00:00Z' }],
    operators: [{ user_id: 'coachA', operator_id: 'opA' }],
    configs: [{ operator_id: 'opA', voice_persona, script }],
  };
}

// ── Return-nudge-path D1 double (text channel forced) ──────────
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

// ── Escalation-path D1 double (for the boundary test) ──────────
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

const NOW_RET = '2026-07-14T15:00:00.000Z'; // inside the return-nudge daytime window
const NOW_ESC = '2026-07-06T14:00:00.000Z';
const cand = (over = {}) => ({ user_id: 'u9', last_event_at: '2026-07-01T09:00:00.000Z', ...over });
// runReturnNudges seeds the return copy per dormancy episode on `user_id:last_event_at`.
// For the default cand() that is this exact string, so "the standard copy for THIS
// delivery" is the variant this seed selects (byte-for-byte, no opener).
const RET_SEED = 'u9:2026-07-01T09:00:00.000Z';
const escRow = (over = {}) => ({
  checkin_id: 'ci9', commitment_id: 'cm9', user_id: 'u9',
  delivered_at: '2026-07-06T13:30:00.000Z', title: 'start the taxes', persona: 'ally', ceiling: 'text', ...over,
});

/** Run one pass and return the single text body Telnyx was asked to send. */
async function sentBody(fn, env, opts) {
  const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
  const summary = await fn(env, opts);
  const body = fetchSpy.mock.calls.length ? JSON.parse(fetchSpy.mock.calls[0][1].body).text : null;
  return { summary, body, calls: fetchSpy.mock.calls.length };
}

afterEach(() => vi.unstubAllGlobals());

describe('the coach’s authored line greets a returning client', () => {
  it('a coached client’s return nudge LEADS with the coach’s opening line, then the standard copy', async () => {
    const db = makeReturnDB({ candidates: [cand()], pref: { persona: 'ally', timezone: 'UTC' }, coach: coachedSetup({ voice_persona: 'calm_ally' }) });
    const { summary, body } = await sentBody(runReturnNudges, { DB: db, ...TELNYX_ENV }, { now: NOW_RET });
    expect(summary.nudged).toBe(1);
    expect(body.startsWith(COACH_LINE)).toBe(true); // the AUTHORED greeting leads
    expect(body).toMatch(RET_ALLY);                 // the standard return copy still follows
  });

  it('the coach’s greeting rides the coach’s VOICE too — hype line, hype copy', async () => {
    const db = makeReturnDB({ candidates: [cand()], pref: { persona: 'ally', timezone: 'UTC' }, coach: coachedSetup({ voice_persona: 'hype_bro' }) });
    const { body } = await sentBody(runReturnNudges, { DB: db, ...TELNYX_ENV }, { now: NOW_RET });
    expect(body.startsWith(COACH_LINE)).toBe(true);
    expect(body).toMatch(RET_HYPE);       // coach's mapped voice still wins on the copy
    expect(body).not.toMatch(RET_ALLY);
  });

  it('a self-directed user is byte-for-byte the standard return copy — no opener', async () => {
    const db = makeReturnDB({ candidates: [cand()], pref: { persona: 'ally', timezone: 'UTC' }, coach: {} });
    const { body } = await sentBody(runReturnNudges, { DB: db, ...TELNYX_ENV }, { now: NOW_RET });
    expect(body).toBe(returnNudgeCopy({ persona: 'ally', seed: RET_SEED })); // nothing added, nothing led with
  });

  it('a PENDING coach link lends neither voice nor opener (consent by construction)', async () => {
    const setup = coachedSetup({ voice_persona: 'hype_bro' });
    setup.links[0].status = 'pending';
    const db = makeReturnDB({ candidates: [cand()], pref: { persona: 'ally', timezone: 'UTC' }, coach: setup });
    const { body } = await sentBody(runReturnNudges, { DB: db, ...TELNYX_ENV }, { now: NOW_RET });
    expect(body).toBe(returnNudgeCopy({ persona: 'ally', seed: RET_SEED })); // falls fully back — no line, own tone
    expect(body).not.toContain(COACH_LINE);
  });

  it('a shaming line planted out-of-band is DROPPED — the warm standard nudge still reaches them (proof-of-rejection)', async () => {
    const db = makeReturnDB({
      candidates: [cand()],
      pref: { persona: 'ally', timezone: 'UTC' },
      coach: coachedSetup({ voice_persona: 'calm_ally', script: 'You failed again — get it together.' }),
    });
    const { body } = await sentBody(runReturnNudges, { DB: db, ...TELNYX_ENV }, { now: NOW_RET });
    expect(body).toBe(returnNudgeCopy({ persona: 'ally', seed: RET_SEED })); // opener dropped at read, warm nudge stands
    expect(body).not.toMatch(/\bfail/i);
  });

  it('two active coaches → the EARLIEST link’s opening line greets, deterministically', async () => {
    const coach = {
      links: [
        { id: 'lk2', coach_user_id: 'coachB', client_user_id: 'u9', status: 'active', created_at: '2026-08-05T00:00:00Z' },
        { id: 'lk1', coach_user_id: 'coachA', client_user_id: 'u9', status: 'active', created_at: '2026-08-01T00:00:00Z' },
      ],
      operators: [{ user_id: 'coachA', operator_id: 'opA' }, { user_id: 'coachB', operator_id: 'opB' }],
      configs: [
        { operator_id: 'opA', voice_persona: 'calm_ally', script: 'Amara here — welcome back.' },
        { operator_id: 'opB', voice_persona: 'hype_bro', script: 'Bex — LET’S GO.' },
      ],
    };
    const db = makeReturnDB({ candidates: [cand()], pref: { persona: 'ally', timezone: 'UTC' }, coach });
    const { body } = await sentBody(runReturnNudges, { DB: db, ...TELNYX_ENV }, { now: NOW_RET });
    expect(body.startsWith('Amara here — welcome back.')).toBe(true); // earliest link wins
    expect(body).not.toContain('Bex');
  });
});

describe('BOUNDARY — the escalation stays voice-only', () => {
  it('the coach’s authored line never leads the escalation knock', async () => {
    const db = makeEscDB({ esc: [escRow({ persona: 'ally' })], coach: coachedSetup({ voice_persona: 'hype_bro' }) });
    const { summary, body } = await sentBody(runEscalations, { DB: db, ...TELNYX_ENV }, { now: NOW_ESC });
    expect(summary.escalated).toBe(1);
    expect(body).not.toContain(COACH_LINE); // no fresh greeting mid-conversation
  });
});

describe('THE DESIGN LAW holds on the wire, whatever line greets', () => {
  it('the composed return body never carries shame / "AI" / a clinical claim', async () => {
    const db = makeReturnDB({ candidates: [cand()], coach: coachedSetup({ voice_persona: 'hype_bro' }) });
    const { body } = await sentBody(runReturnNudges, { DB: db, ...TELNYX_ENV }, { now: NOW_RET });
    expect(body).toBeTruthy();
    expect(body).not.toMatch(/\b(fail|missed|behind|lazy|overdue)\b/i);
    expect(body).not.toMatch(/\bAI\b/);
    expect(body).not.toMatch(/\b(treat|cure|diagnos|disorder|symptom)/i);
  });
});
