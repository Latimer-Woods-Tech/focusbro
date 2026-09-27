/**
 * FocusBro — "let (myself|you|the team) down" self-blame → no-shame reschedule
 * (Contender #10, Phase A).
 *
 * "I let you down" / "I let myself down" is the single heaviest confession an ADHD
 * brain carries to a check-in — and it named itself as the next gap at the end of
 * #332. It is the SAME self-blame family as "dropped the ball" (already folded into
 * SHAME_MISS in #332): a person owning the miss, carrying no "i'm ..." self-frame,
 * no negation contraction, and no "life got in the way" phrase — so it slipped every
 * net and landed on the cold `null` re-prompt ("I didn't catch that, reply DONE or
 * LATER"). That cold branch, aimed at the person confessing they feel they let
 * someone down, is the exact scold the ONE design LAW ("never shame") most protects
 * against. This fix folds the family into SHAME_MISS so it routes to the warm
 * no-shame RESCHEDULE ("no problem, when do you want to try again?").
 *
 * Streak-safe AND regression-safe by construction: a reschedule never resets; the
 * pattern is anchored to `let <person> down`, and SHAME_MISS is consulted only AFTER
 * RESCHEDULE / KEPT / PARTIAL / SNOOZE / FLOW / hold-length have each returned — so a
 * real completion that merely mentions the fear ("did it, was worried i'd let you
 * down") stays KEPT, and the engaged/positive "down" replies ("i'm down", "down for
 * it", "let's go") and the non-person "let it go" / "let it slide" are untouched.
 */

import { describe, it, expect } from 'vitest';
import { detectCheckinReply } from '../accountability.js';

describe('detectCheckinReply — "let ... down" self-blame → no-shame reschedule (was cold null)', () => {
  // Proof-of-rejection (Factory Standing Law #1): every one of these returned `null`
  // — the cold re-prompt — before the fix, and now routes to the no-shame reschedule.
  const SELF_BLAME = [
    'i let myself down',
    'let myself down',
    'i let my self down',
    'i really let myself down',
    'i let you down',
    'let you down',
    'i feel like i let you down',
    'i keep letting you down',
    'let you all down',
    'i let everyone down',
    'i let everybody down',
    'i let the team down',
    'let them down',
    'i let us down',
    'i let her down',
    'i let him down',
    'let my family down',
    'i let my kids down',
    'let our clients down',
  ];
  for (const reply of SELF_BLAME) {
    it(`routes "${reply}" to reschedule, never the cold re-prompt`, () => {
      expect(detectCheckinReply(reply)).toBe('reschedule');
    });
  }
});

describe('detectCheckinReply — regression + false-positive guards for the "let ... down" net', () => {
  const GUARDS = [
    // A real completion wins even when it trails the newly-caught phrase (KEPT runs first).
    ['did it, was worried i’d let you down', 'kept'],
    ['done, thought i let you down but got there', 'kept'],
    // The already-correct self-blame neighbours stay put.
    ['dropped the ball', 'reschedule'],
    ['i suck at this', 'reschedule'],
    // Positive / engaged "down" replies must NEVER trip the net (no "let <person>").
    ['im down', null],
    ["i'm down", null],
    ['down for it', null],
    ["let's go", null],
    ['lets go', null],
    // "let <non-person>" is not self-blame — keep the existing verdict (cold/no-op here).
    ['let it go', null],
    ['let it slide', null],
    // Bare "... down" with no "let" is not this net's business.
    ['calm down', null],
    ['settle down', null],
    ['slow down', null],
    // Unrelated neighbours unchanged.
    ['did it', 'kept'],
    ['later', 'reschedule'],
    ['forgot', 'reschedule'],
  ];
  for (const [reply, want] of GUARDS) {
    it(`keeps "${reply}" as ${String(want)}`, () => {
      expect(detectCheckinReply(reply)).toBe(want);
    });
  }
});
