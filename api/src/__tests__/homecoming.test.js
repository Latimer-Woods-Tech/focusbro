/**
 * FocusBro — person-side homecoming tests (Contender #10, Phase A · R-253).
 *
 * The 2×2 of the return loop: the bro reaches out to a gone-quiet person (R-245),
 * and greets them back either via the nudge deep-link (R-249) or — this slice —
 * when they return UNDER THEIR OWN STEAM, with the coach seeing the same on the
 * roster (reach-out R-251 / back-and-moving R-252). These tests pin the person-side
 * guarantees: a genuine homecoming is greeted EXACTLY ONCE per dormancy episode
 * (a `return_welcome_shown` marker closes it), a person who was never nudged is
 * never greeted, and the detection is non-fatal + names no gap. Detection runs
 * against a fake D1 `DB` keyed off SQL substrings — no live DB, no network.
 */

import { describe, it, expect } from 'vitest';
import { detectHomecoming } from '../accountability.js';
import { renderMePage, meCopySurface, returnWelcomeHeadingCopy, returnWelcomeBodyCopy } from '../me.js';
import { EVENTS } from '../events.js';

// ── a minimal D1-shaped fake keyed off SQL substrings ──
// `lastNudgeAt` is the newest `return_nudge_sent` for the user (null = never
// nudged); `alreadyShown` toggles a `return_welcome_shown` marker after it.
// Every INSERT into analytics_events is captured in `inserts`.
function makeDB({ lastNudgeAt = null, alreadyShown = false } = {}) {
  const inserts = [];
  const db = {
    inserts,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a; return stmt; },
        async first() {
          if (/return_nudge_sent/.test(sql)) return { last_nudge_at: lastNudgeAt };
          if (/return_welcome_shown/.test(sql)) return alreadyShown ? { 1: 1 } : null;
          return null;
        },
        async run() {
          if (/INSERT/i.test(sql) && /analytics_events/.test(sql)) inserts.push({ sql, params });
          return { success: true };
        },
      };
      return stmt;
    },
  };
  return db;
}

describe('detectHomecoming — greet a self-powered return, exactly once per episode', () => {
  const USER = 'user-abc';

  it('never greets a person who was never reached out to', async () => {
    const db = makeDB({ lastNudgeAt: null });
    const out = await detectHomecoming({ DB: db }, USER);
    expect(out).toBe(false);
    // No nudge → no marker written (nothing to close).
    expect(db.inserts.length).toBe(0);
  });

  it('greets a genuine homecoming and closes the episode with a marker', async () => {
    const db = makeDB({ lastNudgeAt: '2026-07-10 09:00:00', alreadyShown: false });
    const out = await detectHomecoming({ DB: db }, USER);
    expect(out).toBe(true);
    // Exactly one marker, of the right type, attributed to the person (their own
    // activity — this IS them coming back).
    expect(db.inserts.length).toBe(1);
    const { params } = db.inserts[0];
    expect(params[0]).toBe(USER);
    expect(params[1]).toBe(EVENTS.RETURN_WELCOME_SHOWN);
  });

  it('never re-greets once the episode has been shown (consume-once)', async () => {
    const db = makeDB({ lastNudgeAt: '2026-07-10 09:00:00', alreadyShown: true });
    const out = await detectHomecoming({ DB: db }, USER);
    expect(out).toBe(false);
    // Already closed → no second marker.
    expect(db.inserts.length).toBe(0);
  });

  it('is non-fatal and guards missing input — a missed greeting, never a throw', async () => {
    await expect(detectHomecoming(null, USER)).resolves.toBe(false);
    await expect(detectHomecoming({}, USER)).resolves.toBe(false);
    await expect(detectHomecoming({ DB: makeDB() }, '')).resolves.toBe(false);
    // A DB that throws mid-detection resolves false, never rejects.
    const boom = { DB: { prepare() { throw new Error('db down'); } } };
    await expect(detectHomecoming(boom, USER)).resolves.toBe(false);
  });
});

describe('the /me/ page wires the self-powered homecoming greeting (R-253)', () => {
  const html = renderMePage();

  it('calls the homecoming endpoint on entry and opens the SAME warm nudged-back door', () => {
    expect(html).toContain('loadHomecoming');
    expect(html).toContain('/api/accountability/homecoming');
    // Reuses the R-249 welcome panel + copy — no second, colder greeting invented.
    expect(html).toContain('id="returnWelcome"');
    expect(html).toContain(returnWelcomeHeadingCopy());
    expect(html).toContain(returnWelcomeBodyCopy());
  });

  it('drives both entry doors off one `returning` gate (deep-link OR homecoming)', () => {
    expect(html).toContain('var HOMECOMING = false;');
    expect(html).toContain('var returning = FROM_RETURN || HOMECOMING;');
  });

  it('inherits the design-LAW guarantee — the greeting copy is gate-scanned, names no gap', () => {
    // R-253 invents no new copy; it re-opens the R-249 door, whose copy is already
    // in the scanned surface. Assert the reuse so the LAW coverage can never lapse.
    const surface = meCopySurface();
    expect(surface).toContain(returnWelcomeHeadingCopy());
    expect(surface).toContain(returnWelcomeBodyCopy());
    const body = returnWelcomeBodyCopy().toLowerCase();
    for (const gapWord of ['while', 'away', 'gap', 'been so long', 'disappear']) {
      expect(body.includes(gapWord), `homecoming greeting names the gap ("${gapWord}")`).toBe(false);
    }
  });
});
