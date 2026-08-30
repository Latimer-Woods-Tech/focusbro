/**
 * FocusBro — "noon" composes with a day qualifier (Contender #10, Phase A).
 *
 * "noon" was read by a standalone branch that only ever landed today or tomorrow.
 * Unlike every other time-of-day anchor ("morning", "afternoon", "lunch",
 * "eod", …), which is modelled as a `partOfDay` entry precisely so it COMPOSES
 * with the tomorrow / weekday / calendar-date branches, "noon" sat outside the
 * ladder and produced two wrong-time outputs on the two-way text moat (voice
 * still gated) — the exact worst outcome the anti-shame design LAW guards:
 *
 *   - "tomorrow noon" — the standalone branch was skipped whenever the reply also
 *     said "tomorrow", and "noon" was absent from the ladder, so the tomorrow
 *     branch fell to the 09:00 default: noon was SILENTLY DROPPED (landed 09:00).
 *   - "saturday noon" / "the 12th at noon" — contained no "tomorrow", so the
 *     standalone branch fired and returned today/tomorrow noon, IGNORING the day
 *     qualifier entirely: a reschedule landing days early.
 *
 * Fix: model "noon" as a `partOfDay` anchor ([12, 0]) so it composes with every
 * branch exactly like its siblings; bare "noon" still lands via the bare
 * part-of-day branch. This file pins the composed forms (each returned the wrong
 * instant before the fix) and re-pins bare "noon" so the fix stays regression-safe.
 */

import { describe, it, expect } from 'vitest';
import { parseWhenReply } from '../accountability.js';

// Monday 2026-07-06, 15:00:00 UTC — noon today has already passed, and the dated
// cases below sit comfortably inside the 14-day reschedule horizon.
const NOW = '2026-07-06T15:00:00.000Z';
const opts = { nowISO: NOW, timezone: 'UTC' };
const parse = (s) => parseWhenReply(s, opts);

describe('"noon" composes with a day qualifier instead of collapsing to today/tomorrow', () => {
  it('"tomorrow noon" lands tomorrow at 12:00, not the 09:00 default (noon no longer dropped)', () => {
    expect(parse('tomorrow noon')).toBe('2026-07-07T12:00:00.000Z');
    expect(parse('noon tomorrow')).toBe('2026-07-07T12:00:00.000Z');
  });

  it('a named weekday + noon lands that weekday at 12:00, not today/tomorrow', () => {
    // Monday → Saturday is +5 days, inside the horizon.
    expect(parse('saturday noon')).toBe('2026-07-11T12:00:00.000Z');
    expect(parse('sat noon')).toBe('2026-07-11T12:00:00.000Z');
  });

  it('a calendar date + noon lands that date at 12:00, not today/tomorrow', () => {
    // "the 12th" this month = 2026-07-12, six days out (inside the horizon).
    expect(parse('the 12th at noon')).toBe('2026-07-12T12:00:00.000Z');
  });

  it('the glued "noonish" softener composes the same way', () => {
    // "noonish" normalizes to "noon" before the ladder, so it must compose too.
    expect(parse('noonish tomorrow')).toBe('2026-07-07T12:00:00.000Z');
    expect(parse('saturday noonish')).toBe('2026-07-11T12:00:00.000Z');
  });

  it('bare "noon" still rolls to tomorrow when today\'s noon has passed (no regression)', () => {
    // Re-pins the behavior the standalone branch had for the bare form.
    expect(parse('noon')).toBe('2026-07-07T12:00:00.000Z');
  });

  it('bare "noon" lands TODAY when it is still ahead (no regression)', () => {
    const MORNING = { nowISO: '2026-07-06T08:00:00.000Z', timezone: 'UTC' };
    expect(parseWhenReply('noon', MORNING)).toBe('2026-07-06T12:00:00.000Z');
  });

  it('"noon" never fires inside "afternoon" (word-boundary safety)', () => {
    // "afternoon" must read as 14:00, never 12:00 — the noon anchor must not
    // shadow it.
    expect(parse('tomorrow afternoon')).toBe('2026-07-07T14:00:00.000Z');
  });
});
