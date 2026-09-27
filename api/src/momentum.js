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
 * An absolute calendar-day name for a "since"/anchor read: "Jul 8" when the day
 * falls in the current local year, "Jul 8, 2025" otherwise (so a long-standing
 * anchor can never read as this year's same date). Distinct from
 * {@link describePeakDay}, which is RELATIVE ("today"/"yesterday"/weekday) for
 * recent days; this always names the absolute day, for anchors that may sit far
 * in the past. Pure; returns '' when the instant can't be placed in the zone.
 *
 * @param {string} iso  an ISO instant
 * @param {object} [p]
 * @param {string} [p.nowISO]     "this year" anchor (defaults to now)
 * @param {string} [p.timezone]   IANA zone the day is resolved in
 * @returns {string}
 */
export function formatCalendarDay(iso, { nowISO, timezone } = {}) {
  const label = localDayInZone(iso, timezone || 'UTC');
  if (!label) return '';
  const [y, mo, d] = label.split('-').map(Number);
  if (!Number.isFinite(mo) || mo < 1 || mo > 12) return '';
  const anchorISO = (nowISO && !Number.isNaN(Date.parse(nowISO))) ? nowISO : new Date().toISOString();
  const nowLabel = localDayInZone(anchorISO, timezone || 'UTC');
  const nowYear = nowLabel ? Number(nowLabel.split('-')[0]) : y;
  return y === nowYear ? `${MONTH_SHORT[mo - 1]} ${d}` : `${MONTH_SHORT[mo - 1]} ${d}, ${y}`;
}

/**
 * Whole local-calendar days between an instant and "today", in a zone:
 * 0 = today, 1 = yesterday, negative = a future day. Uses calendar-label math
 * (DST-agnostic — the same trick the momentum axis and {@link describePeakDay}
 * use), so a DST transition inside the span never miscounts. Pure; null when the
 * instant can't be placed.
 *
 * @param {string} iso
 * @param {object} [p]
 * @param {string} [p.nowISO]     "today" anchor (defaults to now)
 * @param {string} [p.timezone]   IANA zone for day boundaries
 * @returns {number|null}
 */
export function calendarDaysAgo(iso, { nowISO, timezone } = {}) {
  const label = localDayInZone(iso, timezone || 'UTC');
  if (!label) return null;
  const anchorISO = (nowISO && !Number.isNaN(Date.parse(nowISO))) ? nowISO : new Date().toISOString();
  const today = localDayInZone(anchorISO, timezone || 'UTC');
  if (!today) return null;
  const toUTC = (lbl) => { const [y, mo, d] = lbl.split('-').map(Number); return Date.UTC(y, mo - 1, d); };
  return Math.round((toUTC(today) - toUTC(label)) / 86400000);
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

// ════════════════════════════════════════════════════════════
// ALL-TIME BEST DAY — the most words you ever kept in a single day
// ════════════════════════════════════════════════════════════
// The per-day sparkline shows the last two weeks; power hours shows the time of
// day. Neither can answer "the most I ever kept in ONE day". This does: it
// buckets a person's FULL kept-word history by local calendar day and names the
// single tallest day — a standing high-water mark.
//
// DESIGN LAW, by construction: it reads status='kept' instants ONLY, so it can
// only ever crown a day the person SHOWED UP — there is no "worst day" or "days
// you kept nothing" anywhere. And because a past kept row never disappears, the
// number it names can only ever climb: a reset, a miss, or a quiet stretch never
// lowers it. It is a record, not a comparison to today.

/** Minimum kept words on one day before that day is crowned an all-time "best day". */
export const BEST_DAY_MIN_COUNT = 2;

/**
 * The single best day in a kept-word history — the local calendar day on which
 * the person kept the MOST words, from their full list of status='kept' instants.
 * Pure + DST-correct (buckets by local calendar date via Intl, same as
 * {@link bucketKeptByDay}).
 *
 * On a TIE for the most-kept count across several days, names the MOST RECENT such
 * day — the freshest time they hit their high-water mark ("you did it again"),
 * never an older instance. Returns null when no day clears `minCount` (a lone kept
 * word isn't a "best day" worth crowning) or the history is empty — so a thin
 * history gets no record, never a hollow "your best day: 1".
 *
 * @param {object} p
 * @param {string[]} p.timestamps  ISO instants of kept check-ins (any order)
 * @param {string} [p.timezone]    IANA zone for day boundaries
 * @param {number} [p.minCount=BEST_DAY_MIN_COUNT]
 * @returns {{ date: string, count: number } | null}
 */
export function allTimeBestDay({ timestamps, timezone, minCount = BEST_DAY_MIN_COUNT } = {}) {
  const tz = (typeof timezone === 'string' && timezone.trim()) ? timezone.trim() : 'UTC';
  const floor = Number.isFinite(minCount) ? minCount : BEST_DAY_MIN_COUNT;
  const counts = new Map(); // 'YYYY-MM-DD' -> kept count that local day
  for (const ts of Array.isArray(timestamps) ? timestamps : []) {
    const label = localDayInZone(ts, tz);
    if (label != null) counts.set(label, (counts.get(label) || 0) + 1);
  }
  let best = null;
  for (const [date, count] of counts) {
    // A strictly-higher day wins; on a tie the LATER calendar date wins (labels
    // are 'YYYY-MM-DD', so a lexical `>` is a chronological `>`).
    if (!best || count > best.count || (count === best.count && date > best.date)) {
      best = { date, count };
    }
  }
  if (!best || best.count < floor) return null;
  return best;
}

/**
 * Count the distinct LOCAL calendar days on which the person kept at least one
 * word — the BREADTH of the practice, as opposed to its COUNT. Two people with
 * the same lifetime kept total can differ wildly in how many separate days they
 * showed up (one batches 40 words across 6 days; another spreads them across 35),
 * and this names that spread. Pure + DST-correct (buckets each instant by local
 * calendar date via {@link localDayInZone}, same as {@link allTimeBestDay}).
 *
 * Reads ONLY the kept instants the caller passes — a quiet day is simply absent
 * from the set, never counted and never subtracted — so the number can only ever
 * grow. Garbage instants are ignored, not thrown on; empty in → 0 out.
 *
 * @param {object} p
 * @param {string[]} p.timestamps  ISO instants of kept check-ins (any order)
 * @param {string} [p.timezone]    IANA zone for day boundaries
 * @returns {number} count of distinct local days carrying ≥1 kept word
 */
export function distinctKeptDays({ timestamps, timezone } = {}) {
  const tz = (typeof timezone === 'string' && timezone.trim()) ? timezone.trim() : 'UTC';
  const days = new Set();
  for (const ts of Array.isArray(timestamps) ? timestamps : []) {
    const label = localDayInZone(ts, tz);
    if (label != null) days.add(label);
  }
  return days.size;
}

// ════════════════════════════════════════════════════════════
// POWER DAY — the day of the WEEK your kept words tend to land
// ════════════════════════════════════════════════════════════
// The weekday sibling of power hours: where power hours asks "WHEN in the day are
// you strongest?", this asks "which DAY OF THE WEEK do you come through most?" —
// bucketing the same status='kept' instants by local weekday (Mon/Tue/…) across a
// person's history and naming the single peak weekday.
//
// DESIGN LAW, by construction: like everything in this module it reads KEPT
// instants ONLY, so it can only ever point at a weekday you SHOWED UP. There is no
// "your weak day" or "you never keep words on Mondays" surface anywhere here — a
// low weekday is simply the absence of a win, never surfaced. And it names a peak
// only when there is enough signal to trust it (see peakKeptWeekday), so a thin or
// flat history never gets an arbitrary "power day".

/** Minimum kept words across the history before any "power day" is named at all. */
export const POWER_DAY_MIN_TOTAL = 12;

/** Minimum count the peak weekday itself must hold to be worth naming. */
export const POWER_DAY_MIN_PEAK = 4;

/**
 * The recipient-local weekday (0=Sunday … 6=Saturday) of an instant in an IANA
 * zone. Resolves the local calendar day first (via {@link localDayInZone}, so the
 * weekday is correct across DST and zone-of-midnight edges) and reads the weekday
 * off that label with calendar math — never off the raw UTC instant. Pure.
 * @param {string} iso  an ISO instant
 * @param {string} [timeZone]
 * @returns {number|null} 0..6 (0=Sunday), or null if the instant can't be placed
 */
export function localWeekdayInZone(iso, timeZone) {
  const label = localDayInZone(iso, timeZone || 'UTC');
  if (!label || !/^\d{4}-\d{2}-\d{2}$/.test(label)) return null;
  const [y, mo, d] = label.split('-').map(Number);
  const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return Number.isInteger(wd) && wd >= 0 && wd <= 6 ? wd : null;
}

/**
 * Bucket KEPT-word instants into 7 per-local-weekday counts in `timezone`. The
 * caller passes only kept timestamps; a weekday with no entry is a genuine zero (a
 * quiet weekday), never a miss. Pure + DST-correct (buckets by local calendar
 * weekday via {@link localWeekdayInZone}).
 * @param {object} p
 * @param {string[]} p.timestamps  ISO instants of kept check-ins
 * @param {string} [p.timezone]    IANA zone for the weekday boundaries
 * @returns {Array<{weekday:number, count:number}>} index 0=Sunday..6=Saturday
 */
export function bucketKeptByWeekday({ timestamps, timezone } = {}) {
  const tz = (typeof timezone === 'string' && timezone.trim()) ? timezone.trim() : 'UTC';
  const axis = Array.from({ length: 7 }, (_, weekday) => ({ weekday, count: 0 }));
  for (const ts of Array.isArray(timestamps) ? timestamps : []) {
    const wd = localWeekdayInZone(ts, tz);
    if (wd != null) axis[wd].count += 1;
  }
  return axis;
}

/**
 * The single weekday a kept-word histogram peaks — but ONLY when there is enough
 * signal to trust it: a minimum total of kept words, a peak that itself clears a
 * floor, AND a strictly-single tallest weekday (a tie for the top means no one
 * "power day" — we don't invent one). Returns null when the signal is too thin, so
 * a sparse or flat history never gets an arbitrary peak. Pure. Sibling of
 * {@link peakKeptHour}.
 * @param {Array<{weekday:number,count:number}>} buckets
 * @param {{ minTotal?:number, minPeak?:number }} [opts]
 * @returns {{ weekday:number, count:number, total:number, share:number } | null}
 */
export function peakKeptWeekday(buckets, { minTotal = POWER_DAY_MIN_TOTAL, minPeak = POWER_DAY_MIN_PEAK } = {}) {
  const list = Array.isArray(buckets) ? buckets : [];
  let total = 0;
  let best = null;
  for (const b of list) {
    const c = Number(b && b.count) || 0;
    total += c;
    if (!best || c > best.count) best = { weekday: Number(b && b.weekday), count: c };
  }
  if (!best || !Number.isInteger(best.weekday) || total < minTotal || best.count < minPeak) return null;
  const tiedAtTop = list.filter((b) => (Number(b && b.count) || 0) === best.count).length;
  if (tiedAtTop !== 1) return null; // no clear single peak → no power day
  return { weekday: best.weekday, count: best.count, total, share: best.count / total };
}

/**
 * The warm long name of a weekday (0=Sunday..6=Saturday) — "Monday", "Tuesday", …
 * Pure; '' for a non-weekday. Purely descriptive — carries no judgment.
 * @param {number} weekday  0..6
 * @returns {string}
 */
export function describeWeekday(weekday) {
  if (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) return '';
  return WEEKDAY_LONG[weekday];
}

// ════════════════════════════════════════════════════════════
// TYPICAL DAY — how many words you tend to keep on a day you show up
// ════════════════════════════════════════════════════════════
// Every other read here answers a different question: HOW MANY (the lifetime
// count), the PEAK (best day / power hour / power day), the BREADTH (distinct days
// you showed up), or the ANCHOR (when it began). None names the INTENSITY of a
// normal active day — when you DO show up, how much do you tend to keep? This does:
// the average kept words per active day, over the same status='kept' history the
// record reads use.
//
// DESIGN LAW, by construction: BOTH halves of the average — the kept total (the
// numerator) and the count of distinct active days (the denominator) — are drawn
// from status='kept' instants ONLY. A quiet day is in NEITHER number: it is never
// counted and never divided in, so this can only ever describe the days the person
// SHOWED UP. There is no "days you kept nothing", no target, no comparison. And it
// speaks only once there is enough history for an average to be honest (see the
// gate), so a thin record never gets a hollow figure.

/** Minimum distinct active days before a typical-day average is honest to name. */
export const TYPICAL_DAY_MIN_DAYS = 6;

/** Minimum kept words behind the average before it is worth naming. */
export const TYPICAL_DAY_MIN_TOTAL = 12;

/**
 * The person's TYPICAL active day: the average number of words they keep on a day
 * they show up, from status='kept' instants ONLY. Buckets the instants by local
 * calendar day (DST-correct, via {@link localDayInZone}), then divides the kept
 * total by the count of distinct active days. Both halves are kept-only, so a quiet
 * day is in neither — the average describes only the days shown up, never averages a
 * miss in. Returns null below the signal gate (too few active days OR too few kept
 * words) so a thin history never gets a hollow average. Pure; garbage-safe (bad
 * instants are skipped, never thrown on; empty in → null out).
 *
 * @param {object} p
 * @param {string[]} p.timestamps  ISO instants of kept check-ins (any order)
 * @param {string} [p.timezone]    IANA zone for day boundaries
 * @param {number} [p.minDays=TYPICAL_DAY_MIN_DAYS]
 * @param {number} [p.minTotal=TYPICAL_DAY_MIN_TOTAL]
 * @returns {{ perDay:number, total:number, days:number } | null}
 */
export function typicalKeptPerActiveDay({ timestamps, timezone, minDays = TYPICAL_DAY_MIN_DAYS, minTotal = TYPICAL_DAY_MIN_TOTAL } = {}) {
  const tz = (typeof timezone === 'string' && timezone.trim()) ? timezone.trim() : 'UTC';
  const byDay = new Map(); // 'YYYY-MM-DD' -> kept count that local day
  let total = 0;
  for (const ts of Array.isArray(timestamps) ? timestamps : []) {
    const label = localDayInZone(ts, tz);
    if (label != null) { byDay.set(label, (byDay.get(label) || 0) + 1); total += 1; }
  }
  const days = byDay.size;
  const minD = Number.isFinite(minDays) ? minDays : TYPICAL_DAY_MIN_DAYS;
  const minT = Number.isFinite(minTotal) ? minTotal : TYPICAL_DAY_MIN_TOTAL;
  if (days < minD || total < minT) return null;
  return { perDay: total / days, total, days };
}

// ════════════════════════════════════════════════════════════
// BEST WEEK — the most words you ever kept across a single week
// ════════════════════════════════════════════════════════════
// The week-scale peer of allTimeBestDay: where the best day crowns the tallest
// SINGLE local day, this crowns the tallest local WEEK (Monday-anchored, ISO-8601
// style) — the seven-day stretch you strung the most kept words together in. A
// bigger canvas that can tell a different story: a steady week spread across many
// days can crown a week no single one of those days would.
//
// DESIGN LAW, by construction: it buckets status='kept' instants ONLY, so it can
// only ever crown a week you SHOWED UP. It is a standing record that only ever
// climbs — a quiet week never takes it back, and there is no "worst week" or
// week-over-week comparison anywhere here. A floor keeps a thin history from
// getting a hollow "best week".

/** Minimum kept words in the peak week before a "best week" is worth crowning. */
export const BEST_WEEK_MIN_COUNT = 4;

/**
 * The Monday-anchored week label (the 'YYYY-MM-DD' of that week's Monday) for a
 * local calendar-day label. ISO-8601 weeks start on Monday. Pure calendar-label
 * math (the same DST-agnostic trick the momentum axis uses): reads the weekday off
 * the label and steps back to Monday. Returns null for a malformed label.
 * @param {string} dayLabel  a 'YYYY-MM-DD' local calendar label
 * @returns {string|null} the Monday-of-that-week label, or null
 */
export function weekStartLabel(dayLabel) {
  if (typeof dayLabel !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dayLabel)) return null;
  const [y, mo, d] = dayLabel.split('-').map(Number);
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); // 0=Sun … 6=Sat
  const backToMonday = (dow + 6) % 7; // Mon→0 … Sun→6
  return shiftDayLabel(dayLabel, -backToMonday);
}

