// ════════════════════════════════════════════════════════════
// FOCUS SPRINTS — lightweight body doubling (the loudest ADHD demand)
// ════════════════════════════════════════════════════════════
// Body doubling = doing a task in the quiet presence of others. Focusmate does
// this with heavy 1:1 video matching; we do the ambient version: while your
// timer runs you send a heartbeat, and we tell you how many people are focusing
// alongside you right now.
//
// THE COLD-START LAW (why this is heartbeat presence, not a live "N online"
// counter): at low concurrency a bare presence counter is an EMPTY room that
// reads "you're focusing alone" — the exact opposite of the comfort body
// doubling gives, and a shame-law violation. So (a) a quiet room is framed
// warmly, never as absence, and (b) we nudge convergence with a shared sprint
// that starts at the top of each hour, so people naturally focus together.
//
// Anonymous by construction: the client sends a random, rotating client id from
// localStorage — no account, no PII. Presence is a count, never a roster.
//
// Pure + Worker-safe. The API computes the display strings (so the anti-shame
// copy lives here, inside the design-LAW scan) and the client only renders them.
// ════════════════════════════════════════════════════════════

/** How long a heartbeat keeps you "present" before you fade from the count. */
export const PRESENCE_WINDOW_SEC = 120;
/** Rows older than this are pruned opportunistically on write. */
const PRUNE_AFTER_SEC = 600;
/** Longest client id we'll store (anon uuid-ish); anything longer is rejected. */
const MAX_CLIENT_ID = 64;

/**
 * The presence line shown by the timer while you focus. `count` is the total
 * number focusing (including you), so the others = count - 1. A quiet room is
 * framed as warmth, never as being alone — the cold-start law.
 * @param {number} count
 * @returns {string}
 */
export function presenceLine(count) {
  const others = Math.max(0, Math.floor(count) - 1);
  if (others <= 0) {
    return 'A quiet room right now — and that’s just fine. You’ve got this, and others focus here all through the day.';
  }
  if (others === 1) {
    return 'You and one other person are focusing right now — good company.';
  }
  return `You and ${others} others are focusing right now — good company.`;
}

/**
 * The convergence nudge: minutes until the next top-of-the-hour group sprint.
 * Minutes-past-the-hour are the same across almost every timezone, so this is
 * computed from UTC minutes without needing the viewer's zone.
 * @param {string} [nowISO]
 * @returns {string}
 */
export function nextSprintLine(nowISO) {
  const d = nowISO ? new Date(nowISO) : new Date();
  const min = Number.isNaN(d.getTime()) ? 0 : d.getUTCMinutes();
  const mins = min === 0 ? 60 : 60 - min;
  if (mins === 1) return 'The next group focus sprint starts in about a minute — jump in and start together.';
  return `The next group focus sprint starts in about ${mins} minutes — jump in and start together.`;
}

/**
 * Every user-facing string this module can emit — the design-LAW scan surface.
 * @returns {string[]}
 */
export function roomCopySurface() {
  return [
    presenceLine(0),
    presenceLine(1),
    presenceLine(2),
    presenceLine(5),
    nextSprintLine('2026-07-14T10:48:00.000Z'),
    nextSprintLine('2026-07-14T10:59:00.000Z'),
    nextSprintLine('2026-07-14T10:00:00.000Z'),
  ];
}

/** Count everyone whose last heartbeat is inside the presence window. */
async function currentFocusing(env, nowISO) {
  const cutoff = new Date(new Date(nowISO).getTime() - PRESENCE_WINDOW_SEC * 1000).toISOString();
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM focus_presence WHERE last_seen > ?`
  ).bind(cutoff).first();
  return (row && Number(row.c)) || 0;
}

/**
 * Register the focus-sprint presence API. Anonymous (no auth): a signed-out
 * timer user is still real company. Two routes:
 *   POST /api/room/heartbeat { client_id } → refresh presence, return the count
 *   GET  /api/room/count                   → just the count (for a light poll)
 * Both return { focusing, line, next_sprint_line } so the client only renders.
 * @param {object} router itty-router instance
 * @param {object} ctx { jsonResponse }
 */
export function registerRoomRoutes(router, ctx) {
  const { jsonResponse } = ctx;

  router.post('/api/room/heartbeat', async (request, env) => {
    try {
      let body;
      try { body = await request.json(); } catch { body = null; }
      const id = body && typeof body.client_id === 'string' ? body.client_id.trim() : '';
      if (!id || id.length > MAX_CLIENT_ID) {
        return jsonResponse({ error: 'A valid client_id is required.' }, 400);
      }
      const now = new Date().toISOString();
      // Prune stale rows opportunistically so the table stays tiny without a cron.
      const pruneCutoff = new Date(Date.now() - PRUNE_AFTER_SEC * 1000).toISOString();
      try { await env.DB.prepare(`DELETE FROM focus_presence WHERE last_seen < ?`).bind(pruneCutoff).run(); } catch (e) { /* best-effort */ }
      await env.DB.prepare(
        `INSERT INTO focus_presence (client_id, last_seen) VALUES (?, ?)
         ON CONFLICT(client_id) DO UPDATE SET last_seen = excluded.last_seen`
      ).bind(id, now).run();
      const focusing = await currentFocusing(env, now);
      return jsonResponse({ ok: true, focusing, line: presenceLine(focusing), next_sprint_line: nextSprintLine(now) }, 200, 'nocache');
    } catch (err) {
      console.error('[room] heartbeat error:', err && err.message);
      return jsonResponse({ error: 'Could not update the room just now.' }, 500);
    }
  });

  router.get('/api/room/count', async (request, env) => {
    try {
      const now = new Date().toISOString();
      const focusing = await currentFocusing(env, now);
      return jsonResponse({ focusing, line: presenceLine(focusing), next_sprint_line: nextSprintLine(now) }, 200, 'nocache');
    } catch (err) {
      console.error('[room] count error:', err && err.message);
      return jsonResponse({ error: 'Could not read the room just now.' }, 500);
    }
  });
}
