/**
 * FocusBro — Coach roster tests (Contender track, issue #10, Phase A).
 * Covers the pure helpers (label/email validation) and, critically, extends
 * the ONE design LAW — never shame — to the coach's view of a client. A
 * dashboard is exactly where misses could get tallied into a "who's slipping"
 * list; the copy-law test below fails the build if any roster string does that.
 */

import { describe, it, expect } from 'vitest';
import {
  COACH_LINK_STATES,
  normalizeClientLabel,
  looksLikeEmail,
  dashboardIntroCopy,
  clientStatusLine,
  rosterEmptyCopy,
  invitePendingCopy,
  inviteSentCopy,
  rhythmIntroCopy,
  rhythmEmptyCopy,
  nextCheckinCopy,
  MOMENTUM_WINDOW_DAYS,
  localDayInZone,
  bucketKeptByDay,
  sparklineBars,
  momentumIntroCopy,
  momentumSummaryCopy,
  buildMomentum,
} from '../coach.js';
import { describeCadence } from '../accountability.js';

describe('coach link states', () => {
  it('exposes the four link states', () => {
    expect(COACH_LINK_STATES).toEqual(['pending', 'active', 'declined', 'removed']);
  });
});

describe('normalizeClientLabel', () => {
  it('trims and caps length; non-strings become empty', () => {
    expect(normalizeClientLabel('  Sam  ')).toBe('Sam');
    expect(normalizeClientLabel(undefined)).toBe('');
    expect(normalizeClientLabel(42)).toBe('');
    expect(normalizeClientLabel('x'.repeat(200)).length).toBe(120);
  });
});

describe('looksLikeEmail', () => {
  it('accepts plausible emails and rejects junk', () => {
    expect(looksLikeEmail('a@b.co')).toBe(true);
    expect(looksLikeEmail('  someone@example.com  ')).toBe(true);
    expect(looksLikeEmail('nope')).toBe(false);
    expect(looksLikeEmail('a@b')).toBe(false);
    expect(looksLikeEmail('')).toBe(false);
    expect(looksLikeEmail(null)).toBe(false);
  });
});

describe('clientStatusLine — kept-word momentum, never a miss tally', () => {
  it('a fresh client (never kept, no best) reads as a clean page', () => {
    const s = clientStatusLine({ streak: { current_streak: 0, longest_streak: 0 } });
    expect(s.toLowerCase()).toMatch(/start|clean page/);
  });
  it('a reset streak with a prior best reads as an open page, not a slip', () => {
    const s = clientStatusLine({ streak: { current_streak: 0, longest_streak: 7 } });
    expect(s.toLowerCase()).toContain('open page');
  });
  it('an active streak names the momentum and the best', () => {
    const s = clientStatusLine({ streak: { current_streak: 3, longest_streak: 9 } });
    expect(s).toContain('3 kept words in a row');
    expect(s).toContain('their best is 9');
  });
  it('handles missing/garbage streak input without throwing', () => {
    expect(typeof clientStatusLine()).toBe('string');
    expect(typeof clientStatusLine({ streak: null })).toBe('string');
  });
});

describe('describeCadence — the client rhythm a coach sees, read-only', () => {
  it('labels a one-shot commitment', () => {
    expect(describeCadence({ recurrence: 'none', localTime: '08:40' })).toBe('One-time');
    expect(describeCadence({ recurrence: 'none' })).toBe('One-time');
  });
  it('labels a daily cadence with and without a local time', () => {
    expect(describeCadence({ recurrence: 'daily', localTime: '08:40' })).toBe('Every day at 08:40');
    expect(describeCadence({ recurrence: 'daily' })).toBe('Every day');
  });
  it('labels a weekdays cadence with and without a local time', () => {
    expect(describeCadence({ recurrence: 'weekdays', localTime: '9:05' })).toBe('Weekdays at 09:05');
    expect(describeCadence({ recurrence: 'weekdays' })).toBe('Weekdays');
  });
  it('is total — garbage recurrence falls back to one-shot, no throw', () => {
    expect(describeCadence({ recurrence: 'wat', localTime: 'nope' })).toBe('One-time');
    expect(describeCadence()).toBe('One-time');
    expect(describeCadence({ recurrence: 'daily', localTime: '25:99' })).toBe('Every day');
  });
});

