/**
 * FocusBro — the glued "-ish" softener parses like its spaced twin
 * (Contender #10, Phase A).
 *
 * "-ish" is the hedge this ADHD audience texts hardest ("5ish", "noonish",
 * "8ish tonight"). The parser already read the SPACED/HYPHENATED form — the
 * separator-stripping pass turns "3-ish" into "3 ish", which the clock branch
 * reads as 3:00 — but the GLUED form the same texter is at least as likely to
 * send stayed welded to its anchor: "5ish" never reached the clock branch and
 * "noonish" never matched the noon branch, so both fell to the cold re-ask. On
 * the two-way text moat (voice still gated) that silent "he didn't get me" is
 * the exact friction the anti-shame LAW exists to kill.
 *
 * This pins:
 *   - a glued "ish" on a digit or a named clock-word resolves IDENTICALLY to the
 *     spaced twin and to the bare anchor,
 *   - it never guts an ordinary word that merely ends in "ish" ("finish", "wish",
 *     "polish", "spanish" stay a warm re-ask, not a wrong time),
 *   - a glued "ish" composes with "in …", a bare-clock, and a part-of-day.
 *
 * Without the normalization every glued case below returns null and fails —
 * the proof the fix bites.
 */

import { describe, it, expect } from 'vitest';
import { parseWhenReply } from '../accountability.js';

// Sunday 2026-08-30, 15:00:00 UTC — a fixed "now" so soonest-future clocks land
// deterministically (bare "3" → next 03:00, "5" → next 17:00, etc.).
const NOW = '2026-08-30T15:00:00.000Z';
const opts = { nowISO: NOW, timezone: 'UTC' };
const parse = (s) => parseWhenReply(s, opts);

describe('the glued "-ish" softener reads like its spaced twin', () => {
  it('a glued digit+ish resolves to the same instant as the spaced/bare clock', () => {
    for (const [glued, twin] of [
      ['3ish', '3-ish'],
      ['5ish', '5 ish'],
      ['6ish', '6'],
    ]) {
      const g = parse(glued);
      expect(g, glued).toBeTruthy();
      expect(g, `${glued} === ${twin}`).toBe(parse(twin));
      // …and to the bare anchor with no softener at all.
      expect(g, `${glued} === bare`).toBe(parse(glued.replace(/ish$/, '')));
    }
  });

  it('reads a glued named-clock-word: "noonish" === "noon"', () => {
    const g = parse('noonish');
    expect(g).toBeTruthy();
    expect(g).toBe(parse('noon'));
  });

  it('keeps the dropped minutes on a glued colon-time: "5:30ish" lands at :30', () => {
    const g = parse('5:30ish');
    expect(g).toBeTruthy();
    // 5:30 in the future from 15:00 UTC Sunday → next 05:30 (tomorrow), minutes intact.
    expect(new Date(g).getUTCMinutes()).toBe(30);
  });

  it('composes with "in …", a bare clock, and a part-of-day', () => {
    expect(parse('in 5ish'), 'in 5ish').toBe(parse('in 5'));
    expect(parse('at 5ish'), 'at 5ish').toBe(parse('5'));
    expect(parse('30ish min'), '30ish min').toBe(parse('30 min'));
    // "8ish tonight" still lands in the evening, softener peeled.
    expect(parse('8ish tonight'), '8ish tonight').toBeTruthy();
  });

  it('never guts an ordinary word that merely ends in "ish"', () => {
    for (const word of ['finish', 'wish', 'polish it', 'spanish', 'vanish', 'accomplish']) {
      expect(parse(word), word).toBeNull();
    }
  });
});
