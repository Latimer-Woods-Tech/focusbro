/**
 * FocusBro — a day-qualified "midnight" re-asks instead of guessing the wrong day
 * (Contender #10, Phase A).
 *
 * "midnight" (00:00) was read by a standalone branch at the very top of the
 * time-of-day ladder that short-circuited EVERY day/date branch below it and
 * unconditionally returned tomorrow 00:00. So any reply that merely CONTAINED
 * "midnight" ignored its qualifier and landed the wrong instant on the two-way
 * text moat (voice still gated) — the exact worst outcome the anti-shame design
 * LAW guards against (the bro showing up on the wrong day):
 *
 *   - "saturday midnight" / "the 12th at midnight" — the weekday / date was
 *     ignored and the reschedule landed tomorrow 00:00, days off.
 *   - "tomorrow midnight" — landed tomorrow 00:00, a day early (a "tomorrow
 *     midnight" most naturally means the midnight that ENDS tomorrow).
 *
 * Unlike "noon", midnight is NOT composed onto the named day: "saturday
 * midnight" is genuinely ambiguous — the midnight that starts Saturday or the
 * one that ends it — and the design LAW ranks a guessed wrong-day time strictly
 * worse than a warm "which day did you mean?" re-ask. So the fix keeps bare
 * "midnight" (and "tonight at midnight", the same instant) landing the next 00:00
 * = the start of tomorrow, but returns null for a day-qualified midnight so the
 * honest re-ask fires. This file pins both halves: the day-qualified cases (each
 * returned tomorrow 00:00 before the fix, so they fail on the pre-fix source) and
 * the bare / tonight forms (re-pinned so the fix stays regression-safe).
 */

import { describe, it, expect } from 'vitest';
import { parseWhenReply } from '../accountability.js';

// Monday 2026-07-06, 15:00:00 UTC — the dated cases below sit comfortably inside
// the 14-day reschedule horizon; the next midnight is the start of 2026-07-07.
const NOW = '2026-07-06T15:00:00.000Z';
const opts = { nowISO: NOW, timezone: 'UTC' };
const parse = (s) => parseWhenReply(s, opts);

describe('a day-qualified "midnight" re-asks instead of landing the wrong day', () => {
  it('a named weekday + midnight re-asks (no more wrong-day tomorrow 00:00)', () => {
    // Before the fix each returned 2026-07-07T00:00:00.000Z (Saturday ignored).
    expect(parse('saturday midnight')).toBeNull();
    expect(parse('sat midnight')).toBeNull();
    expect(parse('midnight saturday')).toBeNull();
  });

  it('a calendar date + midnight re-asks (no more wrong-day tomorrow 00:00)', () => {
    expect(parse('the 12th at midnight')).toBeNull();
    expect(parse('jul 12 midnight')).toBeNull();
    expect(parse('midnight 12/25')).toBeNull();
  });

  it('"tomorrow midnight" re-asks (no more silently a day early)', () => {
    // Before the fix both returned 2026-07-07T00:00:00.000Z.
    expect(parse('tomorrow midnight')).toBeNull();
    expect(parse('midnight tomorrow')).toBeNull();
  });

  it('the glued "midnightish" softener is day-qualified the same way', () => {
    // "midnightish" normalizes to "midnight" before the ladder, so a qualified
    // form must still re-ask...
    expect(parse('saturday midnightish')).toBeNull();
    // ...while the bare glued form lands the next 00:00 like bare "midnight".
    expect(parse('midnightish')).toBe('2026-07-07T00:00:00.000Z');
  });

  it('bare "midnight" still lands the next 00:00 = start of tomorrow (no regression)', () => {
    expect(parse('midnight')).toBe('2026-07-07T00:00:00.000Z');
  });

  it('"tonight at midnight" / "midnight tonight" still land the next 00:00 (no regression)', () => {
    // "tonight" is not a day qualifier here — tonight's midnight IS the next
    // 00:00 (the start of tomorrow), so these are well-defined, not ambiguous.
    expect(parse('tonight at midnight')).toBe('2026-07-07T00:00:00.000Z');
    expect(parse('midnight tonight')).toBe('2026-07-07T00:00:00.000Z');
  });

  it('the guard only touches midnight: a bare weekday still reads normally', () => {
    // "saturday" alone must still land Saturday at the 09:00 default — proof the
    // day-qualified re-ask is scoped to midnight and did not disturb the weekday
    // branch.
    expect(parse('saturday')).toBe('2026-07-11T09:00:00.000Z');
  });
});
