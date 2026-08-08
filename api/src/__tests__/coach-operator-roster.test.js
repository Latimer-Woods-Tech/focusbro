/**
 * FocusBro — coach roster on the operator hierarchy (Contender #10, Phase C · slice 2).
 *
 * What this locks down:
 *  1. SEATING: an ACTIVE coach→client link is seated as an operator_client keyed
 *     by the client's user id (external_org_id). A pending/declined/removed link
 *     is NEVER seated — consent-by-construction (proof-of-rejection).
 *  2. IDEMPOTENCY: reconciling twice with no roster change writes nothing new —
 *     one seat per person, forever (the unique external_org_id).
 *  3. CONSENT WITHDRAWAL: when a link leaves 'active', the seat is SUSPENDED and
 *     drops out of the operator-backed read (never 'churned' — reversible).
 *  4. RESUME: a returning client (link active again, seat suspended) resumes the
 *     SAME seat — no shame, no second seat.
 *  5. DASHBOARD OFF THE HIERARCHY: buildOperatorRoster sources membership from
 *     listClientOrgs (the hub), decorated with KEPT-WORD momentum only — no miss
 *     count anywhere in the payload (DESIGN LAW).
 *  6. PARITY: reconcile produces an identical hierarchy over the D1OperatorStore
 *     adapter and the reference InMemoryOperatorStore.
 *  7. The roster copy surface carries no shame / "AI" / clinical claim.
 *
 * The D1 double is a stateful in-memory store interpreting exactly the statements
 * the adapter and this module issue (the codebase idiom), so routes + adapter are
 * exercised end-to-end, not against canned rows.
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import { InMemoryOperatorStore, OperatorIdentityService } from '@latimer-woods-tech/operator';
import { D1OperatorStore } from '../operator-store.js';
import {
  registerCoachOperatorRosterRoutes,
  reconcileOperatorClients,
  buildOperatorRoster,
  deriveClientName,
  coachOperatorRosterCopySurface,
} from '../coach-operator-roster.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// ── Stateful in-memory D1 double ─────────────────────────────
function makeD1(seed = {}) {
  const t = {
    operators: [],
    operator_clients: [],
    coach_operators: seed.coach_operators || [],
    coach_clients: seed.coach_clients || [],
    accountability_streaks: seed.accountability_streaks || [],
    commitments: seed.commitments || [],
    commitment_checkins: seed.commitment_checkins || [],
  };
  const now = () => new Date().toISOString();

  function setCols(S) {
    const m = S.match(/SET (.+) WHERE id = \?$/);
    return m[1].split(',').map((s) => s.trim().split('=')[0].trim());
  }

  function run(S, p) {
    if (S.startsWith('INSERT INTO operators')) {
      const [id, slug, display_name, status, connect_account_id, charge_mode, white_label, default_currency, metadata, created_at, updated_at] = p;
      if (t.operators.some((o) => o.slug === slug)) throw new Error('UNIQUE constraint failed: operators.slug');
      if (connect_account_id !== null && t.operators.some((o) => o.connect_account_id === connect_account_id)) {
        throw new Error('UNIQUE constraint failed: operators.connect_account_id');
      }
      t.operators.push({ id, slug, display_name, status, connect_account_id, charge_mode, white_label, default_currency, metadata, created_at, updated_at });
      return { success: true };
    }
    if (S.startsWith('UPDATE operators SET')) {
      const cols = setCols(S); const id = p[p.length - 1];
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
      const cols = setCols(S); const id = p[p.length - 1];
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
    if (S === 'SELECT current_streak, longest_streak, total_kept, last_kept_date FROM accountability_streaks WHERE user_id = ?') {
      return t.accountability_streaks.find((s) => s.user_id === p[0]) ?? null;
    }
    if (S === "SELECT COUNT(*) AS n FROM commitments WHERE user_id = ? AND status = 'active'") {
      return { n: t.commitments.filter((c) => c.user_id === p[0] && c.status === 'active').length };
    }
    if (S === "SELECT timezone FROM commitments WHERE user_id = ? AND timezone IS NOT NULL AND timezone <> '' ORDER BY updated_at DESC LIMIT 1") {
      const rows = t.commitments.filter((c) => c.user_id === p[0] && c.timezone).sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
      return rows[0] ? { timezone: rows[0].timezone } : null;
    }
    throw new Error('unhandled first SQL: ' + S);
  }

  function all(S, p) {
    if (S === 'SELECT * FROM operator_clients WHERE operator_id = ? ORDER BY created_at ASC, id ASC') {
      return t.operator_clients
        .filter((c) => c.operator_id === p[0])
        .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1));
    }
    if (S === "SELECT client_user_id, client_label FROM coach_clients WHERE coach_user_id = ? AND status = 'active'") {
      return t.coach_clients
        .filter((c) => c.coach_user_id === p[0] && c.status === 'active')
        .map((c) => ({ client_user_id: c.client_user_id, client_label: c.client_label || '' }));
    }
    if (S === "SELECT responded_at FROM commitment_checkins WHERE user_id = ? AND status = 'kept' AND responded_at IS NOT NULL AND responded_at >= ? ORDER BY responded_at ASC LIMIT 1000") {
      return t.commitment_checkins
        .filter((c) => c.user_id === p[0] && c.status === 'kept' && c.responded_at && c.responded_at >= p[1])
        .sort((a, b) => (a.responded_at < b.responded_at ? -1 : 1))
        .map((c) => ({ responded_at: c.responded_at }));
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
  verifyToken: async (tok) => (tok === 'coach1' ? { sub: 'u-coach-1' } : null),
  jsonResponse,
};

function makeApp(env) {
  const router = Router();
  registerCoachOperatorRosterRoutes(router, ctx);
  return (method, path, { token, body } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const init = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    return router.handle(new Request(`https://x.test${path}`, init), env);
  };
}

/** Seed an onboarded coach (operator) so reconcile/read have a target. */
function seedOnboardedCoach(db) {
  const opId = 'op-coach-1';
  db._t.operators.push({
    id: opId, slug: 'coach-1', display_name: 'Coach One', status: 'active',
    connect_account_id: null, charge_mode: 'direct', white_label: null,
    default_currency: 'usd', metadata: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  db._t.coach_operators.push({ user_id: 'u-coach-1', operator_id: opId, created_at: new Date().toISOString() });
  return opId;
}

const svcFor = (db) => new OperatorIdentityService({ store: new D1OperatorStore(db) });

// ─────────────────────────────────────────────────────────────
describe('deriveClientName', () => {
  it('prefers the label, falls back to a stable non-empty handle', () => {
    expect(deriveClientName('  Sam  ', 'u-1')).toBe('Sam');
    expect(deriveClientName('', 'user-abc123xyz')).toBe('Client userab');
    expect(deriveClientName(null, '')).toBe('Client friend');
    expect(deriveClientName('x'.repeat(300), 'u').length).toBe(200);
  });
});

describe('reconcileOperatorClients — the hierarchy is a projection of consent', () => {
  it('seats ONLY active links; a pending/declined/removed link is never seated', async () => {
    const db = makeD1({
      coach_clients: [
        { coach_user_id: 'u-coach-1', client_user_id: 'c-active', client_label: 'Ada', status: 'active' },
        { coach_user_id: 'u-coach-1', client_user_id: 'c-pending', client_label: 'Ben', status: 'pending' },
        { coach_user_id: 'u-coach-1', client_user_id: 'c-declined', client_label: 'Cy', status: 'declined' },
        { coach_user_id: 'u-coach-1', client_user_id: 'c-removed', client_label: 'Di', status: 'removed' },
      ],
    });
    const opId = seedOnboardedCoach(db);
    const svc = svcFor(db);

    const res = await reconcileOperatorClients({ DB: db }, svc, opId, 'u-coach-1');
    expect(res).toEqual({ seated: 1, resumed: 0, suspended: 0, active: 1 });

    const seats = await svc.listClientOrgs(opId);
    expect(seats.map((s) => s.externalOrgId)).toEqual(['c-active']);
    expect(seats[0].status).toBe('active');
    expect(seats[0].name).toBe('Ada');
    // Proof-of-rejection: the non-consented people are absent from the hierarchy.
    for (const banned of ['c-pending', 'c-declined', 'c-removed']) {
      expect(seats.some((s) => s.externalOrgId === banned)).toBe(false);
    }
  });

  it('is idempotent — reconciling twice creates no duplicate seat', async () => {
    const db = makeD1({
      coach_clients: [{ coach_user_id: 'u-coach-1', client_user_id: 'c1', client_label: 'One', status: 'active' }],
    });
    const opId = seedOnboardedCoach(db);
    const svc = svcFor(db);

    await reconcileOperatorClients({ DB: db }, svc, opId, 'u-coach-1');
    const second = await reconcileOperatorClients({ DB: db }, svc, opId, 'u-coach-1');
    expect(second).toEqual({ seated: 0, resumed: 0, suspended: 0, active: 1 });
    const seats = await svc.listClientOrgs(opId);
    expect(seats.length).toBe(1);
  });

  it('suspends a seat when consent is withdrawn (never churned)', async () => {
    const db = makeD1({
      coach_clients: [{ coach_user_id: 'u-coach-1', client_user_id: 'c1', client_label: 'One', status: 'active' }],
    });
    const opId = seedOnboardedCoach(db);
    const svc = svcFor(db);
    await reconcileOperatorClients({ DB: db }, svc, opId, 'u-coach-1');

    // Client steps away: the link leaves 'active'.
    db._t.coach_clients[0].status = 'removed';
    const res = await reconcileOperatorClients({ DB: db }, svc, opId, 'u-coach-1');
    expect(res).toEqual({ seated: 0, resumed: 0, suspended: 1, active: 0 });

    const seats = await svc.listClientOrgs(opId);
    expect(seats.length).toBe(1);
    expect(seats[0].status).toBe('suspended'); // reversible, not terminal 'churned'
  });

  it('resumes the SAME seat when a client comes back — no second seat, no shame', async () => {
    const db = makeD1({
      coach_clients: [{ coach_user_id: 'u-coach-1', client_user_id: 'c1', client_label: 'One', status: 'active' }],
    });
    const opId = seedOnboardedCoach(db);
    const svc = svcFor(db);
    await reconcileOperatorClients({ DB: db }, svc, opId, 'u-coach-1');
    const seatId = (await svc.listClientOrgs(opId))[0].id;

    db._t.coach_clients[0].status = 'removed';
    await reconcileOperatorClients({ DB: db }, svc, opId, 'u-coach-1');
    db._t.coach_clients[0].status = 'active'; // they came back
    const res = await reconcileOperatorClients({ DB: db }, svc, opId, 'u-coach-1');
    expect(res).toEqual({ seated: 0, resumed: 1, suspended: 0, active: 1 });

    const seats = await svc.listClientOrgs(opId);
    expect(seats.length).toBe(1); // same seat, never a duplicate
    expect(seats[0].id).toBe(seatId);
    expect(seats[0].status).toBe('active');
  });
});

describe('buildOperatorRoster — dashboard read off the hierarchy, momentum-only', () => {
  const now = '2026-08-08T12:00:00.000Z';

  it('reads membership from the hub and decorates with kept-word momentum only', async () => {
    const db = makeD1({
      coach_clients: [{ coach_user_id: 'u-coach-1', client_user_id: 'c1', client_label: 'Ada', status: 'active' }],
      accountability_streaks: [{ user_id: 'c1', current_streak: 3, longest_streak: 5, total_kept: 12, last_kept_date: '2026-08-08' }],
      commitments: [
        { user_id: 'c1', status: 'active', timezone: 'UTC', updated_at: '2026-08-07T00:00:00Z' },
        { user_id: 'c1', status: 'active', timezone: 'UTC', updated_at: '2026-08-06T00:00:00Z' },
      ],
      commitment_checkins: [
        { user_id: 'c1', status: 'kept', responded_at: '2026-08-07T09:00:00.000Z' },
        { user_id: 'c1', status: 'kept', responded_at: '2026-08-08T09:00:00.000Z' },
        // A MISS row exists in the data — it must NOT influence the read.
        { user_id: 'c1', status: 'missed', responded_at: '2026-08-08T10:00:00.000Z' },
      ],
    });
    const opId = seedOnboardedCoach(db);
    const svc = svcFor(db);
    await reconcileOperatorClients({ DB: db }, svc, opId, 'u-coach-1');

    const roster = await buildOperatorRoster({ DB: db }, svc, opId, { nowISO: now });
    expect(roster.length).toBe(1);
    const entry = roster[0];
    expect(entry.client_id).toBe('c1');
    expect(entry.name).toBe('Ada');
    expect(entry.streak).toEqual({ current_streak: 3, longest_streak: 5, total_kept: 12 });
    expect(entry.active_commitments).toBe(2);
    expect(entry.momentum).toBeTruthy();

    // DESIGN LAW: no miss/failure/gap surface anywhere in a roster entry.
    const flat = JSON.stringify(entry).toLowerCase();
    for (const banned of ['miss', 'fail', 'behind', 'lazy', 'shame', 'gap']) {
      expect(flat.includes(banned)).toBe(false);
    }
    // The momentum total counts kept words only (2), not the miss row.
    expect(entry.momentum.total).toBe(2);
  });

  it('a suspended (consent-withdrawn) seat is absent from the read', async () => {
    const db = makeD1({
      coach_clients: [{ coach_user_id: 'u-coach-1', client_user_id: 'c1', client_label: 'Ada', status: 'active' }],
      accountability_streaks: [{ user_id: 'c1', current_streak: 1, longest_streak: 1, total_kept: 1 }],
    });
    const opId = seedOnboardedCoach(db);
    const svc = svcFor(db);
    await reconcileOperatorClients({ DB: db }, svc, opId, 'u-coach-1');
    db._t.coach_clients[0].status = 'removed';
    await reconcileOperatorClients({ DB: db }, svc, opId, 'u-coach-1');

    const roster = await buildOperatorRoster({ DB: db }, svc, opId, { nowISO: now });
    expect(roster).toEqual([]);
  });
});

describe('parity — same hierarchy over D1OperatorStore and InMemoryOperatorStore', () => {
  function seedCoachClientsDb() {
    return makeD1({
      coach_clients: [
        { coach_user_id: 'u-coach-1', client_user_id: 'c1', client_label: 'One', status: 'active' },
        { coach_user_id: 'u-coach-1', client_user_id: 'c2', client_label: '', status: 'active' },
        { coach_user_id: 'u-coach-1', client_user_id: 'c3', client_label: 'Three', status: 'pending' },
      ],
    });
  }

  async function runOver(store, db) {
    const svc = new OperatorIdentityService({ store });
    // The operator itself must exist in the store for requireOperator to pass.
    await svc.createOperator({ slug: 'coach-1', displayName: 'Coach One' });
    // createOperator minted an id; find it and point coach_operators at it.
    const op = await svc.getOperatorBySlug('coach-1');
    db._t.coach_operators.length = 0;
    db._t.coach_operators.push({ user_id: 'u-coach-1', operator_id: op.id });
    const res = await reconcileOperatorClients({ DB: db }, svc, op.id, 'u-coach-1');
    const seats = (await svc.listClientOrgs(op.id))
      .map((s) => ({ externalOrgId: s.externalOrgId, status: s.status, name: s.name }))
      .sort((a, b) => (a.externalOrgId < b.externalOrgId ? -1 : 1));
    return { res, seats };
  }

  it('reconcile output + resulting seats match on both stores', async () => {
    const dbRef = seedCoachClientsDb();
    const dbD1 = seedCoachClientsDb();
    const ref = await runOver(new InMemoryOperatorStore(), dbRef);
    const d1 = await runOver(new D1OperatorStore(dbD1), dbD1);
    expect(d1.res).toEqual(ref.res);
    expect(d1.seats).toEqual(ref.seats);
    // Only the two active clients were seated; the pending one was rejected.
    expect(d1.seats.map((s) => s.externalOrgId)).toEqual(['c1', 'c2']);
  });
});

describe('coachOperatorRosterCopySurface — never shames, brands "AI", or goes clinical', () => {
  const SHAME = [/\bfail/i, /\blaz/i, /\bshame/i, /\bbehind\b/i, /\bmiss(ed|es|ing)?\b/i, /\bguilt/i, /\bdisappoint/i];
  const CLINICAL = [/\btreat(s|ment|ing)?\b/i, /\bcure/i, /\bdiagnos/i, /\bdisorder/i, /\bsymptom/i, /\bADHD\b/i];
  const AI = /\bAI\b/;

  it('passes every battery', () => {
    for (const line of coachOperatorRosterCopySurface()) {
      expect(typeof line).toBe('string');
      for (const p of SHAME) expect(p.test(line)).toBe(false);
      for (const p of CLINICAL) expect(p.test(line)).toBe(false);
      expect(AI.test(line)).toBe(false);
    }
  });
});

describe('routes', () => {
  it('GET /api/coach/operator/clients before onboarding → onboarded:false, empty', async () => {
    const db = makeD1();
    const app = makeApp({ DB: db, JWT_SECRET: 'x' });
    const res = await app('GET', '/api/coach/operator/clients', { token: 'coach1' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.onboarded).toBe(false);
    expect(body.roster).toEqual([]);
    expect(body.empty_message).toBeTruthy();
  });

  it('GET reconciles then reads off the hierarchy for an onboarded coach', async () => {
    const db = makeD1({
      coach_clients: [
        { coach_user_id: 'u-coach-1', client_user_id: 'c1', client_label: 'Ada', status: 'active' },
        { coach_user_id: 'u-coach-1', client_user_id: 'c2', client_label: 'Ben', status: 'pending' },
      ],
      accountability_streaks: [{ user_id: 'c1', current_streak: 2, longest_streak: 2, total_kept: 2 }],
    });
    seedOnboardedCoach(db);
    const app = makeApp({ DB: db, JWT_SECRET: 'x' });
    const res = await app('GET', '/api/coach/operator/clients', { token: 'coach1' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.onboarded).toBe(true);
    expect(body.roster.length).toBe(1); // pending client never surfaces
    expect(body.roster[0].client_id).toBe('c1');
    // The seat now exists in the hub as a side effect of the read's reconcile.
    expect(db._t.operator_clients.map((c) => c.external_org_id)).toEqual(['c1']);
  });

  it('POST sync requires onboarding, then seats the consented roster', async () => {
    const db = makeD1({
      coach_clients: [{ coach_user_id: 'u-coach-1', client_user_id: 'c1', client_label: 'Ada', status: 'active' }],
    });
    const app = makeApp({ DB: db, JWT_SECRET: 'x' });

    const denied = await app('POST', '/api/coach/operator/clients/sync', { token: 'coach1' });
    expect(denied.status).toBe(400);

    seedOnboardedCoach(db);
    const ok = await app('POST', '/api/coach/operator/clients/sync', { token: 'coach1' });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body).toMatchObject({ ok: true, seated: 1, active: 1 });
  });

  it('rejects an unauthenticated read', async () => {
    const db = makeD1();
    const app = makeApp({ DB: db, JWT_SECRET: 'x' });
    const res = await app('GET', '/api/coach/operator/clients', {});
    expect(res.status).toBe(401);
  });
});
