// ════════════════════════════════════════════════════════════
// FOCUSBRO — KEPT-WORD MOMENTUM  (Contender track, issue #10, Phase A)
// ════════════════════════════════════════════════════════════
// The shared, runtime-agnostic momentum engine: bucket KEPT-word instants into
// per-local-day counts and render a text/bar sparkline. Both the coach detail
// view and the person's own /me/ view read from here, each supplying its own
// voice (third-person for the coach, first-person for the person) via injected
// copy — one tested shape, two surfaces.
//
// DESIGN LAW, by construction: everything here reads KEPT instants ONLY. A day
// with no kept word is a short bar — the *absence* of a win, never the
// *presence* of a miss. There is no missed/skipped series anywhere in this
// module, so no surface built on it can leak a "who's slipping" miss-grid.
// ════════════════════════════════════════════════════════════

/** How many trailing days the momentum sparkline covers by default. */
export const MOMENTUM_WINDOW_DAYS = 14;

/** The eight ramp glyphs, lowest→highest, for a text sparkline. */
const SPARK_GLYPHS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/**
 * The recipient-local calendar date (`YYYY-MM-DD`) of an instant in an IANA
 * zone. Uses Intl (Workers + Node support zones); falls back to the UTC date
 * when the zone/instant is unusable. Pure.
 * @param {string} iso  an ISO instant
 * @param {string} [timeZone]
 * @returns {string|null} 'YYYY-MM-DD', or null if the instant can't be parsed
 */
export function localDayInZone(iso, timeZone) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  try {
    const dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    });
    // en-CA renders as YYYY-MM-DD.
    return dtf.format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/** Step a 'YYYY-MM-DD' calendar label back/forward by whole days (label math, DST-agnostic). */
function shiftDayLabel(label, deltaDays) {
  const [y, mo, d] = label.split('-').map(Number);
  const t = Date.UTC(y, mo - 1, d) + deltaDays * 86400000;
  const nd = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${nd.getUTCFullYear()}-${p(nd.getUTCMonth() + 1)}-${p(nd.getUTCDate())}`;
}

/**
 * Bucket a list of KEPT-word instants into per-local-day counts over the last
 * `days` days (inclusive of today) in `timezone`. The caller passes only kept
 * timestamps; a day with no entry is a genuine zero (a quiet day), never a miss.
 * Instants outside the window are ignored. Pure + DST-correct (it buckets by
 * local calendar date via Intl, and walks the axis by calendar-label math).
 *
 * @param {object} p
 * @param {string[]} p.timestamps  ISO instants of kept check-ins
 * @param {number} [p.days=MOMENTUM_WINDOW_DAYS]
 * @param {string} [p.nowISO]      "today" anchor (defaults to now)
 * @param {string} [p.timezone]    IANA zone for day boundaries
 * @returns {Array<{date: string, count: number}>} oldest→newest, length `days`
 */
export function bucketKeptByDay({ timestamps, days = MOMENTUM_WINDOW_DAYS, nowISO, timezone } = {}) {
  const n = Math.max(1, Math.min(90, Math.floor(days) || MOMENTUM_WINDOW_DAYS));
  const tz = (typeof timezone === 'string' && timezone.trim()) ? timezone.trim() : 'UTC';
  const anchorISO = (nowISO && !Number.isNaN(Date.parse(nowISO))) ? nowISO : new Date().toISOString();
  const today = localDayInZone(anchorISO, tz);

  // Ordered axis of `n` day labels ending at today (today is last).
  const axis = [];
  const index = new Map();
  for (let i = n - 1; i >= 0; i--) {
    const label = shiftDayLabel(today, -i);
    index.set(label, axis.length);
    axis.push({ date: label, count: 0 });
  }

  for (const ts of Array.isArray(timestamps) ? timestamps : []) {
    const label = localDayInZone(ts, tz);
    const at = label != null ? index.get(label) : undefined;
    if (at !== undefined) axis[at].count += 1;
  }
  return axis;
}

/**
 * A text sparkline for a per-day count series. Scales the busiest day to the
 * tallest glyph; a quiet day is the shortest glyph, never blank — the baseline
 * is always drawn, so the shape reads as momentum, not a gap. An all-zero
 * window is a flat baseline (a clean page), not an empty string. Pure.
 * @param {Array<number|{count:number}>} counts
 * @returns {string} one glyph per entry
 */
export function sparklineBars(counts) {
  const nums = (Array.isArray(counts) ? counts : []).map((c) => {
    const v = typeof c === 'object' && c ? Number(c.count) : Number(c);
    return Number.isFinite(v) && v > 0 ? v : 0;
  });
  if (!nums.length) return '';
  const max = Math.max(...nums);
  if (max === 0) return SPARK_GLYPHS[0].repeat(nums.length);
  return nums.map((v) => {
    if (v === 0) return SPARK_GLYPHS[0];
    const idx = Math.round(((v / max) * (SPARK_GLYPHS.length - 1)));
    return SPARK_GLYPHS[Math.max(1, Math.min(SPARK_GLYPHS.length - 1, idx))];
  }).join('');
}

/**
 * Assemble a full momentum block from raw kept instants, in a caller-supplied
 * voice. The math (bucketing, totals, peak, sparkline) is fixed and tested; the
 * words are injected so the coach view ("their momentum") and the person's own
 * view ("your momentum") share one shape without sharing a voice.
 *
 * @param {object} p
 * @param {string[]} p.timestamps  ISO instants of kept check-ins
 * @param {number} [p.days=MOMENTUM_WINDOW_DAYS]
 * @param {string} [p.nowISO]
 * @param {string} [p.timezone]
 * @param {string} [p.intro='']    header copy for this surface
 * @param {function} [p.summary]   ({total,days,peak}) => string, the warm one-liner
 * @returns {object} { intro, days, timezone, buckets, total, peak, sparkline, summary }
 */
export function buildMomentum({ timestamps, days = MOMENTUM_WINDOW_DAYS, nowISO, timezone, intro = '', summary } = {}) {
  const buckets = bucketKeptByDay({ timestamps, days, nowISO, timezone });
  let total = 0;
  let peak = buckets[0] || { date: null, count: 0 };
  for (const b of buckets) {
    total += b.count;
    if (b.count > peak.count) peak = b;
  }
  const peakOut = { date: peak.date, count: peak.count };
  return {
    intro: typeof intro === 'string' ? intro : '',
    days: buckets.length,
    timezone: (typeof timezone === 'string' && timezone.trim()) ? timezone.trim() : 'UTC',
    buckets,
    total,
    peak: peakOut,
    sparkline: sparklineBars(buckets),
    summary: typeof summary === 'function' ? summary({ total, days: buckets.length, peak: peakOut }) : '',
  };
}
