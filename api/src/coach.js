// ════════════════════════════════════════════════════════════
// FOCUSBRO — COACH ROSTER  (Contender track, issue #10, Phase A)
// ════════════════════════════════════════════════════════════
// The skeleton coach dashboard: an operator-facing, READ-ONLY view of the
// clients a coach supports and each client's kept-word momentum.
//
// A coach is any user who supports others. The full coach white-label —
// cadence/voice/script config, wholesale billing, the operator hierarchy —
// is Phase C, gated on the @latimer-woods-tech/operator UNBLOCK. This module
// deliberately stops at the skeleton: a consent-respecting roster link and a
// read-only view. It does NOT build a parallel billing or hierarchy system.
//
// CONSENT IS LOAD-BEARING: a coach cannot see a client's commitments or streak
// until the client accepts the invitation. Inviting only creates a `pending`
// link; the coach sees nothing about a person who has not opted in. This is the
// honest skeleton of the real onboarding Phase C will flesh out.
//
// THE DESIGN LAW (non-negotiable): never shame — and it applies to the coach's
// view too. A dashboard is exactly where a client's misses could get tallied
// into a "who's falling behind" list; that would be the guilt engine wearing a
// coach's hat. So this view shows KEPT-WORD momentum only. There is no miss
// count anywhere in the roster, by design — the same law that governs what the
// bro says to a client governs what a coach sees about them. Enforced by
// coach.test.js (banned-word + no-"AI" + no-clinical-claim assertions).
// ════════════════════════════════════════════════════════════

import { describeCadence, formatWhenLocal } from './accountability.js';
import {
  MOMENTUM_WINDOW_DAYS,
  localDayInZone,
  bucketKeptByDay,
  sparklineBars,
  buildMomentum as buildMomentumBlock,
} from './momentum.js';

// Re-exported so existing importers (and coach.test.js) keep their import path
// while the implementations live in the shared ./momentum.js engine.
export { MOMENTUM_WINDOW_DAYS, localDayInZone, bucketKeptByDay, sparklineBars };

/** Roster link states. A coach sees client data only in the `active` state. */
export const COACH_LINK_STATES = ['pending', 'active', 'declined', 'removed'];

const MAX_LABEL = 120;

/** Normalize/validate a coach's private label for a client (optional). */
export function normalizeClientLabel(label) {
  if (typeof label !== 'string') return '';
  return label.trim().slice(0, MAX_LABEL);
}

/** Basic email shape check — good enough to reject obvious junk before a lookup. */
export function looksLikeEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// ── ROSTER COPY ENGINE ───────────────────────────────────────
// Every string a coach reads about a client is warm and momentum-framed.
// We celebrate kept words; we never surface a failure tally. On a fresh or
// reset streak it reads as an open page, never "this one is slipping."

/** Header subtitle for the dashboard — sets the tone for the whole view. */
export function dashboardIntroCopy() {
  return 'The people you show up for, and the words they’re keeping. Cheer the wins; the rest just means the next one’s ahead.';
}

/** Warm one-line status for a single client, framed by kept-word momentum. */
export function clientStatusLine({ streak } = {}) {
  const cur = Number(streak?.current_streak) || 0;
  const best = Number(streak?.longest_streak) || 0;
  if (cur === 0) {
    return best > 0
      ? 'Open page right now — a strong run already logged and the next one ahead.'
      : 'Just getting started — a clean page to build on.';
  }
  const bestPart = best > cur ? ` (their best is ${best})` : '';
  return `${cur} kept word${cur === 1 ? '' : 's'} in a row${bestPart} — real momentum.`;
}

/** Shown when a coach's roster has no active clients yet. */
export function rosterEmptyCopy() {
  return 'No one on your roster yet. Invite someone you support by their email — they’ll get to accept before you see anything.';
}

/** Status text for an invitation the client hasn’t answered yet. */
export function invitePendingCopy() {
  return 'Invited — waiting for them to accept. No rush, and nothing to see until they do.';
}

/** Confirmation copy after a coach sends an invitation. */
export function inviteSentCopy({ email } = {}) {
  const who = email ? ` to ${email}` : '';
  return `Invitation sent${who}. They choose whether to opt in — you’ll see their kept-word momentum once they accept.`;
}

