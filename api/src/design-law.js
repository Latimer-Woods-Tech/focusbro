/**
 * THE DESIGN LAW — one enforceable lexicon for every user-facing string.
 *
 * FocusBro's non-negotiable product law (issue #10): the voice is a ride-or-die
 * ally glad you showed up — never a boss tallying misses. Any copy that shames,
 * counts failures, brands itself "AI", or makes a clinical/treatment claim is a
 * DEFECT, not a style choice.
 *
 * Historically each copy surface (`meCopySurface`, `roomCopySurface`,
 * `consentCopySurface`, `coachOnboardingCopySurface`,
 * `coachOperatorRosterCopySurface`) was guarded by its OWN hand-rolled banned-word
 * list inside its own test file. Those lists drifted apart: the two coach surfaces
 * checked for shame words but never for banned "AI" branding or clinical claims,
 * while `me`/`room`/`consent` did. The law was therefore only as strong as the
 * weakest local list on any given surface. This module is the single source of
 * truth so every surface is held to the same bar and a future edit that leaks an
 * "AI" or a treatment claim onto a coach surface is caught the same as on a
 * consumer surface.
 *
 * Nuance encoded here:
 *  - Shame, treatment claims, and "AI" branding are banned EVERYWHERE — consumer
 *    copy and coach-facing copy alike.
 *  - The bare word "ADHD" is banned in CONSUMER copy but allowed in the coach
 *    pitch and in SEO (guardrail: "ADHD lives in SEO and the coach pitch, not in
 *    a clinical promise"). Callers on a coach-pitch surface pass `allowAdhd: true`.
 */

/**
 * Shame / self-blame patterns. Anything that reads as "you failed" belongs here.
 * The word-boundary anchors keep innocuous words safe: `\bmiss(ed|es|ing)?\b` does
 * not match "mission"/"permission"/"dismiss"; `\bbehind\b` does not match "behind
 * the scenes" only as the literal word (curated copy simply never uses it).
 * Seeded from the strictest consumer sweep (`me.js` tests), then extended with the
 * two shame words that were only ever guarded per-surface and had drifted: the
 * "who's slipping" framing (`report`/`coach`) and the incredulous "again?!"
 * (`accountability`/`two-way-checkins`, whose local regex was dead — see below).
 * Now every surface derives its shame guard from this one list.
 */
export const SHAME_PATTERNS = Object.freeze([
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
  /\bunrespons/i, // a quiet client is never framed as "unresponsive"
  /\bslipping\b/i, // no "who's slipping" framing — a quiet client is an open page, not a miss
  // The incredulous "late again?!" is shame; the warm reschedule "want to try
  // again?" (single `?`) is NOT. Anchoring the `?!` pair keeps that warm line
  // clean while catching the eye-roll. (The old per-surface `/\bagain\?!\b/i`
  // never matched — a `\b` after `!` can never be a boundary — so this was
  // silently unguarded until it was promoted here.)
  /\bagain\?!/i,
  /\bmiss(ed|es|ing)?\b/i, // no miss tally in what the person reads
]);

/**
 * Clinical / treatment-claim patterns — banned on EVERY surface, coach copy
 * included, because a treatment claim carries regulatory teeth regardless of who
 * reads it. Deliberately excludes bare "patient" and bare "treat yourself"-style
 * usage is avoided by keeping `treat` anchored to clinical framing via the curated
 * copy discipline; `patient` is intentionally NOT banned so warm copy can still
 * say "be patient with yourself". "ADHD" is handled separately (see ADHD_WORD).
 */
export const TREATMENT_CLAIM_PATTERNS = Object.freeze([
  /\btreat(s|ment|ing)?\b/i,
  /\bcure/i,
  /\bdiagnos/i,
  /\bdisorder/i,
  /\bsymptom/i,
  /\bmedication\b/i,
  /\btherapy\b/i,
]);

/**
 * The banned "AI" branding. Case-sensitive on purpose so ordinary words that
 * contain the letters — "again", "said", "email", "detail" — never trip it; only
 * the standalone capitalized token "AI" is a violation.
 */
export const AI_BRANDING = /\bAI\b/;

/** The bare word "ADHD" — banned in consumer copy, allowed in the coach pitch/SEO. */
export const ADHD_WORD = /\bADHD\b/i;

/**
 * Scan one string for design-LAW violations.
 *
 * @param {unknown} text - the copy string (coerced to String).
 * @param {{ allowAdhd?: boolean }} [opts] - set `allowAdhd: true` on coach-pitch /
 *   SEO surfaces where naming ADHD is permitted; consumer surfaces leave it false.
 * @returns {Array<{ kind: string, pattern: RegExp }>} one entry per violation
 *   (empty array = clean).
 */
export function scanDesignLaw(text, opts = {}) {
  const { allowAdhd = false } = opts;
  const s = String(text);
  const violations = [];
  for (const pattern of SHAME_PATTERNS) {
    if (pattern.test(s)) violations.push({ kind: 'shame', pattern });
  }
  for (const pattern of TREATMENT_CLAIM_PATTERNS) {
    if (pattern.test(s)) violations.push({ kind: 'treatment', pattern });
  }
  if (AI_BRANDING.test(s)) violations.push({ kind: 'ai-branding', pattern: AI_BRANDING });
  if (!allowAdhd && ADHD_WORD.test(s)) {
    violations.push({ kind: 'adhd-in-consumer-copy', pattern: ADHD_WORD });
  }
  return violations;
}

/**
 * Assert a whole copy surface is design-LAW clean. Throws with the offending
 * string and matched pattern on the first violation, so a failing test points
 * straight at the bad copy.
 *
 * @param {Iterable<unknown>} strings - the surface's strings.
 * @param {{ allowAdhd?: boolean, label?: string }} [opts]
 */
export function assertDesignLawClean(strings, opts = {}) {
  const { label = 'copy surface' } = opts;
  for (const raw of strings) {
    const violations = scanDesignLaw(raw, opts);
    if (violations.length > 0) {
      const v = violations[0];
      throw new Error(
        `Design-LAW violation (${v.kind}) in ${label}: ${JSON.stringify(String(raw))} matched ${v.pattern}`,
      );
    }
  }
}
