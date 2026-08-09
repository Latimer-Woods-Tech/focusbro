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
//
// That cue now also FLOATS its seat (Contender #10, Phase C · R-320): the roster
// leads with the person the bro just welcomed back so a coach's top-down scan
// lands on the live moment first, using the Phase-A roster's `rosterTriageRank`
// pattern (a pure, stable reorder of already-resolved cues — no new query). A
// calm seat scores 0 and keeps its natural hierarchy spot; the order is an
// invitation map, never a failure ranking.
//
// The OTHER live positive moment now floats too (Contender #10, Phase C · R-321):
// a kept-word MILESTONE just landing (`milestone_line`, clientMilestoneCopy —
// already resolved on every seat) is the celebration twin of the return-nudge
// welcome, so the operator triage now folds it in as ONE warm-moment dimension
// with the welcomed-back cue — a return OR a milestone floats a seat, counted
// once, exactly the Phase-A grouping. Still momentum-only and engine-independent:
// the milestone cue reads the kept-word run, present only AT a milestone, so a
// between-milestone seat holds its calm spot and no gap is ever surfaced.
//
// A SECOND, independent warm dimension now floats too (Contender #10, Phase C ·
// R-322): a client MOVING this week — a kept word landed inside the trailing
// week (`moving_this_week`, `moving_line`) — read straight off the momentum every
// seat already carries, with no extra query. This is the operator twin of the
// Phase-A roster's `engaged_this_week` rung: where Phase A reads the two-way "I'm
// on it" lean-in off the snooze channel, the operator-backed roster has no such
// channel wired, so it derives live engagement from the kept-word momentum. Like
// Phase A it is a SEPARATE rung from the warm-moment dimension, so a seat both at
// a warm moment AND moving this week floats highest. DESIGN LAW holds: the
// momentum buckets count status='kept' only, so this reads the presence of wins,
// never a miss — a quiet week is simply a calm card that holds its natural spot.
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
  momentumMovingThisWeek,
  clientMovingThisWeekCopy,
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

/**
 * Warm triage weight for ORDERING a seat on the operator-backed roster — the
 * number that floats a card, never one a coach ever sees. Mirrors the Phase-A
 * roster's `rosterTriageRank` pattern (coach.js): every seat carries its cue
 * while the ORDER stayed frozen in hub-hierarchy order, so the seat a coach's
 * touch would help most right now — the one carrying a live positive moment —
 * could sit anywhere. This mirrors Phase A's TWO independent warm dimensions:
 *   +1  a live warm MOMENT for the coach to reinforce — EITHER the bro's return
 *       nudge just reached this person (`welcomed_back.recent`, a re-engagement
 *       moment) OR their current kept-word run just landed on a milestone
 *       (`milestone_line`, clientMilestoneCopy — a celebration moment). These two
 *       are ONE warm-moment dimension (exactly the Phase-A grouping of a
 *       milestone with a return), counted once so neither can out-weigh the
 *       other. Both read "a great moment to send a word / reconnect", so the card
 *       should surface WHILE that moment is live, not sit frozen at its
 *       hub-hierarchy spot where a top-down scan scrolls past it.
 *   +1  the client is MOVING this week (`moving_this_week`) — a kept word has
 *       landed inside the trailing week, read off the momentum already computed.
 *       The operator twin of Phase A's `engaged_this_week` rung: a second,
 *       independent dimension, so a client both at a warm moment AND moving this
 *       week floats highest (reinforce while they are actively in it).
 *
 * DESIGN LAW, by construction: every input is an INVITATION to connect — a
 * person coming back to say you noticed, a kept-word milestone to celebrate, a
 * client keeping words this week to cheer on — never a miss, never a "went quiet"
 * tally. A calm seat simply scores 0 and keeps its natural hierarchy spot; it is
 * never demoted FOR being calm, never annotated, never flagged. `milestone_line`
 * is present ONLY at the exact moment a run lands on a milestone
 * (clientMilestoneCopy is '' otherwise) and `moving_this_week` reads kept
 * instants ONLY (never a miss), so a between-milestone / quiet seat contributes
 * nothing here. The weight is internal only (never serialized), so no visible
 * copy ever tallies anything.
 * @param {object} entry a built operator-roster entry
 * @returns {number} higher = surfaces sooner
 */
export function operatorRosterTriageRank(entry = {}) {
  const welcomedBack = Boolean(entry && entry.welcomed_back && entry.welcomed_back.recent === true);
  const milestone = Boolean(entry && entry.milestone_line);
  const moving = Boolean(entry && entry.moving_this_week === true);
  // Two independent warm dimensions, mirroring the Phase-A roster's rank:
  //   +1 a live warm MOMENT (a return OR a milestone landing), counted once
  //   +1 the client is MOVING this week (kept words landing) — reinforce while live
  return (welcomedBack || milestone ? 1 : 0) + (moving ? 1 : 0);
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

    // "Moving this week": at least one kept word inside the trailing week, read
    // straight off the momentum just computed — no extra query. The operator
    // twin of Phase A's `engaged_this_week`. DESIGN LAW: the momentum buckets
    // count status='kept' only, so this reads the presence of wins, never a miss.
    const moving = momentumMovingThisWeek(momentum);

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
      // Kept words landing this week — a live-engagement cue to reinforce, read
      // off the momentum above. '' / false when the trailing week is quiet.
      moving_this_week: moving,
      moving_line: clientMovingThisWeekCopy({ moving }),
      momentum,
    });
  }

  // Warm triage ordering: float the seats carrying a live positive moment — the
  // bro just welcomed them back OR their kept-word run just landed a milestone —
  // to where a coach's top-down scan lands first, instead of leaving them
  // wherever they sit in the hub hierarchy. Uses ONLY the cues already resolved
  // on each entry (operatorRosterTriageRank) — no extra query, no new data.
  // Pure, STABLE reorder (decorate-sort-undecorate preserves the hub's created_at
  // order within equal rank). DESIGN LAW: the order is an invitation map, never a
  // failure ranking — a calm seat scores 0 and holds its spot, never sunk for
  // being calm, never flagged.
  return roster
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => {
      const d = operatorRosterTriageRank(b.entry) - operatorRosterTriageRank(a.entry);
      if (d !== 0) return d; // higher triage weight surfaces sooner
      return a.i - b.i; // stable tiebreak — preserves the hub hierarchy order
    })
    .map((x) => x.entry);
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
    clientMovingThisWeekCopy({ moving: true }),
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
