/**
 * FocusBro — the rest of the "life got in the way" family reads as the no-shame
 * reschedule, and the SNOOZE-colliding forgot slang stops being mis-read as a
 * check-back (Contender #10, Phase A).
 *
 * `detectCheckinReply` already routes the self-blame miss (SHAME_MISS) and the
 * first wave of circumstantial confessions ("forgot", "ran out of time", "no time
 * today", "swamped") to the no-shame RESCHEDULE. This slice closes the remaining
 * cold-`null` gaps in the same family — the low-state / distraction / decline
 * confessions that carry no self-blame and no negation contraction, so they
 * slipped every net exactly the way "forgot" once did:
 *
 *   sidetracked · something came up · no energy · too tired · exhausted ·
 *   wiped out · worn out · burnt out · pass · not this time
 *
 * …plus the FORGOT-family slang whose "on it" marker was being read as an engaged
 * SNOOZE ("spaced on it", "blanked on it") or that went cold ("spaced", "spaced
 * out", "blanked", "drew a blank"). "spaced on it" returned `'snooze'` before this
 * fix — the two-way moat cheerfully told a person who just BLANKED that it would
 * "swing back" as if they were mid-task — so its guard runs AHEAD of the SNOOZE net
 * (after KEPT, under a clean-completion veto).
 *
 * Streak-safe and regression-safe by construction: a reschedule never resets, and
 * every guard below pins that completions, engaged snoozes, and the enthusiastic
 * "no time to lose" / genuinely-ambiguous "zoned out" replies are all untouched.
 */

import { describe, it, expect } from 'vitest';
import { detectCheckinReply } from '../accountability.js';

describe('detectCheckinReply — the rest of the "life got in the way" family → no-shame reschedule', () => {
  // Each returned `null` (the cold re-prompt) before this fix — the exact scold
  // the ONE design LAW forbids, aimed at the person confessing they just couldn't.
  const CONFESSIONS = [
    'sidetracked',
    'got sidetracked',
    'ugh got sidetracked',
    'something came up',
    "something's come up",
    'stuff came up',
    'things came up',
    'no energy',
    'no energy today',
    'zero energy',
    'low energy',
    'no motivation',
    'too tired',
    'so tired',
    'dead tired',
    'exhausted',
    'exhausted today',
    'wiped out',
    'worn out',
    'burnt out',
    'burned out',
    'pass',
    "i'll pass",
    'gonna pass',
    'not this time',
  ];
  for (const reply of CONFESSIONS) {
    it(`reads ${JSON.stringify(reply)} as the no-shame reschedule`, () => {
      expect(detectCheckinReply(reply)).toBe('reschedule');
    });
  }

  // The SNOOZE-colliding / cold forgot slang. "spaced on it" / "blanked on it"
  // returned `'snooze'` before the fix (the "on it" marker); the bare forms went
  // cold. All are a gentle miss.
  const FORGOT_SLANG = [
    'spaced',
    'spaced out',
    'spaced on it',
    'totally spaced on it',
    'blanked',
    'blanked out',
    'blanked on it',
    'drew a blank',
  ];
  for (const reply of FORGOT_SLANG) {
    it(`reads the forgot-slang ${JSON.stringify(reply)} as the no-shame reschedule, never a snooze`, () => {
      expect(detectCheckinReply(reply)).toBe('reschedule');
    });
  }

  // --- Regression guards: everything that already worked must keep working. ---

  it('a real completion wins even when the miss slang trails it', () => {
    // KEPT runs before the forgot-slang guard, and the clean-completion veto backs
    // it up, so a genuine win that merely mentions spacing/energy keeps its word.
    expect(detectCheckinReply('did it, then spaced on the email')).toBe('kept');
    expect(detectCheckinReply('done, no energy left but finished')).toBe('kept');
    expect(detectCheckinReply('nailed it, was exhausted after')).toBe('kept');
  });

  it('an engaged mid-task "on it" is still a snooze, not stolen by the forgot slang', () => {
    expect(detectCheckinReply('on it')).toBe('snooze');
    expect(detectCheckinReply('still working on it')).toBe('snooze');
    expect(detectCheckinReply('give me 20')).toBe('snooze');
  });

  it('the enthusiastic "no time" idioms stay the honest warm re-ask (null)', () => {
    expect(detectCheckinReply('no time to lose')).toBeNull();
    expect(detectCheckinReply('no time like the present')).toBeNull();
  });

  it('the genuinely ambiguous states stay the honest warm re-ask (null)', () => {
    // "zoned out" is an ambiguous state, not a stated miss — pinned to the warm ask.
    expect(detectCheckinReply('zoned out')).toBeNull();
    expect(detectCheckinReply('cooking dinner')).toBeNull();
  });

  it('"passed"/"passing" (not the decline "pass") never trips the miss net', () => {
    // \bpass\b matches only the standalone decline — a real win keeps its word.
    expect(detectCheckinReply('finally passed it, done')).toBe('kept');
    expect(detectCheckinReply('just a sec, passing through')).toBe('snooze');
  });

  it('the existing first-wave confessions and real reschedules are unchanged', () => {
    expect(detectCheckinReply('forgot')).toBe('reschedule');
    expect(detectCheckinReply('no time today')).toBe('reschedule');
    expect(detectCheckinReply('tomorrow')).toBe('reschedule');
    expect(detectCheckinReply('later')).toBe('reschedule');
  });
});
