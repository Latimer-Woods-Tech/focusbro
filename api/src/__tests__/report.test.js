/**
 * FocusBro — Weekly report tests (Contender #10, Phase A · R-237).
 *
 * The coach-proof artifact (docs/IMPROVEMENT_PLAN.md, L2 — the keystone): turn
 * the loop's kept-word signals into a per-user weekly summary that renders and
 * exports as shareable text. These tests exercise the pure builder and the text
 * renderer with no DB, and — critically — extend the ONE design LAW to the
 * report: every copy path is asserted free of shame, "AI", and any clinical
 * claim. A weekly report is exactly where a quiet week could be scored as a wall
 * of misses; the copy-law test below fails the build if any string does that.
 */

import { describe, it, expect } from 'vitest';
import {
  WEEKLY_WINDOW_DAYS,
  reportIntroCopy,
  reportHeadlineCopy,
  nextStepCopy,
  showedUpCopy,
  rhythmsIntroCopy,
  rhythmNextCopy,
  buildWeeklyReport,
  renderReportText,
} from '../report.js';

const NOW = '2026-07-13T12:00:00Z';

// Build ISO instants for "N days ago at noon UTC" so the 7-day bucketer lands
// them on known local (UTC) days.
function daysAgo(n) {
  return new Date(Date.parse(NOW) - n * 86400000).toISOString();
}

describe('WEEKLY_WINDOW_DAYS', () => {
  it('is a trailing week', () => {
    expect(WEEKLY_WINDOW_DAYS).toBe(7);
  });
});

describe('buildWeeklyReport — kept-this-week math', () => {
  it('counts only kept instants inside the trailing 7 local days', () => {
    // 3 this week (0,2,6 days ago), 2 older (8, 10 days ago — outside the week).
    const keptTimestamps = [daysAgo(0), daysAgo(2), daysAgo(6), daysAgo(8), daysAgo(10)];
    const rep = buildWeeklyReport({
      streak: { current_streak: 3, longest_streak: 9, total_kept: 40 },
      keptTimestamps,
      rhythms: [],
      timezone: 'UTC',
      nowISO: NOW,
    });
    expect(rep.kept_this_week).toBe(3);
    expect(rep.streak).toEqual({ current_streak: 3, longest_streak: 9, total_kept: 40 });
    // window ends today, spans 7 days.
    expect(rep.window.days).toBe(7);
    expect(rep.window.until).toBe('2026-07-13');
    expect(rep.window.since).toBe('2026-07-07');
  });

  it('surfaces the best single day of the week', () => {
    // two kept on the same day (2 days ago), one today.
    const keptTimestamps = [daysAgo(2), daysAgo(2), daysAgo(0)];
    const rep = buildWeeklyReport({ keptTimestamps, timezone: 'UTC', nowISO: NOW });
    expect(rep.kept_this_week).toBe(3);
    expect(rep.best_day.count).toBe(2);
    expect(rep.best_day.date).toBe('2026-07-11');
  });

  it('a quiet week is a genuine zero, never negative or NaN', () => {
    const rep = buildWeeklyReport({ keptTimestamps: [], timezone: 'UTC', nowISO: NOW });
    expect(rep.kept_this_week).toBe(0);
    expect(rep.best_day.count).toBe(0);
    expect(rep.streak).toEqual({ current_streak: 0, longest_streak: 0, total_kept: 0 });
    // momentum still renders a flat baseline, never an empty/undefined shape.
    expect(typeof rep.momentum.sparkline).toBe('string');
    expect(rep.momentum.sparkline.length).toBe(14);
  });

  it('maps active rhythms with a cadence and a forward next-up line', () => {
    const rep = buildWeeklyReport({
      keptTimestamps: [],
      rhythms: [
        { title: 'Taxes', recurrence: 'none', local_time: null, timezone: 'UTC', next_checkin: daysAgo(-1) },
        { title: 'Gym', recurrence: 'daily', local_time: '08:40', timezone: 'UTC', next_checkin: null },
      ],
      timezone: 'UTC',
      nowISO: NOW,
    });
    expect(rep.rhythms).toHaveLength(2);
    expect(rep.rhythms[0].title).toBe('Taxes');
    expect(rep.rhythms[0].next_checkin_label).toMatch(/^Next up /);
    expect(rep.rhythms[1].cadence.length).toBeGreaterThan(0);
    // no next check-in queued yet reads as forward, never overdue.
    expect(rep.rhythms[1].next_checkin_label.toLowerCase()).toMatch(/lining up|whenever/);
  });
});

