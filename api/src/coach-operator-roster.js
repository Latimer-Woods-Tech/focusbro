// ════════════════════════════════════════════════════════════
// FOCUSBRO — COACH ROSTER, ON THE OPERATOR HIERARCHY  (Contender #10, Phase C · slice 2)
// ════════════════════════════════════════════════════════════
// Slice 1 mounted coach identity + white-label + check-in config on the shared
// `@latimer-woods-tech/operator` platform. This slice seats the coach's actual
// people INTO that platform's hierarchy and reads the dashboard back OFF it:
//
//   Phase-A `coach_clients` (the consent-gated roster) ──▶ `operator_clients`
//   (the operator→client hierarchy owned by the operator package).
//
// The coach dashboard's membership now comes from `listClientOrgs(operatorId)` —
// the hub's hierarchy — not from a hand-rolled `coach_clients` query. That is the
// point of the slice: FocusBro stops carrying its own parallel client hierarchy
// and lets the operator platform own it (the Warden's UNBLOCK: "Do NOT hand-roll
// billing/hierarchy; thin adapters come out.").
//
// CONSENT IS LOAD-BEARING, BY CONSTRUCTION. The hierarchy is a *projection* of
// the CONSENTED set and never more: only an `active` coach→client link (the
// client accepted) is seated. A `pending`/`declined`/`removed` link is not
// consent to be seated, so it never enters `operator_clients` at all — a coach
// can never see, in the operator-backed view, a person who has not opted in. When
// a client steps away (the link leaves `active`), their seat is SUSPENDED — it
// drops out of the read immediately. Suspended, never `churned`: churned is
// terminal and would read as a verdict; a stepped-away person can always come
// back, and on return their same seat resumes (no shame, no second seat).
//
// ONE seat per person, forever: the client's user id is the seat's stable
// `external_org_id`, and `(operator_id, external_org_id)` is unique — so
// reconciling is idempotent and a person is never double-seated.
//
// THE DESIGN LAW reaches the operator-backed read too. The dashboard shows
// KEPT-WORD momentum only — current/longest/total kept words and a kept-only
// sparkline. There is no miss count anywhere in it, by construction: the
// sparkline reads `status='kept'` rows exclusively, so a quiet day is a short
// bar, never a surfaced gap. Enforced by coach-operator-roster.test.js.
//
// A "JUST WELCOMED BACK" cue rides the same read (Contender #10, Phase C · R-319):
// when the bro's automated return nudge has just reached out to one of the
// coach's people (a RETURN_NUDGE_SENT marker inside WELCOMED_BACK_WINDOW_DAYS),
// the roster surfaces it so the coach can add their own touch to the automated
// warm hello. It reads the OUTREACH marker only — never who answered — so it is
// a positive re-engagement moment, never a "went quiet" tally. Same design law:
// the cue is '' unless the moment is live, and its copy names no gap.
// ════════════════════════════════════════════════════════════

import { OperatorIdentityService } from '@latimer-woods-tech/operator';
import { D1OperatorStore } from './operator-store.js';
import {
  buildMomentum,
  MOMENTUM_WINDOW_DAYS,
  dashboardIntroCopy,
  rosterEmptyCopy,
  clientStatusLine,
  clientMilestoneCopy,
  coachWelcomedBackCopy,
  WELCOMED_BACK_WINDOW_DAYS,
} from './coach.js';

/**
 * Derive a non-empty, legible name for a client's seat in the hierarchy. Prefers
 * the coach's private label; falls back to a short, stable handle from the
 * client's id so the operator package's non-empty-name rule always holds. Capped
 * at 200 chars (the package's own `assertNonEmptyName` ceiling).
 * @param {string} label  the coach's private client_label (may be blank)
 * @param {string} clientUserId  the FocusBro user id of the client
 * @returns {string}
 */
export function deriveClientName(label, clientUserId) {
  const l = typeof label === 'string' ? label.trim() : '';
  if (l) return l.slice(0, 200);
  const suffix = String(clientUserId || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6) || 'friend';
  return `Client ${suffix}`;
}

