import { pageHead, pageNav } from './page-shell.js';
// ════════════════════════════════════════════════════════════
// FOCUSBRO — WEEKLY REPORT  (Contender track, issue #10, Phase A · R-237)
// ════════════════════════════════════════════════════════════
// The coach-proof artifact (docs/IMPROVEMENT_PLAN.md, L2 — "the keystone"):
// turn the loop's private, first-party signals into something a person — and,
// crucially, the coach who supports them — can SEE and SHARE. L1 (events.js)
// measured the loop; this is the surface that makes the measurement legible.
//
// A weekly report is a per-user summary read from REAL data: the words kept
// this week, the current kept-word run, the 14-day momentum shape, the rhythms
// they've asked the bro to show up for, and ONE tiny forward step. It renders
// at /me/report, and it exports as plain text so it can be copied or shared
// with a coach (mailto / download) — the concrete GTM surface Phase 3 (coach
// activation) needs before it can gate on "≥5 real coach-visible reports".
//
// THE DESIGN LAW (non-negotiable), by construction: a report is exactly where a
// week could be scored as a wall of misses. It is not. Every number here reads
// KEPT-word signal ONLY — words kept this week, a kept-word run, kept-per-day
// momentum. A quiet week is a fresh page, never a failure tally; the "next tiny
// step" is always forward and warm, never a reproach. There is no missed/skipped
// series anywhere in this module. Enforced by report.test.js (banned-word +
// no-"AI" + no-clinical-claim assertions over every copy path).
//
// Pure + testable: buildWeeklyReport() and renderReportText() take plain data
// (no DB), so the whole report shape is unit-tested without a live database.
// The route (registerReportRoutes) does the D1 reads and hands the rows here.
// ════════════════════════════════════════════════════════════

import { describeCadence, formatWhenLocal, milestoneCopy } from './accountability.js';
import { EVENTS } from './events.js';
import {
  MOMENTUM_WINDOW_DAYS,
  bucketKeptByDay,
  buildMomentum as buildMomentumBlock,
  describePeakDay,
} from './momentum.js';

/** The reporting window: the trailing week (inclusive of today). */
export const WEEKLY_WINDOW_DAYS = 7;

// ── REPORT COPY ENGINE ───────────────────────────────────────
// First-person, warm, kept-word framed. A quiet week is an open page; the only
// forward-looking ask is a single small next step.

/** Header line for the report — sets the tone before any number. */
export function reportIntroCopy() {
  return 'Your week, in the words you kept. We count the wins; a quiet day is just quiet, and the next kept word lands right here.';
}

/**
 * The warm headline: how many words you kept this week and, if you're on a run,
 * that you're on it now. On a quiet week it's a clean-page invitation, never a
 * shortfall.
 * @param {object} p { keptThisWeek, current }
 * @returns {string}
 */
export function reportHeadlineCopy({ keptThisWeek = 0, current = 0 } = {}) {
  const n = Number(keptThisWeek) || 0;
  const cur = Number(current) || 0;
  if (n === 0) {
    return 'A fresh page this week. Pick one small thing, give it a time, and the bro will be right there with you.';
  }
  const kept = `You kept ${n} word${n === 1 ? '' : 's'} this week.`;
  if (cur > 0) {
    return `${kept} You’re on a ${cur}-word run right now — real momentum.`;
  }
  return `${kept} Every one of those was you showing up for yourself.`;
}

/**
 * The single, tiny, forward step — the "next adjustment" L2 asks for, kept
 * gentle and concrete. Never a correction of what didn't happen; always the one
 * easiest next thing.
 * @param {object} p { keptThisWeek, activeCount, current }
 * @returns {string}
 */
export function nextStepCopy({ keptThisWeek = 0, activeCount = 0, current = 0 } = {}) {
  const n = Number(keptThisWeek) || 0;
  const active = Number(activeCount) || 0;
  if (active === 0) {
    return 'One tiny next step: give a single word a time this week — something small you’d be glad you did.';
  }
  if (n === 0) {
    return 'One tiny next step: pick the easiest word on your list and meet the bro there first. Momentum starts with one.';
  }
  return 'One tiny next step: keep the rhythm that’s working, and add just one small word for next week.';
}

