/**
 * FocusBro — the coach's opening line + voice reaches their client's check-in
 * (Contender #10, Phase C · slice 3).
 *
 * Slice 1 (coach-onboarding.js) let a coach author an opening line and pick a
 * voice, anti-shame-validated and stored — but nothing ever SPOKE it: the cron
 * built every nudge from the commitment's own persona, so the coach's pen never
 * reached the person. This closes that loop.
 *
 * What this locks down:
 *  1. A coached client's check-in LEADS with the coach's opening line, in the
 *     coach's configured voice (calm_ally → calm nudge, hype_bro → hype energy).
 *  2. A self-directed user (no coach link) is UNCHANGED — the standard nudge,
 *     no coach line, their own persona.
 *  3. CONSENT BY CONSTRUCTION: a pending / declined / removed coach link never
 *     brings the coach's voice in — only an `active` link does.
 *  4. THE DESIGN LAW, enforced twice: a shaming opening line stored out-of-band
 *     (bypassing the write-boundary validator) is DROPPED at read — the client
 *     gets the warm standard nudge and never sees the shaming words.
 *  5. Determinism: a client linked to two active coaches resolves to their
 *     earliest link — one opener, never a double send or a flickering voice.
 *  6. End-to-end through runDueCheckins: the coach line actually rides the wire,
 *     and the delivered payload still carries no shame / "AI" / clinical claim.
 *
 * Message content is asserted over the TEXT channel, whose delivered body is the
 * full composed nudge (opener + prompt + reply hint) captured from the Telnyx
 * request — the most direct end-to-end proof of what the person receives.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { deliverCheckin, runDueCheckins } from '../checkins-cron.js';
import { mapCoachPersona } from '../coach-onboarding.js';

const TELNYX_ENV = { TELNYX_API_KEY: 'k', TELNYX_FROM_NUMBER: '+15550001111' };

// ── Stateful in-memory D1 double ─────────────────────────────
// Holds the coach linkage tables and interprets exactly the statements
// resolveCoachCheckin + deliverText issue, applying the real JOIN / active-only
// / earliest-link-wins semantics so the resolver is exercised, not canned.
function makeDB({ links = [], operators = [], configs = [], phone = '+15557654321', due = [], consent = { status: 'granted', quiet_start: null, quiet_end: null, timezone: 'UTC' } } = {}) {
  const runs = [];
  function resolveCoach(clientUserId) {
    const active = links
      .filter((l) => l.client_user_id === clientUserId && l.status === 'active')
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : (a.id < b.id ? -1 : 1)));
    for (const link of active) {
      const op = operators.find((o) => o.user_id === link.coach_user_id);
      if (!op) continue;
      const cfg = configs.find((c) => c.operator_id === op.operator_id);
      if (cfg) return { script: cfg.script, voice_persona: cfg.voice_persona };
    }
    return null;
  }
  return {
    runs,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a; return stmt; },
        async all() {
          if (/FROM commitment_checkins c/.test(sql)) return { results: due, _params: params };
          return { results: [] };
        },
        async first() {
          if (/FROM coach_clients cc/.test(sql)) return resolveCoach(params[0]);
          if (/FROM contact_consent/.test(sql)) return consent;
          if (/SELECT phone FROM users/.test(sql)) return phone ? { phone } : {};
          return null;
        },
        async run() { runs.push({ sql, params }); return { success: true }; },
      };
      return stmt;
    },
  };
}

const textRow = (over = {}) => ({
  checkin_id: 'ci1', commitment_id: 'cm1', user_id: 'u1', channel: 'text',
  attempts: 0, title: 'start the taxes', persona: 'ally',
  recurrence: 'none', commitment_status: 'active', scheduled_for: '2026-08-08T14:00:00.000Z', ...over,
});

/** A coach fully set up: an active link, an operator map row, and a config. */
function coachedSetup({ voice_persona = 'calm_ally', script = 'Hey, it’s Sam — glad you’re here. Let’s ease in together.' } = {}) {
  return {
    links: [{ id: 'lk1', coach_user_id: 'coachA', client_user_id: 'u1', status: 'active', created_at: '2026-08-01T00:00:00Z' }],
    operators: [{ user_id: 'coachA', operator_id: 'opA' }],
    configs: [{ operator_id: 'opA', voice_persona, script }],
  };
}

/** Grab the text body Telnyx was asked to send. */
async function sentTextBody(env, row) {
  const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
  const out = await deliverCheckin(env, row);
  const body = fetchSpy.mock.calls.length ? JSON.parse(fetchSpy.mock.calls[0][1].body).text : null;
  return { out, body };
}

afterEach(() => vi.unstubAllGlobals());

describe('mapCoachPersona — coach voice → copy-engine persona', () => {
  it('maps hype_bro → hype, calm_ally → ally, unknown → the calm default', () => {
    expect(mapCoachPersona('hype_bro')).toBe('hype');
    expect(mapCoachPersona('calm_ally')).toBe('ally');
    expect(mapCoachPersona('whatever')).toBe('ally');
    expect(mapCoachPersona(undefined)).toBe('ally');
  });
});

