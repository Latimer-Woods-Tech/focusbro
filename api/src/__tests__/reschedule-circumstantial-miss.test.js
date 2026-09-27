/**
 * FocusBro — a circumstantial "life got in the way" miss reads as the no-shame
 * reschedule, not a cold "I didn't catch that" (Contender #10, Phase A).
 *
 * `detectCheckinReply` already reads a SELF-BLAME miss ("failed again", "i suck",
 * "gave up") as the no-shame reschedule via the SHAME_MISS net. Its circumstantial
 * cousin — "forgot", "slipped my mind", "ran out of time", "no time today", "not
 * today", "not happening", "swamped", "too busy" — carries no self-blame (so
 * SHAME_MISS never touched it) AND no negation contraction (so RESCHEDULE's
 * "didn't"/"couldn't"/"can't"/"haven't" net, which already caught "didn't have
 * time" / "couldn't get to it", never caught these bare forms). They fell through
 * the entire classifier to a bare `null` — the cold "reply DONE or LATER"
 * re-prompt, delivered to the very ADHD user confessing they just forgot: the
 * exact scold the ONE design LAW ("never shame") forbids, on the two-way text moat
 * while voice is still gated.
 *
 * The fix adds a CIRCUMSTANTIAL_MISS net that runs LAST — after RESCHEDULE, KEPT,
 * PARTIAL, SNOOZE, FLOW and the hold-length nets have each returned — so it is
 * streak-safe and regression-safe by construction: it can only ever change a reply
 * that would otherwise have gone cold. This file pins both halves: the confessions
 * (each returned `null` before the fix, so they FAIL on the pre-fix source) and the
 * regression guards (completions that merely mention time/forgot stay KEPT, engaged
 * snoozes stay SNOOZE, real reschedules stay RESCHEDULE, and the enthusiastic "no
 * time to lose" / genuinely-ambiguous replies stay the honest warm re-ask).
 */

import { describe, it, expect } from 'vitest';
import { detectCheckinReply } from '../accountability.js';

describe('detectCheckinReply — circumstantial "life got in the way" miss → no-shame reschedule', () => {
  // Each of these returned `null` (the cold re-prompt) before the fix.
  const CONFESSIONS = [
    'forgot',
    'totally forgot',
    'ugh forgot',
    'i forgot',
    'forgot all about it',
    'slipped my mind',
    'lost track of time',
    'lost track of the time',
    'ran out of time',
    'out of time',
    'no time today',
    'no time left',
    'no time for it',
    'not today',
    'not happening',
    'never got to it',
    'never got around to it',
    'got swamped',
    'swamped',
    'too busy',
    'no bandwidth',
  ];
  for (const reply of CONFESSIONS) {
    it(`reads ${JSON.stringify(reply)} as a reschedule (was a cold null)`, () => {
      expect(detectCheckinReply(reply)).toBe('reschedule');
    });
  }
});

describe('detectCheckinReply — the circumstantial-miss net never steals a real outcome', () => {
  // A completion that merely MENTIONS forgot/time stays KEPT — the completion nets
  // run first, so the miss net never reaches these.
  const STILL_KEPT = [
    'done',
    'did it almost forgot to say',
    'finished, ran out of time to clean up but its done',
    'did it, no time to spare but done',
    'crushed it',
    'done for today',
  ];
  for (const reply of STILL_KEPT) {
    it(`keeps ${JSON.stringify(reply)} as kept`, () => {
      expect(detectCheckinReply(reply)).toBe('kept');
    });
  }

  // An engaged mid-task reply that mentions losing track of time stays a SNOOZE —
  // the "on it" marker wins before the miss net.
  const STILL_SNOOZE = [
    'on it, lost track of time',
    'still working, no time to waste',
  ];
  for (const reply of STILL_SNOOZE) {
    it(`keeps ${JSON.stringify(reply)} as snooze`, () => {
      expect(detectCheckinReply(reply)).toBe('snooze');
    });
  }

  // A genuine reschedule already caught upstream is unchanged.
  const STILL_RESCHEDULE = [
    'later',
    'tomorrow',
    'not yet',
    'cant today',
    'didnt happen',
    'maybe later',
  ];
  for (const reply of STILL_RESCHEDULE) {
    it(`keeps ${JSON.stringify(reply)} as reschedule`, () => {
      expect(detectCheckinReply(reply)).toBe('reschedule');
    });
  }

  // "no time" WITHOUT a miss qualifier is the enthusiastic "let's go" — a start,
  // not a miss — and must stay the honest warm re-ask, never a reschedule.
  const STILL_AMBIGUOUS = [
    'no time to lose',
    'no time like the present',
    'hmm',
    'idk',
  ];
  for (const reply of STILL_AMBIGUOUS) {
    it(`leaves ${JSON.stringify(reply)} as the warm re-ask (null)`, () => {
      expect(detectCheckinReply(reply)).toBeNull();
    });
  }
});