describe('nextCheckinCopy — the concrete next moment the bro shows up', () => {
  const nowISO = '2026-07-11T12:00:00Z';
  it('phrases a same-day check-in as "Next up at <time>"', () => {
    const s = nextCheckinCopy({ iso: '2026-07-11T20:00:00Z', timezone: 'UTC', nowISO });
    expect(s).toMatch(/^Next up /);
    expect(s).toMatch(/\b(AM|PM)\b/);
    expect(s).not.toMatch(/tomorrow/i);
  });
  it('phrases a next-day check-in as "Next up tomorrow at <time>"', () => {
    const s = nextCheckinCopy({ iso: '2026-07-12T13:40:00Z', timezone: 'UTC', nowISO });
    expect(s).toMatch(/^Next up tomorrow /);
    expect(s).toMatch(/\b(AM|PM)\b/);
  });
  it('stays warm and forward-looking when nothing is scheduled yet', () => {
    const s = nextCheckinCopy({ iso: null, timezone: 'UTC', nowISO });
    expect(s.toLowerCase()).toContain('lining up');
    expect(s.toLowerCase()).not.toContain('overdue');
  });
  it('treats a garbage instant as nothing-scheduled, never throwing', () => {
    expect(typeof nextCheckinCopy({ iso: 'not-a-date', timezone: 'UTC', nowISO })).toBe('string');
    expect(typeof nextCheckinCopy()).toBe('string');
  });
});

// ── THE DESIGN LAW extends to the coach's view ───────────────
describe('copy law — a coach never reads shame, "AI", or a clinical claim', () => {
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
    dashboardIntroCopy(),
    rosterEmptyCopy(),
    invitePendingCopy(),
    inviteSentCopy({ email: 'a@b.co' }),
    inviteSentCopy({}),
    clientStatusLine({ streak: { current_streak: 0, longest_streak: 0 } }),
    clientStatusLine({ streak: { current_streak: 0, longest_streak: 5 } }),
    clientStatusLine({ streak: { current_streak: 1, longest_streak: 1 } }),
    clientStatusLine({ streak: { current_streak: 12, longest_streak: 20 } }),
    rhythmIntroCopy(),
    rhythmEmptyCopy(),
    momentumIntroCopy(),
    momentumSummaryCopy({ total: 0, days: 14 }),
    momentumSummaryCopy({ total: 1, days: 14, peak: { count: 1 } }),
    momentumSummaryCopy({ total: 9, days: 14, peak: { count: 3 } }),
    nextCheckinCopy({ iso: '2026-07-11T20:00:00Z', timezone: 'UTC', nowISO: '2026-07-11T12:00:00Z' }),
    nextCheckinCopy({ iso: '2026-07-12T13:40:00Z', timezone: 'UTC', nowISO: '2026-07-11T12:00:00Z' }),
    nextCheckinCopy({ iso: null }),
    describeCadence({ recurrence: 'none' }),
    describeCadence({ recurrence: 'daily', localTime: '08:40' }),
    describeCadence({ recurrence: 'weekdays', localTime: '09:05' }),
  ];

  it('produces non-empty strings for every roster copy path', () => {
    for (const s of samples) {
      expect(typeof s).toBe('string');
      expect(s.trim().length).toBeGreaterThan(0);
    }
  });

  it('never emits a shaming word', () => {
    for (const s of samples) {
      for (const pat of SHAME_PATTERNS) {
        expect(pat.test(s), `shaming coach copy: "${s}" matched ${pat}`).toBe(false);
      }
    }
  });

  it('never emits the word "AI"', () => {
    for (const s of samples) {
      expect(AI_WORD.test(s), `"AI" leaked into coach copy: "${s}"`).toBe(false);
    }
  });

  it('never makes a clinical or treatment claim', () => {
    for (const s of samples) {
      for (const pat of CLINICAL_PATTERNS) {
        expect(pat.test(s), `clinical claim in coach copy: "${s}" matched ${pat}`).toBe(false);
      }
    }
  });
});

describe('localDayInZone', () => {
  it('returns the UTC calendar date for a UTC zone', () => {
    expect(localDayInZone('2026-07-11T23:30:00Z', 'UTC')).toBe('2026-07-11');
  });
  it('shifts an instant into the correct local day west of UTC', () => {
    // 02:30 UTC on the 12th is still the evening of the 11th in New York.
    expect(localDayInZone('2026-07-12T02:30:00Z', 'America/New_York')).toBe('2026-07-11');
  });
  it('shifts an instant into the next local day east of UTC', () => {
    // 22:30 UTC on the 11th is already the 12th in Tokyo.
    expect(localDayInZone('2026-07-11T22:30:00Z', 'Asia/Tokyo')).toBe('2026-07-12');
  });
  it('returns null for an unparseable instant', () => {
    expect(localDayInZone('not-a-date', 'UTC')).toBe(null);
  });
});

