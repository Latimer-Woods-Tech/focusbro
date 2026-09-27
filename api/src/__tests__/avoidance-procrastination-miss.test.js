/**
 * FocusBro — avoidance / procrastination confession → no-shame reschedule
 * (Contender #10, Phase A).
 *
 * "been procrastinating", "keep putting it off", "avoiding it", "dreading it",
 * "dragging my feet", "stalling", "dodging it" — the most ADHD-real reply of all:
 * the person owning that they're circling the task without touching it. It is
 * shame-adjacent by nature, yet it carries NO self-blame "i'm ..." identity phrase
 * (so SHAME_MISS misses it), NO circumstantial excuse word — forgot/swamped/
 * out-of-time (so CIRCUMSTANTIAL_MISS misses it), and NO negation contraction (so
 * RESCHEDULE's "didn't"/"can't" net misses it). So the whole family fell through
 * every net to the stone-cold `null` re-prompt ("I didn't catch that, reply DONE
 * or LATER") — aimed squarely at the person confessing they can't make themselves
 * start, the exact reply the ONE design LAW ("never shame") most protects. This
 * fix adds AVOIDANCE_MISS, consulted only after every completion / engaged /
 * dated-reschedule net has returned, so it routes the family to the warm no-shame
 * RESCHEDULE ("no problem, when do you want to try again?").
 *
 * Streak-safe AND regression-safe by construction: a reschedule never resets, and
 * the net runs AFTER RESCHEDULE / KEPT / PARTIAL / SNOOZE / FLOW / hold-length /
 * SHAME_MISS / CIRCUMSTANTIAL_MISS have each returned — so a real completion that
 * merely mentions the dread stays KEPT, an engaged "on it, been putting it off but
 * here now" stays a SNOOZE, and a "later, still avoiding it" stays a plain
 * RESCHEDULE. The postpone forms REQUIRE the word "off", so an engaged "putting it
 * on my calendar for 3pm" is never grabbed.
 */

import { describe, it, expect } from 'vitest';
import { detectCheckinReply } from '../accountability.js';

describe('detectCheckinReply — avoidance/procrastination confession → no-shame reschedule (was cold null)', () => {
  // Proof-of-rejection (Factory Standing Law #1): every one of these returned
  // `null` — the cold re-prompt — before the fix, and now routes to reschedule.
  const AVOIDANCE = [
    'been procrastinating all day',
    'procrastinating',
    'i keep procrastinating',
    'total procrastination over here',
    'i procrastinated again',
    'keep putting it off',
    'putting it off',
    'putting off the taxes',
    'i put it off again',
    'put off starting',
    'avoiding it honestly',
    'been avoiding it',
    'i keep avoiding it',
    'avoiding doing it',
    'dreading it',
    'been dreading it all week',
    'dreading doing it',
    'dragging my feet',
    'dragging my heels on this',
    'stalling',
    'stalling hard',
    'keep dodging it',
    'dodging it tbh',
  ];
  for (const reply of AVOIDANCE) {
    it(`routes "${reply}" to reschedule, never the cold re-prompt`, () => {
      expect(detectCheckinReply(reply)).toBe('reschedule');
    });
  }
});

describe('detectCheckinReply — regression + false-positive guards for the avoidance net', () => {
  const GUARDS = [
    // A real completion wins even when it trails the newly-caught phrase (KEPT runs first).
    ['did it, was dreading it all week', 'kept'],
    ['done, been putting it off forever but finished', 'kept'],
    // An engaged mid-task reply stays a snooze (SNOOZE runs first).
    ['on it, been putting it off but here now', 'snooze'],
    // A dated/marker reschedule stays a plain reschedule (RESCHEDULE runs first).
    ['later, still avoiding it', 'reschedule'],
    // "putting it …" WITHOUT "off" is engaged planning, not avoidance — must NOT
    // be read as a miss; it stays a warm ask (null), exactly as before.
    ['putting it on my calendar for 3pm', null],
    ['putting it on the list', null],
    // The already-correct miss neighbours stay put.
    ['forgot', 'reschedule'],
    ['dropped the ball', 'reschedule'],
    ['i suck at this', 'reschedule'],
    // Unrelated neighbours unchanged.
    ['did it', 'kept'],
    ['later', 'reschedule'],
    ['on it', 'snooze'],
  ];
  for (const [reply, want] of GUARDS) {
    it(`keeps "${reply}" as ${String(want)}`, () => {
      expect(detectCheckinReply(reply)).toBe(want);
    });
  }
});