/**
 * Header copy for the client-rhythm panel. A cadence view shows WHEN a person
 * asked the bro to show up — the shape of their commitment, never a scorecard.
 */
export function rhythmIntroCopy() {
  return 'The rhythm they set for themselves — the times they’ve asked the bro to show up.';
}

/** Shown in the rhythm panel when an active client has no live commitments. */
export function rhythmEmptyCopy() {
  return 'Nothing on the books right now — a clear page, ready for their next word.';
}

/**
 * Warm "next time the bro shows up" line for a single active commitment. The
 * whole product thesis is a companion who shows up ON A SCHEDULE, so a coach
 * should see the CONCRETE next occurrence — "Next up tomorrow at 8:40 AM" — not
 * just the abstract cadence. DESIGN LAW: this reads only an OUTSTANDING (future)
 * check-in — a moment the bro is about to keep — so it is momentum by
 * construction and can never surface a miss. When nothing is scheduled yet (a
 * one-time word already answered, or a rhythm the cron is about to re-arm), it
 * stays warm and forward-looking, never "overdue".
 * @param {object} p { iso, timezone, nowISO }
 * @returns {string}
 */
export function nextCheckinCopy({ iso, timezone, nowISO } = {}) {
  if (iso && !Number.isNaN(Date.parse(iso))) {
    return `Next up ${formatWhenLocal(iso, timezone, nowISO)}`;
  }
  return 'Next check-in lining up.';
}

/**
 * The warm coach-voice "door held open" line for a client whose soonest
 * outstanding check-in time has already passed but is still open. Third-person
 * twin of me.js `listNextCheckinWaitingCopy` — the whole point is that time
 * passing is not failure here, so this is NEVER "late"/"overdue"/a miss.
 * @returns {string}
 */
export function rosterNextCheckinWaitingCopy() {
  return 'Still here whenever they’re ready';
}

/**
 * At-a-glance next-check-in line for a client on the coach ROSTER (not the
 * drill-in rhythm panel). The whole product thesis is a companion who shows up
 * ON A SCHEDULE, so a coach should see the soonest concrete moment the bro will
 * next keep a word for THIS client across their whole roster — not only by
 * opening "View rhythm" one client at a time (R-224). This is the coach-side
 * twin of the person's own at-a-glance next check-in (R-233).
 *
 * DESIGN LAW, by construction: the caller only ever passes an OUTSTANDING
 * check-in (pending/sent/deferred) that belongs to an ACTIVE commitment — a
 * future moment about to be KEPT, never a miss. When that moment has already
 * passed but is still open, this reads as a warm "still here whenever they're
 * ready" (the door held open), NEVER "late"/"overdue". Nothing queued → '' so
 * the at-a-glance card stays clean (the drill-in rhythm view carries per-word
 * detail).
 * @param {object} p { iso, timezone, nowISO }
 * @returns {string} rendered line, or '' when there is nothing outstanding
 */
export function rosterNextCheckinLine({ iso, timezone, nowISO } = {}) {
  if (!iso || Number.isNaN(Date.parse(iso))) return '';
  const now = nowISO && !Number.isNaN(Date.parse(nowISO)) ? Date.parse(nowISO) : Date.now();
  if (Date.parse(iso) <= now) return rosterNextCheckinWaitingCopy();
  return nextCheckinCopy({ iso, timezone, nowISO });
}

// ── KEPT-WORD MOMENTUM SPARKLINE ─────────────────────────────
// A coach should feel a client's momentum at a glance, not just read a single
// streak number. So the detail view carries a per-day count of KEPT words over
// a recent window — a little sparkline of "words kept per day".
//
// The math lives in ./momentum.js (shared with the person's own /me/ view). The
// coach voice — third-person, "their momentum" — is supplied here. DESIGN LAW,
// by construction: momentum.js reads KEPT instants ONLY, so nothing a coach
// sees here can read as "who's slipping."

/** Header copy for the momentum panel — a momentum chart, framed as such. */
export function momentumIntroCopy() {
  return 'Words kept per day — the shape of their momentum. Quiet days are just quiet; we only ever count the wins.';
}

