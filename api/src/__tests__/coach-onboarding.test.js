/**
 * FocusBro — coach onboarding, mounted on @latimer-woods-tech/operator
 * (Contender #10, Phase C · slice 1).
 *
 * What this locks down:
 *  1. The D1OperatorStore adapter is a FAITHFUL implementation of the operator
 *     package's OperatorStore port — the SAME OperatorIdentityService flows run
 *     identically over it and over the reference InMemoryOperatorStore, and a
 *     duplicate slug / external-org collision rejects on it exactly as on the
 *     reference. (Proves "thin adapter", not a re-implemented hierarchy.)
 *  2. The money half of the port is Phase-D gated: it rejects rather than
 *     silently persisting money rows this app is not cleared to move.
 *  3. Coach onboarding is idempotent (a coach never gets a second operator).
 *  4. THE DESIGN LAW at the write boundary: a coach-authored opening line that
 *     shames / brands "AI" / makes a clinical claim is REJECTED (400), never
 *     stored — proof-of-rejection with the real PUT route over a stateful D1.
 *  5. The onboarding copy surface itself carries no shame / "AI" / clinical claim.
 *
 * The D1 double below is a stateful in-memory store that interprets exactly the
 * statements the adapter and the onboarding module issue (the codebase idiom),
 * so the routes and the adapter are exercised end-to-end, not against canned rows.
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import { InMemoryOperatorStore, OperatorIdentityService } from '@latimer-woods-tech/operator';
import { D1OperatorStore } from '../operator-store.js';
import {
  registerCoachOnboardingRoutes,
  validateCheckinScript,
  validateBrandName,
  validateSupportEmail,
  deriveOperatorSlug,
  coachOnboardingCopySurface,
  COACH_CADENCES,
  COACH_VOICE_PERSONAS,
} from '../coach-onboarding.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// ── Stateful in-memory D1 double ─────────────────────────────
// Holds the operator + coach tables as arrays and interprets the exact
// statements operator-store.js and coach-onboarding.js issue. UNIQUE indexes
// on operators.slug and (operator_id, external_org_id) are enforced so a
// duplicate throws the same "UNIQUE constraint failed" the driver would.
function makeD1() {
  const t = { operators: [], operator_clients: [], coach_operators: [], coach_checkin_config: [] };
  const now = () => new Date().toISOString();

  function setCols(S) {
    // "... SET a = ?, b = ?, updated_at = ? WHERE id = ?" → ['a','b','updated_at']
    const m = S.match(/SET (.+) WHERE id = \?$/);
    return m[1].split(',').map((s) => s.trim().split('=')[0].trim());
  }

  function run(S, p) {
    if (S.startsWith('INSERT INTO operators')) {
      const [id, slug, display_name, status, connect_account_id, charge_mode, white_label, default_currency, metadata, created_at, updated_at] = p;
      if (t.operators.some((o) => o.slug === slug)) {
        throw new Error('UNIQUE constraint failed: operators.slug');
      }
      if (connect_account_id !== null && t.operators.some((o) => o.connect_account_id === connect_account_id)) {
        throw new Error('UNIQUE constraint failed: operators.connect_account_id');
      }
      t.operators.push({ id, slug, display_name, status, connect_account_id, charge_mode, white_label, default_currency, metadata, created_at, updated_at });
      return { success: true };
    }
    if (S.startsWith('UPDATE operators SET')) {
      const cols = setCols(S);
      const id = p[p.length - 1];
      const row = t.operators.find((o) => o.id === id);
      if (row) cols.forEach((c, i) => { row[c] = p[i]; });
      return { success: true };
    }
    if (S.startsWith('INSERT INTO operator_clients')) {
      const [id, operator_id, external_org_id, name, status, retail_override, metadata, created_at, updated_at] = p;
      if (external_org_id !== null && t.operator_clients.some((c) => c.operator_id === operator_id && c.external_org_id === external_org_id)) {
        throw new Error('UNIQUE constraint failed: operator_clients.external_org_id');
      }
      t.operator_clients.push({ id, operator_id, external_org_id, name, status, retail_override, metadata, created_at, updated_at });
      return { success: true };
    }
    if (S.startsWith('UPDATE operator_clients SET')) {
      const cols = setCols(S);
      const id = p[p.length - 1];
      const row = t.operator_clients.find((c) => c.id === id);
      if (row) cols.forEach((c, i) => { row[c] = p[i]; });
      return { success: true };
    }
    if (S.startsWith('INSERT INTO coach_operators')) {
      const [user_id, operator_id] = p;
      const row = t.coach_operators.find((r) => r.user_id === user_id);
      if (row) row.operator_id = operator_id;
      else t.coach_operators.push({ user_id, operator_id, created_at: now() });
      return { success: true };
    }
    if (S.startsWith('INSERT INTO coach_checkin_config')) {
      const [operator_id, cadence, voice_persona, script] = p;
      const row = t.coach_checkin_config.find((r) => r.operator_id === operator_id);
      if (row) { row.cadence = cadence; row.voice_persona = voice_persona; row.script = script; }
      else t.coach_checkin_config.push({ operator_id, cadence, voice_persona, script, updated_at: now() });
      return { success: true };
    }
    throw new Error('unhandled run SQL: ' + S);
  }

  function first(S, p) {
    if (S === 'SELECT * FROM operators WHERE id = ?') return t.operators.find((o) => o.id === p[0]) ?? null;
    if (S === 'SELECT * FROM operators WHERE slug = ?') return t.operators.find((o) => o.slug === p[0]) ?? null;
    if (S === 'SELECT * FROM operator_clients WHERE id = ?') return t.operator_clients.find((c) => c.id === p[0]) ?? null;
    if (S === 'SELECT operator_id FROM coach_operators WHERE user_id = ?') {
      const r = t.coach_operators.find((x) => x.user_id === p[0]);
      return r ? { operator_id: r.operator_id } : null;
    }
    if (S === 'SELECT cadence, voice_persona, script FROM coach_checkin_config WHERE operator_id = ?') {
      const r = t.coach_checkin_config.find((x) => x.operator_id === p[0]);
      return r ? { cadence: r.cadence, voice_persona: r.voice_persona, script: r.script } : null;
    }
    throw new Error('unhandled first SQL: ' + S);
  }

  function all(S, p) {
    if (S === 'SELECT * FROM operator_clients WHERE operator_id = ? ORDER BY created_at ASC, id ASC') {
      return t.operator_clients
        .filter((c) => c.operator_id === p[0])
        .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1));
    }
    throw new Error('unhandled all SQL: ' + S);
  }

  function prepare(sql) {
    const S = sql.replace(/\s+/g, ' ').trim();
    let params = [];
    const stmt = {
      bind(...a) { params = a; return stmt; },
      async first() { return first(S, params); },
      async all() { return { results: all(S, params) }; },
      async run() { return run(S, params); },
    };
    return stmt;
  }

  return { prepare, _t: t };
}

const ctx = {
  getAuthToken: (r) => {
    const h = r.headers.get('Authorization');
    return h && h.startsWith('Bearer ') ? h.slice(7) : null;
  },
  verifyToken: async (tok) => (tok === 'coach1' ? { sub: 'u-coach-1' } : tok === 'coach2' ? { sub: 'u-coach-2' } : null),
  jsonResponse,
};

function makeApp(env) {
  const router = Router();
  registerCoachOnboardingRoutes(router, ctx);
  return (method, path, { token, body } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = new Request(`https://focusbro.net${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return router.handle(req, env);
  };
}

describe('validateCheckinScript — the design LAW at the coach\'s pen', () => {
  it('accepts a warm, on-your-side opening line', () => {
    const r = validateCheckinScript("  You said you'd start at 2 — I'm here, let's go.  ");
    expect(r.ok).toBe(true);
    expect(r.value).toBe("You said you'd start at 2 — I'm here, let's go.");
  });

  it('rejects a shaming line, an empty line, an over-long line', () => {
    expect(validateCheckinScript('You failed again, don\'t be lazy').ok).toBe(false);
    expect(validateCheckinScript('You are behind and should have started').ok).toBe(false);
    expect(validateCheckinScript('   ').ok).toBe(false);
    expect(validateCheckinScript('x'.repeat(401)).ok).toBe(false);
  });

  it('rejects a clinical/treatment claim and the "AI" brand', () => {
    expect(validateCheckinScript('This will treat your ADHD symptoms').ok).toBe(false);
    expect(validateCheckinScript('Our AI will ring you').ok).toBe(false);
  });

  it('closes the drift holes the old local list missed — "therapy" and "unresponsive"', () => {
    // Proof-of-rejection (Standing Law #1): before this guard was routed through
    // the canonical `scanDesignLaw`, the local CLINICAL list omitted `therapy`
    // and the local SHAME list omitted `unrespons`, so both saved silently at
    // this write boundary. They must now be rejected.
    expect(validateCheckinScript('I booked your therapy session for 2').ok).toBe(false);
    expect(validateCheckinScript("You've been unresponsive lately").ok).toBe(false);
  });

  it('every rejection reason is itself warm — no shame/clinical/AI leaks into feedback', () => {
    const reasons = [
      validateCheckinScript('').reason,
      validateCheckinScript('you failed again').reason,
      validateCheckinScript('treat your disorder').reason,
      validateCheckinScript('the AI calls you').reason,
    ];
    const SHAME = [/\bfail/i, /\blazy\b/i, /\bshame\b/i, /\bmiss(ed|es|ing)?\b/i, /\bbehind\b/i, /\bguilt/i];
    const CLINICAL = [/\btreat(s|ment|ing)?\b/i, /\bdiagnos/i, /\bdisorder/i, /\bsymptom/i, /\bADHD\b/i];
    for (const s of reasons) {
      for (const p of SHAME) expect(p.test(s), `shame in reason: "${s}"`).toBe(false);
      for (const p of CLINICAL) expect(p.test(s), `clinical in reason: "${s}"`).toBe(false);
      expect(/\bAI\b/.test(s), `"AI" in reason: "${s}"`).toBe(false);
    }
  });
});

describe('validateBrandName — the design LAW on the coach\'s white-label', () => {
  it('accepts a clean brand and trims it', () => {
    const r = validateBrandName('  Steady Wins Coaching  ');
    expect(r.ok).toBe(true);
    expect(r.value).toBe('Steady Wins Coaching');
  });

  it('allows "ADHD" in a brand — a brand IS the coach pitch', () => {
    // Guardrail: "ADHD lives in SEO and the coach pitch, not a clinical promise."
    // A coaching business legitimately named for its market must not be rejected.
    expect(validateBrandName('ADHD Focus Coaching').ok).toBe(true);
  });

  it('rejects a shaming, empty, or over-long brand', () => {
    expect(validateBrandName('Lazy No More Coaching').ok).toBe(false);
    expect(validateBrandName('No More Excuses').ok).toBe(false);
    expect(validateBrandName('   ').ok).toBe(false);
    expect(validateBrandName('x'.repeat(81)).ok).toBe(false);
  });

  it('rejects a clinical/treatment claim and the "AI" brand even in the name', () => {
    // A brand promising to "treat"/"cure" a diagnosis is exactly the clinical
    // claim with regulatory teeth the law bans everywhere; "AI" is never allowed.
    expect(validateBrandName('ADHD Cure Partners').ok).toBe(false);
    expect(validateBrandName('Therapy Line').ok).toBe(false);
    expect(validateBrandName('AI Accountability').ok).toBe(false);
  });

  it('every rejection reason is itself warm — no shame/clinical/AI leaks into feedback', () => {
    const reasons = [
      validateBrandName('').reason,
      validateBrandName('Lazy No More Coaching').reason,
      validateBrandName('ADHD Cure Partners').reason,
      validateBrandName('AI Accountability').reason,
    ];
    const SHAME = [/\bfail/i, /\blazy\b/i, /\bshame\b/i, /\bmiss(ed|es|ing)?\b/i, /\bbehind\b/i, /\bguilt/i];
    const CLINICAL = [/\btreat(s|ment|ing)?\b/i, /\bdiagnos/i, /\bdisorder/i, /\bsymptom/i, /\btherapy\b/i, /\bADHD\b/i];
    for (const s of reasons) {
      for (const p of SHAME) expect(p.test(s), `shame in reason: "${s}"`).toBe(false);
      for (const p of CLINICAL) expect(p.test(s), `clinical in reason: "${s}"`).toBe(false);
      expect(/\bAI\b/.test(s), `"AI" in reason: "${s}"`).toBe(false);
    }
  });
});

describe('validateSupportEmail — the design LAW on the coach\'s white-label support address', () => {
  it('accepts a clean support address and trims it', () => {
    const r = validateSupportEmail('  hello@steadywins.coach  ');
    expect(r.ok).toBe(true);
    expect(r.value).toBe('hello@steadywins.coach');
  });

  it('allows "ADHD" in a support address — it is part of the coach pitch', () => {
    // Same guardrail as the brand: a coach whose real address names their market
    // must not be blocked ("ADHD lives in SEO and the coach pitch").
    expect(validateSupportEmail('help@adhdfocuscoaching.com').ok).toBe(true);
  });

  it('rejects a valid-format but design-dirty address (shame / clinical / AI)', () => {
    // Proof-of-rejection (Standing Law #1): each of these PASSES the operator
    // package's email-format check yet shames or makes a clinical claim to the
    // client — before this guard they reached updateWhiteLabel unscanned.
    expect(validateSupportEmail('dont-be-lazy@coach.com').ok).toBe(false); // shame
    expect(validateSupportEmail('you-failed@coach.com').ok).toBe(false); // shame
    expect(validateSupportEmail('cure-your-adhd@clinic.com').ok).toBe(false); // clinical
    expect(validateSupportEmail('therapy@coach.com').ok).toBe(false); // clinical
    expect(validateSupportEmail('the-AI-desk@coach.com').ok).toBe(false); // "AI"
  });

  it('every rejection reason is itself warm — no shame/clinical/AI leaks into feedback', () => {
    const reasons = [
      validateSupportEmail('').reason,
      validateSupportEmail('dont-be-lazy@coach.com').reason,
      validateSupportEmail('cure-your-adhd@clinic.com').reason,
      validateSupportEmail('the-AI-desk@coach.com').reason,
    ];
    const SHAME = [/\bfail/i, /\blazy\b/i, /\bshame\b/i, /\bmiss(ed|es|ing)?\b/i, /\bbehind\b/i, /\bguilt/i];
    const CLINICAL = [/\btreat(s|ment|ing)?\b/i, /\bcure/i, /\bdiagnos/i, /\bdisorder/i, /\bsymptom/i, /\btherapy\b/i, /\bADHD\b/i];
    for (const s of reasons) {
      for (const p of SHAME) expect(p.test(s), `shame in reason: "${s}"`).toBe(false);
      for (const p of CLINICAL) expect(p.test(s), `clinical in reason: "${s}"`).toBe(false);
      expect(/\bAI\b/.test(s), `"AI" in reason: "${s}"`).toBe(false);
    }
  });
});

describe('coachOnboardingCopySurface — never shames, brands "AI", or goes clinical', () => {
  const SHAME = [/\bfail(ed|ure|ing|s)?\b/i, /\blaz(y|iness)\b/i, /\bshame\b/i, /\bguilt/i, /\bbehind\b/i, /\bmiss(ed|es|ing)?\b/i, /\bpathetic\b/i, /\bworthless\b/i];
  const CLINICAL = [/\btreat(s|ment|ing)?\b/i, /\bcure/i, /\bdiagnos/i, /\bdisorder/i, /\bsymptom/i, /\bADHD\b/i, /\bmedication\b/i];
  it('passes every battery', () => {
    for (const s of coachOnboardingCopySurface()) {
      expect(typeof s).toBe('string');
      expect(s.length).toBeGreaterThan(0);
      for (const p of SHAME) expect(p.test(s), `shame in copy: "${s}"`).toBe(false);
      for (const p of CLINICAL) expect(p.test(s), `clinical in copy: "${s}"`).toBe(false);
      expect(/\bAI\b/.test(s), `"AI" in copy: "${s}"`).toBe(false);
    }
  });
});

describe('deriveOperatorSlug', () => {
  it('produces a valid, per-user-disambiguated slug', () => {
    const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    const s = deriveOperatorSlug('Jane’s Focus Coaching!!', 'a81a6e04-ed31-4631-93be-66d78c577dc6');
    expect(SLUG.test(s)).toBe(true);
    expect(s.length).toBeGreaterThanOrEqual(2);
    expect(s.length).toBeLessThanOrEqual(63);
    // Same name, different users → different slugs (no global collision).
    expect(deriveOperatorSlug('Focus', 'user-aaaa')).not.toBe(deriveOperatorSlug('Focus', 'user-bbbb'));
    // All-symbol name still yields a valid slug.
    expect(SLUG.test(deriveOperatorSlug('!!!', 'user-cccc'))).toBe(true);
  });
});

describe('D1OperatorStore — faithful port implementation (parity with the reference)', () => {
  async function runFlow(store) {
    const svc = new OperatorIdentityService({ store });
    const op = await svc.createOperator({ slug: 'acme-coach', displayName: 'Acme Coaching' });
    const wl = await svc.updateWhiteLabel(op.id, { brandName: 'Acme', primaryColor: '#1a1a2e' });
    const client = await svc.createClientOrg({ operatorId: op.id, name: 'Downtown', externalOrgId: 'user-42' });
    const bySlug = await svc.getOperatorBySlug('acme-coach');
    const clients = await svc.listClientOrgs(op.id);
    return {
      opStatus: op.status,
      opCharge: op.chargeMode,
      opCurrency: op.defaultCurrency,
      whiteLabel: wl.whiteLabel,
      clientName: client.name,
      clientExternal: client.externalOrgId,
      clientStatus: client.status,
      bySlugName: bySlug.displayName,
      clientCount: clients.length,
    };
  }

  it('runs the identity+hierarchy flow identically to InMemoryOperatorStore', async () => {
    const ref = await runFlow(new InMemoryOperatorStore());
    const d1 = await runFlow(new D1OperatorStore(makeD1()));
    expect(d1).toEqual(ref);
    expect(d1.whiteLabel).toEqual({ brandName: 'Acme', primaryColor: '#1a1a2e' });
  });

  it('rejects a duplicate slug like the reference does', async () => {
    for (const store of [new InMemoryOperatorStore(), new D1OperatorStore(makeD1())]) {
      const svc = new OperatorIdentityService({ store });
      await svc.createOperator({ slug: 'dup-coach', displayName: 'One' });
      await expect(svc.createOperator({ slug: 'dup-coach', displayName: 'Two' })).rejects.toMatchObject({ name: 'ValidationError' });
    }
  });

  it('rejects a duplicate (operator, external-org) client like the reference does', async () => {
    for (const store of [new InMemoryOperatorStore(), new D1OperatorStore(makeD1())]) {
      const svc = new OperatorIdentityService({ store });
      const op = await svc.createOperator({ slug: 'roster-coach', displayName: 'Roster' });
      await svc.createClientOrg({ operatorId: op.id, name: 'A', externalOrgId: 'user-1' });
      await expect(svc.createClientOrg({ operatorId: op.id, name: 'B', externalOrgId: 'user-1' })).rejects.toMatchObject({ name: 'ValidationError' });
    }
  });

  it('gates the money surface to Phase D (rejects, never silently persists)', async () => {
    const store = new D1OperatorStore(makeD1());
    await expect(store.appendLedgerEntry({})).rejects.toMatchObject({ name: 'ValidationError' });
    await expect(store.insertPayout({})).rejects.toMatchObject({ name: 'ValidationError' });
    await expect(store.insertPriceBookEntry({})).rejects.toMatchObject({ name: 'ValidationError' });
  });
});

describe('coach onboarding routes (mounted on the operator platform)', () => {
  it('onboards a coach as an operator and is idempotent', async () => {
    const env = { DB: makeD1(), JWT_SECRET: 'x' };
    const app = makeApp(env);

    const res1 = await app('POST', '/api/coach/onboarding', { token: 'coach1', body: { displayName: 'Jane Coaching' } });
    expect(res1.status).toBe(201);
    const b1 = await res1.json();
    expect(b1.onboarded).toBe(true);
    expect(b1.operator_id).toBeTruthy();
    expect(b1.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

    // Second call → SAME operator, not a second one.
    const res2 = await app('POST', '/api/coach/onboarding', { token: 'coach1', body: { displayName: 'Jane Coaching' } });
    expect(res2.status).toBe(200);
    const b2 = await res2.json();
    expect(b2.operator_id).toBe(b1.operator_id);
    expect(env.DB._t.operators.length).toBe(1);
    expect(env.DB._t.coach_operators.length).toBe(1);
  });

  it('rejects an unauthenticated onboarding', async () => {
    const env = { DB: makeD1(), JWT_SECRET: 'x' };
    const res = await makeApp(env)('POST', '/api/coach/onboarding', { body: { displayName: 'X' } });
    expect(res.status).toBe(401);
  });

  it('requires a practice name', async () => {
    const env = { DB: makeD1(), JWT_SECRET: 'x' };
    const res = await makeApp(env)('POST', '/api/coach/onboarding', { token: 'coach1', body: {} });
    expect(res.status).toBe(400);
  });

  it('sets white-label at onboarding and reads it back', async () => {
    const env = { DB: makeD1(), JWT_SECRET: 'x' };
    const app = makeApp(env);
    const res = await app('POST', '/api/coach/onboarding', { token: 'coach1', body: { displayName: 'Jane Coaching', brandName: 'Jane', primaryColor: '#123abc' } });
    expect(res.status).toBe(201);
    expect((await res.json()).white_label).toEqual({ brandName: 'Jane', primaryColor: '#123abc' });

    const get = await app('GET', '/api/coach/onboarding', { token: 'coach1' });
    const gb = await get.json();
    expect(gb.white_label).toEqual({ brandName: 'Jane', primaryColor: '#123abc' });
  });

  it('rejects an invalid white-label color', async () => {
    const env = { DB: makeD1(), JWT_SECRET: 'x' };
    const app = makeApp(env);
    await app('POST', '/api/coach/onboarding', { token: 'coach1', body: { displayName: 'Jane Coaching' } });
    const res = await app('PUT', '/api/coach/white-label', { token: 'coach1', body: { brandName: 'Jane', primaryColor: 'not-a-color' } });
    expect(res.status).toBe(400);
  });

  it('the white-label PUT rejects a shaming / "AI" / clinical brand name (400)', async () => {
    const env = { DB: makeD1(), JWT_SECRET: 'x' };
    const app = makeApp(env);
    await app('POST', '/api/coach/onboarding', { token: 'coach1', body: { displayName: 'Jane Coaching' } });
    for (const bad of ['Lazy No More Coaching', 'ADHD Cure Partners', 'AI Accountability']) {
      const res = await app('PUT', '/api/coach/white-label', { token: 'coach1', body: { brandName: bad } });
      expect(res.status, `expected 400 for brand "${bad}"`).toBe(400);
    }
    // A clean brand (and an ADHD-in-pitch brand) still saves.
    const ok = await app('PUT', '/api/coach/white-label', { token: 'coach1', body: { brandName: 'ADHD Focus Coaching' } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).white_label.brandName).toBe('ADHD Focus Coaching');
  });

  it('onboarding rejects a shaming brand up front and creates NO operator', async () => {
    // Proof-of-rejection (Standing Law #1): the sibling drift hole R-327 left —
    // the brand name reached updateWhiteLabel unscanned on the onboarding path.
    const env = { DB: makeD1(), JWT_SECRET: 'x' };
    const app = makeApp(env);
    const res = await app('POST', '/api/coach/onboarding', { token: 'coach1', body: { displayName: 'Jane Coaching', brandName: "Don't Be Lazy Coaching" } });
    expect(res.status).toBe(400);
    // The rejection happened before any operator was created.
    const get = await app('GET', '/api/coach/onboarding', { token: 'coach1' });
    expect((await get.json()).onboarded).toBe(false);
  });

  it('the white-label PUT rejects a valid-but-design-dirty support email (400) and stores a clean one', async () => {
    // Proof-of-rejection (Standing Law #1): the support email is the sibling
    // white-label field that reached updateWhiteLabel unscanned. A valid-format
    // address that shames / goes clinical / brands "AI" must now be rejected.
    const env = { DB: makeD1(), JWT_SECRET: 'x' };
    const app = makeApp(env);
    await app('POST', '/api/coach/onboarding', { token: 'coach1', body: { displayName: 'Jane Coaching' } });
    for (const bad of ['dont-be-lazy@coach.com', 'cure-your-adhd@clinic.com', 'therapy@coach.com', 'the-AI-desk@coach.com']) {
      const res = await app('PUT', '/api/coach/white-label', { token: 'coach1', body: { brandName: 'Jane', supportEmail: bad } });
      expect(res.status, `expected 400 for support email "${bad}"`).toBe(400);
    }
    // A clean support address (and an ADHD-in-pitch one) saves and reads back.
    const ok = await app('PUT', '/api/coach/white-label', { token: 'coach1', body: { brandName: 'Jane', supportEmail: 'help@janecoaching.com' } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).white_label.supportEmail).toBe('help@janecoaching.com');
    const get = await app('GET', '/api/coach/onboarding', { token: 'coach1' });
    expect((await get.json()).white_label.supportEmail).toBe('help@janecoaching.com');
  });

  it('onboarding rejects a design-dirty support email up front and creates NO operator', async () => {
    const env = { DB: makeD1(), JWT_SECRET: 'x' };
    const app = makeApp(env);
    const res = await app('POST', '/api/coach/onboarding', {
      token: 'coach1',
      body: { displayName: 'Jane Coaching', brandName: 'Jane', supportEmail: 'you-failed@coach.com' },
    });
    expect(res.status).toBe(400);
    const get = await app('GET', '/api/coach/onboarding', { token: 'coach1' });
    expect((await get.json()).onboarded).toBe(false);
    expect(env.DB._t.operators.length).toBe(0);
  });

  it('GET before onboarding reports not onboarded', async () => {
    const env = { DB: makeD1(), JWT_SECRET: 'x' };
    const res = await makeApp(env)('GET', '/api/coach/onboarding', { token: 'coach1' });
    expect((await res.json()).onboarded).toBe(false);
  });

  it('saves a warm check-in config and reads it back', async () => {
    const env = { DB: makeD1(), JWT_SECRET: 'x' };
    const app = makeApp(env);
    await app('POST', '/api/coach/onboarding', { token: 'coach1', body: { displayName: 'Jane Coaching' } });

    const res = await app('PUT', '/api/coach/checkin-config', {
      token: 'coach1',
      body: { cadence: 'weekdays', voicePersona: 'calm_ally', script: "You showed up — that's the whole game. Let's go." },
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.cadence).toBe('weekdays');
    expect(b.voice_persona).toBe('calm_ally');

    const get = await app('GET', '/api/coach/onboarding', { token: 'coach1' });
    const gb = await get.json();
    expect(gb.cadence).toBe('weekdays');
    expect(gb.voice_persona).toBe('calm_ally');
    expect(gb.script).toContain('showed up');
  });

  it('REJECTS a shaming check-in script (proof-of-rejection) and stores nothing', async () => {
    const env = { DB: makeD1(), JWT_SECRET: 'x' };
    const app = makeApp(env);
    await app('POST', '/api/coach/onboarding', { token: 'coach1', body: { displayName: 'Jane Coaching' } });

    const res = await app('PUT', '/api/coach/checkin-config', {
      token: 'coach1',
      body: { cadence: 'daily', voicePersona: 'hype_bro', script: "You failed again — don't be so lazy about it." },
    });
    expect(res.status).toBe(400);
    // Nothing shaming was persisted.
    expect(env.DB._t.coach_checkin_config.length).toBe(0);
  });

  it('rejects an unknown cadence or persona', async () => {
    const env = { DB: makeD1(), JWT_SECRET: 'x' };
    const app = makeApp(env);
    await app('POST', '/api/coach/onboarding', { token: 'coach1', body: { displayName: 'Jane Coaching' } });
    expect((await app('PUT', '/api/coach/checkin-config', { token: 'coach1', body: { cadence: 'hourly', voicePersona: 'calm_ally', script: 'hi there friend' } })).status).toBe(400);
    expect((await app('PUT', '/api/coach/checkin-config', { token: 'coach1', body: { cadence: 'daily', voicePersona: 'robot', script: 'hi there friend' } })).status).toBe(400);
  });

  it('config before onboarding is refused', async () => {
    const env = { DB: makeD1(), JWT_SECRET: 'x' };
    const res = await makeApp(env)('PUT', '/api/coach/checkin-config', { token: 'coach1', body: { cadence: 'daily', voicePersona: 'calm_ally', script: 'hi there friend' } });
    expect(res.status).toBe(400);
  });

  it('exposes exactly the intended cadence + persona vocabularies', () => {
    expect(COACH_CADENCES).toEqual(['daily', 'weekdays', 'weekly']);
    expect(COACH_VOICE_PERSONAS).toEqual(['hype_bro', 'calm_ally']);
  });
});
