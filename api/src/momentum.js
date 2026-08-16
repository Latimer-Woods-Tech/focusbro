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

/** Weekday and short-month names for a warm peak-day callout (index 0 = Sunday / January). */
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A warm, unambiguous name for the day a kept-word window peaked, relative to
 * "today" in the same zone the window was bucketed in. Within the last week it
 * reads as a plain relative day ("today", "yesterday", "Wednesday"); older than
 * a week it pins the calendar date too ("Wednesday, Jul 2") so it can never be
 * mistaken for this week's same-named day. Pure; returns '' when the label is
 * missing or unparseable (e.g. an all-quiet window whose peak has no date).
 *
 * @param {string} dayLabel   a 'YYYY-MM-DD' calendar label (e.g. momentum.peak.date)
 * @param {object} [p]
 * @param {string} [p.nowISO]     "today" anchor (defaults to now)
 * @param {string} [p.timezone]   IANA zone the window was bucketed in
 * @returns {string}
 */
export function describePeakDay(dayLabel, { nowISO, timezone } = {}) {
  if (typeof dayLabel !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dayLabel)) return '';
  const tz = (typeof timezone === 'string' && timezone.trim()) ? timezone.trim() : 'UTC';
  const anchorISO = (nowISO && !Number.isNaN(Date.parse(nowISO))) ? nowISO : new Date().toISOString();
  const today = localDayInZone(anchorISO, tz);
  if (!today) return '';
  // Whole-day distance by calendar-label math (DST-agnostic — same trick as the axis walk).
  const toUTC = (lbl) => { const [y, mo, d] = lbl.split('-').map(Number); return Date.UTC(y, mo - 1, d); };
  const daysAgo = Math.round((toUTC(today) - toUTC(dayLabel)) / 86400000);
  if (daysAgo === 0) return 'today';
  if (daysAgo === 1) return 'yesterday';
  const [y, mo, d] = dayLabel.split('-').map(Number);
  const weekday = WEEKDAY_LONG[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  // 2–6 days back: this past week — the weekday alone is unambiguous.
  if (daysAgo >= 2 && daysAgo <= 6) return weekday;
  // A week or more back: name the date so it can't read as this week's same weekday.
  return `${weekday}, ${MONTH_SHORT[mo - 1]} ${d}`;
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

// ════════════════════════════════════════════════════════════
// POWER HOURS — the time of day your kept words tend to land
// ════════════════════════════════════════════════════════════
// A sibling of the per-day momentum sparkline: instead of "which DAYS did you
// keep your word", it answers "WHEN in the day are you strongest?" — bucketing
// the same status='kept' instants by local hour and naming the single peak.
//
// DESIGN LAW, by construction: like everything in this module it reads KEPT
// instants ONLY, so it can only ever point at an hour you SHOWED UP. There is no
// "quiet hours" or "you never keep words after lunch" surface anywhere here — a
// low hour is simply the absence of a win, never surfaced. And it names a peak
// only when there is enough signal to trust it (see peakKeptHour), so a thin or
// flat history never gets an arbitrary "power hour".

/** How many trailing days the power-hours histogram reads. Wider than the daily
 * sparkline because a time-of-day pattern needs accumulation before it's honest. */
export const POWER_HOURS_WINDOW_DAYS = 60;

/** Minimum kept words in the window before any "power hour" is named at all. */
export const POWER_HOURS_MIN_TOTAL = 8;

/** Minimum count the peak hour itself must hold to be worth naming. */
export const POWER_HOURS_MIN_PEAK = 3;

/**
 * The recipient-local hour-of-day (0–23) of an instant in an IANA zone. Uses Intl
 * (Workers + Node support zones); falls back to the UTC hour when the zone/instant
 * is unusable. Pure.
 * @param {string} iso  an ISO instant
 * @param {string} [timeZone]
 * @returns {number|null} 0..23, or null if the instant can't be parsed
 */
export function localHourInZone(iso, timeZone) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  try {
    const dtf = new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone || 'UTC', hour: '2-digit', hour12: false,
    });
    const part = dtf.formatToParts(new Date(ms)).find((p) => p.type === 'hour');
    let n = part ? Number(part.value) : NaN;
    if (n === 24) n = 0; // some ICU builds render local midnight as "24"
    return Number.isInteger(n) && n >= 0 && n <= 23 ? n : null;
  } catch {
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.getUTCHours();
  }
}

