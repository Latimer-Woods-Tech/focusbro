// ════════════════════════════════════════════════════════════
// FOCUSBRO — ACCOUNTABILITY CORE  (Contender track, issue #10, Phase A)
// ════════════════════════════════════════════════════════════
// "The bro who calls to make sure you did the thing."
//
// You give your word (a commitment). At the moment you said, FocusBro checks
// in. You tell it how it went. Keeping your word builds a streak; a miss is
// met with "no problem — when do you want to try again?" and never a scold.
//
// Mechanic transplanted from wordis-bond: a parent definition (test_suites →
// commitments) + scheduled resolution rows with a resolved outcome
// (test_runs → commitment_checkins) + streak tracking on top. Engine-
// independent: the check-in channel is push/text now; the voice call
// (Phase B) rides the shared @latimer-woods-tech/voice-agent engine later.
//
// THE DESIGN LAW (non-negotiable): never shame. Every string this module can
// emit is an ally glad you showed up — never a boss tallying misses. Any copy
// that counts failures back to the user is a defect. Enforced by
// accountability.test.js (banned-word + no-"AI" + no-clinical-claim assertions).
// ════════════════════════════════════════════════════════════

/** Check-in delivery channels available in Phase A. Voice is Phase B (engine-gated). */
export const CHANNELS = ['push', 'text'];

/** Configurable companion persona. Both are warm; neither ever shames. */
export const PERSONAS = ['ally', 'hype'];

/** Resolution outcomes for a check-in. */
export const OUTCOMES = ['kept', 'missed', 'reschedule'];

const MAX_TITLE = 200;
const MAX_DETAILS = 2000;
const DEFAULT_CHECKIN_OFFSET_MS = 60 * 60 * 1000; // check back ~1h after start by default

/** Normalize a persona value to a known persona, defaulting to the calm ally. */
export function pickPersona(p) {
  return PERSONAS.includes(p) ? p : 'ally';
}

