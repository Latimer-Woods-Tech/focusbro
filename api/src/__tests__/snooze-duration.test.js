/**
 * FocusBro — a stated snooze length is honored (Contender #10, Phase A).
 *
 * A real accountability friend who hears "on it — give me 20" checks back in
 * TWENTY, not at a fixed default. The "I'm on it" snooze already re-arms the
 * nudge and never touches the streak; before this, it always used
 * SNOOZE_DEFAULT_MIN and quietly ignored the interval the person named on the
 * exact two-way channel the moat is built on. `parseSnoozeMinutes` reads that
 * interval:
 *   - "give me 20" / "20 min" / "check back in an hour" / "half an hour" land,
 *   - a snooze with no named length ("on it", "hang on", "gimme a few") returns
 *     null so the caller keeps the default — UPGRADE-ONLY, never shorter/wronger,
 *   - the result is clamped to the snooze window (floor 5, ceiling 180) so a
 *     snooze can never become a disappearance or a silent full reschedule,
 *   - a clock time ("at 3", "3pm") is never misread as a minute count,
 *   - the streak is NEVER read or written — a snooze is not a resolution.
 */

import { describe, it, expect } from 'vitest';
import {
  parseSnoozeMinutes,
  SNOOZE_DEFAULT_MIN,
  SNOOZE_MIN_MIN,
  SNOOZE_MAX_MIN,
} from '../accountability.js';

describe('parseSnoozeMinutes — checks back WHEN they said', () => {
  it('reads a bare number behind a snooze lead-in as minutes', () => {
    expect(parseSnoozeMinutes('on it, give me 20')).toBe(20);
    expect(parseSnoozeMinutes('gimme 30')).toBe(30);
    expect(parseSnoozeMinutes('still working, check back in 25')).toBe(25);
    expect(parseSnoozeMinutes('another 15')).toBe(15);
    expect(parseSnoozeMinutes('need 45 more')).toBe(45);
  });

  it('reads an explicit minutes unit in every common spelling', () => {
    for (const t of ['on it, 20 min', 'give me 20 mins', 'still working, 20 minutes',
                     'hang on, 20m', 'on it — 20 more minutes']) {
      expect(parseSnoozeMinutes(t), t).toBe(20);
    }
  });

  it('reads hours and converts to minutes', () => {
    expect(parseSnoozeMinutes('on it, check back in an hour')).toBe(60);
    expect(parseSnoozeMinutes('still working, give me 2 hours')).toBe(120);
    expect(parseSnoozeMinutes('on it, 90 mins')).toBe(90);
    expect(parseSnoozeMinutes('hang on, 1 hr')).toBe(60);
  });

  it('reads the common fractional-hour idioms', () => {
    expect(parseSnoozeMinutes('on it, half an hour')).toBe(30);
    expect(parseSnoozeMinutes('still working, half hour')).toBe(30);
    expect(parseSnoozeMinutes('give me a quarter hour')).toBe(15);
    expect(parseSnoozeMinutes('on it, an hour and a half')).toBe(90);
  });

  it('reads spelled-out numbers', () => {
    expect(parseSnoozeMinutes('on it, give me twenty')).toBe(20);
    expect(parseSnoozeMinutes('still working, thirty minutes')).toBe(30);
    expect(parseSnoozeMinutes('hang on, forty five minutes')).toBe(45);
  });

  it('never reads a clock time as a hold length — that is a reschedule target', () => {
    // Guarded so even a mis-classified reply falls back to the default, never a
    // wrong minute count. (These would normally reach parseWhenReply, not here.)
    expect(parseSnoozeMinutes('at 3')).toBeNull();
    expect(parseSnoozeMinutes('check back at 4pm')).toBeNull();
    expect(parseSnoozeMinutes('3pm')).toBeNull();
    expect(parseSnoozeMinutes('around noon')).toBeNull();
  });

  it('returns null when no length was stated — the caller keeps the default (upgrade-only)', () => {
    for (const t of ['on it', "I'm on it", 'hang on', 'one sec', 'gimme a few',
                     'still working on it', 'almost there', '']) {
      expect(parseSnoozeMinutes(t), t).toBeNull();
    }
    // and null is exactly what makes the callers fall back to SNOOZE_DEFAULT_MIN
    expect(parseSnoozeMinutes('on it') ?? SNOOZE_DEFAULT_MIN).toBe(SNOOZE_DEFAULT_MIN);
  });

  it('clamps to the snooze window — never a disappearance, never a silent reschedule', () => {
    // Below the floor stays a nudge; above the ceiling can never become a full move.
    expect(parseSnoozeMinutes('on it, give me 2 min')).toBe(SNOOZE_MIN_MIN);   // 2 → 5
    expect(parseSnoozeMinutes('on it, give me 1')).toBe(SNOOZE_MIN_MIN);       // 1 → 5
    expect(parseSnoozeMinutes('on it, give me 5 hours')).toBe(SNOOZE_MAX_MIN); // 300 → 180
    expect(parseSnoozeMinutes('on it, 240 min')).toBe(SNOOZE_MAX_MIN);         // 240 → 180
  });

  it('does not fire on an incidental number that is not a hold length', () => {
    expect(parseSnoozeMinutes('still on it, task 2 of 3')).toBeNull();
    expect(parseSnoozeMinutes('on it 100%')).toBeNull();
    // "min" must be a real word boundary — never inside another word
    expect(parseSnoozeMinutes('on it, 20 monkeys')).toBeNull();
  });
});
