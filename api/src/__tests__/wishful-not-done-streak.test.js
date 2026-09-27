/**
 * FocusBro — a wishful / counterfactual "almost-yes" ("wish I could say yes", "if
 * only I'd done it", "almost said done") reads as the no-shame reschedule, NOT a
 * false 'kept' streak tick (Contender #10, Phase A).
 *
 * This is a streak-INTEGRITY bug, not a cold-spot bug. On the live two-way text
 * moat, `detectCheckinReply` let a completion word wrapped in a wish — where the
 * affirmation is hypothetical and the person plainly did NOT do it — trip KEPT's
 * bare `yes`/`done`/`did it`/`finished` and log a kept word: the streak silently
 * ticked on a gentle miss, on the exact channel where kept-word honesty is the
 * product. Every earlier net missed it: RESCHEDULE needs a
 * "later"/"tomorrow"/negation-contraction the wish doesn't carry, and the
 * grateful-completion intercept needs a gratitude idiom; KEPT's word-boundary
 * affirmation needs no adjacency, so it won.
 *
 * The fix adds a narrow `isWishfulNotDone` net consulted BEFORE KEPT. What makes a
 * wish counterfactual is scope: the affirmation falls AFTER the wishful lead-in
 * ("wish … yes"), so it is inside the wish, never a reported fact. A real win that
 * merely TRAILS a wish states the completion first ("did it, wish I'd started
 * sooner"); the clean-completion veto reads only the text before the lead-in and
 * leaves that win alone. A bare "wish me luck" / "I wish" with no affirmation
 * after it never matches and still falls through to the warm ask.
 *
 * This file pins the proof-of-rejection (the trips returned 'kept' on the pre-fix
 * source; they now read 'reschedule') plus regression guards proving no real
 * completion, trailing-wish win, snooze, or reschedule reading drifted.
 */

import { describe, it, expect } from 'vitest';
import { detectCheckinReply } from '../accountability.js';

describe('detectCheckinReply — a wishful / counterfactual "almost-yes" → no-shame reschedule', () => {
  // A completion/affirmation word scoped by a preceding wish — each returned a
  // FALSE 'kept' before the fix (KEPT's bare affirmation, over-credited as a
  // resolved word), even the ones carrying an explicit "but no".
  const FALSE_STREAK_TRIPS = [
    'wish i could say yes',
    'wish i could say i did it',
    'i wish i finished',
    'wish i had done it',
    'if only i had done it',
    'i was gonna say yes but no',
    'almost said done',
    "i'd love to say yes",
    'hoped to say done',
    'was going to say done but nope',
  ];

  it('reads a wished-for completion ("wish I could say yes") as the RESCHEDULE, never a false streak tick', () => {
    for (const t of FALSE_STREAK_TRIPS) {
      expect(detectCheckinReply(t), t).toBe('reschedule');
    }
  });

  it('regression: a real win TRAILING a wish keeps its word — the completion stated first is credited', () => {
    // The clean-completion veto looks only BEFORE the wishful lead-in, so a
    // completion reported before the wish ("did it, wish I'd started sooner") is a
    // real win and the net stands down.
    expect(detectCheckinReply("did it, wish i'd started sooner")).toBe('kept');
    expect(detectCheckinReply("finished! wish i'd done it sooner")).toBe('kept');
    expect(detectCheckinReply('nailed it, wish it were easier')).toBe('kept');
    expect(detectCheckinReply('done and done, wish every task was this easy')).toBe('kept');
  });

  it('regression: a clean completion with no wish stays kept', () => {
    for (const t of ['yes', 'yesss', 'did it', 'yes did it', 'done and done', 'yes finally did it', 'crushed it']) {
      expect(detectCheckinReply(t), t).toBe('kept');
    }
  });

  it('regression: a bare wish with no affirmation after it still falls through to the warm ask (never assumed a miss)', () => {
    // "wish me luck" / "I wish" carry no wished-for completion word, so the net
    // never fires and the reply keeps its prior, un-assumed reading (null = ask).
    expect(detectCheckinReply('wish me luck')).toBeNull();
    expect(detectCheckinReply('i wish')).toBeNull();
  });

  it('regression: a genuine reschedule that happens to open with a wish is still a reschedule', () => {
    // RESCHEDULE runs first, so a real "later"/"tomorrow" wins regardless — the
    // outcome is a reschedule either way, never a false kept.
    expect(detectCheckinReply('wish i could, tomorrow')).toBe('reschedule');
    expect(detectCheckinReply('wanted to say done but nope')).toBe('reschedule');
  });

  it('regression: real reschedules, snoozes, and unreadable replies are untouched', () => {
    expect(detectCheckinReply('not yet')).toBe('reschedule');
    expect(detectCheckinReply('on it')).toBe('snooze');
    expect(detectCheckinReply('in the zone')).toBe('snooze');
    expect(detectCheckinReply('banana')).toBeNull();
  });
});