/**
 * The single best WEEK in a kept-word history — the Monday-anchored local week in
 * which the person kept the MOST words, from their full list of status='kept'
 * instants. Pure + DST-correct (buckets each instant by local calendar day via
 * {@link localDayInZone}, then folds days into their Monday-anchored week via
 * {@link weekStartLabel}).
 *
 * On a TIE for the most-kept count across several weeks, names the MOST RECENT such
 * week (the freshest time the high-water mark was hit), never an older one. Returns
 * null when no week clears `minCount` or the history is empty — so a thin history
 * gets no record, never a hollow "your best week: 1".
 *
 * @param {object} p
 * @param {string[]} p.timestamps  ISO instants of kept check-ins (any order)
 * @param {string} [p.timezone]    IANA zone for day/week boundaries
 * @param {number} [p.minCount=BEST_WEEK_MIN_COUNT]
 * @returns {{ weekStart: string, count: number } | null}
 */
export function allTimeBestWeek({ timestamps, timezone, minCount = BEST_WEEK_MIN_COUNT } = {}) {
  const tz = (typeof timezone === 'string' && timezone.trim()) ? timezone.trim() : 'UTC';
  const floor = Number.isFinite(minCount) ? minCount : BEST_WEEK_MIN_COUNT;
  const counts = new Map(); // Monday 'YYYY-MM-DD' -> kept count that local week
  for (const ts of Array.isArray(timestamps) ? timestamps : []) {
    const day = localDayInZone(ts, tz);
    const week = day != null ? weekStartLabel(day) : null;
    if (week != null) counts.set(week, (counts.get(week) || 0) + 1);
  }
  let best = null;
  for (const [weekStart, count] of counts) {
    // A strictly-higher week wins; on a tie the LATER Monday wins (labels are
    // 'YYYY-MM-DD', so a lexical `>` is a chronological `>`).
    if (!best || count > best.count || (count === best.count && weekStart > best.weekStart)) {
      best = { weekStart, count };
    }
  }
  if (!best || best.count < floor) return null;
  return best;
}

