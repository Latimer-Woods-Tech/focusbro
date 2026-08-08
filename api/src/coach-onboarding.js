// ════════════════════════════════════════════════════════════
// FOCUSBRO — COACH ONBOARDING  (Contender track, issue #10, Phase C · slice 1)
// ════════════════════════════════════════════════════════════
// The first real Phase-C slice: a coach signs up and becomes an OPERATOR on the
// shared `@latimer-woods-tech/operator` platform (identity + white-label +
// the operator→client hierarchy), then configures HOW the bro checks in with
// the people they support — cadence, voice persona, and the opening line.
//
// WHAT IS MOUNTED vs. WHAT IS OURS:
//   • Identity / white-label / hierarchy  → `@latimer-woods-tech/operator`
//     (via the thin `D1OperatorStore`). We do NOT hand-roll a parallel
//     hierarchy or billing — the Warden's UNBLOCK (issue #10, 2026-08-08) is
//     explicit about that.
//   • Cadence / voice persona / opening line → FocusBro-native config. This is
//     product behaviour, not billing/hierarchy, so it lives here.
// A single thin row (`coach_operators`) maps a FocusBro user to their operator
// id — the glue between our identity and the hub's, not a second hierarchy.
//
// THE DESIGN LAW REACHES THE COACH'S PEN. A coach authors the opening line the
// bro will say to their clients. That is exactly where a guilt engine could be
// smuggled in — "you missed again", "don't be lazy". So a coach-authored script
// is validated at the write boundary against the same never-shame / no-"AI" /
// no-clinical batteries the rest of the product lives under, and a shaming line
// is REJECTED, never stored. The law that governs what the bro says on its own
// governs what a coach can put in its mouth. Enforced by coach-onboarding.test.js.
// ════════════════════════════════════════════════════════════

import { OperatorIdentityService } from '@latimer-woods-tech/operator';
import { D1OperatorStore } from './operator-store.js';

/** Check-in cadences a coach can pick. Kept deliberately small and legible. */
export const COACH_CADENCES = ['daily', 'weekdays', 'weekly'];

/**
 * Voice personas — the tuned tone the issue calls out ("hype-bro vs calm-ally
 * per user"). Both are ride-or-die allies glad you showed up; they differ only
 * in energy, never in whether they're on your side.
 */
export const COACH_VOICE_PERSONAS = ['hype_bro', 'calm_ally'];

const MAX_SCRIPT = 400;
const MAX_DISPLAY_NAME = 120;

/**
 * Map a coach's configured voice persona (`COACH_VOICE_PERSONAS`) onto the copy
 * engine's persona vocabulary (`accountability.js` `PERSONAS`: 'hype' | 'ally').
 * Both coach voices are ride-or-die allies — this only carries the *energy*
 * across to the warm nudge the client actually hears, never the care. Anything
 * unrecognised falls back to the calm ally, the product's gentlest default.
 * @param {string} voicePersona
 * @returns {'hype'|'ally'}
 */
export function mapCoachPersona(voicePersona) {
  return voicePersona === 'hype_bro' ? 'hype' : 'ally';
}

// ── ANTI-SHAME BATTERIES ─────────────────────────────────────
// Mirrors the batteries the consumer-copy suites enforce (me.test.js /
// coach.test.js), applied here to COACH-AUTHORED text at the write boundary.
const SHAME_PATTERNS = [
  /\bfail(ed|ure|ing|s)?\b/i,
  /\blaz(y|iness)\b/i,
  /\bdisappoint/i,
  /\bguilt/i,
  /\bashamed\b/i,
  /\bshame\b/i,
  /\byou (didn.?t|should have|should.?ve)\b/i,
  /\bfall(ing|en)? behind\b/i,
  /\bbehind\b/i,
  /\bexcuse/i,
  /\bslack(ing|er|ed)? off\b/i,
  /\bpathetic\b/i,
  /\bworthless\b/i,
  /\bmiss(ed|es|ing)?\b/i,
];
const CLINICAL_PATTERNS = [/\btreat(s|ment|ing)?\b/i, /\bcure/i, /\bdiagnos/i, /\bdisorder/i, /\bsymptom/i, /\bADHD\b/i, /\bmedication\b/i];
const AI_WORD = /\bAI\b/; // case-sensitive: the banned branding, not "again"/"said"

/**
 * Validate a coach-authored opening line. Returns `{ ok: true, value }` for a
 * warm line, or `{ ok: false, reason }` (a warm, banned-word-free explanation)
 * for one that shames, brands "AI", or makes a clinical claim.
 * @param {unknown} text
 */
export function validateCheckinScript(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, reason: 'Add a short opening line the bro will lead with.' };
  }
  const t = text.trim();
  if (t.length > MAX_SCRIPT) {
    return { ok: false, reason: `Keep the opening line under ${MAX_SCRIPT} characters.` };
  }
  for (const p of SHAME_PATTERNS) {
    if (p.test(t)) {
      return { ok: false, reason: 'Let’s keep it on their side — rewrite this warm, with no blame in it.' };
    }
  }
  for (const p of CLINICAL_PATTERNS) {
    if (p.test(t)) {
      return { ok: false, reason: 'Keep the line everyday and warm — no clinical wording.' };
    }
  }
  if (AI_WORD.test(t)) {
    return { ok: false, reason: 'Skip that word — the bro is a person to them, warm and human.' };
  }
  return { ok: true, value: t };
}