/**
 * Warm one-line summary of the kept-word window. Momentum-only: it names the
 * total kept and the best single day, and on a quiet window it reads as a fresh
 * page — never a tally of what wasn't done.
 * @param {object} p { total, days, peak }
 * @returns {string}
 */
export function momentumSummaryCopy({ total, days = MOMENTUM_WINDOW_DAYS, peak } = {}) {
  const kept = Number(total) || 0;
  const span = Number(days) || MOMENTUM_WINDOW_DAYS;
  if (kept === 0) {
    return `A clean page over the last ${span} days — every window is a fresh start, and the next kept word lands right here.`;
  }
  const best = Number(peak && peak.count) || 0;
  const bestPart = best > 1 ? ` Their best day: ${best} kept.` : '';
  return `${kept} word${kept === 1 ? '' : 's'} kept over the last ${span} days.${bestPart}`;
}

/**
 * Assemble the coach-facing momentum block from raw kept instants. Thin wrapper
 * over the shared engine that injects the coach (third-person) voice.
 * @param {object} p { timestamps, days, nowISO, timezone }
 * @returns {object} { intro, days, timezone, buckets, total, peak, sparkline, summary }
 */
export function buildMomentum({ timestamps, days = MOMENTUM_WINDOW_DAYS, nowISO, timezone } = {}) {
  return buildMomentumBlock({
    timestamps, days, nowISO, timezone,
    intro: momentumIntroCopy(),
    summary: momentumSummaryCopy,
  });
}

// ── ROUTES ───────────────────────────────────────────────────
// Registered from index.js so the module-private helpers (getAuthToken,
// verifyToken, jsonResponse, generateUUID) stay in one scope.

/**
 * Register the coach roster API on an itty-router instance.
 * @param {object} router itty-router instance
 * @param {object} ctx  { getAuthToken, verifyToken, jsonResponse, generateUUID }
 */