describe('buildWeeklyReport — "the bro showed up" (delivered check-ins this week)', () => {
  it('counts only delivered instants inside the same trailing 7 local days', () => {
    // 4 deliveries this week (0,1,3,6 days ago), 2 older (9, 12 — outside).
    const deliveredTimestamps = [daysAgo(0), daysAgo(1), daysAgo(3), daysAgo(6), daysAgo(9), daysAgo(12)];
    const rep = buildWeeklyReport({ keptTimestamps: [], deliveredTimestamps, timezone: 'UTC', nowISO: NOW });
    expect(rep.showed_up_this_week).toBe(4);
    expect(rep.showed_up_line).toContain('4 times');
    expect(rep.showed_up_line).toMatch(/kept its word too/);
  });

  it('is singular for exactly one showing-up', () => {
    const rep = buildWeeklyReport({ deliveredTimestamps: [daysAgo(1)], timezone: 'UTC', nowISO: NOW });
    expect(rep.showed_up_this_week).toBe(1);
    expect(rep.showed_up_line).toContain('1 time this week');
    expect(rep.showed_up_line).not.toContain('1 times');
  });

  it('hides the line entirely when the bro has not shown up yet this week (no "0 times")', () => {
    const rep = buildWeeklyReport({ deliveredTimestamps: [], timezone: 'UTC', nowISO: NOW });
    expect(rep.showed_up_this_week).toBe(0);
    expect(rep.showed_up_line).toBe('');
  });

  it('is independent from kept-word count (a delivery is not a kept word)', () => {
    // one kept word, three deliveries — the two numbers do not merge.
    const rep = buildWeeklyReport({
      keptTimestamps: [daysAgo(1)],
      deliveredTimestamps: [daysAgo(0), daysAgo(1), daysAgo(2)],
      timezone: 'UTC', nowISO: NOW,
    });
    expect(rep.kept_this_week).toBe(1);
    expect(rep.showed_up_this_week).toBe(3);
  });
});

describe('showedUpCopy — support signal, never a scorecard', () => {
  it('is empty at zero (a quiet page, not a negative)', () => {
    expect(showedUpCopy({ showedUp: 0 })).toBe('');
    expect(showedUpCopy({})).toBe('');
    expect(showedUpCopy({ showedUp: -3 })).toBe('');
  });
  it('names the ally keeping its word, in the person’s favour', () => {
    const s = showedUpCopy({ showedUp: 5 });
    expect(s).toContain('showed up for you 5 times');
    expect(s).toMatch(/kept its word too/);
  });
});

describe('rhythmNextCopy', () => {
  it('names a concrete future moment', () => {
    const s = rhythmNextCopy({ iso: '2026-07-14T13:40:00Z', timezone: 'UTC', nowISO: NOW });
    expect(s).toMatch(/^Next up /);
    expect(s).toMatch(/\b(AM|PM)\b/);
  });
  it('holds the door open (never "overdue") when the moment has passed', () => {
    const s = rhythmNextCopy({ iso: '2026-07-12T13:40:00Z', timezone: 'UTC', nowISO: NOW });
    expect(s.toLowerCase()).toMatch(/whenever you.?re ready/);
  });
  it('stays forward-looking with no moment queued', () => {
    expect(rhythmNextCopy({ iso: null }).toLowerCase()).toMatch(/lining up/);
  });
});

describe('renderReportText — shareable plain text', () => {
  it('carries the headline, the numbers, the sparkline, and the next step', () => {
    const rep = buildWeeklyReport({
      streak: { current_streak: 3, longest_streak: 9, total_kept: 40 },
      keptTimestamps: [daysAgo(0), daysAgo(2), daysAgo(6)],
      deliveredTimestamps: [daysAgo(0), daysAgo(2)],
      rhythms: [{ title: 'Taxes', recurrence: 'none', local_time: null, timezone: 'UTC', next_checkin: daysAgo(-1) }],
      timezone: 'UTC',
      nowISO: NOW,
    });
    const text = renderReportText(rep);
    expect(text).toContain('FocusBro — weekly report');
    expect(text).toContain('Words kept this week: 3');
    expect(text).toContain('Current kept-word run: 3 (best ever: 9)');
    expect(text).toContain('Words kept, all time: 40');
    expect(text).toContain('FocusBro showed up for you: 2 times this week');
    expect(text).toMatch(/Momentum \(last 14 days\): /);
    expect(text).toContain('- Taxes');
    expect(text).toContain('One tiny next step:');
    expect(text).toContain('focusbro.net');
    // never a triple blank line (renderer collapses runs).
    expect(text).not.toMatch(/\n{3,}/);
  });

  it('degrades safely on a null report', () => {
    expect(renderReportText(null)).toBe('FocusBro — weekly report');
  });
});