/**
 * The mutual-accountability line: how many times FocusBro ITSELF showed up for
 * you this week — the check-ins it delivered when it said it would. This counts
 * the ALLY keeping its word, never the person's outcomes, so by construction it
 * can only ever read as support: a delivered nudge is "the bro rang you," full
 * stop, whether the word was then kept, moved, or is still in flight. Empty when
 * the bro hasn't had a moment to show up yet this week — nothing to celebrate,
 * nothing to apologise for, just a quiet page (per the module's design LAW).
 * @param {object} p { showedUp }
 * @returns {string}
 */
export function showedUpCopy({ showedUp = 0 } = {}) {
  const n = Number(showedUp) || 0;
  if (n <= 0) return '';
  return `And FocusBro showed up for you ${n} time${n === 1 ? '' : 's'} this week — the bro kept its word too.`;
}

/**
 * Warm one-line summary of the rhythms on the books — the shape of what you've
 * asked the bro to show up for, never a scorecard. Empty when nothing is live.
 * @param {number} activeCount
 * @returns {string}
 */
export function rhythmsIntroCopy(activeCount = 0) {
  const n = Number(activeCount) || 0;
  if (n === 0) {
    return 'Nothing on the books right now — a clear page, ready for your next word.';
  }
  return 'The rhythm you set for yourself — the times you’ve asked the bro to show up.';
}

/**
 * A forward-looking "next up" line for a single rhythm. Reads only an
 * OUTSTANDING (future/open) check-in — a moment about to be kept — so it can
 * never surface a miss. When time has passed but the door is still open it
 * stays warm ("still here whenever you’re ready"), never "overdue".
 * @param {object} p { iso, timezone, nowISO }
 * @returns {string}
 */
export function rhythmNextCopy({ iso, timezone, nowISO } = {}) {
  if (!iso || Number.isNaN(Date.parse(iso))) return 'Next check-in lining up.';
  const now = nowISO && !Number.isNaN(Date.parse(nowISO)) ? Date.parse(nowISO) : Date.now();
  if (Date.parse(iso) <= now) return 'Still here whenever you’re ready.';
  return `Next up ${formatWhenLocal(iso, timezone, nowISO)}`;
}

/**
 * A warm "strongest day" anchor for the report's momentum shape — the piece the
 * sparkline can't say: WHICH day the 14-day window peaked, and how many words
 * were kept then. Second person, so it sits straight under the sparkline line in
 * the shared report text. The person's own twin of coach.js `clientNotePeakDayCopy`
 * (identical wording, kept module-local because report.js is upstream of coach.js).
 * Shown only for a genuine standout (a day with 2+ kept), so a week whose kept
 * days are all singles — or a quiet week — never gets an arbitrary "best day".
 * Anti-shame by construction, same law as detailPeakDayCopy: it celebrates a high
 * point and never sets it against now — "so far" frames the mark as still open to
 * being beaten, never "you were better before". Returns '' when there is no
 * standout to name.
 * @param {object} p { count, whenPhrase } peak.count and describePeakDay(peak.date)
 * @returns {string}
 */
export function reportPeakDayCopy({ count, whenPhrase } = {}) {
  const n = Number(count) || 0;
  const when = typeof whenPhrase === 'string' ? whenPhrase.trim() : '';
  if (n < 2 || !when) return '';
  return `Your strongest day so far: ${when} — ${n} words kept. 🔥`;
}

// ── REPORT BUILDER ───────────────────────────────────────────

/**
 * Build a per-user weekly report from plain data (no DB). The route supplies:
 * the kept-word streak row, the raw list of KEPT check-in instants (over at
 * least the momentum window), and the person's active rhythms with each one's
 * soonest outstanding check-in. Everything here is derived and warm.
 *
 * DESIGN LAW: `keptTimestamps` is KEPT instants ONLY — bucketing them yields a
 * genuine per-day win count where a quiet day is a real zero, never a miss.
 *
 * @param {object} p
 * @param {object} [p.streak]         { current_streak, longest_streak, total_kept }
 * @param {string[]} [p.keptTimestamps]  ISO instants of kept check-ins
 * @param {Array<object>} [p.rhythms]    [{ title, recurrence, local_time, timezone, next_checkin }]
 * @param {string} [p.timezone]        representative IANA zone for day boundaries
 * @param {string} [p.nowISO]          "today" anchor (defaults to now)
 * @returns {object} the structured report
 */
