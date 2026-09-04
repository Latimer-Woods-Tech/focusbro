/**
 * Caffeine decay arithmetic — pure, dependency-free, and the ONE source both
 * the unit tests and the served client script (/guides/caffeine.js) use. First-
 * order elimination: remaining = dose · 0.5^(hours / halfLife).
 *
 * Half-life default 5 h, range 1.5–9.5 h: Institute of Medicine (2001),
 * doi:10.17226/10219. Smoking shortens it; pregnancy and oral contraceptives
 * lengthen it. This is arithmetic on a population average, not a measurement
 * of anyone's body, and never medical advice.
 */
export const HALF_LIFE_DEFAULT_H = 5;
export const HALF_LIFE_MIN_H = 1.5;
export const HALF_LIFE_MAX_H = 9.5;

export function remainingMg(doseMg, hoursElapsed, halfLifeHours) {
  if (!(doseMg >= 0) || !(halfLifeHours > 0)) return 0;
  const h = Math.max(0, Number(hoursElapsed) || 0);
  return doseMg * Math.pow(0.5, h / halfLifeHours);
}

export function hoursUntil(doseMg, targetMg, halfLifeHours) {
  if (!(doseMg > 0) || !(targetMg > 0) || !(halfLifeHours > 0)) return 0;
  if (targetMg >= doseMg) return 0;
  return halfLifeHours * Math.log2(doseMg / targetMg);
}

/** Hours from a clock time (HH:MM) to a later clock time, wrapping past midnight. */
export function hoursBetween(fromHHMM, toHHMM) {
  const parse = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); return m ? (Number(m[1]) % 24) + Number(m[2]) / 60 : null; };
  const a = parse(fromHHMM), b = parse(toHHMM);
  if (a == null || b == null) return null;
  let d = b - a; if (d < 0) d += 24;
  return d;
}