/**
 * A warm, relative-aware name for a best-week Monday label: "this week" / "last
 * week" for the current and prior local weeks, else "the week of Jul 7" (absolute,
 * and year-qualified past a year rollover so an old record can't read as this
 * year's same date). Pure; returns '' for a malformed label. The week distance is
 * whole-week calendar-label math (DST-agnostic — the same trick describePeakDay
 * uses for days).
 * @param {string} weekStart  a Monday 'YYYY-MM-DD' label (from {@link allTimeBestWeek})
 * @param {object} [p]
 * @param {string} [p.nowISO]     "this week" anchor (defaults to now)
 * @param {string} [p.timezone]   IANA zone the week was bucketed in
 * @returns {string}
 */
export function describeBestWeek(weekStart, { nowISO, timezone } = {}) {
  if (typeof weekStart !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return '';
  const tz = (typeof timezone === 'string' && timezone.trim()) ? timezone.trim() : 'UTC';
  const anchorISO = (nowISO && !Number.isNaN(Date.parse(nowISO))) ? nowISO : new Date().toISOString();
  const todayLabel = localDayInZone(anchorISO, tz);
  const thisWeek = todayLabel ? weekStartLabel(todayLabel) : null;
  if (thisWeek) {
    const toUTC = (lbl) => { const [y, mo, d] = lbl.split('-').map(Number); return Date.UTC(y, mo - 1, d); };
    const weeksAgo = Math.round((toUTC(thisWeek) - toUTC(weekStart)) / (7 * 86400000));
    if (weeksAgo === 0) return 'this week';
    if (weeksAgo === 1) return 'last week';
  }
  // Older (or no usable anchor): name the Monday date; qualify the year past a rollover.
  const [y, mo, d] = weekStart.split('-').map(Number);
  if (!Number.isFinite(mo) || mo < 1 || mo > 12) return '';
  const nowYear = thisWeek ? Number(thisWeek.split('-')[0]) : y;
  const base = `the week of ${MONTH_SHORT[mo - 1]} ${d}`;
  return y === nowYear ? base : `${base}, ${y}`;
}