export function buildWeeklyReport({ streak = {}, keptTimestamps = [], deliveredTimestamps = [], rhythms = [], timezone, nowISO } = {}) {
  const tz = (typeof timezone === 'string' && timezone.trim()) ? timezone.trim() : 'UTC';
  const anchorISO = (nowISO && !Number.isNaN(Date.parse(nowISO))) ? nowISO : new Date().toISOString();

  const current = Number(streak.current_streak) || 0;
  const longest = Number(streak.longest_streak) || 0;
  const total = Number(streak.total_kept) || 0;

  // This week: bucket kept instants over the trailing 7 local days.
  const weekBuckets = bucketKeptByDay({ timestamps: keptTimestamps, days: WEEKLY_WINDOW_DAYS, nowISO: anchorISO, timezone: tz });
  let keptThisWeek = 0;
  let bestDay = weekBuckets[0] || { date: null, count: 0 };
  for (const b of weekBuckets) {
    keptThisWeek += b.count;
    if (b.count > bestDay.count) bestDay = b;
  }

  // The ally's side of the same week, on the SAME 7-local-day axis: how many
  // check-ins the bro actually delivered ("showed up"). A support signal, never
  // a scorecard — see showedUpCopy. Deliveries are distinct from kept words (a
  // delivered nudge may be kept, moved, or still open), so the two never merge.
  const deliveredBuckets = bucketKeptByDay({ timestamps: deliveredTimestamps, days: WEEKLY_WINDOW_DAYS, nowISO: anchorISO, timezone: tz });
  let showedUpThisWeek = 0;
  for (const b of deliveredBuckets) showedUpThisWeek += b.count;

  // 14-day momentum (first-person voice injected by the route via momentum copy;
  // here we build the neutral shape and let the route/text carry the words).
  const momentum = buildMomentumBlock({
    timestamps: keptTimestamps, days: MOMENTUM_WINDOW_DAYS, nowISO: anchorISO, timezone: tz,
  });

  // A warm anchor for that 14-day shape: WHICH day it peaked. Resolve the phrase
  // HERE, where anchorISO/tz are in scope, so "today"/"yesterday"/weekday agrees
  // exactly with the bars the sparkline draws (same trick the coach note uses).
  // Gated on a genuine 2+ standout by reportPeakDayCopy, so a flat or all-singles
  // week names no day at all — the absence of a callout, never a low-day note.
  const peakDayPhrase = describePeakDay(
    momentum && momentum.peak && momentum.peak.date,
    { nowISO: anchorISO, timezone: tz }
  );
  const peakDay = reportPeakDayCopy({
    count: momentum && momentum.peak && momentum.peak.count,
    whenPhrase: peakDayPhrase,
  });

  const activeCount = Array.isArray(rhythms) ? rhythms.length : 0;
  const rhythmRows = (Array.isArray(rhythms) ? rhythms : []).map((r) => ({
    title: r.title || 'Your word',
    cadence: describeCadence({ recurrence: r.recurrence, localTime: r.local_time }),
    next_checkin: r.next_checkin || null,
    next_checkin_label: rhythmNextCopy({ iso: r.next_checkin, timezone: r.timezone || tz, nowISO: anchorISO }),
  }));

  return {
    generated_at: anchorISO,
    timezone: tz,
    window: {
      since: weekBuckets[0].date,
      until: weekBuckets[weekBuckets.length - 1].date,
      days: WEEKLY_WINDOW_DAYS,
    },
    intro: reportIntroCopy(),
    headline: reportHeadlineCopy({ keptThisWeek, current }),
    kept_this_week: keptThisWeek,
    showed_up_this_week: showedUpThisWeek,
    showed_up_line: showedUpCopy({ showedUp: showedUpThisWeek }),
    best_day: { date: bestDay.date, count: bestDay.count },
    streak: { current_streak: current, longest_streak: longest, total_kept: total },
    // A milestone recognition for the report — the shareable/coach-proof twin of
    // the /me/ badge (R-255) and the coach-roster cue (R-256). Reuses the SAME
    // guaranteed-anti-shame helper: fires ONLY when the current kept-word run is
    // EXACTLY at a milestone (3/7/14/30/100), '' otherwise, so a between-milestone
    // week carries nothing — never a "not there yet" line in the artifact a person
    // hands their coach. Named count reached only; no gap, no distance-to-next.
    milestone: milestoneCopy({ streak: { current_streak: current } }),
    momentum,
    // The warm "strongest day" anchor for the momentum shape ('' unless a genuine
    // 2+ standout). Rendered directly under the sparkline in the shared text.
    peak_day: peakDay,
    rhythms_intro: rhythmsIntroCopy(activeCount),
    rhythms: rhythmRows,
    next_step: nextStepCopy({ keptThisWeek, activeCount, current }),
  };
}

