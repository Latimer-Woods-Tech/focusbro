/**
 * FocusBro — a soft-negative hedge that negates a bare completion adjective ("not
 * really done", "not so much finished", "not really complete") reads as the
 * no-shame reschedule, NOT a false 'kept' streak tick (Contender #10, Phase A).
 *
 * This is a streak-INTEGRITY bug, not a cold-spot bug. On the live two-way text
 * moat, `detectCheckinReply` let the gentlest "I didn't really finish" slip
 * through the whole classifier and trip KEPT's bare `\bdone\b`/`finished`/
 * `complete`: the person gently confessing a miss was silently logged as having
 * KEPT their word — a false streak tick, on the exact channel where kept-word
 * honesty is the product. The negated completion word is why every earlier net
 * missed it: RESCHEDULE's net needs the adjacent "not done"/"not finished" (and
 * "really"/"so much" sits between), and the grateful-completion intercept needs a
 * CLEAN completion; KEPT's word-boundary `done` needs no adjacency, so it won.
 * The prior soft-negative-hedge slice (PR #323) deliberately left this — its late
 * net is placed AFTER KEPT and so could not touch KEPT's return.
 *
 * The fix adds a narrow `isSoftNegDoneTrip` net consulted BEFORE KEPT that reads
 * exactly the hedge-immediately-negating-a-bare-completion-adjective overlap
 * (only the adjective forms KEPT reads bare: done/finished/complete[d]). An
 * appended completion CLAUSE ("not really, did it" / "not really got it done") is
 * untouched and keeps its word, matching the existing verb-clause precedent; a
 * real win riding along ("not really done yet but nailed it") is vetoed by the
 * clean-completion guard. The bare hedge with no completion trip still flows to
 * its streak-safe late net.
 *
 * This file pins the proof-of-rejection (the trips returned 'kept' on the pre-fix
 * source; they now read 'reschedule') plus regression guards proving no real
 * completion, verb-clause claim, snooze, or reschedule reading drifted.
 */

import { describe, it, expect } from 'vitest';
import { detectCheckinReply } from '../accountability.js';

describe('detectCheckinReply — soft-negative hedge negating a bare completion adjective → no-shame reschedule', () => {
  // Hedge + bare completion adjective — each returned a FALSE 'kept' before the
  // fix (KEPT's bare done/finished/complete, over-credited as a resolved word).
  const FALSE_STREAK_TRIPS = [
    'not really done',
    'not so much done',
    'not really finished',
    'not so much finished',
    'not really complete',
    'not really completed',
    'not really done yet',
    'not really finished it',
    'not really done today',
    'not so much, done',
  ];

  it('reads a hedge-negated bare completion ("not really done") as the RESCHEDULE, never a false streak tick', () => {
    for (const t of FALSE_STREAK_TRIPS) {
      expect(detectCheckinReply(t), t).toBe('reschedule');
    }
  });

  it('regression: an appended completion CLAUSE keeps its word — the verb-clause precedent is preserved', () => {
    // "not really, did it" / "not really got it done" append a completion claim
    // (a verb clause), read by KEPT exactly as they are today. The new net fires
    // ONLY on the bare adjective forms the hedge directly negates, so these are
    // untouched.
    expect(detectCheckinReply('not really, did it')).toBe('kept');
    expect(detectCheckinReply('not really got it done')).toBe('kept');
    expect(detectCheckinReply('not really did that')).toBe('kept');
  });

  it('regression: a real win riding along with the hedge is credited, never wrongly rescheduled', () => {
    // The clean-completion veto: "not really done yet but nailed it" carries a
    // clean "nailed it" win → KEPT reads it, the trip net stands down.
    expect(detectCheckinReply('not really done yet but nailed it')).toBe('kept');
    expect(detectCheckinReply('not really feeling it but knocked it out')).not.toBe('reschedule');
  });

  it('regression: the bare soft-negative hedge (no completion word) still routes via its late net', () => {
    for (const t of ['not really', 'not so much', 'meh not really', 'not really today', 'not really tbh']) {
      expect(detectCheckinReply(t), t).toBe('reschedule');
    }
  });

  it('regression: a clean completion with no hedge stays kept', () => {
    for (const t of ['done', 'all done', 'finished', 'did it', 'got it done', 'really nailed it']) {
      expect(detectCheckinReply(t), t).toBe('kept');
    }
  });

  it('regression: an engaged near-done ("not much left") is not swept in as a miss', () => {
    expect(detectCheckinReply('not much left')).not.toBe('reschedule');
    expect(detectCheckinReply('almost there')).toBe('snooze');
  });

  it('regression: real reschedules, snoozes, and unreadable replies are untouched', () => {
    expect(detectCheckinReply('not yet')).toBe('reschedule');
    expect(detectCheckinReply('tomorrow')).toBe('reschedule');
    expect(detectCheckinReply('on it')).toBe('snooze');
    expect(detectCheckinReply('banana')).toBeNull();
  });
});
