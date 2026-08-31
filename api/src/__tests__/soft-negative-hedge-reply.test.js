/**
 * FocusBro — a bare soft-negative hedge ("not really" / "not so much") reads as
 * the no-shame reschedule, not a cold "I didn't catch that" (Contender #10,
 * Phase A).
 *
 * On the live two-way text moat, `detectCheckinReply` had a cold spot on the
 * gentlest partial "no" an ADHD user texts back to "did you do it?": "not
 * really", "not so much", and any reply carrying one ("meh not really", "not
 * really tbh", "no not really"). It carries no self-blame (SHAME_MISS misses
 * it), no "life got in the way" phrase (CIRCUMSTANTIAL_MISS misses it), no
 * negation contraction and no adjacent "not done"/"not yet" (RESCHEDULE's net
 * misses it), and it is not the single-token "n"/"no"/"not" the last-pass net
 * reads — so it fell clean through the whole classifier to a bare `null`, the
 * cold "reply DONE or LATER" re-prompt, delivered to someone gently confessing a
 * miss: the exact scold the ONE design LAW ("never shame") forbids.
 *
 * The fix adds an `isSoftNegMiss` net consulted LAST (after RESCHEDULE, KEPT,
 * PARTIAL, SNOOZE, FLOW, hold-length, SHAME_MISS and CIRCUMSTANTIAL_MISS have
 * each returned), so it can only ever change a reply that would otherwise have
 * gone cold. It is streak-safe and regression-safe by construction; its one
 * guard is a clean-completion veto so a real win carrying the hedge is left
 * alone.
 *
 * This file pins the proof-of-rejection (the hedges returned `null` on the
 * pre-fix source; they now read 'reschedule') plus a battery of regression
 * guards proving no completion, snooze, or real reschedule reading drifted.
 */

import { describe, it, expect } from 'vitest';
import { detectCheckinReply } from '../accountability.js';

describe('detectCheckinReply — soft-negative hedge → no-shame reschedule', () => {
  // Bare soft-negative hedges — returned null (the cold re-prompt) before the fix.
  const SOFT_NEG = [
    'not really',
    'not so much',
    'not really no',
    'not really tbh',
    'not really got to it',
    'meh not really',
    'no not really',
    'nah not really',
    'not really today',
    'not so much really',
  ];

  it('reads a bare soft-negative hedge ("not really", "not so much") as the RESCHEDULE, never the cold null', () => {
    for (const t of SOFT_NEG) {
      expect(detectCheckinReply(t), t).toBe('reschedule');
    }
  });

  it('regression: a clean completion carrying the hedge is NOT rescheduled (the win is credited)', () => {
    // "not really, did it" normalizes to "not really did it" and KEPT reads the
    // clean "did it" before the late soft-neg net; a "knocked it out" win that
    // KEPT's list omits is vetoed by the clean-completion guard (falls through,
    // never a wrong reschedule).
    expect(detectCheckinReply('not really, did it')).toBe('kept');
    expect(detectCheckinReply('not really felt like it but got it done')).toBe('kept');
    expect(detectCheckinReply('not really feeling it but knocked it out')).not.toBe('reschedule');
  });

  it('regression: "really" without the negation stays whatever it was — no "not really" in sight', () => {
    expect(detectCheckinReply('really nailed it')).toBe('kept');
    expect(detectCheckinReply('did it really')).toBe('kept');
  });

  it('regression: an engaged near-done ("not much left") is not swept in as a miss', () => {
    // Bare "not much" is deliberately excluded; "not much left" is engaged, not a
    // miss, and must never read as a reschedule via this net.
    expect(detectCheckinReply('not much left')).not.toBe('reschedule');
    expect(detectCheckinReply('almost there')).toBe('snooze');
  });

  it('regression: real reschedules and circumstantial misses still route correctly', () => {
    for (const t of ['not yet', 'later', 'nope', 'tomorrow', 'not today', 'forgot', 'swamped']) {
      expect(detectCheckinReply(t), t).toBe('reschedule');
    }
  });

  it('regression: a genuine snooze and an unreadable reply are untouched', () => {
    expect(detectCheckinReply('on it')).toBe('snooze');
    expect(detectCheckinReply('still working on it')).toBe('snooze');
    expect(detectCheckinReply('banana')).toBeNull();
  });
});