/**
 * Reconcile the operator→client hierarchy with the consented roster: seat every
 * `active` coach→client link that isn't seated yet, resume any seat whose person
 * has come back (link active again, seat suspended), and suspend any seat whose
 * link is no longer active (consent withdrawn → drops out of the read).
 *
 * Idempotent: running it twice with no roster change makes no writes. The
 * hierarchy it produces is exactly the set of currently-consented people —
 * never a pending/declined/removed one.
 *
 * @param {{ DB: D1Database }} env
 * @param {OperatorIdentityService} svc  the operator identity service (hub)
 * @param {string} operatorId  the coach's operator id
 * @param {string} coachUserId  the coach's FocusBro user id
 * @returns {Promise<{ seated: number, resumed: number, suspended: number, active: number }>}
 */
export async function reconcileOperatorClients(env, svc, operatorId, coachUserId) {
  // The consented set — accepted links only. A pending/declined/removed link is
  // NOT consent to seat, so it is never in this map and never enters the hub.
  const linkRows = await env.DB.prepare(
    `SELECT client_user_id, client_label FROM coach_clients
      WHERE coach_user_id = ? AND status = 'active'`,
  ).bind(coachUserId).all();
  const consented = new Map();
  for (const r of (linkRows && linkRows.results) || []) {
    consented.set(r.client_user_id, r.client_label || '');
  }

  // The seats that already exist in the hub, keyed by the person they represent.
  const existing = await svc.listClientOrgs(operatorId);
  const byExternal = new Map();
  for (const c of existing) {
    if (c.externalOrgId) byExternal.set(c.externalOrgId, c);
  }

  let seated = 0;
  let resumed = 0;
  let suspended = 0;

  // Seat or resume every consented person.
  for (const [clientId, label] of consented) {
    const seat = byExternal.get(clientId);
    if (!seat) {
      await svc.createClientOrg({
        operatorId,
        name: deriveClientName(label, clientId),
        externalOrgId: clientId,
        status: 'active',
      });
      seated += 1;
    } else if (seat.status === 'suspended') {
      // They stepped away and came back — resume the same seat, no shame, no
      // second seat. (suspended → active is a legal client transition.)
      await svc.setClientStatus(seat.id, 'active');
      resumed += 1;
    }
    // active link + active seat → already correct; do nothing (idempotent).
  }

  // Withdraw consent: any active seat whose person is no longer consented drops
  // OUT of the read. Suspended (reversible), never churned (terminal/a verdict).
  for (const [clientId, seat] of byExternal) {
    if (!consented.has(clientId) && seat.status === 'active') {
      await svc.setClientStatus(seat.id, 'suspended');
      suspended += 1;
    }
  }

  return { seated, resumed, suspended, active: consented.size };
}

/** Kept-word streak numbers for a client, defaulting to a clean zero row. */
async function loadStreak(env, userId) {
  const row = await env.DB.prepare(
    `SELECT current_streak, longest_streak, total_kept, last_kept_date
       FROM accountability_streaks WHERE user_id = ?`,
  ).bind(userId).first();
  return row || { current_streak: 0, longest_streak: 0, total_kept: 0, last_kept_date: null };
}