/**
 * Render a weekly report as plain, coach-shareable text — the body used by
 * "Copy report", "Share with coach" (mailto), and the .txt download. No markup,
 * no "AI", kept-word framed throughout. Pure.
 * @param {object} report  a buildWeeklyReport() result
 * @param {object} [opts]  { heading }
 * @returns {string}
 */
export function renderReportText(report, { heading = 'FocusBro — weekly report' } = {}) {
  if (!report || typeof report !== 'object') return heading;
  const w = report.window || {};
  const s = report.streak || {};
  const lines = [];
  lines.push(heading);
  if (w.since && w.until) lines.push(`Week of ${w.since} to ${w.until}`);
  lines.push('');
  lines.push(report.headline || '');
  lines.push('');
  lines.push(`Words kept this week: ${Number(report.kept_this_week) || 0}`);
  lines.push(`Current kept-word run: ${Number(s.current_streak) || 0} (best ever: ${Number(s.longest_streak) || 0})`);
  lines.push(`Words kept, all time: ${Number(s.total_kept) || 0}`);
  // Milestone celebration rides with the run number it belongs to. Only present
  // when the run is exactly at a milestone; between milestones the line is absent,
  // never a "0" or a shortfall — same construction as the showed-up line below.
  if (report.milestone) lines.push(report.milestone);
  const showedUp = Number(report.showed_up_this_week) || 0;
  if (showedUp > 0) {
    lines.push(`FocusBro showed up for you: ${showedUp} time${showedUp === 1 ? '' : 's'} this week`);
  }
  if (report.momentum && report.momentum.sparkline) {
    lines.push('');
    lines.push(`Momentum (last ${report.momentum.days || MOMENTUM_WINDOW_DAYS} days): ${report.momentum.sparkline}`);
    // A warm anchor riding directly on the shape: which day it peaked. Present
    // only for a genuine standout (reportPeakDayCopy gates it), so a flat or
    // quiet window carries the sparkline alone — never a named low day.
    if (report.peak_day) lines.push(report.peak_day);
  }
  const rhythms = Array.isArray(report.rhythms) ? report.rhythms : [];
  lines.push('');
  lines.push(report.rhythms_intro || '');
  for (const r of rhythms) {
    const cad = r.cadence ? ` — ${r.cadence}` : '';
    const next = r.next_checkin_label ? `; ${r.next_checkin_label}` : '';
    lines.push(`- ${r.title}${cad}${next}`);
  }
  lines.push('');
  lines.push(report.next_step || '');
  lines.push('');
  lines.push('— Shared from FocusBro (focusbro.net)');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

// ── ROUTE ────────────────────────────────────────────────────
// Registered from index.js so the module-private auth helpers stay in one scope.

/**
 * Register the weekly-report API on an itty-router instance.
 * @param {object} router itty-router instance
 * @param {object} ctx  { getAuthToken, verifyToken, jsonResponse }
 */
export function registerReportRoutes(router, ctx) {
  const { getAuthToken, verifyToken, jsonResponse } = ctx;

  async function requireUser(request, env) {
    const token = getAuthToken(request);
    if (!token) return { error: jsonResponse({ error: 'Unauthorized' }, 401) };
    const payload = await verifyToken(token, env.JWT_SECRET);
    if (!payload) return { error: jsonResponse({ error: 'Invalid token' }, 401) };
    return { userId: payload.sub };
  }

  // ── GET my weekly report (kept-word summary, momentum, rhythms, next step) ──
  // Coach-proof artifact: returns both the structured report and a plain-text
  // rendering for copy / mailto / download. Momentum-only by construction — the
  // only check-in rows read are status='kept' (the win record) and OUTSTANDING
  // (pending/sent/deferred) future moments; no miss series is ever queried.
  router.get('/api/me/report', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;
      const nowISO = new Date().toISOString();

      const streak = await env.DB.prepare(
        `SELECT current_streak, longest_streak, total_kept, last_kept_date
           FROM accountability_streaks WHERE user_id = ?`
      ).bind(auth.userId).first() || { current_streak: 0, longest_streak: 0, total_kept: 0 };

      // Representative timezone: the most recently touched commitment zone.
      const tzRow = await env.DB.prepare(
        `SELECT timezone FROM commitments
          WHERE user_id = ? AND timezone IS NOT NULL AND timezone <> ''
          ORDER BY updated_at DESC LIMIT 1`
      ).bind(auth.userId).first();
      const timezone = (tzRow && tzRow.timezone) || 'UTC';

      // Kept instants over a slightly wider raw window than the 14-day momentum
      // axis (tz offsets can shift an instant across midnight); the builder trims.
      const windowCutoffISO = new Date(Date.parse(nowISO) - (MOMENTUM_WINDOW_DAYS + 2) * 86400000).toISOString();
      const keptRows = await env.DB.prepare(
        `SELECT responded_at FROM commitment_checkins
          WHERE user_id = ? AND status = 'kept' AND responded_at IS NOT NULL AND responded_at >= ?
          ORDER BY responded_at ASC
          LIMIT 1000`
      ).bind(auth.userId, windowCutoffISO).all();
      const keptTimestamps = ((keptRows && keptRows.results) || []).map((r) => r.responded_at);

      // The ally's showings-up: first-party 'checkin_delivered' events for THIS
      // user (the moment the bro rang). Same wide raw window as kept instants;
      // buildWeeklyReport buckets to the trailing 7 local days. A support signal,
      // never a miss series — see showedUpCopy's design-LAW note.
      const deliveredRows = await env.DB.prepare(
        `SELECT created_at FROM analytics_events
          WHERE user_id = ? AND event_type = ? AND created_at >= ?
          ORDER BY created_at ASC
          LIMIT 1000`
      ).bind(auth.userId, EVENTS.CHECKIN_DELIVERED, windowCutoffISO).all();
      const deliveredTimestamps = ((deliveredRows && deliveredRows.results) || []).map((r) => r.created_at);

      // Active rhythms + the soonest OUTSTANDING check-in per commitment (one
      // grouped query, not N+1). Outstanding = a future moment about to be kept.
      const commitmentsRes = await env.DB.prepare(
        `SELECT id, title, recurrence, local_time, timezone
           FROM commitments
          WHERE user_id = ? AND status = 'active'
          ORDER BY start_at ASC
          LIMIT 100`
      ).bind(auth.userId).all();
      const commitments = (commitmentsRes && commitmentsRes.results) || [];

      const nextByCommitment = {};
      if (commitments.length) {
        const nextRows = await env.DB.prepare(
          `SELECT commitment_id, MIN(scheduled_for) AS next_for
             FROM commitment_checkins
            WHERE user_id = ? AND status IN ('pending', 'sent', 'deferred')
            GROUP BY commitment_id`
        ).bind(auth.userId).all();
        for (const r of (nextRows && nextRows.results) || []) {
          nextByCommitment[r.commitment_id] = r.next_for;
        }
      }

      const rhythms = commitments.map((c) => ({
        title: c.title,
        recurrence: c.recurrence || 'none',
        local_time: c.local_time || null,
        timezone: c.timezone || timezone,
        next_checkin: nextByCommitment[c.id] || null,
      }));

      const report = buildWeeklyReport({ streak, keptTimestamps, deliveredTimestamps, rhythms, timezone, nowISO });
      const text = renderReportText(report);

      return jsonResponse({ report, text }, 200, 'nocache');
    } catch (err) {
      console.error('[report] weekly report error:', err && err.message);
      return jsonResponse({ error: 'Could not build your weekly report just now.' }, 500);
    }
  });
}

