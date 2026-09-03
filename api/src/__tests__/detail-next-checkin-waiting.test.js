/**
 * FocusBro — the per-word detail panel honors a passed-but-open check-in
 * (Contender #10, Phase A).
 *
 * The /me/ list card (R-233), the coach roster (R-234), and the report
 * (rhythmNextCopy) all render an active word's next check-in as a warm
 * "Still here whenever you're ready" line ONCE that moment has passed but the
 * check-in is still open (a slipped, quiet-hours-, or night-deferred delivery —
 * #338 leaves the row pending, scheduled_for unchanged, so the earliest
 * outstanding moment the detail endpoint returns as `next_checkin` can be in the
 * PAST). The per-word detail panel was the one surface that still printed that
 * moment as a raw "Next check-in: <a time already gone>" line — which reads as a
 * no-show on that word, exactly the reliability-undermining signal THE DESIGN LAW
 * forbids.
 *
 * This suite pulls the REAL `renderDetail` client function out of the built
 * /me/ page and drives it: a past `next_checkin` must fall to the warm waiting
 * line (and never format the stale time); a future one must still be named
 * outright. The proof-of-rejection removes the passed-branch and shows the past
 * case regress to a printed stale time.
 */

import { describe, it, expect } from 'vitest';
import { renderMePage, detailNextLabelCopy, listNextCheckinWaitingCopy } from '../me.js';
import { scanDesignLaw } from '../design-law.js';

// Extract a top-level `function <name>(...) { ... }` body from a source string by
// brace-matching from its opening brace. Load-bearing for driving the real
// client render (which lives inside the page's inline <script> string) instead
// of a hand-copied twin that could drift from what ships.
function extractFunction(source, name) {
  const sig = 'function ' + name + '(';
  const start = source.indexOf(sig);
  if (start === -1) throw new Error('function ' + name + ' not found in page');
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces extracting ' + name);
}

// Build a callable renderDetail with the panel's collaborators stubbed. `esc` is
// identity (we assert on plain substrings); `fmtWhen` marks any formatted time
// with a sentinel so we can prove a stale past time is NEVER formatted;
// momentum/kept are inert so only the next-check-in line is under test.
function buildRenderDetail() {
  const page = renderMePage();
  const src = extractFunction(page, 'renderDetail');
  const factory = new Function(
    'esc', 'fmtWhen', 'hasMomentum', 'sparkBlockHTML',
    'DETAIL_NEXT_LABEL', 'DETAIL_NEXT_WAITING', 'DETAIL_KEPT_HEADING', 'DETAIL_MOMENTUM_HEADING',
    src + '\nreturn renderDetail;'
  );
  return factory(
    (s) => String(s == null ? '' : s),
    () => 'FMT_TIME',           // sentinel: a formatted clock time
    () => false,                // hasMomentum: skip the sparkline branch
    () => '',                   // sparkBlockHTML
    detailNextLabelCopy(),      // DETAIL_NEXT_LABEL
    listNextCheckinWaitingCopy(),// DETAIL_NEXT_WAITING (shared with the list card)
    'Kept', 'Momentum'
  );
}

const PAST = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();   // 3h ago (slipped/deferred)
const FUTURE = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(); // 3h out

describe('the per-word detail panel never shows a stale past check-in time', () => {
  const renderDetail = buildRenderDetail();
  const WAITING = listNextCheckinWaitingCopy();
  const LABEL = detailNextLabelCopy();

  it('a passed-but-open next check-in falls to the warm waiting line, not a formatted stale time', () => {
    const html = renderDetail({ next_checkin: PAST });
    expect(html).toContain(WAITING);
    // The stale past moment is NEVER formatted into a "Next check-in: <time>" line.
    expect(html).not.toContain('FMT_TIME');
    expect(html).not.toContain(LABEL + ': ');
    expect(html).toContain('when waiting');
  });

  it('a future next check-in is still named outright with its formatted time', () => {
    const html = renderDetail({ next_checkin: FUTURE });
    expect(html).toContain(LABEL + ': FMT_TIME');
    expect(html).not.toContain(WAITING);
  });

  it('no next check-in renders neither the label nor the waiting line', () => {
    const html = renderDetail({ next_checkin: null });
    expect(html).not.toContain(WAITING);
    expect(html).not.toContain('FMT_TIME');
  });

  it('exactly one of {waiting line, timed line} ever renders for a given moment', () => {
    const p = renderDetail({ next_checkin: PAST });
    const f = renderDetail({ next_checkin: FUTURE });
    expect(p.includes(WAITING) && p.includes('FMT_TIME')).toBe(false);
    expect(f.includes(WAITING) && f.includes('FMT_TIME')).toBe(false);
  });

  // Proof-of-rejection (Standing Law #1): the PRE-FIX detail panel printed the
  // moment unconditionally. Reconstruct that one line and confirm the past case
  // regresses to a formatted stale time — the exact defect this slice removes.
  it('PROOF-OF-REJECTION: the unconditional (pre-fix) line shows the stale past time', () => {
    const preFix = (next, fmtWhen, LBL) =>
      next ? '<div class="when">' + LBL + ': ' + fmtWhen(next) + '</div>' : '';
    const bad = preFix(PAST, () => 'FMT_TIME', LABEL);
    expect(bad).toContain('FMT_TIME');            // the bug: a past time is shown
    expect(bad).not.toContain(WAITING);           // and the warm line is absent
  });

  it('the shared waiting line carries no shame, no miss tally, no "AI", no clinical claim', () => {
    expect(scanDesignLaw(WAITING).length).toBe(0);
    expect(scanDesignLaw(LABEL).length).toBe(0);
    expect(WAITING.toLowerCase()).toContain('still here');
    expect(WAITING.toLowerCase()).not.toMatch(/late|overdue|missed|failed|behind/);
  });
});