describe('copy law — a weekly report never reads shame, "AI", or a clinical claim', () => {
  const SHAME_PATTERNS = [
    /\bfail(ed|ure|ing|s)?\b/i,
    /\blaz(y|iness)\b/i,
    /\bdisappoint/i,
    /\bguilt/i,
    /\bashamed\b/i,
    /\bshame\b/i,
    /\bslipping\b/i,
    /\bfall(ing|en)? behind\b/i,
    /\bbehind\b/i,
    /\bmiss(es|ed|ing)?\b/i,
    /\bexcuse/i,
    /\bpathetic\b/i,
    /\bworthless\b/i,
  ];
  const CLINICAL_PATTERNS = [/\btreat(s|ment|ing)?\b/i, /\bcure/i, /\bdiagnos/i, /\bdisorder/i, /\bsymptom/i, /\bADHD\b/i, /\bmedication\b/i];
  const AI_WORD = /\bAI\b/;

  const samples = [
    reportIntroCopy(),
    reportHeadlineCopy({ keptThisWeek: 0, current: 0 }),
    reportHeadlineCopy({ keptThisWeek: 1, current: 0 }),
    reportHeadlineCopy({ keptThisWeek: 5, current: 3 }),
    nextStepCopy({ keptThisWeek: 0, activeCount: 0, current: 0 }),
    nextStepCopy({ keptThisWeek: 0, activeCount: 2, current: 0 }),
    nextStepCopy({ keptThisWeek: 4, activeCount: 2, current: 4 }),
    showedUpCopy({ showedUp: 1 }),
    showedUpCopy({ showedUp: 6 }),
    rhythmsIntroCopy(0),
    rhythmsIntroCopy(3),
    rhythmNextCopy({ iso: '2026-07-14T13:40:00Z', timezone: 'UTC', nowISO: NOW }),
    rhythmNextCopy({ iso: '2026-07-12T13:40:00Z', timezone: 'UTC', nowISO: NOW }),
    rhythmNextCopy({ iso: null }),
  ];

  it('produces non-empty strings for every report copy path', () => {
    for (const s of samples) {
      expect(typeof s).toBe('string');
      expect(s.trim().length).toBeGreaterThan(0);
    }
  });

  it('never emits a shaming word', () => {
    for (const s of samples) {
      for (const pat of SHAME_PATTERNS) {
        expect(pat.test(s), `shaming report copy: "${s}" matched ${pat}`).toBe(false);
      }
    }
  });

  it('never emits the word "AI"', () => {
    for (const s of samples) {
      expect(AI_WORD.test(s), `"AI" leaked into report copy: "${s}"`).toBe(false);
    }
  });

  it('never makes a clinical or treatment claim', () => {
    for (const s of samples) {
      for (const pat of CLINICAL_PATTERNS) {
        expect(pat.test(s), `clinical claim in report copy: "${s}" matched ${pat}`).toBe(false);
      }
    }
  });

  it('the full rendered report text is also clean', () => {
    const rep = buildWeeklyReport({
      streak: { current_streak: 2, longest_streak: 5, total_kept: 12 },
      keptTimestamps: [daysAgo(1)],
      deliveredTimestamps: [daysAgo(1), daysAgo(2)],
      rhythms: [{ title: 'Write', recurrence: 'weekdays', local_time: '09:05', timezone: 'UTC', next_checkin: daysAgo(-1) }],
      timezone: 'UTC',
      nowISO: NOW,
    });
    const text = renderReportText(rep);
    for (const pat of [...SHAME_PATTERNS, ...CLINICAL_PATTERNS, AI_WORD]) {
      expect(pat.test(text), `rendered report text matched ${pat}`).toBe(false);
    }
  });
});
