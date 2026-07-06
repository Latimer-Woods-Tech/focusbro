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
} from '../coach.js';

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
