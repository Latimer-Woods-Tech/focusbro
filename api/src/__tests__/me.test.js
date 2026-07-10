/**
 * FocusBro — Consumer accountability front door tests (Contender #10, Phase A).
 *
 * The consumer page (/me/) is the one surface where a person sees their OWN list
 * of words — the exact place a to-do app becomes a guilt engine, showing past
 * misses in red. This suite extends the ONE design LAW (never shame) to that
 * surface: every consumer-facing string fails the build on a shaming word, the
 * banned "AI" branding, or a clinical/treatment claim — and a `missed`
 * commitment must render as an open door, never a failure tally.
 */

import { describe, it, expect } from 'vitest';
import {
  COMMITMENT_STATUSES,
  statusPresentation,
  mePageIntroCopy,
  giveWordHeadingCopy,
  emptyCommitmentsCopy,
  streakHeadingCopy,
  checkinActionLabels,
  keptLogHeadingCopy,
  keptLogEmptyCopy,
  mePageFootnoteCopy,
  meCopySurface,
  renderMePage,
} from '../me.js';

const SHAME_PATTERNS = [
  /\bfail(ed|ure|ing|s)?\b/i,
  /\blaz(y|iness)\b/i,
  /\bdisappoint/i,
  /\bguilt/i,
  /\bashamed\b/i,
  /\bshame\b/i,
  /\byou (didn.?t|should have|should.?ve)\b/i,
  /\bfall(ing|en)? behind\b/i,
  /\bbehind\b/i,
  /\bexcuse/i,
  /\bslack(ing|er|ed)? off\b/i,
  /\bpathetic\b/i,
  /\bworthless\b/i,
  /\bmiss(ed|es|ing)?\b/i, // no miss tally in what the person reads
];
const CLINICAL_PATTERNS = [/\btreat(s|ment|ing)?\b/i, /\bcure/i, /\bdiagnos/i, /\bdisorder/i, /\bsymptom/i, /\bADHD\b/i, /\bmedication\b/i];
const AI_WORD = /\bAI\b/; // case-sensitive: the banned branding, not "again"/"said"

describe('commitment statuses', () => {
  it('exposes the six lifecycle states', () => {
    expect(COMMITMENT_STATUSES).toEqual(['active', 'kept', 'missed', 'rescheduled', 'released', 'paused']);
  });

  it('every status presents a non-empty label and a known, non-shame tone', () => {
    for (const s of COMMITMENT_STATUSES) {
      const p = statusPresentation(s);
      expect(typeof p.label).toBe('string');
      expect(p.label.trim().length).toBeGreaterThan(0);
      expect(['active', 'kept', 'moved', 'open']).toContain(p.tone);
    }
  });

  it('an unknown status falls back to the neutral active presentation', () => {
    expect(statusPresentation('nonsense').tone).toBe('active');
    expect(statusPresentation(undefined).tone).toBe('active');
  });
});

describe('the design LAW extends to the consumer view', () => {
  const surface = meCopySurface();

  it('curates a non-empty copy surface covering every user-facing string', () => {
    expect(surface.length).toBeGreaterThan(0);
    for (const s of surface) {
      expect(typeof s).toBe('string');
      expect(s.trim().length).toBeGreaterThan(0);
    }
  });

  it('never emits a shaming word', () => {
    for (const s of surface) {
      for (const pat of SHAME_PATTERNS) {
        expect(pat.test(s), `shaming copy: "${s}" matched ${pat}`).toBe(false);
      }
    }
  });

  it('never emits the word "AI"', () => {
    for (const s of surface) {
      expect(AI_WORD.test(s), `"AI" leaked into copy: "${s}"`).toBe(false);
    }
  });

  it('never makes a clinical or treatment claim', () => {
    for (const s of surface) {
      for (const pat of CLINICAL_PATTERNS) {
        expect(pat.test(s), `clinical claim in copy: "${s}" matched ${pat}`).toBe(false);
      }
    }
  });
});

describe('a missed word is an open door, never a failure', () => {
  it('the missed status does not read as a failure or a tally', () => {
    const p = statusPresentation('missed');
    expect(p.tone).toBe('open');
    expect(/fail|missed|behind/i.test(p.label)).toBe(false);
  });

  it('the footnote promises the always-open try-again door', () => {
    const foot = mePageFootnoteCopy().toLowerCase();
    expect(foot).toMatch(/try again/);
    expect(foot).toContain('ally');
  });
});

describe('renderMePage', () => {
  const html = renderMePage();

  it('is a self-contained, noindex HTML document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    expect(html).toContain('</html>');
  });

  it('drives the accountability API (commitments, streak, and the kept-word log)', () => {
    expect(html).toContain('/api/commitments');
    expect(html).toContain('/api/accountability/streak');
    expect(html).toContain('/api/accountability/kept');
    expect(html).toContain('/auth/login');
    expect(html).toContain('/auth/register');
    expect(html).toContain('focusbro_token');
  });

  it('renders the curated copy into the page', () => {
    expect(html).toContain(giveWordHeadingCopy());
    expect(html).toContain(streakHeadingCopy());
    expect(html).toContain(emptyCommitmentsCopy());
    expect(html).toContain(mePageIntroCopy());
    expect(html).toContain(keptLogHeadingCopy());
    expect(html).toContain(keptLogEmptyCopy());
    const A = checkinActionLabels();
    expect(html).toContain(A.kept);
    expect(html).toContain(A.missed);
  });
});
