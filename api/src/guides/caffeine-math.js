/**
 * Caffeine decay arithmetic — pure, dependency-free, and the ONE source both
 * the unit tests and the served client script (/guides/caffeine.js) use.
 * First-order elimination: remaining = dose · 0.5^(hours / halfLife).
 *
 * Half-life default 5 h, range 1.5–9.5 h: Institute of Medicine (2001),
 * doi:10.17226/10219. Smoking shortens it; pregnancy and oral contraceptives
 * lengthen it. This is arithmetic on a population average, not a measurement
 * of anyone's body, and never medical advice.
 *
 * WHY A STRING: the client script must contain this code verbatim. Deriving it
 * with Function.prototype.toString() looked like one source of truth and was
 * not — wrangler's bundler wraps every declaration in its `__name(...)` helper,
 * so the bundled function's source referenced a helper the browser does not
 * have and the calculator was dead in production while every local test
 * passed. Data survives a bundler; reflected source does not. So the source is
 * a string, and the module's own exports are BUILT from it — there is exactly
 * one copy of the arithmetic, and it is the one the browser runs.
 */
export const HALF_LIFE_DEFAULT_H = 5;
export const HALF_LIFE_MIN_H = 1.5;
export const HALF_LIFE_MAX_H = 9.5;

export const CAFFEINE_MATH_SRC = `
function remainingMg(doseMg, hoursElapsed, halfLifeHours) {
  if (!(doseMg >= 0) || !(halfLifeHours > 0)) return 0;
  var h = Math.max(0, Number(hoursElapsed) || 0);
  return doseMg * Math.pow(0.5, h / halfLifeHours);
}
function hoursUntil(doseMg, targetMg, halfLifeHours) {
  if (!(doseMg > 0) || !(targetMg > 0) || !(halfLifeHours > 0)) return 0;
  if (targetMg >= doseMg) return 0;
  return halfLifeHours * Math.log2(doseMg / targetMg);
}
function hoursBetween(fromHHMM, toHHMM) {
  var parse = function (t) { var m = /^(\\d{1,2}):(\\d{2})$/.exec(String(t || '')); return m ? (Number(m[1]) % 24) + Number(m[2]) / 60 : null; };
  var a = parse(fromHHMM), b = parse(toHHMM);
  if (a == null || b == null) return null;
  var d = b - a; if (d < 0) d += 24;
  return d;
}
`;

// The module's callable exports are the string, evaluated once. Tests exercise
// exactly the code the browser receives.
const built = new Function(`${CAFFEINE_MATH_SRC}; return { remainingMg, hoursUntil, hoursBetween };`)();
export const remainingMg = built.remainingMg;
export const hoursUntil = built.hoursUntil;
export const hoursBetween = built.hoursBetween;