/**
 * Validate + normalize the body of a create-commitment request.
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function validateCommitmentInput(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'A commitment needs at least a title and a start time.' };
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return { ok: false, error: 'What are you going to do? Give it a title.' };
  if (title.length > MAX_TITLE) return { ok: false, error: `Keep the title under ${MAX_TITLE} characters.` };

  const details = typeof body.details === 'string' ? body.details.trim().slice(0, MAX_DETAILS) : '';

  const startAt = parseWhen(body.start_at);
  if (!startAt) return { ok: false, error: 'When do you want to start? Give a valid start time.' };

  let checkinAt = parseWhen(body.checkin_at);
  if (!checkinAt) {
    checkinAt = new Date(new Date(startAt).getTime() + DEFAULT_CHECKIN_OFFSET_MS).toISOString();
  }

  const channel = typeof body.channel === 'string' ? body.channel.toLowerCase() : 'push';
  if (channel === 'voice') {
    return { ok: false, error: 'Voice check-ins are coming soon — for now pick push or text and I’ll still show up.' };
  }
  if (!CHANNELS.includes(channel)) {
    return { ok: false, error: `Check-in channel must be one of: ${CHANNELS.join(', ')}.` };
  }

  const persona = pickPersona(body.persona);
  const timezone = typeof body.timezone === 'string' && body.timezone.trim() ? body.timezone.trim() : 'UTC';

  return { ok: true, value: { title, details, startAt, checkinAt, channel, persona, timezone } };
}

/** Parse a when-value into an ISO string, or null if unusable. */
function parseWhen(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Pure kept-word-streak transition.
 *
 * - kept       → +1 to the current streak, +1 total kept, longest tracked.
 * - reschedule → streak PROTECTED (unchanged): rescheduling is the no-shame
 *                path, so it never breaks the chain.
 * - missed     → current streak silently resets to 0. We keep NO miss tally —
 *                counting failures is a defect under the design LAW.
 *
 * @param {object} prev  { current_streak, longest_streak, total_kept, last_kept_date }
 * @param {'kept'|'missed'|'reschedule'} outcome
 * @param {string} [today] ISO date (YYYY-MM-DD) the kept happened on
 */
export function computeStreakAfter(prev, outcome, today) {
  const s = {
    current_streak: Number(prev?.current_streak) || 0,
    longest_streak: Number(prev?.longest_streak) || 0,
    total_kept: Number(prev?.total_kept) || 0,
    last_kept_date: prev?.last_kept_date || null,
  };

  if (outcome === 'kept') {
    s.current_streak += 1;
    s.total_kept += 1;
    if (s.current_streak > s.longest_streak) s.longest_streak = s.current_streak;
    if (today) s.last_kept_date = today;
  } else if (outcome === 'missed') {
    s.current_streak = 0; // no-shame reset; no miss counter, ever
  }
  // 'reschedule' → protected, no change
  return s;
}

// ── COPY ENGINE ──────────────────────────────────────────────
// Every string below is an ally. Warm, gender-neutral, no shame, no "AI",
// no clinical claim. Persona shifts the energy (calm vs. hype), never the care.

/** The nudge sent at check-in time: "you said, I'm here, let's go." */
export function checkinPromptCopy({ title, persona } = {}) {
  const what = (title || 'the thing').toString();
  if (pickPersona(persona) === 'hype') {
    return `Yo — you called it: ${what}. Let’s get it. I’m right here with you. 🔥`;
  }
  return `You said you’d ${startsWithVerbish(what) ? '' : 'do '}${what}. I’m here — ready to go? We’ve got this.`;
}

/** After a kept word: celebrate the person, name the streak, mean it. */
export function keptCopy({ persona, streak } = {}) {
  const n = Number(streak) || 0;
  const run = n > 1 ? ` That’s ${n} in a row — your word’s good.` : ' Your word’s good with me.';
  if (pickPersona(persona) === 'hype') {
    return `LET’S GO — you did the thing!${n > 1 ? ` ${n} in a row, that’s all you.` : ''} 💪`;
  }
  return `You did the thing. Proud of you.${run}`;
}

/** After a miss: NEVER a scold. Meet them with warmth and an open door. */
export function missRescheduleCopy({ persona } = {}) {
  if (pickPersona(persona) === 'hype') {
    return 'All good — no stress at all. Life happens. We just pick a new time. When works for you?';
  }
  return 'No problem at all — life happens, and I’m still on your side. When do you want to try again?';
}

/** Confirming a reschedule: the word still counts; the chain is intact. */
export function rescheduleConfirmCopy({ persona, when } = {}) {
  const at = when ? ` for ${formatWhen(when)}` : '';
  if (pickPersona(persona) === 'hype') {
    return `Locked in${at}. I got you — nothing broken, we just go again. 💪`;
  }
  return `Got it — I’ll check back${at}. Your word’s still good with me; we just pick it back up.`;
}

/** A streak summary. On zero, it's a fresh start — never "you failed." */
export function streakSummaryCopy({ streak, persona } = {}) {
  const cur = Number(streak?.current_streak) || 0;
  const best = Number(streak?.longest_streak) || 0;
  if (cur === 0) {
    if (pickPersona(persona) === 'hype') {
      return 'Fresh start, clean slate. Next one’s yours — I’m ready when you are. 🔥';
    }
    return 'Fresh start whenever you’re ready. I’m here for the next one — no pressure, no catching up.';
  }
  const bestPart = best > cur ? ` (your best is ${best})` : '';
  return `You’ve kept your word ${cur} time${cur === 1 ? '' : 's'} in a row${bestPart}. Every single one counts.`;
}

/** Rough heuristic: does the title already read as an action phrase? */
function startsWithVerbish(t) {
  return /^(start|finish|do|call|email|write|clean|go|read|study|work|pay|file|send|make|book|review)\b/i.test(t.trim());
}

/** Human-ish rendering of an ISO time for copy (kept simple; no locale deps). */
function formatWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

// ── ROUTES ───────────────────────────────────────────────────
// Registered from index.js. `ctx` supplies the module-private helpers that
// live in index.js so this module stays import-free of the router internals.

/**
 * Register the accountability API on an itty-router instance.
 * @param {object} router  itty-router instance
 * @param {object} ctx  { getAuthToken, verifyToken, jsonResponse, generateUUID }
 */
export function registerAccountabilityRoutes(router, ctx) {
  const { getAuthToken, verifyToken, jsonResponse, generateUUID } = ctx;

  async function requireUser(request, env) {
    const token = getAuthToken(request);
    if (!token) return { error: jsonResponse({ error: 'Unauthorized' }, 401) };
    const payload = await verifyToken(token, env.JWT_SECRET);
    if (!payload) return { error: jsonResponse({ error: 'Invalid token' }, 401) };
    return { userId: payload.sub };
  }

  async function loadStreak(env, userId) {
    const row = await env.DB.prepare(
      `SELECT current_streak, longest_streak, total_kept, last_kept_date
         FROM accountability_streaks WHERE user_id = ?`
    ).bind(userId).first();
    return row || { current_streak: 0, longest_streak: 0, total_kept: 0, last_kept_date: null };
  }

  async function saveStreak(env, userId, s) {
    await env.DB.prepare(
      `INSERT INTO accountability_streaks
         (user_id, current_streak, longest_streak, total_kept, last_kept_date, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         current_streak = excluded.current_streak,
         longest_streak = excluded.longest_streak,
         total_kept     = excluded.total_kept,
         last_kept_date = excluded.last_kept_date,
         updated_at     = datetime('now')`
    ).bind(userId, s.current_streak, s.longest_streak, s.total_kept, s.last_kept_date).run();
  }

  // ── CREATE a commitment (give your word) ──
  router.post('/api/commitments', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;

      let body;
      try { body = await request.json(); } catch { body = null; }

      const parsed = validateCommitmentInput(body);
      if (!parsed.ok) return jsonResponse({ error: parsed.error }, 400);
      const v = parsed.value;

      const id = generateUUID();
      await env.DB.prepare(
        `INSERT INTO commitments
           (id, user_id, title, details, start_at, checkin_at, channel, persona, timezone, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
      ).bind(id, auth.userId, v.title, v.details, v.startAt, v.checkinAt, v.channel, v.persona, v.timezone).run();

      // Schedule the check-in row (pending delivery; the delivery cron is a later slice).
      const checkinId = generateUUID();
      await env.DB.prepare(
        `INSERT INTO commitment_checkins
           (id, commitment_id, user_id, scheduled_for, channel, status)
         VALUES (?, ?, ?, ?, ?, 'pending')`
      ).bind(checkinId, id, auth.userId, v.checkinAt, v.channel).run();

      return jsonResponse({
        commitment: {
          id, title: v.title, details: v.details, start_at: v.startAt, checkin_at: v.checkinAt,
          channel: v.channel, persona: v.persona, timezone: v.timezone, status: 'active',
        },
        checkin_id: checkinId,
        message: checkinPromptCopy({ title: v.title, persona: v.persona }),
      }, 201);
    } catch (err) {
      console.error('[accountability] create error:', err && err.message);
      return jsonResponse({ error: 'Could not save that commitment. Try again in a moment.' }, 500);
    }
  });

  // ── LIST my commitments (active first, newest first) ──
  router.get('/api/commitments', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;

      const rows = await env.DB.prepare(
        `SELECT id, title, details, start_at, checkin_at, channel, persona, timezone, status, created_at
           FROM commitments WHERE user_id = ?
          ORDER BY (status = 'active') DESC, start_at DESC
          LIMIT 200`
      ).bind(auth.userId).all();

      return jsonResponse({ commitments: (rows && rows.results) || [] }, 200, 'short');
    } catch (err) {
      console.error('[accountability] list error:', err && err.message);
      return jsonResponse({ error: 'Could not load your commitments.' }, 500);
    }
  });

  // ── GET one commitment + its check-ins ──
  router.get('/api/commitments/:id', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;
      const id = request.params.id;

      const commitment = await env.DB.prepare(
        `SELECT id, title, details, start_at, checkin_at, channel, persona, timezone, status, created_at
           FROM commitments WHERE id = ? AND user_id = ?`
      ).bind(id, auth.userId).first();
      if (!commitment) return jsonResponse({ error: 'Not found' }, 404);

      const checkins = await env.DB.prepare(
        `SELECT id, scheduled_for, channel, status, responded_at, note
           FROM commitment_checkins WHERE commitment_id = ? AND user_id = ?
          ORDER BY scheduled_for ASC`
      ).bind(id, auth.userId).all();

      return jsonResponse({ commitment, checkins: (checkins && checkins.results) || [] }, 200, 'short');
    } catch (err) {
      console.error('[accountability] get error:', err && err.message);
      return jsonResponse({ error: 'Could not load that commitment.' }, 500);
    }
  });

  // ── RESOLVE a check-in (kept / missed / reschedule) ──
  router.post('/api/commitments/:id/checkin', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;
      const id = request.params.id;

      let body;
      try { body = await request.json(); } catch { body = {}; }
      const outcome = typeof body.outcome === 'string' ? body.outcome.toLowerCase() : '';
      if (!OUTCOMES.includes(outcome)) {
        return jsonResponse({ error: `outcome must be one of: ${OUTCOMES.join(', ')}` }, 400);
      }
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, MAX_DETAILS) : '';

      const commitment = await env.DB.prepare(
        `SELECT id, title, persona, channel, status FROM commitments WHERE id = ? AND user_id = ?`
      ).bind(id, auth.userId).first();
      if (!commitment) return jsonResponse({ error: 'Not found' }, 404);

      const persona = pickPersona(commitment.persona);
      const newCommitmentStatus = outcome === 'kept' ? 'kept'
        : outcome === 'missed' ? 'missed' : 'rescheduled';

      // Record the resolution on the pending check-in (or the latest one).
      await env.DB.prepare(
        `UPDATE commitment_checkins
            SET status = ?, responded_at = datetime('now'), note = ?
          WHERE user_id = ? AND commitment_id = ?
            AND id = (
              SELECT id FROM commitment_checkins
               WHERE commitment_id = ? AND user_id = ?
               ORDER BY (status = 'pending') DESC, scheduled_for DESC LIMIT 1
            )`
      ).bind(outcome, note, auth.userId, id, id, auth.userId).run();

      await env.DB.prepare(
        `UPDATE commitments SET status = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`
      ).bind(newCommitmentStatus, id, auth.userId).run();

      // Streak transition.
      const prev = await loadStreak(env, auth.userId);
      const today = new Date().toISOString().slice(0, 10);
      const next = computeStreakAfter(prev, outcome, today);
      await saveStreak(env, auth.userId, next);

      const response = { streak: next };

      if (outcome === 'kept') {
        response.message = keptCopy({ persona, streak: next.current_streak });
      } else if (outcome === 'missed') {
        // A miss still offers the open door — never a dead end.
        response.message = missRescheduleCopy({ persona });
        response.offer_reschedule = true;
      } else {
        // reschedule: create the follow-up commitment so the word carries forward.
        const parsed = validateCommitmentInput({
          title: commitment.title,
          start_at: body.new_start_at,
          checkin_at: body.new_checkin_at,
          channel: commitment.channel,
          persona,
        });
        if (!parsed.ok) return jsonResponse({ error: parsed.error }, 400);
        const v = parsed.value;
        const newId = generateUUID();
        await env.DB.prepare(
          `INSERT INTO commitments
             (id, user_id, title, details, start_at, checkin_at, channel, persona, timezone, status, rescheduled_from)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`
        ).bind(newId, auth.userId, v.title, '', v.startAt, v.checkinAt, v.channel, v.persona, v.timezone, id).run();

        const newCheckinId = generateUUID();
        await env.DB.prepare(
          `INSERT INTO commitment_checkins (id, commitment_id, user_id, scheduled_for, channel, status)
           VALUES (?, ?, ?, ?, ?, 'pending')`
        ).bind(newCheckinId, newId, auth.userId, v.checkinAt, v.channel).run();

        response.message = rescheduleConfirmCopy({ persona, when: v.startAt });
        response.new_commitment = {
          id: newId, title: v.title, start_at: v.startAt, checkin_at: v.checkinAt,
          channel: v.channel, persona: v.persona, status: 'active',
        };
      }

      return jsonResponse(response, 200);
    } catch (err) {
      console.error('[accountability] checkin error:', err && err.message);
      return jsonResponse({ error: 'Could not record that check-in. Your word still counts — try again.' }, 500);
    }
  });

  // ── GET my kept-word streak ──
  router.get('/api/accountability/streak', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;
      const streak = await loadStreak(env, auth.userId);
      return jsonResponse({
        streak,
        message: streakSummaryCopy({ streak }),
      }, 200, 'short');
    } catch (err) {
      console.error('[accountability] streak error:', err && err.message);
      return jsonResponse({ error: 'Could not load your streak.' }, 500);
    }
  });
}
