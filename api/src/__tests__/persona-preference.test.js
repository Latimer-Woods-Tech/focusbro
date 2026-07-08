/**
 * FocusBro — user-level companion-tone preference (Contender #10, Phase B readiness).
 *
 * "Persona configurable — hype-bro vs calm-ally per user" is called out in the
 * contender brief as a feature only a tuned persona engine can deliver. This
 * suite pins the engine-independent foundation:
 *   - validateCommitmentInput inherits the user's saved default tone when a
 *     request doesn't name one, and an explicit request tone still wins.
 *   - GET/POST /api/accountability/preferences read and persist that default,
 *     normalizing any unknown value to the calm ally (a preference never fails
 *     a person).
 *   - a commitment created with no persona inherits the saved default.
 *
 * The design LAW holds: personaOptions() copy is scanned for shame words, the
 * banned "AI" branding, and clinical/treatment terms — the same guardrail that
 * keeps a guilt engine from ever shipping.
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import {
  personaOptions,
  pickPersona,
  validateCommitmentInput,
  registerAccountabilityRoutes,
} from '../accountability.js';
import { generateUUID } from '../middleware.js';

// ── validateCommitmentInput: default-tone inheritance ────────
describe('validateCommitmentInput — companion-tone inheritance', () => {
  const base = { title: 'start the taxes', start_at: '2026-07-08T14:00:00Z' };

  it('inherits the user default tone when the request names none', () => {
    expect(validateCommitmentInput(base, undefined, { defaultPersona: 'hype' }).value.persona).toBe('hype');
  });

  it('lets an explicit request tone win over the default', () => {
    const r = validateCommitmentInput({ ...base, persona: 'ally' }, undefined, { defaultPersona: 'hype' });
    expect(r.value.persona).toBe('ally');
  });

  it('treats a blank request tone as "not named" and inherits the default', () => {
    expect(validateCommitmentInput({ ...base, persona: '   ' }, undefined, { defaultPersona: 'hype' }).value.persona).toBe('hype');
  });

  it('normalizes an unknown default to the calm ally', () => {
    expect(validateCommitmentInput(base, undefined, { defaultPersona: 'boss' }).value.persona).toBe('ally');
  });

  it('still defaults to the calm ally with no opts at all (back-compat)', () => {
    expect(validateCommitmentInput(base).value.persona).toBe('ally');
  });
});

// ── personaOptions shape + copy law ──────────────────────────
describe('personaOptions', () => {
  it('offers exactly the two known personas with a label and blurb', () => {
    const opts = personaOptions();
    expect(opts.map((o) => o.value).sort()).toEqual(['ally', 'hype']);
    for (const o of opts) {
      expect(typeof o.label).toBe('string');
      expect(o.label.trim().length).toBeGreaterThan(0);
      expect(o.blurb.trim().length).toBeGreaterThan(0);
      expect(pickPersona(o.value)).toBe(o.value); // every offered value is valid
    }
  });

  it('never shames, never says "AI", never makes a clinical claim', () => {
    const SHAME = [/\bfail/i, /\blaz/i, /\bguilt/i, /\bshame/i, /\bdisappoint/i, /\bbehind\b/i, /\bpathetic\b/i, /\bworthless\b/i];
    const CLINICAL = [/\btreat(s|ment|ing)?\b/i, /\bcure/i, /\bdiagnos/i, /\bdisorder/i, /\bsymptom/i, /\bADHD\b/i, /\bmedication\b/i];
    const AI = /\bAI\b/;
    for (const o of personaOptions()) {
      const s = o.label + ' ' + o.blurb;
      for (const p of SHAME) expect(p.test(s), `shame in "${s}"`).toBe(false);
      for (const p of CLINICAL) expect(p.test(s), `clinical in "${s}"`).toBe(false);
      expect(AI.test(s), `"AI" in "${s}"`).toBe(false);
    }
  });
});

// ── the preferences routes, end to end ───────────────────────
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// A small stateful fake D1: one user whose default_persona we can read/write,
// plus capture of any commitment INSERT so we can assert inherited tone.
function makeDB({ persona = null } = {}) {
  const state = { persona };
  const commitments = [];
  return {
    _state: state,
    _commitments: commitments,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a; return stmt; },
        async first() {
          if (/SELECT default_persona FROM users/.test(sql)) {
            return { default_persona: state.persona };
          }
          if (/FROM accountability_streaks/.test(sql)) return null;
          return null;
        },
        async run() {
          if (/UPDATE users SET default_persona/.test(sql)) {
            state.persona = params[0]; // (persona, id)
          } else if (/INSERT INTO commitments/.test(sql)) {
            commitments.push({ persona: params[7] }); // 8th bound value is persona
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
}

function buildRouter() {
  const router = Router();
  registerAccountabilityRoutes(router, {
    getAuthToken: () => 'tok',
    verifyToken: async () => ({ sub: 'u1' }),
    jsonResponse,
    generateUUID,
  });
  return router;
}

const ENV = { JWT_SECRET: 'test' };
const req = (path, method = 'GET', body) =>
  new Request('https://focusbro.net' + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

describe('/api/accountability/preferences', () => {
  it('reads the calm ally by default and lists both options', async () => {
    const db = makeDB();
    const router = buildRouter();
    const res = await router.handle(req('/api/accountability/preferences'), { ...ENV, DB: db });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.persona).toBe('ally');
    expect(body.options.map((o) => o.value).sort()).toEqual(['ally', 'hype']);
  });

  it('persists a chosen tone and reads it back', async () => {
    const db = makeDB();
    const router = buildRouter();
    const set = await router.handle(req('/api/accountability/preferences', 'POST', { persona: 'hype' }), { ...ENV, DB: db });
    expect(set.status).toBe(200);
    expect(db._state.persona).toBe('hype');
    const read = await router.handle(req('/api/accountability/preferences'), { ...ENV, DB: db });
    expect((await read.json()).persona).toBe('hype');
  });

  it('normalizes an unknown tone to the calm ally instead of erroring', async () => {
    const db = makeDB();
    const router = buildRouter();
    const res = await router.handle(req('/api/accountability/preferences', 'POST', { persona: 'boss' }), { ...ENV, DB: db });
    expect(res.status).toBe(200);
    expect(db._state.persona).toBe('ally');
  });

  it('a commitment created without a tone inherits the saved default', async () => {
    const db = makeDB({ persona: 'hype' });
    const router = buildRouter();
    const res = await router.handle(
      req('/api/commitments', 'POST', { title: 'call the dentist', start_at: '2026-07-09T15:00:00Z' }),
      { ...ENV, DB: db },
    );
    expect(res.status).toBe(201);
    expect(db._commitments.length).toBe(1);
    expect(db._commitments[0].persona).toBe('hype');
  });
});
