/**
 * FocusBro — Coach "new personal best" cue tests (Contender track, issue #10, Phase A).
 *
 * The person's own /me/ streak card celebrates a fresh all-time best the moment
 * their CURRENT kept-word run becomes the longest they've ever kept going
 * (`personalBestCopy`, cur >= 2 && cur === longest). The coach's roster only had
 * `clientMilestoneCopy`, which fires at FIXED milestone rungs (3/7/14/30/100) —
 * so a client setting a genuine all-time record at a BETWEEN-milestone count
 * (5, 6, 8, 9, …) gave the coach NO celebration cue at the single highest-value
 * moment to reach out. `clientPersonalBestCopy` closes that gap.
 *
 * Proof-of-rejection (Standing Law #1): the between-milestone-record assertions
 * below are exactly the behavior that did not exist before this slice — with the
 * cue neutered to always return '' (or absent), every "…toBeGreaterThan(0)" here
 * is red. The complementarity block proves the new cue can never stack a second
 * celebration on a card the milestone cue already owns.
 */

import { describe, it, expect } from 'vitest';
import { scanDesignLaw } from '../design-law.js';
import { STREAK_MILESTONES } from '../accountability.js';
import { clientPersonalBestCopy, clientMilestoneCopy } from '../coach.js';

describe('clientPersonalBestCopy — the coach twin of the person-side best-run badge', () => {
  it('fires at a fresh all-time best that is NOT a milestone (the gap it closes)', () => {
    // A record run at a between-milestone count: the person sees "you're at your
    // best"; before this slice the coach saw nothing.
    for (const n of [2, 5, 6, 8, 9, 11, 42]) {
      expect(STREAK_MILESTONES.includes(n)).toBe(false); // guard: these are genuinely off-milestone
      const line = clientPersonalBestCopy({ streak: { current_streak: n, longest_streak: n } });
      expect(line.trim().length).toBeGreaterThan(0);
      expect(line).toContain(String(n));
    }
  });

  it('stays silent unless the current run IS the all-time best', () => {
    // Still climbing toward a past best — not a record, nothing to celebrate.
    expect(clientPersonalBestCopy({ streak: { current_streak: 5, longest_streak: 9 } })).toBe('');
    // A record stands but the current run is over (that's personalRecordCopy's job,
    // person-side; the roster cue only marks a LIVE record).
    expect(clientPersonalBestCopy({ streak: { current_streak: 0, longest_streak: 9 } })).toBe('');
  });

  it('stays silent below the "worth marking" bar (a run of 1 is not yet a best)', () => {
    expect(clientPersonalBestCopy({ streak: { current_streak: 1, longest_streak: 1 } })).toBe('');
    expect(clientPersonalBestCopy({ streak: { current_streak: 0, longest_streak: 0 } })).toBe('');
  });

  it('defers to the milestone cue at every milestone rung (never double-celebrates)', () => {
    // At an all-time best that lands exactly on a milestone, the milestone cue owns
    // the moment and the personal-best cue is silent — so a card carries ONE cue.
    for (const m of STREAK_MILESTONES) {
      expect(clientPersonalBestCopy({ streak: { current_streak: m, longest_streak: m } })).toBe('');
    }
  });

  it('the two celebration cues are exact complements across every all-time-best count', () => {
    // For any live all-time best (cur === best >= 2), EXACTLY one of the two cues
    // speaks: the milestone cue on a rung, the personal-best cue between rungs.
    for (let n = 2; n <= 101; n += 1) {
      const streak = { current_streak: n, longest_streak: n };
      const best = clientPersonalBestCopy({ streak }).length > 0;
      const mile = clientMilestoneCopy({ streak }).length > 0;
      expect(best !== mile).toBe(true); // never both, never neither
      // And the split is precisely the milestone membership.
      expect(mile).toBe(STREAK_MILESTONES.includes(n));
    }
  });

  it('handles missing / malformed input without throwing', () => {
    expect(clientPersonalBestCopy({ streak: null })).toBe('');
    expect(clientPersonalBestCopy({ streak: {} })).toBe('');
    expect(clientPersonalBestCopy({})).toBe('');
    expect(clientPersonalBestCopy()).toBe('');
    expect(clientPersonalBestCopy({ streak: { current_streak: 'x', longest_streak: 'x' } })).toBe('');
  });

  it('THE DESIGN LAW: the cue never shames, brands "AI", or makes a clinical claim', () => {
    // Sweep every between-milestone record count the cue can fire on.
    for (const n of [2, 5, 6, 8, 9, 11, 13, 42, 99]) {
      if (STREAK_MILESTONES.includes(n)) continue;
      const line = clientPersonalBestCopy({ streak: { current_streak: n, longest_streak: n } });
      expect(line.length).toBeGreaterThan(0);
      expect(scanDesignLaw(line)).toEqual([]); // consumer bar: no shame / treatment / AI / ADHD
    }
  });
});