/**
 * Turn a coach's display name into a valid operator slug (2–63 lowercase
 * alphanumeric segments joined by single hyphens), disambiguated per user so two
 * coaches with the same practice name never collide on the globally-unique slug.
 * @param {string} displayName
 * @param {string} userId
 */
export function deriveOperatorSlug(displayName, userId) {
  const base =
    String(displayName || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'coach';
  const suffix = String(userId || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 8) || 'x';
  return `${base}-${suffix}`.slice(0, 63);
}

// ── COPY SURFACE ─────────────────────────────────────────────
// Every static string the onboarding surface (and its validation feedback) can
// show a coach, kept in one place so the design-LAW test scans all of it and no
// shaming label can slip in unnoticed.
/** @returns {string[]} */
export function coachOnboardingCopySurface() {
  return [
    onboardingIntroCopy(),
    ...COACH_CADENCES.map(cadenceLabel),
    ...COACH_VOICE_PERSONAS.map(personaLabel),
    ...COACH_VOICE_PERSONAS.map(personaDescription),
    scriptFieldHelpCopy(),
    // Validation feedback lines (must themselves be warm + banned-word-free):
    validateCheckinScript('').reason,
    validateCheckinScript('x'.repeat(MAX_SCRIPT + 1)).reason,
    validateCheckinScript('you failed again').reason,
    validateCheckinScript('let us treat your disorder').reason,
    validateCheckinScript('the AI will call you').reason,
  ];
}

/** Header copy for the coach onboarding surface. */
export function onboardingIntroCopy() {
  return 'Set up how you show up for the people you support: your name on it, the rhythm of the check-ins, and the voice they’ll hear.';
}

/** Friendly label for a cadence value. */
export function cadenceLabel(cadence) {
  switch (cadence) {
    case 'daily': return 'Every day';
    case 'weekdays': return 'Weekdays';
    case 'weekly': return 'Once a week';
    default: return 'Every day';
  }
}

/** Friendly label for a voice persona value. */
export function personaLabel(persona) {
  switch (persona) {
    case 'hype_bro': return 'Hype ally';
    case 'calm_ally': return 'Calm ally';
    default: return 'Calm ally';
  }
}

/** One-line description of a voice persona — both are on the person's side. */
export function personaDescription(persona) {
  switch (persona) {
    case 'hype_bro': return 'High-energy and pumped for you — a friend cheering you into the thing.';
    case 'calm_ally': return 'Steady and easy — a friend sitting with you as you start.';
    default: return 'Steady and easy — a friend sitting with you as you start.';
  }
}

/** Help text under the opening-line field. */
export function scriptFieldHelpCopy() {
  return 'The first thing they hear. Keep it warm — you showed up, let’s go. On a rough day it’s still glad to see them.';
}

/**
 * Register the Phase-C coach-onboarding routes. Mounts `OperatorIdentityService`
 * on the D1-backed operator store; the FocusBro-native check-in config lives in
 * `coach_checkin_config`.
 *
 * @param {import('itty-router').Router} router
 * @param {{ getAuthToken: Function, verifyToken: Function, jsonResponse: Function }} ctx
 */
export function registerCoachOnboardingRoutes(router, ctx) {
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

  /** Load the FocusBro-native check-in config for an operator, or defaults. */
  async function loadConfig(env, operatorId) {
    const row = await env.DB.prepare(
      'SELECT cadence, voice_persona, script FROM coach_checkin_config WHERE operator_id = ?',
    ).bind(operatorId).first();
    if (!row) return { cadence: null, voice_persona: null, script: null };
    return { cadence: row.cadence, voice_persona: row.voice_persona, script: row.script };
  }

  /** Shape a validation/known error into a 400; anything else bubbles to 500. */
  function errStatus(err) {
    return err && (err.name === 'ValidationError' || err.name === 'NotFoundError') ? 400 : 500;
  }

  // ── POST /api/coach/onboarding — become an operator (idempotent) ──
  router.post('/api/coach/onboarding', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;

      let body;
      try { body = await request.json(); } catch { body = null; }
      const displayName = body && typeof body.displayName === 'string' ? body.displayName.trim() : '';
      if (!displayName) {
        return jsonResponse({ error: 'What should we call your coaching practice?' }, 400);
      }
      if (displayName.length > MAX_DISPLAY_NAME) {
        return jsonResponse({ error: `Keep the name under ${MAX_DISPLAY_NAME} characters.` }, 400);
      }

      const svc = service(env);

      // Idempotent: a coach who is already onboarded gets their operator back,
      // never a second one.
      const existingId = await operatorIdForUser(env, auth.userId);
      if (existingId) {
        const op = await svc.getOperator(existingId);
        if (op) {
          return jsonResponse(
            { onboarded: true, operator_id: op.id, slug: op.slug, display_name: op.displayName, white_label: op.whiteLabel, status: op.status },
            200,
          );
        }
        // Dangling map row (operator gone) — fall through and re-create.
      }

      const slug = deriveOperatorSlug(displayName, auth.userId);
      const operator = await svc.createOperator({ slug, displayName });

      await env.DB.prepare(
        `INSERT INTO coach_operators (user_id, operator_id, created_at)
           VALUES (?, ?, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET operator_id = excluded.operator_id`,
      ).bind(auth.userId, operator.id).run();

      // Optional white-label in the same step.
      let whiteLabel = null;
      const brandName = body && typeof body.brandName === 'string' ? body.brandName.trim() : '';
      if (brandName) {
        const config = { brandName };
        if (body.primaryColor) config.primaryColor = body.primaryColor;
        if (body.secondaryColor) config.secondaryColor = body.secondaryColor;
        if (body.supportEmail) config.supportEmail = body.supportEmail;
        const updated = await svc.updateWhiteLabel(operator.id, config);
        whiteLabel = updated.whiteLabel;
      }

      return jsonResponse(
        { onboarded: true, operator_id: operator.id, slug: operator.slug, display_name: operator.displayName, white_label: whiteLabel, status: operator.status },
        201,
      );
    } catch (err) {
      const status = errStatus(err);
      return jsonResponse({ error: status === 400 ? err.message : 'Could not set up your coaching space.' }, status);
    }
  });

  // ── GET /api/coach/onboarding — read my operator + config ──
  router.get('/api/coach/onboarding', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;

      const operatorId = await operatorIdForUser(env, auth.userId);
      if (!operatorId) return jsonResponse({ onboarded: false }, 200);

      const svc = service(env);
      const op = await svc.getOperator(operatorId);
      if (!op) return jsonResponse({ onboarded: false }, 200);

      const config = await loadConfig(env, operatorId);
      return jsonResponse({
        onboarded: true,
        operator_id: op.id,
        slug: op.slug,
        display_name: op.displayName,
        white_label: op.whiteLabel,
        status: op.status,
        cadence: config.cadence,
        voice_persona: config.voice_persona,
        script: config.script,
      }, 200);
    } catch {
      return jsonResponse({ error: 'Could not load your coaching space.' }, 500);
    }
  });

  // ── PUT /api/coach/white-label — set brand config ──
  router.put('/api/coach/white-label', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;

      const operatorId = await operatorIdForUser(env, auth.userId);
      if (!operatorId) return jsonResponse({ error: 'Set up your coaching space first.' }, 400);

      let body;
      try { body = await request.json(); } catch { body = null; }
      const brandName = body && typeof body.brandName === 'string' ? body.brandName.trim() : '';
      if (!brandName) return jsonResponse({ error: 'Add the name that goes on it.' }, 400);
      const config = { brandName };
      if (body.primaryColor) config.primaryColor = body.primaryColor;
      if (body.secondaryColor) config.secondaryColor = body.secondaryColor;
      if (body.supportEmail) config.supportEmail = body.supportEmail;

      const svc = service(env);
      const updated = await svc.updateWhiteLabel(operatorId, config);
      return jsonResponse({ white_label: updated.whiteLabel }, 200);
    } catch (err) {
      const status = errStatus(err);
      return jsonResponse({ error: status === 400 ? err.message : 'Could not save your brand.' }, status);
    }
  });

  // ── PUT /api/coach/checkin-config — cadence / voice / opening line ──
  router.put('/api/coach/checkin-config', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;

      const operatorId = await operatorIdForUser(env, auth.userId);
      if (!operatorId) return jsonResponse({ error: 'Set up your coaching space first.' }, 400);

      let body;
      try { body = await request.json(); } catch { body = null; }
      const cadence = body && typeof body.cadence === 'string' ? body.cadence : '';
      const voicePersona = body && typeof body.voicePersona === 'string' ? body.voicePersona : '';
      if (!COACH_CADENCES.includes(cadence)) {
        return jsonResponse({ error: 'Pick a check-in rhythm: every day, weekdays, or once a week.' }, 400);
      }
      if (!COACH_VOICE_PERSONAS.includes(voicePersona)) {
        return jsonResponse({ error: 'Pick a voice: hype ally or calm ally.' }, 400);
      }
      // THE DESIGN LAW at the write boundary: a shaming opening line is rejected.
      const script = validateCheckinScript(body && body.script);
      if (!script.ok) return jsonResponse({ error: script.reason }, 400);

      await env.DB.prepare(
        `INSERT INTO coach_checkin_config (operator_id, cadence, voice_persona, script, updated_at)
           VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(operator_id) DO UPDATE
           SET cadence = excluded.cadence,
               voice_persona = excluded.voice_persona,
               script = excluded.script,
               updated_at = datetime('now')`,
      ).bind(operatorId, cadence, voicePersona, script.value).run();

      return jsonResponse({ cadence, voice_persona: voicePersona, script: script.value }, 200);
    } catch {
      return jsonResponse({ error: 'Could not save your check-in setup.' }, 500);
    }
  });
}
