/**
 * FocusBro — collapse the double gesture (Contender #10, Phase A, R-314).
 *
 * A person typed a word and a time on the homepage and pressed "Give my word",
 * then landed on /me/ — the SAME form — and had to press it AGAIN. Across 942
 * visits, 0 people ever crossed that second press: 0 commitments, ever. The
 * homepage now leaves a one-shot, short-lived, same-tab token proving the press;
 * /me/ honors it by giving the word the same way the button does, so the person
 * lands on the warm confirmation instead of a second empty form.
 *
 * These tests hold the invariants that keep the collapse safe:
 *  - guests are still created only on a real human gesture (the token), never on
 *    a bare /me/?task= page load;
 *  - the manual submit and the auto path travel exactly ONE code path (giveWord);
 *  - the token is consumed before use (one-shot) and rejected when stale or when
 *    it does not match the word this page was opened for.
 */

import { describe, it, expect } from 'vitest';
import { renderMePage } from '../me.js';

const html = renderMePage();

describe('R-314 — the homepage gesture is honored in one step', () => {
  it('gives the word and the manual submit share one path (giveWord)', () => {
    // The word is given through a single named function...
    expect(html).toContain('function giveWord(opts)');
    // ...and the form submit is now just a thin caller of it — no duplicated
    // guest-creation / POST / confirmation logic to drift out of sync.
    expect(html).toContain("el('commitForm').addEventListener('submit', function (ev) { ev.preventDefault(); giveWord(); });");
    // The one shared POST target.
    expect(html).toContain("fetch('/api/commitments'");
  });

  it('auto-completes from the handoff, guarded against drive-by loads', () => {
    expect(html).toContain('function maybeAutoGiveWord()');
    expect(html).toContain('function readWordHandoff()');
    // The token the homepage leaves.
    expect(html).toContain("sessionStorage.getItem('focusbro_word_handoff')");
    // One-shot: consumed BEFORE it is used, so a reload never re-fires it.
    expect(html).toContain("sessionStorage.removeItem('focusbro_word_handoff')");
    // Short-lived: a token older than ~60s is not a "just now" gesture.
    expect(html).toContain('(Date.now() - h.ts) > 60000');
    // Only honor a token for the very word this page was opened for.
    expect(html).toContain('if (PREFILL_TASK && h.t && h.t !== PREFILL_TASK) return;');
    // The auto path calls the SAME giveWord, flagged so it stays quiet on the one
    // failure it must not shout (a missing time never happens on this path).
    expect(html).toContain('giveWord({ auto: true });');
  });

  it('the auto-give runs on load in BOTH the anonymous and the returning-session doors', () => {
    // Anonymous: the form-first door prefills, then honors the gesture.
    expect(html).toMatch(/function enterAnonymous\(\) \{[\s\S]*applyPrefill\(\);\s*maybeAutoGiveWord\(\);/);
    // Returning session: same, after its loads are kicked off.
    expect(html).toMatch(/function enterApp\(session\) \{[\s\S]*applyPrefill\(\);[\s\S]*maybeAutoGiveWord\(\);/);
  });

  it('a bare page load with no token creates nothing — the guest gesture is preserved', () => {
    // maybeAutoGiveWord returns before giveWord unless readWordHandoff yields a
    // token; readWordHandoff returns null with no stored token. The account is
    // still born on the homepage press, never on merely opening /me/.
    expect(html).toContain('var h = readWordHandoff();\n    if (!h) return;');
    // And startGuest (account creation) is still reached only via giveWord's
    // ANONYMOUS branch — never called directly on load.
    expect(html).toContain('(ANONYMOUS ? startGuest() : Promise.resolve(null))');
  });
});