export function registerCoachRoutes(router, ctx) {
  const { getAuthToken, verifyToken, jsonResponse, generateUUID } = ctx;

  async function requireUser(request, env) {
    const token = getAuthToken(request);
    if (!token) return { error: jsonResponse({ error: 'Unauthorized' }, 401) };
    const payload = await verifyToken(token, env.JWT_SECRET);
    if (!payload) return { error: jsonResponse({ error: 'Invalid token' }, 401) };
    return { userId: payload.sub };
  }

  async function loadStreakFor(env, userId) {
    const row = await env.DB.prepare(
      `SELECT current_streak, longest_streak, total_kept, last_kept_date
         FROM accountability_streaks WHERE user_id = ?`
    ).bind(userId).first();
    return row || { current_streak: 0, longest_streak: 0, total_kept: 0, last_kept_date: null };
  }

  // ── COACH: invite an existing user (by email) onto my roster ──
  // Creates a `pending` link only. The coach sees NOTHING about the person
  // until they accept — consent is the gate, not a formality.
  router.post('/api/coach/clients', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;

      let body;
      try { body = await request.json(); } catch { body = null; }
      const email = body && typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (!looksLikeEmail(email)) {
        return jsonResponse({ error: 'Enter the email of the person you support.' }, 400);
      }
      const label = normalizeClientLabel(body && body.label);

      const client = await env.DB.prepare(
        'SELECT id FROM users WHERE email = ? AND is_active = 1'
      ).bind(email).first();
      // Do not reveal whether the email maps to an account (enumeration guard);
      // the invitation simply stays unclaimable until that person signs up.
      if (!client) {
        return jsonResponse({ message: inviteSentCopy({ email }), status: 'pending' }, 202);
      }
      if (client.id === auth.userId) {
        return jsonResponse({ error: 'You’re already on your own side — invite someone you support.' }, 400);
      }

      // Idempotent: reuse an existing link unless it was removed/declined.
      const existing = await env.DB.prepare(
        'SELECT id, status FROM coach_clients WHERE coach_user_id = ? AND client_user_id = ?'
      ).bind(auth.userId, client.id).first();

      if (existing && (existing.status === 'pending' || existing.status === 'active')) {
        return jsonResponse({ message: inviteSentCopy({ email }), status: existing.status, link_id: existing.id }, 200);
      }

      if (existing) {
        await env.DB.prepare(
          `UPDATE coach_clients
              SET status = 'pending', client_label = ?, invited_at = datetime('now'),
                  responded_at = NULL, updated_at = datetime('now')
            WHERE id = ?`
        ).bind(label, existing.id).run();
        return jsonResponse({ message: inviteSentCopy({ email }), status: 'pending', link_id: existing.id }, 200);
      }

      const id = generateUUID();
      await env.DB.prepare(
        `INSERT INTO coach_clients
           (id, coach_user_id, client_user_id, client_label, status, invited_at)
         VALUES (?, ?, ?, ?, 'pending', datetime('now'))`
      ).bind(id, auth.userId, client.id, label).run();

      return jsonResponse({ message: inviteSentCopy({ email }), status: 'pending', link_id: id }, 201);
    } catch (err) {
      console.error('[coach] invite error:', err && err.message);
      return jsonResponse({ error: 'Could not send that invitation. Try again in a moment.' }, 500);
    }
  });

  // ── COACH: my roster (pending + active) with kept-word momentum ──
  // Active clients carry a streak summary + active-commitment count. Pending
  // links carry nothing but their state — no data before consent.
  router.get('/api/coach/clients', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;

      const links = await env.DB.prepare(
        `SELECT cc.id AS link_id, cc.client_user_id, cc.client_label, cc.status,
                cc.invited_at, cc.responded_at, u.email AS client_email
           FROM coach_clients cc
           JOIN users u ON u.id = cc.client_user_id
          WHERE cc.coach_user_id = ? AND cc.status IN ('pending','active')
          ORDER BY (cc.status = 'active') DESC, cc.invited_at DESC
          LIMIT 200`
      ).bind(auth.userId).all();

      const roster = [];
      for (const link of (links && links.results) || []) {
        const entry = {
          link_id: link.link_id,
          client_id: link.client_user_id,
          label: link.client_label || '',
          email: link.client_email,
          status: link.status,
          invited_at: link.invited_at,
        };
        if (link.status === 'active') {
          const streak = await loadStreakFor(env, link.client_user_id);
          const active = await env.DB.prepare(
            `SELECT COUNT(*) AS n FROM commitments WHERE user_id = ? AND status = 'active'`
          ).bind(link.client_user_id).first();
          entry.streak = {
            current_streak: Number(streak.current_streak) || 0,
            longest_streak: Number(streak.longest_streak) || 0,
            total_kept: Number(streak.total_kept) || 0,
          };
          entry.active_commitments = Number(active && active.n) || 0;
          entry.status_line = clientStatusLine({ streak });
        } else {
          entry.status_line = invitePendingCopy();
        }
        roster.push(entry);
      }

      // At-a-glance next check-in per active client — the soonest concrete
      // moment the bro next shows up for them — so a coach sees it across the
      // whole roster, not only by opening "View rhythm" per client (R-224). ONE
      // grouped query over all active clients (no N+1 across the roster): the
      // JOIN pins each outstanding check-in to an ACTIVE commitment, so a stray
      // row on a released word never leaks in, and MIN() picks the soonest. The
      // bare `timezone` follows that MIN row (SQLite min/max bare-column rule),
      // so the moment is formatted in its OWN commitment's zone. Momentum-only
      // by construction: pending/sent/deferred is a future moment about to be
      // KEPT — never a miss.
      const activeIds = roster.filter((e) => e.status === 'active').map((e) => e.client_id);
      if (activeIds.length) {
        const placeholders = activeIds.map(() => '?').join(', ');
        const nextRows = await env.DB.prepare(
          `SELECT c.user_id AS client_id, MIN(cc.scheduled_for) AS next_for, c.timezone AS timezone
             FROM commitment_checkins cc
             JOIN commitments c ON c.id = cc.commitment_id
            WHERE c.user_id IN (${placeholders})
              AND c.status = 'active'
              AND cc.status IN ('pending', 'sent', 'deferred')
            GROUP BY c.user_id`
        ).bind(...activeIds).all();
        const nextByClient = {};
        for (const r of (nextRows && nextRows.results) || []) {
          nextByClient[r.client_id] = { iso: r.next_for, timezone: r.timezone || 'UTC' };
        }
        const nowISO = new Date().toISOString();
        for (const entry of roster) {
          if (entry.status !== 'active') continue;
          const n = nextByClient[entry.client_id];
          entry.next_checkin = (n && n.iso) || null;
          entry.next_checkin_line = rosterNextCheckinLine({
            iso: n && n.iso, timezone: n && n.timezone, nowISO,
          });
        }
      }

      return jsonResponse({
        intro: dashboardIntroCopy(),
        roster,
        empty_message: roster.length ? null : rosterEmptyCopy(),
      }, 200, 'nocache');
    } catch (err) {
      console.error('[coach] roster error:', err && err.message);
      return jsonResponse({ error: 'Could not load your roster.' }, 500);
    }
  });

  // ── COACH: read-only detail for one ACTIVE client ──
  // Active commitments + kept-word streak only. No miss list, ever.
  router.get('/api/coach/clients/:clientId', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;
      const clientId = request.params.clientId;

      const link = await env.DB.prepare(
        `SELECT client_label, status FROM coach_clients
          WHERE coach_user_id = ? AND client_user_id = ?`
      ).bind(auth.userId, clientId).first();
      if (!link || link.status !== 'active') {
        // Same 404 whether the link is missing or not yet accepted — no leak.
        return jsonResponse({ error: 'Not found' }, 404);
      }

      const streak = await loadStreakFor(env, clientId);
      const commitments = await env.DB.prepare(
        `SELECT id, title, start_at, checkin_at, status, recurrence, local_time, timezone
           FROM commitments
          WHERE user_id = ? AND status = 'active'
          ORDER BY start_at ASC
          LIMIT 100`
      ).bind(clientId).all();

      // The soonest OUTSTANDING check-in per active commitment — the concrete
      // next moment the bro will show up. One grouped query (not N per row).
      // Momentum-only by construction: an outstanding check-in is a future
      // moment about to be KEPT (pending/sent/deferred), never a miss.
      const nextRows = await env.DB.prepare(
        `SELECT commitment_id, MIN(scheduled_for) AS next_for
           FROM commitment_checkins
          WHERE user_id = ? AND status IN ('pending', 'sent', 'deferred')
          GROUP BY commitment_id`
      ).bind(clientId).all();
      const nextByCommitment = {};
      for (const r of (nextRows && nextRows.results) || []) {
        nextByCommitment[r.commitment_id] = r.next_for;
      }
      const nowISO = new Date().toISOString();

      // ── Kept-word momentum sparkline (per-day KEPT count over a recent window) ──
      // A representative timezone for day boundaries: the client's most recently
      // touched commitment zone, falling back to UTC. Fetch a slightly wider raw
      // window than the axis (tz offsets can shift an instant across midnight),
      // then bucketKeptByDay trims to the last N local days. DESIGN LAW: reads
      // status='kept' ONLY — a quiet day is a short bar, never a surfaced miss.
      const tzRow = await env.DB.prepare(
        `SELECT timezone FROM commitments
          WHERE user_id = ? AND timezone IS NOT NULL AND timezone <> ''
          ORDER BY updated_at DESC LIMIT 1`
      ).bind(clientId).first();
      const momentumTz = (tzRow && tzRow.timezone) || 'UTC';
      const windowCutoffISO = new Date(Date.parse(nowISO) - (MOMENTUM_WINDOW_DAYS + 2) * 86400000).toISOString();
      const keptRows = await env.DB.prepare(
        `SELECT responded_at FROM commitment_checkins
          WHERE user_id = ? AND status = 'kept' AND responded_at IS NOT NULL AND responded_at >= ?
          ORDER BY responded_at ASC
          LIMIT 1000`
      ).bind(clientId, windowCutoffISO).all();
      const keptTimestamps = ((keptRows && keptRows.results) || []).map((r) => r.responded_at);
      const momentum = buildMomentum({
        timestamps: keptTimestamps, days: MOMENTUM_WINDOW_DAYS, nowISO, timezone: momentumTz,
      });

      // Surface each commitment's self-set cadence (the rhythm) AND the concrete
      // next check-in, read-only. This is when they asked to be met and when the
      // bro shows up next — never a miss list.
      const activeCommitments = ((commitments && commitments.results) || []).map((c) => {
        const nextCheckin = nextByCommitment[c.id] || null;
        return {
          title: c.title,
          start_at: c.start_at,
          checkin_at: c.checkin_at,
          status: c.status,
          recurrence: c.recurrence || 'none',
          local_time: c.local_time || null,
          timezone: c.timezone || 'UTC',
          cadence: describeCadence({ recurrence: c.recurrence, localTime: c.local_time }),
          next_checkin: nextCheckin,
          next_checkin_label: nextCheckinCopy({ iso: nextCheckin, timezone: c.timezone || 'UTC', nowISO }),
        };
      });

      return jsonResponse({
        client_id: clientId,
        label: link.client_label || '',
        streak: {
          current_streak: Number(streak.current_streak) || 0,
          longest_streak: Number(streak.longest_streak) || 0,
          total_kept: Number(streak.total_kept) || 0,
        },
        status_line: clientStatusLine({ streak }),
        momentum,
        rhythm_intro: rhythmIntroCopy(),
        rhythm_empty: activeCommitments.length ? null : rhythmEmptyCopy(),
        active_commitments: activeCommitments,
      }, 200, 'nocache');
    } catch (err) {
      console.error('[coach] client detail error:', err && err.message);
      return jsonResponse({ error: 'Could not load that client.' }, 500);
    }
  });

  // ── COACH: remove a link from my roster (soft) ──
  router.delete('/api/coach/clients/:clientId', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;
      const clientId = request.params.clientId;
      await env.DB.prepare(
        `UPDATE coach_clients SET status = 'removed', updated_at = datetime('now')
          WHERE coach_user_id = ? AND client_user_id = ?`
      ).bind(auth.userId, clientId).run();
      return jsonResponse({ ok: true }, 200);
    } catch (err) {
      console.error('[coach] remove error:', err && err.message);
      return jsonResponse({ error: 'Could not update your roster.' }, 500);
    }
  });

  // ── CLIENT side: invitations awaiting my answer ──
  router.get('/api/coach/invitations', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;
      const rows = await env.DB.prepare(
        `SELECT cc.id AS link_id, cc.invited_at, u.email AS coach_email
           FROM coach_clients cc
           JOIN users u ON u.id = cc.coach_user_id
          WHERE cc.client_user_id = ? AND cc.status = 'pending'
          ORDER BY cc.invited_at DESC
          LIMIT 100`
      ).bind(auth.userId).all();
      return jsonResponse({ invitations: (rows && rows.results) || [] }, 200, 'nocache');
    } catch (err) {
      console.error('[coach] invitations error:', err && err.message);
      return jsonResponse({ error: 'Could not load your invitations.' }, 500);
    }
  });

  // ── CLIENT side: accept / decline an invitation (consent gate) ──
  router.post('/api/coach/invitations/:id/accept', async (request, env) => {
    return respondToInvite(request, env, 'active');
  });
  router.post('/api/coach/invitations/:id/decline', async (request, env) => {
    return respondToInvite(request, env, 'declined');
  });

  async function respondToInvite(request, env, nextStatus) {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;
      const id = request.params.id;
      // Only the invited client may answer, and only a pending invite.
      const link = await env.DB.prepare(
        `SELECT id FROM coach_clients
          WHERE id = ? AND client_user_id = ? AND status = 'pending'`
      ).bind(id, auth.userId).first();
      if (!link) return jsonResponse({ error: 'Not found' }, 404);
      await env.DB.prepare(
        `UPDATE coach_clients SET status = ?, responded_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ?`
      ).bind(nextStatus, id).run();
      return jsonResponse({ ok: true, status: nextStatus }, 200);
    } catch (err) {
      console.error('[coach] respond error:', err && err.message);
      return jsonResponse({ error: 'Could not update that invitation.' }, 500);
    }
  }
}
