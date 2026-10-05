/**
 * One product, one number: the shell's stats card shows the kept-word total
 * from the accountability ledger — the number /me/ keeps — not a local day
 * streak of its own.
 *
 * The old "Day Streak" counted consecutive days with a pomodoro or a task and
 * reset to 0 on any quiet day. That is exactly the mechanic the design LAW bans
 * in copy ("the streak is a kept-word record that only climbs; it is never
 * broken") — the shell was contradicting the spine with a number instead of a
 * word. `total_kept` is monotonic by construction (accountability_streaks), so
 * what the shell shows can only ever go up.
 */

import { describe, it, expect } from 'vitest';
import servedHtml from '../html.js';

describe('the shell reads kept words from the ledger', () => {
  it('shows "Words kept", not a resetting day streak', () => {
    expect(servedHtml).toContain('id="statKept"');
    expect(servedHtml).toContain('Words kept');
    expect(servedHtml).not.toContain('Day Streak');
    expect(servedHtml).not.toContain('id="statStreak"');
    // no definition AND no stray call (a stray call throws on load — the e2e suite caught one)
    expect(servedHtml).not.toContain('updateStreak');
  });

  it('reads the ledger endpoint on the cookie session, after the session probe — never the /me/ token', () => {
    expect(servedHtml).toContain("fetch('/api/accountability/streak')");
    expect(servedHtml).toContain('if (fbAuthenticated) { fbFlushTelemetry(); loadKeptWords(); }');
    expect(servedHtml).not.toContain("localStorage.getItem('focusbro_token')");
    expect(servedHtml).toMatch(/typeof ledger\.total_kept === 'number'/);
    // never the current run, which a quiet stretch can zero
    expect(servedHtml).not.toMatch(/function loadKeptWords[\s\S]{0,600}current_streak/);
  });

  it('a fetch failure never throws into the page', () => {
    const start = servedHtml.indexOf('function loadKeptWords()');
    const fn = servedHtml.slice(start, servedHtml.indexOf('\n}\n', start));
    expect(fn).toContain('.catch(');
  });
});
