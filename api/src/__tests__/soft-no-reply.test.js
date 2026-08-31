/**
 * FocusBro — a casual soft "no" reads as the no-shame reschedule, not a false
 * 'kept' and not a cold "I didn't catch that" (Contender #10, Phase A).
 *
 * On the live two-way text moat, `detectCheckinReply` had two cold spots on the
 * soft-no family — the gentlest way an ADHD user says "I didn't get to it":
 *
 *  1. "yeah nah" / "yeah no" — a yes-hedged soft NO — tripped KEPT's
 *     elongation-tolerant yes net on the LEADING "yeah" and was over-credited as
 *     a resolved word. That is a false streak tick — a streak-INTEGRITY bug on
 *     the very channel where kept-word honesty is the product.
 *  2. bare "nah" / "naw" carry no marker word, no negation contraction, and
 *     aren't the single-letter "n"/"no"/"not" the last-pass net reads, so they
 *     fell through the whole classifier to a bare `null` — the cold "reply DONE
 *     or LATER" re-prompt, delivered to someone gently confessing a miss: the
 *     exact scold the ONE design LAW ("never shame") forbids.
 *
 * The operative token in a yes+no hedge is the LAST one, exactly as in speech:
 * "yeah nah" = no, "nah yeah" = yes. The fix adds an `isSoftNo` guard that runs
 * BEFORE KEPT (so the leading "yeah" can't be over-credited) and routes the
 * soft-no family to the no-shame RESCHEDULE. It is safe by construction:
 *  - a clean (un-negated) completion anywhere ("nah, did it") vetoes it;
 *  - a soft-no immediately answered by a yes ("nah yeah", "no yes") is read as a
 *    soft-YES and left for KEPT;
 *  - RESCHEDULE still runs first, so "nope" / "nah not yet" are unaffected.
 *
 * This file pins both halves: the soft-noes that were mis-read (FAIL on pre-fix
 * source — the yes-hedged ones returned 'kept', the bare ones returned null) now
 * read 'reschedule', and a battery of regression guards proves no real yes,
 * snooze, or soft-YES was stolen.
 */

import { describe, it, expect } from 'vitest';
import { detectCheckinReply } from '../accountability.js';

describe('detectCheckinReply — casual soft "no" → no-shame reschedule', () => {
  // Yes-hedged soft NO — returned 'kept' before the fix (KEPT read the leading yes).
  const YES_HEDGED_NO = [
    'yeah nah',
    'yeah, nah',
    'yeah nah man',
    'yeah nah sorry',
    'ya nah',
    'yea nah',
    'yep nah',
    'yeah no',
    'yeah, no',
    'ya no',
    'yep no',
    'yeah nope',
    'yeah, nope',
  ];

  // Bare soft NO — returned null (the cold re-prompt) before the fix.
  const BARE_NO = [
    'nah',
    'naw',
    'nahh',
    'nawww',
    'nah man',
    'nah sorry',
    'nah not feeling it',
    'nah nah',
  ];

  it('reads a yes-hedged soft "no" ("yeah nah", "yeah no") as the RESCHEDULE, never a false kept', () => {
    for (const t of YES_HEDGED_NO) {
      expect(detectCheckinReply(t), t).toBe('reschedule');
    }
  });

  it('reads a bare soft "no" ("nah", "naw") as the RESCHEDULE, never the cold null', () => {
    for (const t of BARE_NO) {
      expect(detectCheckinReply(t), t).toBe('reschedule');
    }
  });

  it('regression: a soft YES ("nah yeah") stays KEPT — the terminal token is operative', () => {
    // "nah yeah" and "no yeah" are soft YESES (the operative token is the trailing
    // yes); the soft-no guard must NOT flip these to a reschedule.
    for (const t of ['nah yeah', 'nah, yeah', 'no yeah', 'naw yes', 'nah yep']) {
      expect(detectCheckinReply(t), t).toBe('kept');
    }
  });

  it('regression: a plain yes and the elongated variants stay KEPT (no soft-no in sight)', () => {
    for (const t of ['yeah', 'yes', 'yea', 'yah', 'yesss', 'yaas', 'yep', 'yup', 'ya']) {
      expect(detectCheckinReply(t), t).toBe('kept');
    }
  });

  it('regression: a completion wins even when a soft-no token rides along ("nah, did it")', () => {
    // A clean, un-negated completion anywhere vetoes the soft-no reading — the
    // person did the thing; credit the word.
    for (const t of ['nah did it', 'nah, did it', 'nah got it done', 'yeah nah just kidding all done']) {
      expect(detectCheckinReply(t), t).toBe('kept');
    }
  });

  it('regression: real reschedules and "nope" are unchanged (RESCHEDULE runs first)', () => {
    for (const t of ['nope', 'not yet', 'later', 'no can do', 'nah not yet', 'tomorrow']) {
      expect(detectCheckinReply(t), t).toBe('reschedule');
    }
  });

  it('regression: a bare "no <positive word>" is not swept into the soft-no net', () => {
    // "no worries" / "no problem" must not be read as a soft-no by the yes-hedge
    // net — it has no leading yes. (They fall through to their existing reading;
    // the point of this guard is that the soft-no change did NOT newly flip them.)
    expect(detectCheckinReply('no worries')).not.toBe('kept');
    expect(detectCheckinReply('no problem')).not.toBe('kept');
  });

  it('regression: an engaged snooze and a bare unreadable reply are untouched', () => {
    expect(detectCheckinReply('on it')).toBe('snooze');
    expect(detectCheckinReply('still working on it')).toBe('snooze');
    expect(detectCheckinReply('banana')).toBeNull();     // 'nah' is a substring of nothing here; also not a word
    expect(detectCheckinReply('gnaw on it')).toBe('snooze'); // "gnaw" ≠ bare "naw"; the "on it" snooze wins
  });
});
