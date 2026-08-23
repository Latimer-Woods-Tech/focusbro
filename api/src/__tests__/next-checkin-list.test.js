/**
 * FocusBro — person-facing next check-in on the /me/ list (Contender #10, Phase A, R-233).
 *
 * The /me/ list showed each word's original start time + cadence, but the
 * concrete NEXT moment the bro shows up lived only in the per-word detail panel
 * (R-222). This slice attaches `next_checkin` to every ACTIVE word in
 * `GET /api/commitments` — one grouped query, no N+1 — so the person sees it
 * across their whole list at a glance (the person-side twin of the coach's
 * next-check-in, R-224).
 *
 * DESIGN LAW checks live here too: a resolved/kept/moved word carries no
 * next_checkin, and the copy for an already-past-but-open check-in is warm
 * ("still here"), never a "late"/"overdue"/miss scold.
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import { registerAccountabilityRoutes } from '../accountability.js';
import { listNextCheckinLabelCopy, listNextCheckinWaitingCopy } from '../me.js';
import { generateUUID } from '../middleware.js';
import { scanDesignLaw } from '../design-law.js';

// THE DESIGN LAW is one lexicon now (design-law.js). This person-facing /me/
// surface used to hand-roll its own banned-word union, which had drifted WEAKER
// than canonical: it missed `disappoint`, `ashamed`, `pathetic`, `worthless`,
// `unrespons`, `slipping`, the incredulous `again?!`, `disorder`, `symptom`,
// `medication`, `therapy`, the bare word `ADHD` (banned in consumer copy), and
// the fuller shame/clinical stems the terse union missed — `failing`/`fails`
// (its `fail|failed|failure` never caught the `-ing`/`-s` forms), `laziness`
// (only `lazy`), and `treats`/`treating` (only `treat`/`treatment`). Route the
// guard through `scanDesignLaw` (shame + clinical + "AI" branding + consumer-ADHD
// in one pass) so this /me/ next-check-in copy is held to the same bar as every
// other surface — while preserving the genuine per-surface extras the canonical
// list intentionally does NOT carry:
//   • `late` / `overdue` — the miss-framing this line must never use
//   • bare `slack(ing)` — canonical only bans "slack off" (so "Slack" the app
//     stays sayable elsewhere); this line never names the app, so the stricter
//     form is kept here
//   • bare `should have` — canonical anchors it to "you should have"
const localExtras = /\b(late|overdue|slack(ing)?|should have)\b/i;
const hasBanned = (s) => scanDesignLaw(String(s)).length > 0 || localExtras.test(String(s));

// ── router harness (mirrors kept-log.test.js) ────────────────
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
const ctx = {
  getAuthToken: (request) => {
    const h = request.headers.get('Authorization');
    return h && h.startsWith('Bearer ') ? h.slice(7) : null;
  },
  verifyToken: async (token) => (token === 'good' ? { sub: 'u1' } : null),
  jsonResponse,
  generateUUID,
};

// In-memory D1 double. The commitments list query returns `commitments`; the
// grouped outstanding-check-in query returns `outstanding` rows shaped
// { commitment_id, next_checkin }.
function makeDB({ commitments = [], outstanding = [], unreachable = [] } = {}) {
  const queries = [];
  const db = {
    queries,
    prepare(sql) {
      queries.push(sql);
      const stmt = {
        bind() { return stmt; },
        async first() { return null; },
        async all() {
          if (/FROM commitments\b/.test(sql)) return { results: commitments };
          if (/FROM commitment_checkins/.test(sql) && /GROUP BY commitment_id/.test(sql)) {
            // Two grouped check-in queries share the shape; the in-app fallback
            // one is the only one that filters skipped rows by last_error.
            if (/status = 'skipped'/.test(sql)) return { results: unreachable };
            return { results: outstanding };
          }
          return { results: [] };
        },
        async run() { return { success: true, meta: { changes: 1 } }; },
      };
      return stmt;
    },
  };
  return db;
}

function buildRouter(db) {
  const router = Router();
  registerAccountabilityRoutes(router, ctx);
  const env = { DB: db, JWT_SECRET: 'test' };
  return (method, path, { token = 'good' } = {}) => {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = new Request('https://x' + path, { method, headers });
    return router.handle(req, env);
  };
}

const ACTIVE = { id: 'c-active', title: 'start the taxes', status: 'active', start_at: '2026-07-12T14:00:00Z', recurrence: 'none' };
const RECUR = { id: 'c-recur', title: 'morning pages', status: 'active', start_at: '2026-07-12T08:00:00Z', recurrence: 'daily' };
const KEPT = { id: 'c-kept', title: 'call the dentist', status: 'kept', start_at: '2026-07-10T09:00:00Z', recurrence: 'none' };

describe('GET /api/commitments — next check-in attached to active words (R-233)', () => {
  it('attaches next_checkin to each active word from the grouped outstanding query', async () => {
    const db = makeDB({
      commitments: [ACTIVE, RECUR, KEPT],
      outstanding: [
        { commitment_id: 'c-active', next_checkin: '2026-07-12T15:00:00Z' },
        { commitment_id: 'c-recur', next_checkin: '2026-07-13T08:00:00Z' },
      ],
    });
    const res = await buildRouter(db)('GET', '/api/commitments');
    expect(res.status).toBe(200);
    const body = await res.json();
    const byId = Object.fromEntries(body.commitments.map((c) => [c.id, c]));
    expect(byId['c-active'].next_checkin).toBe('2026-07-12T15:00:00Z');
    expect(byId['c-recur'].next_checkin).toBe('2026-07-13T08:00:00Z');
  });

  it('never attaches a next_checkin to a non-active (kept/moved/released) word', async () => {
    const db = makeDB({
      commitments: [KEPT],
      // Even if a stray outstanding row existed for it, a non-active word stays null.
      outstanding: [{ commitment_id: 'c-kept', next_checkin: '2026-07-12T15:00:00Z' }],
    });
    const res = await buildRouter(db)('GET', '/api/commitments');
    const body = await res.json();
    expect(body.commitments[0].next_checkin).toBeNull();
  });

  it('leaves next_checkin null for an active word with nothing queued', async () => {
    const db = makeDB({ commitments: [ACTIVE], outstanding: [] });
    const res = await buildRouter(db)('GET', '/api/commitments');
    const body = await res.json();
    expect(body.commitments[0].next_checkin).toBeNull();
  });

  it('reads check-ins with grouped queries only (no N+1 per commitment)', async () => {
    const db = makeDB({
      commitments: [ACTIVE, RECUR],
      outstanding: [{ commitment_id: 'c-active', next_checkin: '2026-07-12T15:00:00Z' }],
    });
    await buildRouter(db)('GET', '/api/commitments');
    // The outstanding read is a single grouped query; the in-app fallback adds AT
    // MOST one more grouped query (only when a word is left unfilled) — the total
    // never scales with the number of commitments.
    const outstandingQ = db.queries.filter((q) => /FROM commitment_checkins/.test(q) && /GROUP BY commitment_id/.test(q) && !/status = 'skipped'/.test(q));
    const fallbackQ = db.queries.filter((q) => /FROM commitment_checkins/.test(q) && /status = 'skipped'/.test(q));
    expect(outstandingQ.length).toBe(1);
    expect(fallbackQ.length).toBeLessThanOrEqual(1);
  });

  it('requires auth', async () => {
    const db = makeDB({ commitments: [ACTIVE] });
    const res = await buildRouter(db)('GET', '/api/commitments', { token: null });
    expect(res.status).toBe(401);
  });
});

// ── in-app fallback: the bro shows up even when we could not reach the person ──
// A one-shot word whose only check-in was parked `skipped` for a MISSING DELIVERY
// CHANNEL (no push subscription / push or text not configured / no number) never
// reached the person: no push, no SMS. It has no next occurrence, so it silently
// vanished from /me/ — the ONE place the bro could still hold the door. This slice
// surfaces its most recent unreachable check-in as `next_checkin` (a past moment →
// the warm "still here" open door), never a miss. An aged-out `stale` skip is NOT
// resurfaced, and a word with anything genuinely outstanding is untouched.
describe('GET /api/commitments — in-app fallback for a check-in the bro could not deliver', () => {
  it('surfaces an unreachable one-shot skip as the (past) next_checkin open door', async () => {
    const db = makeDB({
      commitments: [ACTIVE],
      outstanding: [], // nothing pending/sent/deferred/awaiting — the one-shot was skipped
      unreachable: [{ commitment_id: 'c-active', next_checkin: '2026-07-12T14:00:00Z' }],
    });
    const res = await buildRouter(db)('GET', '/api/commitments');
    const body = await res.json();
    expect(body.commitments[0].next_checkin).toBe('2026-07-12T14:00:00Z');
    // It reads as the warm already-past open door: the scheduled moment is in the past.
    expect(new Date(body.commitments[0].next_checkin).getTime()).toBeLessThan(Date.now());
  });

  it('the fallback query targets ONLY no-channel skips, never an aged-out `stale` one', async () => {
    const db = makeDB({ commitments: [ACTIVE], outstanding: [], unreachable: [] });
    await buildRouter(db)('GET', '/api/commitments');
    const fallback = db.queries.find((q) => /FROM commitment_checkins/.test(q) && /status = 'skipped'/.test(q));
    expect(fallback, 'the fallback query should run when a word is unfilled').toBeTruthy();
    // Precisely the four "we had no way to reach them" details, and no more.
    for (const detail of ['no_subscription', 'push_not_configured', 'no_phone', 'text_not_configured']) {
      expect(fallback).toContain(detail);
    }
    // The aged-out skip is deliberately excluded — it never haunts the list.
    expect(fallback).not.toContain('stale');
  });

  it('an outstanding check-in always wins over the fallback (no override of a live moment)', async () => {
    const db = makeDB({
      commitments: [ACTIVE],
      outstanding: [{ commitment_id: 'c-active', next_checkin: '2026-07-12T15:00:00Z' }],
      unreachable: [{ commitment_id: 'c-active', next_checkin: '2026-07-12T14:00:00Z' }],
    });
    const res = await buildRouter(db)('GET', '/api/commitments');
    const body = await res.json();
    expect(body.commitments[0].next_checkin).toBe('2026-07-12T15:00:00Z');
    // And the extra grouped query is skipped entirely when nothing is unfilled.
    const fallback = db.queries.filter((q) => /FROM commitment_checkins/.test(q) && /status = 'skipped'/.test(q));
    expect(fallback.length).toBe(0);
  });

  it('never resurrects an unreachable skip onto a non-active (kept/moved) word', async () => {
    const db = makeDB({
      commitments: [KEPT],
      outstanding: [],
      unreachable: [{ commitment_id: 'c-kept', next_checkin: '2026-07-10T09:00:00Z' }],
    });
    const res = await buildRouter(db)('GET', '/api/commitments');
    const body = await res.json();
    expect(body.commitments[0].next_checkin).toBeNull();
  });
});

describe('R-233 copy obeys the design LAW (never shame)', () => {
  const strings = [listNextCheckinLabelCopy(), listNextCheckinWaitingCopy()];

  it('the label and the waiting line carry no shame, no miss tally, no "AI", no clinical claim', () => {
    for (const s of strings) {
      expect(typeof s).toBe('string');
      expect(s.length).toBeGreaterThan(0);
      expect(hasBanned(s), `banned word in: "${s}"`).toBe(false);
    }
  });

  it('the waiting line is warmly forward, not a scold about time passing', () => {
    expect(listNextCheckinWaitingCopy().toLowerCase()).toContain('still here');
  });
});

// ── proof-of-rejection (Standing Law #1): the fold STRENGTHENS this surface ──
// Pins that routing through scanDesignLaw catches shame/clinical framings the old
// hand-rolled union silently missed, that the preserved per-surface extras still
// fire, and — the load-bearing one — that the warm next-check-in copy stays clean,
// so the anti-shame LAW is protected by construction, not by luck.
describe('the /me/ next-check-in copy is guarded by the ONE canonical design-LAW scanner (never shame)', () => {
  it('catches shame/clinical framings the old per-surface union silently missed', () => {
    // None of these were in the old `banned` union; all are caught by scanDesignLaw now.
    for (const bad of [
      'you disappointed me',           // disappoint
      'that was pathetic',             // pathetic
      'you feel worthless',            // worthless
      "you're slipping",               // slipping (never guarded here before)
      'not this again?!',              // the incredulous again?! (the R-331 dead-regex class)
      'this is therapy for you',       // therapy (clinical)
      'a diagnosed disorder',          // disorder (clinical, unguarded before)
      'take your medication',          // medication (clinical, unguarded before)
      'built for your ADHD',           // ADHD in consumer copy (unguarded before)
      'you keep failing',              // failing (the -ing stem the terse union missed)
      'sheer laziness',                // laziness (only `lazy` was guarded)
      'it treats the condition',       // treats (only `treat`/`treatment` was guarded)
    ]) {
      expect(hasBanned(bad), `should be caught: ${bad}`).toBe(true);
    }
  });

  it('still fires on the genuine per-surface extras kept out of the canonical list', () => {
    for (const bad of ['the taxes are late', 'the taxes are overdue', 'stop slacking', 'you should have started']) {
      expect(hasBanned(bad), `per-surface extra should fire: ${bad}`).toBe(true);
    }
  });

  it('leaves the warm next-check-in copy clean (the anti-shame LAW survives)', () => {
    for (const good of [
      listNextCheckinLabelCopy(),
      listNextCheckinWaitingCopy(),
      'Still here whenever you’re ready',
      'when do you want to try again?', // single "?" — the warm reschedule, NOT the eye-roll
    ]) {
      expect(hasBanned(good), `warm copy must stay clean: ${good}`).toBe(false);
    }
  });
});