/**
 * The /me/report page shell. A calm, standalone reading surface that loads the
 * signed-in person's report from /api/me/report (Bearer token from
 * localStorage, same as /me/ and /coach/) and offers Copy + Share-with-coach.
 * Static HTML string — served by the route in index.js.
 * @returns {string} full HTML document
 */
export function renderReportPage() {
  return `${pageHead({ title: 'Weekly report — FocusBro', description: 'Your week, in the words you kept — copy it or share it with your coach.', maxWidth: 720 })}
<body>
${pageNav([{ href: '/me/', label: 'Your words' }, { href: '/', label: 'Home' }, { href: '/coach/', label: 'Coach view' }])}
<h1>Weekly report</h1>
<p class="intro" id="intro">Your week, in the words you kept.</p>

<div id="signin" class="card hidden">
  <p class="muted">Sign in on <a href="/me/">your words</a> first, then come back for your report.</p>
</div>

<div id="report" class="hidden">
  <div class="card">
    <p class="headline" id="headline"></p>
    <div class="stats">
      <div class="stat"><b id="s-week">0</b><small>kept this week</small></div>
      <div class="stat"><b id="s-run">0</b><small>current run</small></div>
      <div class="stat"><b id="s-total">0</b><small>kept all time</small></div>
    </div>
    <div class="spark" id="spark" aria-hidden="true"></div>
    <p class="momentum-summary" id="momentum-summary"></p>
    <p class="showed-up" id="showed-up"></p>
    <p class="streakmilestone hidden" id="milestone"></p>
  </div>

  <div class="card">
    <p class="muted" id="rhythms-intro" style="margin-top:0;"></p>
    <div id="rhythms"></div>
  </div>

  <p class="next-step" id="next-step"></p>

  <div class="actions">
    <button id="copy">Copy report</button>
    <button id="share" class="secondary">Share with coach</button>
    <button id="download" class="secondary">Download (.txt)</button>
  </div>
  <p class="muted" id="action-note"></p>
</div>

<p class="err hidden" id="err"></p>
<p class="footnote">Kept-word only, always. A quiet day is just quiet — we only ever count the wins. FocusBro is built by Latimer Woods Tech.</p>

<script>
(function () {
  var token = null;
  try { token = localStorage.getItem('focusbro_token'); } catch (e) { token = null; }
  var reportText = '';

  var el = function (id) { return document.getElementById(id); };
  function show(id) { el(id).classList.remove('hidden'); }
  function hide(id) { el(id).classList.add('hidden'); }

  if (!token) { show('signin'); return; }

  fetch('/api/me/report', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(function (r) {
      if (r.status === 401) { show('signin'); throw new Error('signin'); }
      if (!r.ok) throw new Error('load');
      return r.json();
    })
    .then(function (data) {
      var rep = data && data.report;
      if (!rep) throw new Error('load');
      reportText = (data && data.text) || '';

      el('intro').textContent = rep.intro || 'Your week, in the words you kept.';
      el('headline').textContent = rep.headline || '';
      el('s-week').textContent = String(rep.kept_this_week || 0);
      el('s-run').textContent = String((rep.streak && rep.streak.current_streak) || 0);
      el('s-total').textContent = String((rep.streak && rep.streak.total_kept) || 0);

      var mo = rep.momentum || {};
      var buckets = (mo.buckets) || [];
      var maxCount = 0;
      for (var i = 0; i < buckets.length; i++) { if (buckets[i].count > maxCount) maxCount = buckets[i].count; }
      var spark = el('spark');
      spark.innerHTML = '';
      for (var j = 0; j < buckets.length; j++) {
        var c = buckets[j].count || 0;
        var bar = document.createElement('div');
        bar.className = 'spark-bar' + (c === 0 ? ' zero' : '');
        var h = maxCount > 0 && c > 0 ? Math.max(10, Math.round((c / maxCount) * 100)) : 6;
        bar.style.height = h + '%';
        bar.title = buckets[j].date + ': ' + c;
        spark.appendChild(bar);
      }
      el('momentum-summary').textContent = mo.summary || '';

      // Mutual-accountability line: the bro kept its word too. Hidden entirely
      // when there's nothing yet — a quiet page, never a "0 times" negative.
      var showedUpLine = rep.showed_up_line || '';
      var suEl = el('showed-up');
      if (showedUpLine) { suEl.textContent = showedUpLine; suEl.classList.remove('hidden'); }
      else { suEl.textContent = ''; suEl.classList.add('hidden'); }

      // Milestone celebration — shown only when the run is exactly at a milestone;
      // hidden entirely otherwise, so a between-milestone week is a clean page.
      var milestoneLine = rep.milestone || '';
      var miEl = el('milestone');
      if (milestoneLine) { miEl.textContent = milestoneLine; miEl.classList.remove('hidden'); }
      else { miEl.textContent = ''; miEl.classList.add('hidden'); }

      el('rhythms-intro').textContent = rep.rhythms_intro || '';
      var rh = el('rhythms');
      rh.innerHTML = '';
      var rhythms = rep.rhythms || [];
      for (var k = 0; k < rhythms.length; k++) {
        var row = document.createElement('div');
        row.className = 'rhythm-row';
        var left = document.createElement('div');
        var t = document.createElement('div'); t.className = 'rhythm-title'; t.textContent = rhythms[k].title || 'Your word';
        var nx = document.createElement('div'); nx.className = 'rhythm-next'; nx.textContent = rhythms[k].next_checkin_label || '';
        left.appendChild(t); left.appendChild(nx);
        var cad = document.createElement('div'); cad.className = 'rhythm-cadence'; cad.textContent = rhythms[k].cadence || '';
        row.appendChild(left); row.appendChild(cad);
        rh.appendChild(row);
      }

      el('next-step').textContent = rep.next_step || '';
      show('report');
    })
    .catch(function (e) {
      if (e && e.message === 'signin') return;
      el('err').textContent = 'Could not load your report just now. Try again in a moment.';
      show('err');
    });

  el('copy').addEventListener('click', function () {
    if (!reportText) return;
    var done = function () { el('action-note').textContent = 'Copied — paste it wherever you like.'; };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(reportText).then(done, function () { el('action-note').textContent = 'Select the text and copy it manually.'; });
    } else {
      el('action-note').textContent = 'Copy not supported here — use Download instead.';
    }
  });

  // Share with coach. On a phone the native share sheet (navigator.share) reaches
  // text, WhatsApp, or email — the channels a person actually uses to get their
  // week to their coach. Where Web Share isn't available (most desktop browsers)
  // it degrades to the same pre-filled mailto: as before. Parity with the coach
  // page's "Share note" (index.js). No recipient is set either way.
  el('share').addEventListener('click', function () {
    if (!reportText) return;
    var subjectText = 'My FocusBro weekly report';
    var sendByEmail = function () {
      var subject = encodeURIComponent(subjectText);
      var body = encodeURIComponent(reportText);
      window.location.href = 'mailto:?subject=' + subject + '&body=' + body;
      el('action-note').textContent = 'Opening your email — your report is ready to send.';
    };
    var data = { title: subjectText, text: reportText };
    if (navigator.share && (!navigator.canShare || navigator.canShare(data))) {
      navigator.share(data).then(function () {
        el('action-note').textContent = 'Shared — your report is on its way.';
      }, function (err) {
        // A cancelled share sheet is not a failure — say nothing, leave the report
        // in place. Only a genuine Web Share error degrades to email.
        if (err && err.name === 'AbortError') { el('action-note').textContent = ''; return; }
        sendByEmail();
      });
    } else {
      sendByEmail();
    }
  });

  el('download').addEventListener('click', function () {
    if (!reportText) return;
    try {
      var blob = new Blob([reportText], { type: 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'focusbro-weekly-report.txt';
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    } catch (e) {
      el('action-note').textContent = 'Download not supported here — use Copy instead.';
    }
  });
})();
</script>
</body></html>`;
}
