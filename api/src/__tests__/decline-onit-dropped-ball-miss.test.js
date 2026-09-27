/**
 * FocusBro — the last two SNOOZE-colliding / self-blame gaps in the no-shame
 * check-in classifier (Contender #10, Phase A).
 *
 * Two replies still reached a wrong verdict before this fix, each on the two-way
 * SMS moat and each a direct violation of the ONE design LAW ("never shame"):
 *
 *   1. "pass on it" / "passing on it" / "passed on it" — a DECLINE. A bare "pass"
 *      already routed to the no-shame RESCHEDULE (via CIRCUMSTANTIAL_MISS), but the
 *      "on it" phrasing carried the marker the SNOOZE net reads as actively-doing-it,
 *      so a person BOWING OUT was cheerfully told the bro would "swing back" — the
 *      same collision "spaced on it" hit, in the decline direction. It returned
 *      'snooze' before this fix; now 'reschedule'.
 *
 *   2. "dropped the ball" / "drop(ping) the ball" — a self-blame confession owning
 *      the miss. It carries no "i'm ..." self-frame, no negation contraction, and no
 *      "life got in the way" phrase, so it slipped every net and landed on the cold
 *      `null` re-prompt — the exact scold aimed at the person the design LAW most
 *      protects. It returned null before this fix; now 'reschedule' (folded into the
 *      SHAME_MISS self-blame family).
 *
 * Streak-safe and regression-safe by construction: a reschedule never resets; KEPT
 * runs first (so a real completion that mentions either phrase keeps its word); the
 * decline net is anchored to "on it/this/that/today" and vetoed by a clean
 * completion, so "pass me the notes" (engaged) and "did it, gonna pass on it" are
 * untouched.
 */

import { describe, it, expect } from 'vitest';
import { detectCheckinReply } from '../accountability.js';

describe('detectCheckinReply — "pass on it" decline → no-shame reschedule (was snooze)', () => {
  // Each returned 'snooze' before this fix — the bro cheerfully offering to "swing
  // back" to a person who just declined.
  const DECLINES = [
    'pass on it',
    'passing on it',
    'passed on it',
    'pass on this',
    'pass on that',
    'pass on today',
    "i'll pass on it",
    'gonna pass on it',
    'think i pass on it', // colloquial, still a decline
  ];
  for (const reply of DECLINES) {
    it(`routes "${reply}" to reschedule, never a snooze`, () => {
      expect(detectCheckinReply(reply)).toBe('reschedule');
    });
  }
});

describe('detectCheckinReply — "dropped the ball" self-blame → no-shame reschedule (was cold null)', () => {
  // Each returned null (the cold re-prompt) before this fix.
  const SELF_BLAME = [
    'dropped the ball',
    'i dropped the ball',
    'totally dropped the ball',
    'ugh dropped the ball',
    'drop the ball',
    'dropping the ball',
    'sorry i dropped the ball on this',
  ];
  for (const reply of SELF_BLAME) {
    it(`routes "${reply}" to reschedule, never the cold re-prompt`, () => {
      expect(detectCheckinReply(reply)).toBe('reschedule');
    });
  }
});

describe('detectCheckinReply — regression guards for the decline / self-blame nets', () => {
  const GUARDS = [
    // A real completion wins even when it trails either newly-caught phrase.
    ['did it, gonna pass on it', 'kept'],
    ['done, dropped the ball on the email', 'kept'],
    // "pass me ..." is engaged help, not a decline — the "on it" marker is a real snooze.
    ["i'm on it, pass me the notes", 'snooze'],
    // The already-correct neighbours stay put.
    ['pass', 'reschedule'],
    ['on it', 'snooze'],
    ['still working on it', 'snooze'],
    ['spaced on it', 'reschedule'],
    ['blanked on it', 'reschedule'],
    ['did it', 'kept'],
    ['later', 'reschedule'],
    ['forgot', 'reschedule'],
  ];
  for (const [reply, want] of GUARDS) {
    it(`keeps "${reply}" as ${want}`, () => {
      expect(detectCheckinReply(reply)).toBe(want);
    });
  }
});
