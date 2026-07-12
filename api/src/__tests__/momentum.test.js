/**
 * FocusBro — shared kept-word momentum engine (Contender #10, Phase A).
 *
 * The math (bucketing, sparkline, totals/peak) is exercised in depth via the
 * coach re-exports in coach.test.js. This suite pins the part unique to the
 * shared module: buildMomentum injects a caller-supplied voice, so the coach and
 * the person's own /me/ view share ONE shape without sharing a voice — and the
 * engine reads KEPT instants only (a quiet day is a short bar, never a miss).
 */

import { describe, it, expect } from 'vitest';
import { buildMomentum, MOMENTUM_WINDOW_DAYS, sparklineBars, bucketKeptByDay } from '../momentum.js';

const now = '2026-07-11T18:00:00Z';

describe('buildMomentum — one shape, an injected voice', () => {
  it('uses the caller-supplied intro string and summary function verbatim', () => {
    const m = buildMomentum({
      timestamps: ['2026-07-11T09:00:00Z', '2026-07-11T14:00:00Z', '2026-07-09T10:00:00Z'],
      days: 14, nowISO: now, timezone: 'UTC',
      intro: 'MY-INTRO',
      summary: ({ total, days, peak }) => `MY-SUMMARY total=${total} days=${days} peak=${peak.count}`,
    });
    expect(m.intro).toBe('MY-INTRO');
    expect(m.summary).toBe('MY-SUMMARY total=3 days=14 peak=2');
    expect(m.total).toBe(3);
    expect(m.peak).toEqual({ date: '2026-07-11', count: 2 });
    expect(Array.from(m.sparkline).length).toBe(14);
  });

  it('defaults to an empty voice when none is injected (never throws)', () => {
    const m = buildMomentum({ timestamps: [], nowISO: now, timezone: 'UTC' });
    expect(m.intro).toBe('');
    expect(m.summary).toBe('');
    expect(m.days).toBe(MOMENTUM_WINDOW_DAYS);
    expect(m.total).toBe(0);
  });

  it('a quiet window is a flat baseline sparkline, not an empty string', () => {
    const m = buildMomentum({ timestamps: [], days: 14, nowISO: now, timezone: 'UTC' });
    expect(m.sparkline).toBe('▁'.repeat(14));
  });

  it('the injected summary receives only kept-derived numbers (no miss series exists)', () => {
    const seen = [];
    buildMomentum({
      timestamps: ['2026-07-10T10:00:00Z'], days: 7, nowISO: now, timezone: 'UTC',
      summary: (arg) => { seen.push(Object.keys(arg).sort().join(',')); return ''; },
    });
    expect(seen[0]).toBe('days,peak,total'); // total/peak/days only — nothing about misses
  });
});

describe('the engine is kept-only by construction', () => {
  it('sparklineBars draws a baseline for zero, never a gap', () => {
    expect(sparklineBars([0, 0, 0])).toBe('▁▁▁');
    expect(sparklineBars([0, 2])).toBe('▁█');
  });
  it('bucketKeptByDay counts instants per local day and ignores out-of-window ones', () => {
    const b = bucketKeptByDay({
      timestamps: ['2026-07-11T09:00:00Z', '2026-06-01T09:00:00Z'], days: 3, nowISO: now, timezone: 'UTC',
    });
    expect(b).toHaveLength(3);
    expect(b[b.length - 1]).toEqual({ date: '2026-07-11', count: 1 }); // today
    expect(b.reduce((s, d) => s + d.count, 0)).toBe(1); // the June instant is outside the 3-day window
  });
});