/**
 * Bucket KEPT-word instants into 24 per-local-hour counts in `timezone`. The
 * caller passes only kept timestamps; an hour with no entry is a genuine zero (a
 * quiet hour), never a miss. Pure + DST-correct (buckets by local wall-clock hour
 * via Intl).
 * @param {object} p
 * @param {string[]} p.timestamps  ISO instants of kept check-ins
 * @param {string} [p.timezone]    IANA zone for the wall clock
 * @returns {Array<{hour:number, count:number}>} index 0..23
 */
export function bucketKeptByHour({ timestamps, timezone } = {}) {
  const tz = (typeof timezone === 'string' && timezone.trim()) ? timezone.trim() : 'UTC';
  const axis = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  for (const ts of Array.isArray(timestamps) ? timestamps : []) {
    const h = localHourInZone(ts, tz);
    if (h != null) axis[h].count += 1;
  }
  return axis;
}

/**
 * The single hour a kept-word histogram peaks — but ONLY when there is enough
 * signal to trust it: a minimum total of kept words in the window, a peak that
 * itself clears a floor, AND a strictly-single tallest hour (a tie for the top
 * means no one "power hour" — we don't invent one). Returns null when the signal
 * is too thin, so a sparse or flat history never gets an arbitrary peak. Pure.
 * @param {Array<{hour:number,count:number}>} buckets
 * @param {{ minTotal?:number, minPeak?:number }} [opts]
 * @returns {{ hour:number, count:number, total:number, share:number } | null}
 */
export function peakKeptHour(buckets, { minTotal = POWER_HOURS_MIN_TOTAL, minPeak = POWER_HOURS_MIN_PEAK } = {}) {
  const list = Array.isArray(buckets) ? buckets : [];
  let total = 0;
  let best = null;
  for (const b of list) {
    const c = Number(b && b.count) || 0;
    total += c;
    if (!best || c > best.count) best = { hour: Number(b && b.hour), count: c };
  }
  if (!best || !Number.isInteger(best.hour) || total < minTotal || best.count < minPeak) return null;
  const tiedAtTop = list.filter((b) => (Number(b && b.count) || 0) === best.count).length;
  if (tiedAtTop !== 1) return null; // no clear single peak → no power hour
  return { hour: best.hour, count: best.count, total, share: best.count / total };
}

/** 12-hour clock words for a warm hour name; midnight/noon get their own words. */
function formatHour12(h) {
  if (h === 0) return 'midnight';
  if (h === 12) return 'noon';
  const suffix = h < 12 ? 'am' : 'pm';
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}${suffix}`;
}

/** The part of the day an hour lives in — a warm, plain phrase (never a judgment). */
function partOfDay(h) {
  if (h >= 5 && h < 12) return 'in the morning';
  if (h >= 12 && h < 17) return 'in the afternoon';
  if (h >= 17 && h < 21) return 'in the evening';
  return 'at night';
}

/**
 * A warm, human name for an hour of the day — a plain 12-hour clock time plus the
 * part of day it lives in ("9am, in the morning"); midnight and noon stand alone.
 * Pure; '' for a non-hour. Purely descriptive — carries no judgment about the hour.
 * @param {number} hour  0..23
 * @returns {string}
 */
export function describeHourBand(hour) {
  if (typeof hour !== 'number' || !Number.isInteger(hour) || hour < 0 || hour > 23) return '';
  const clock = formatHour12(hour);
  if (clock === 'midnight' || clock === 'noon') return clock;
  return `${clock}, ${partOfDay(hour)}`;
}