/**
 * Build the coach dashboard by reading the operator hierarchy: list the
 * operator's ACTIVE seats and decorate each with kept-word momentum. Membership
 * is sourced from `listClientOrgs` (the hub), so a suspended (consent-withdrawn)
 * seat is absent by construction. Momentum-only — no miss count anywhere.
 *
 * @param {{ DB: D1Database }} env
 * @param {OperatorIdentityService} svc
 * @param {string} operatorId
 * @param {{ nowISO?: string }} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function buildOperatorRoster(env, svc, operatorId, { nowISO } = {}) {
  const now = nowISO || new Date().toISOString();
  const clients = await svc.listClientOrgs(operatorId);
  const active = clients.filter((c) => c.status === 'active' && c.externalOrgId);

  // "Just welcomed back": which of these people the bro's return nudge reached
  // out to inside the trailing window (a RETURN_NUDGE_SENT marker). ONE batched
  // query for the whole roster — the marker's payload carries the person's id
  // (the row's user_id is NULL by design, so the nudge never counts as their own
  // activity). DESIGN LAW: this reads the OUTREACH only, never who answered it —
  // a positive re-engagement moment for the coach to add their touch to, never a
  // "went quiet" tally. Format-agnostic day-prefix compare, the events.js idiom.
  const welcomedCutoff = new Date(
    Date.parse(now) - WELCOMED_BACK_WINDOW_DAYS * 86400000,
  ).toISOString().slice(0, 10);
  const welcomedRows = await env.DB.prepare(
    `SELECT json_extract(event_data, '$.user_id') AS client_id, MAX(created_at) AS at
       FROM analytics_events
      WHERE event_type = 'return_nudge_sent'
        AND substr(created_at, 1, 10) >= ?
      GROUP BY json_extract(event_data, '$.user_id')`,
  ).bind(welcomedCutoff).all();
  const welcomedByClient = new Map();
  for (const r of (welcomedRows && welcomedRows.results) || []) {
    if (r.client_id) welcomedByClient.set(r.client_id, r.at || null);
  }

  const roster = [];
  for (const c of active) {
    const clientId = c.externalOrgId;
    const streakRow = await loadStreak(env, clientId);
    const streak = {
      current_streak: Number(streakRow.current_streak) || 0,
      longest_streak: Number(streakRow.longest_streak) || 0,
      total_kept: Number(streakRow.total_kept) || 0,
    };

    const activeCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM commitments WHERE user_id = ? AND status = 'active'`,
    ).bind(clientId).first();

    // Kept-word momentum sparkline. A representative timezone for day boundaries:
    // the client's most recently touched commitment zone, UTC fallback. Fetch a
    // slightly wider raw window than the axis (tz offsets can shift an instant
    // across midnight); buildMomentum trims to the last N local days. DESIGN LAW:
    // reads status='kept' ONLY — a quiet day is a short bar, never a surfaced miss.
    const tzRow = await env.DB.prepare(
      `SELECT timezone FROM commitments
        WHERE user_id = ? AND timezone IS NOT NULL AND timezone <> ''
        ORDER BY updated_at DESC LIMIT 1`,
    ).bind(clientId).first();
    const tz = (tzRow && tzRow.timezone) || 'UTC';
    const cutoffISO = new Date(Date.parse(now) - (MOMENTUM_WINDOW_DAYS + 2) * 86400000).toISOString();
    const keptRows = await env.DB.prepare(
      `SELECT responded_at FROM commitment_checkins
        WHERE user_id = ? AND status = 'kept' AND responded_at IS NOT NULL AND responded_at >= ?
        ORDER BY responded_at ASC
        LIMIT 1000`,
    ).bind(clientId, cutoffISO).all();
    const keptTs = ((keptRows && keptRows.results) || []).map((r) => r.responded_at);
    const momentum = buildMomentum({
      timestamps: keptTs, days: MOMENTUM_WINDOW_DAYS, nowISO: now, timezone: tz,
    });

    const welcomedAt = welcomedByClient.get(clientId) || null;
    const welcomed = welcomedAt !== null;

    roster.push({
      operator_client_id: c.id,
      client_id: clientId,
      name: c.name,
      streak,
      active_commitments: Number(activeCount && activeCount.n) || 0,
      status_line: clientStatusLine({ streak }),
      milestone_line: clientMilestoneCopy({ streak }),
      // The bro's just-fired return-nudge outreach, surfaced for the coach to
      // add their own touch to. `recent` gates the card cue; `at` is the
      // outreach instant (internal). Copy is '' when there is nothing live.
      welcomed_back: { recent: welcomed, at: welcomedAt },
      welcome_back_line: coachWelcomedBackCopy({ welcomed }),
      momentum,
    });
  }
  return roster;
}

/**
 * Every static string the operator-backed roster surface can show a coach, in
 * one place so the design-LAW test scans all of it and no shaming/clinical/"AI"
 * label can slip in unnoticed.
 * @returns {string[]}
 */