describe('bucketKeptByDay — per-day KEPT counts, momentum by construction', () => {
  const now = '2026-07-11T18:00:00Z';

  it('produces exactly `days` buckets, oldest→newest, ending today', () => {
    const b = bucketKeptByDay({ timestamps: [], days: 14, nowISO: now, timezone: 'UTC' });
    expect(b).toHaveLength(14);
    expect(b[13].date).toBe('2026-07-11');
    expect(b[0].date).toBe('2026-06-28');
    expect(b.every((d) => d.count === 0)).toBe(true);
  });

  it('counts multiple kept words on the same day into one bucket', () => {
    const b = bucketKeptByDay({
      timestamps: ['2026-07-11T09:00:00Z', '2026-07-11T14:00:00Z', '2026-07-10T10:00:00Z'],
      days: 14, nowISO: now, timezone: 'UTC',
    });
    expect(b[13].count).toBe(2); // today
    expect(b[12].count).toBe(1); // yesterday
  });

  it('ignores instants outside the window', () => {
    const b = bucketKeptByDay({
      timestamps: ['2026-05-01T09:00:00Z'], days: 14, nowISO: now, timezone: 'UTC',
    });
    expect(b.reduce((n, d) => n + d.count, 0)).toBe(0);
  });

  it('buckets by LOCAL day, not UTC day', () => {
    // 02:30 UTC on the 12th → evening of the 11th in New York → today's bucket.
    const b = bucketKeptByDay({
      timestamps: ['2026-07-12T02:30:00Z'], days: 14, nowISO: '2026-07-11T20:00:00-04:00', timezone: 'America/New_York',
    });
    expect(b[13].date).toBe('2026-07-11');
    expect(b[13].count).toBe(1);
  });
});

describe('sparklineBars — always a baseline, never a gap', () => {
  it('one glyph per entry', () => {
    expect(Array.from(sparklineBars([0, 1, 2, 3])).length).toBe(4);
  });
  it('an all-zero window is a flat baseline, not empty', () => {
    expect(sparklineBars([0, 0, 0])).toBe('▁▁▁');
  });
  it('scales the busiest day to the tallest glyph', () => {
    const s = sparklineBars([0, 1, 4]);
    expect(s[0]).toBe('▁');
    expect(s[2]).toBe('█');
  });
  it('accepts bucket objects as well as raw numbers', () => {
    expect(sparklineBars([{ count: 0 }, { count: 2 }])).toBe('▁█');
  });
  it('empty input is an empty string', () => {
    expect(sparklineBars([])).toBe('');
  });
});

describe('buildMomentum — the assembled coach-facing block', () => {
  const now = '2026-07-11T18:00:00Z';

  it('assembles totals, peak, sparkline and summary from kept instants', () => {
    const m = buildMomentum({
      timestamps: ['2026-07-11T09:00:00Z', '2026-07-11T14:00:00Z', '2026-07-09T10:00:00Z'],
      days: 14, nowISO: now, timezone: 'UTC',
    });
    expect(m.days).toBe(14);
    expect(m.buckets).toHaveLength(14);
    expect(m.total).toBe(3);
    expect(m.peak.count).toBe(2);
    expect(m.peak.date).toBe('2026-07-11');
    expect(Array.from(m.sparkline).length).toBe(14);
    expect(m.summary).toContain('3 words kept');
    expect(m.timezone).toBe('UTC');
  });

  it('a quiet window reads as a clean page, never a miss tally', () => {
    const m = buildMomentum({ timestamps: [], days: 14, nowISO: now, timezone: 'UTC' });
    expect(m.total).toBe(0);
    expect(m.sparkline).toBe('▁'.repeat(14));
    expect(m.summary.toLowerCase()).toMatch(/clean page|fresh start/);
    // The design LAW, asserted on the assembled block's own copy.
    expect(/\bmiss(es|ed|ing)?\b/i.test(m.summary)).toBe(false);
    expect(/\bbehind\b/i.test(m.summary)).toBe(false);
  });

  it('MOMENTUM_WINDOW_DAYS is the default span', () => {
    const m = buildMomentum({ timestamps: [], nowISO: now, timezone: 'UTC' });
    expect(m.days).toBe(MOMENTUM_WINDOW_DAYS);
  });
});
