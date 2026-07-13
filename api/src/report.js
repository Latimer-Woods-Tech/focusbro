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

import { describeCadence, formatWhenLocal } from './accountability.js';
import {
  MOMENTUM_WINDOW_DAYS,
  bucketKeptByDay,
  buildMomentum as buildMomentumBlock,
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
export function buildWeeklyReport({ streak = {}, keptTimestamps = [], rhythms = [], timezone, nowISO } = {}) {
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

  // 14-day momentum (first-person voice injected by the route via momentum copy;
  // here we build the neutral shape and let the route/text carry the words).
  const momentum = buildMomentumBlock({
    timestamps: keptTimestamps, days: MOMENTUM_WINDOW_DAYS, nowISO: anchorISO, timezone: tz,
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
    best_day: { date: bestDay.date, count: bestDay.count },
    streak: { current_streak: current, longest_streak: longest, total_kept: total },
    momentum,
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
  if (report.momentum && report.momentum.sparkline) {
    lines.push('');
    lines.push(`Momentum (last ${report.momentum.days || MOMENTUM_WINDOW_DAYS} days): ${report.momentum.sparkline}`);
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

      const report = buildWeeklyReport({ streak, keptTimestamps, rhythms, timezone, nowISO });
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
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex, nofollow" />
<title>Weekly report — FocusBro</title>
<meta name="description" content="Your week, in the words you kept — copy it or share it with your coach." />
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; max-width: 720px; margin: 0 auto; padding: 24px; line-height: 1.55; color: #111827; }
  a { color: #4f46e5; }
  h1 { margin-bottom: 4px; }
  .intro { color: #4b5563; margin-top: 0; }
  .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px 18px; margin: 14px 0; }
  .headline { font-size: 18px; font-weight: 600; margin: 0 0 6px; }
  .stats { display: flex; gap: 18px; flex-wrap: wrap; margin: 10px 0 2px; }
  .stat { text-align: center; }
  .stat b { display: block; font-size: 26px; font-weight: 700; color: #4f46e5; line-height: 1.1; }
  .stat small { color: #6b7280; font-size: 12px; }
  .spark { display: flex; align-items: flex-end; gap: 3px; height: 44px; margin: 8px 0 4px; }
  .spark-bar { flex: 1 1 0; min-width: 4px; background: #4f46e5; border-radius: 2px 2px 0 0; min-height: 3px; opacity: .85; }
  .spark-bar.zero { background: #e5e7eb; }
  .momentum-summary { color: #4b5563; font-size: 13px; margin: 2px 0; }
  .rhythm-row { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; font-size: 14px; border-top: 1px dashed #e5e7eb; }
  .rhythm-row:first-of-type { border-top: none; }
  .rhythm-title { color: #111827; }
  .rhythm-cadence { color: #4f46e5; white-space: nowrap; }
  .rhythm-next { color: #6b7280; font-size: 13px; }
  .next-step { background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 10px; padding: 12px 14px; color: #3730a3; margin-top: 12px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 16px 0; }
  button { font-size: 15px; padding: 9px 14px; border-radius: 8px; border: none; background: #4f46e5; color: #fff; cursor: pointer; }
  button.secondary { background: #f3f4f6; color: #374151; border: 1px solid #d1d5db; }
  .muted { color: #6b7280; font-size: 13px; }
  .err { color: #b91c1c; font-size: 14px; }
  .hidden { display: none; }
  .footnote { margin-top: 28px; font-size: 13px; color: #6b7280; border-top: 1px solid #e5e7eb; padding-top: 14px; }
</style></head>
<body>
<nav style="font-size:14px;color:#374151;"><a href="/me/">Your words</a> | <a href="/">Home</a> | <a href="/coach/">Coach view</a></nav>
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

  el('share').addEventListener('click', function () {
    if (!reportText) return;
    var subject = encodeURIComponent('My FocusBro weekly report');
    var body = encodeURIComponent(reportText);
    window.location.href = 'mailto:?subject=' + subject + '&body=' + body;
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