export function coachOperatorRosterCopySurface() {
  return [
    dashboardIntroCopy(),
    rosterEmptyCopy(),
    clientStatusLine({ streak: { current_streak: 0, longest_streak: 0 } }),
    clientStatusLine({ streak: { current_streak: 0, longest_streak: 9 } }),
    clientStatusLine({ streak: { current_streak: 1, longest_streak: 1 } }),
    clientStatusLine({ streak: { current_streak: 5, longest_streak: 9 } }),
    clientMilestoneCopy({ streak: { current_streak: 7 } }),
    clientMilestoneCopy({ streak: { current_streak: 30 } }),
    coachWelcomedBackCopy({ welcomed: true }),
  ];
}

/**
 * Register the Phase-C slice-2 routes: seat the consented roster into the
 * operator hierarchy and read the coach dashboard back off it.
 *
 * @param {import('itty-router').Router} router
 * @param {{ getAuthToken: Function, verifyToken: Function, jsonResponse: Function }} ctx
 */
export function registerCoachOperatorRosterRoutes(router, ctx) {
  const { getAuthToken, verifyToken, jsonResponse } = ctx;

  function service(env) {
    return new OperatorIdentityService({ store: new D1OperatorStore(env.DB) });
  }

  async function requireUser(request, env) {
    const token = getAuthToken(request);
    if (!token) return { error: jsonResponse({ error: 'Unauthorized' }, 401) };
    const payload = await verifyToken(token, env.JWT_SECRET, env);
    if (!payload) return { error: jsonResponse({ error: 'Invalid token' }, 401) };
    return { userId: payload.sub };
  }

  /** The operator id this user coaches under, or null if not yet onboarded. */
  async function operatorIdForUser(env, userId) {
    const row = await env.DB.prepare(
      'SELECT operator_id FROM coach_operators WHERE user_id = ?',
    ).bind(userId).first();
    return row ? row.operator_id : null;
  }

  // ── POST /api/coach/operator/clients/sync — reconcile the hierarchy ──
  // Seat newly-accepted clients, resume returners, suspend the withdrawn. Safe
  // to call any time; idempotent when nothing changed.
  router.post('/api/coach/operator/clients/sync', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;

      const operatorId = await operatorIdForUser(env, auth.userId);
      if (!operatorId) return jsonResponse({ error: 'Set up your coaching space first.' }, 400);

      const svc = service(env);
      const result = await reconcileOperatorClients(env, svc, operatorId, auth.userId);
      return jsonResponse({ ok: true, ...result }, 200);
    } catch {
      return jsonResponse({ error: 'Could not sync your roster.' }, 500);
    }
  });

  // ── GET /api/coach/operator/clients — the coach dashboard, off the hierarchy ──
  router.get('/api/coach/operator/clients', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;

      const operatorId = await operatorIdForUser(env, auth.userId);
      if (!operatorId) {
        // Not onboarded yet — no coaching space, so no hierarchy to read.
        return jsonResponse(
          { onboarded: false, roster: [], intro: dashboardIntroCopy(), empty_message: rosterEmptyCopy() },
          200,
        );
      }

      const svc = service(env);
      // Reconcile first, so the hierarchy reflects the CURRENT consented roster
      // before we read it: a just-accepted client is seated and a just-revoked
      // one has dropped out, all in this one request.
      await reconcileOperatorClients(env, svc, operatorId, auth.userId);
      const roster = await buildOperatorRoster(env, svc, operatorId);

      return jsonResponse({
        onboarded: true,
        intro: dashboardIntroCopy(),
        roster,
        empty_message: roster.length ? null : rosterEmptyCopy(),
      }, 200);
    } catch {
      return jsonResponse({ error: 'Could not load your roster.' }, 500);
    }
  });
}
