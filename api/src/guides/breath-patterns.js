/**
 * Breathing patterns + the pacing arithmetic, in ONE place.
 *
 * The patterns are data: every count comes from the guide that hosts the
 * pacer, and the guide's prose is tested against the same object. The math is
 * a plain SOURCE STRING that this module builds its own exports from and the
 * served script embeds verbatim — never Function.prototype.toString(), which
 * the Worker bundler rewrites with a `__name` helper the browser lacks
 * (the caffeine calculator shipped dead that way once).
 *
 * Rounds are capped per pattern by what the guide says, not by taste: the
 * 4-7-8 guide's "do no more than about four rounds at a time" is a maxRounds
 * of 4, and a test pins it.
 */

const phase = (name, seconds) => Object.freeze({ name, seconds });

export const BREATH_PATTERNS = Object.freeze({
  box: Object.freeze({
    id: 'box',
    label: 'Box 4-4-4-4',
    phases: Object.freeze([phase('Inhale', 4), phase('Hold', 4), phase('Exhale', 4), phase('Hold', 4)]),
    defaultRounds: 4,
    maxRounds: 10,
    note: 'Four rounds is about a minute. If a four-count hold makes you gasp on the next breath, the counts are too long — you should never feel starved for air.',
  }),
  resonance: Object.freeze({
    id: 'resonance',
    label: 'Resonance 5-5 (no holds)',
    phases: Object.freeze([phase('Inhale', 5), phase('Exhale', 5)]),
    defaultRounds: 6,
    maxRounds: 18,
    note: 'Six breaths a minute — the pace the heart-rate-variability research (Lehrer & Gevirtz, 2014) calls the resonance frequency for most adults. No holds; just slow and even.',
  }),
  '478': Object.freeze({
    id: '478',
    label: '4-7-8',
    phases: Object.freeze([phase('Inhale', 4), phase('Hold', 7), phase('Exhale', 8)]),
    defaultRounds: 4,
    maxRounds: 4,
    note: 'Up to four rounds — more is not better here. Stop if you feel light-headed, and let the exhale be slow and complete.',
  }),
  '478short': Object.freeze({
    id: '478short',
    label: 'Shorter 4-7-8 (2.5-4.5-5)',
    phases: Object.freeze([phase('Inhale', 2.5), phase('Hold', 4.5), phase('Exhale', 5)]),
    defaultRounds: 4,
    maxRounds: 4,
    note: 'The same shape at a quicker pace — short in, longer hold, longest out — for when a seven-count hold is a strain. Keep the ratio; the seconds can shrink.',
  }),
});

// The pacing arithmetic, as data. `phaseAt` locates the phase for a moment in
// the cycle; `breathLevel` is the 0..1 "fullness of the lungs" that both the
// visual and the swell follow (rising through an inhale, held after it,
// falling through an exhale, empty after that); `swellTarget` is where the
// audio automation ramps TO by the end of each phase.
export const BREATH_MATH_SRC = `
function cycleSeconds(phases) { var t = 0; for (var i = 0; i < phases.length; i++) t += Number(phases[i].seconds) || 0; return t; }
function phaseAt(phases, t) {
  var cycle = cycleSeconds(phases); if (!(cycle > 0)) return null;
  var u = ((Number(t) || 0) % cycle + cycle) % cycle, acc = 0;
  for (var i = 0; i < phases.length; i++) {
    var s = Number(phases[i].seconds) || 0;
    if (u < acc + s || i === phases.length - 1) { var e = u - acc; return { index: i, name: phases[i].name, seconds: s, elapsed: e, remaining: s - e, progress: s > 0 ? e / s : 1 }; }
    acc += s;
  }
  return null;
}
function fullAfter(phases, index) {
  for (var i = index; i >= 0; i--) { if (phases[i].name === 'Inhale') return 1; if (phases[i].name === 'Exhale') return 0; }
  for (var j = phases.length - 1; j > index; j--) { if (phases[j].name === 'Inhale') return 1; if (phases[j].name === 'Exhale') return 0; }
  return 0;
}
function breathLevel(phases, t) {
  var p = phaseAt(phases, t); if (!p) return 0;
  if (p.name === 'Inhale') return p.progress;
  if (p.name === 'Exhale') return 1 - p.progress;
  return fullAfter(phases, p.index);
}
function swellTarget(phases, index) {
  var name = phases[index].name;
  if (name === 'Inhale') return { gain: 1, cutoff: 900 };
  if (name === 'Exhale') return { gain: 0.1, cutoff: 300 };
  return fullAfter(phases, index) ? { gain: 0.82, cutoff: 760 } : { gain: 0.08, cutoff: 280 };
}
`;

const built = new Function(`${BREATH_MATH_SRC}; return { cycleSeconds, phaseAt, breathLevel, swellTarget };`)();
export const cycleSeconds = built.cycleSeconds;
export const phaseAt = built.phaseAt;
export const breathLevel = built.breathLevel;
export const swellTarget = built.swellTarget;

/** The patterns as the JSON literal the served script embeds — data, not code. */
export const BREATH_PATTERNS_JSON = JSON.stringify(BREATH_PATTERNS);