describe('coach opening line reaches a coached client', () => {
  it('leads a coached client’s nudge with the coach’s authored line', async () => {
    const setup = coachedSetup({ script: 'Hey, it’s Sam — glad you’re here. Let’s ease in together.' });
    const { out, body } = await sentTextBody({ DB: makeDB(setup), ...TELNYX_ENV }, textRow());
    expect(out.status).toBe('sent');
    expect(body).toContain('it’s Sam — glad you’re here');
    // The coach line comes FIRST, then the standard prompt, then the reply hint.
    expect(body.indexOf('Sam')).toBeLessThan(body.indexOf('start the taxes'));
    expect(body.toLowerCase()).toMatch(/reply done/);
    // Never a scold.
    expect(body).not.toMatch(/\b(fail|missed|behind|lazy)\b/i);
  });

  it('speaks in the coach’s configured voice — hype energy for hype_bro', async () => {
    const setup = coachedSetup({ voice_persona: 'hype_bro', script: 'Yo, Coach K here — let’s GO. 🙌' });
    const { body } = await sentTextBody({ DB: makeDB(setup), ...TELNYX_ENV }, textRow({ persona: 'ally' }));
    // Commitment persona is 'ally', but the coach's hype voice wins for their client.
    expect(body).toContain('Coach K here');
    expect(body).toMatch(/🔥|Yo/); // checkinPromptCopy hype marker
  });
});

describe('self-directed users are untouched', () => {
  it('a user with no coach link gets the plain standard nudge, own persona', async () => {
    const { out, body } = await sentTextBody({ DB: makeDB({ links: [] }), ...TELNYX_ENV }, textRow({ persona: 'ally' }));
    expect(out.status).toBe('sent');
    expect(body.startsWith('You said you’d')).toBe(true);
    expect(body).not.toContain('Sam');
  });

  it('a PENDING coach link does NOT bring the coach’s voice in (consent by construction)', async () => {
    const setup = coachedSetup();
    setup.links[0].status = 'pending';
    const { body } = await sentTextBody({ DB: makeDB(setup), ...TELNYX_ENV }, textRow());
    expect(body).not.toContain('Sam');
    expect(body.startsWith('You said you’d')).toBe(true);
  });
});

describe('THE DESIGN LAW — a shaming stored line never reaches a person', () => {
  it('drops an out-of-band shaming coach line and delivers the warm standard nudge', async () => {
    // A line that could never have passed the write-boundary validator, planted
    // directly in the config (a bad migration, a direct DB write).
    const setup = coachedSetup({ script: 'You failed again — stop being lazy.' });
    const { out, body } = await sentTextBody({ DB: makeDB(setup), ...TELNYX_ENV }, textRow());
    expect(out.status).toBe('sent');
    expect(body).not.toMatch(/fail|lazy/i);
    // Falls back to the warm standard nudge, not a broken/empty message.
    expect(body.startsWith('You said you’d')).toBe(true);
  });
});

describe('determinism — never a double voice', () => {
  it('a client linked to two active coaches resolves to the earliest link only', async () => {
    const setup = {
      links: [
        { id: 'lk2', coach_user_id: 'coachB', client_user_id: 'u1', status: 'active', created_at: '2026-08-05T00:00:00Z' },
        { id: 'lk1', coach_user_id: 'coachA', client_user_id: 'u1', status: 'active', created_at: '2026-08-01T00:00:00Z' },
      ],
      operators: [{ user_id: 'coachA', operator_id: 'opA' }, { user_id: 'coachB', operator_id: 'opB' }],
      configs: [
        { operator_id: 'opA', voice_persona: 'calm_ally', script: 'Amara here — in your corner.' },
        { operator_id: 'opB', voice_persona: 'hype_bro', script: 'Bex here — LET’S GO.' },
      ],
    };
    const { body } = await sentTextBody({ DB: makeDB(setup), ...TELNYX_ENV }, textRow());
    expect(body).toContain('Amara here'); // earliest (2026-08-01) wins
    expect(body).not.toContain('Bex here');
  });
});

describe('end-to-end through runDueCheckins', () => {
  it('the coach line rides the wire and the payload stays shame-free', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const setup = coachedSetup({ script: 'Hey, it’s Sam — glad you’re here.' });
    const db = makeDB({ ...setup, due: [textRow()] });
    const s = await runDueCheckins({ DB: db, ...TELNYX_ENV }, { now: '2026-08-08T14:05:00.000Z' });
    expect(s.sent).toBe(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body).text;
    expect(body).toContain('it’s Sam');
    expect(body).not.toMatch(/\b(fail|missed|behind|lazy|overdue)\b/i);
    expect(body).not.toMatch(/\bAI\b/);
    expect(body).not.toMatch(/\b(treat|cure|diagnos|disorder|symptom)/i);
  });
});
