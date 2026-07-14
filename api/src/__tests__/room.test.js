import { describe, expect, it } from 'vitest';
import {
  presenceLine,
  nextSprintLine,
  roomCopySurface,
  registerRoomRoutes,
} from '../room.js';

// Focus sprints = ambient body doubling. The cold-start law: a quiet room must
// read as warmth, never as being alone. These tests pin the copy, the count
// math, and the anonymous heartbeat routes.

const SHAME = [
  /\bfail(ed|ure|ing|s)?\b/i, /\blaz(y|iness)\b/i, /\bdisappoint/i, /\bguilt/i,
  /\bashamed\b/i, /\bshame\b/i, /\byou (didn.?t|should have|should.?ve)\b/i,
  /\bfall(ing|en)? behind\b/i, /\bbehind\b/i, /\bexcuse/i, /\bpathetic\b/i,
  /\bworthless\b/i, /\bmiss(ed|es|ing)?\b/i, /\balone\b/i,
];
const CLINICAL = [/\btreat(s|ment|ing)?\b/i, /\bcure/i, /\bdiagnos/i, /\bdisorder/i, /\bsymptom/i, /\bADHD\b/i, /\bmedication\b/i];
const AI = /\bAI\b/;

describe('presence copy — the cold-start law (a quiet room is warmth, never "alone")', () => {
  it('frames a solo/quiet room warmly for count 0 and 1', () => {
    for (const c of [0, 1]) {
      const s = presenceLine(c);
      expect(s.toLowerCase()).not.toContain('alone');
      expect(s).toMatch(/quiet room/);
    }
  });

  it('counts others correctly (the count includes you)', () => {
    expect(presenceLine(2)).toMatch(/one other person/);
    expect(presenceLine(5)).toMatch(/4 others/);
  });

  it('every room string is anti-shame, non-clinical, and never says "AI"', () => {
    for (const s of roomCopySurface()) {
      for (const p of SHAME) expect(p.test(s), `shame in "${s}" matched ${p}`).toBe(false);
      for (const p of CLINICAL) expect(p.test(s), `clinical in "${s}"`).toBe(false);
      expect(AI.test(s), `no "AI" in "${s}"`).toBe(false);
    }
  });
});

describe('nextSprintLine — convergence nudge from UTC minutes', () => {
  it('reports minutes to the next top-of-hour', () => {
    expect(nextSprintLine('2026-07-14T10:48:00.000Z')).toMatch(/about 12 minutes/);
    expect(nextSprintLine('2026-07-14T10:59:00.000Z')).toMatch(/about a minute/);
    expect(nextSprintLine('2026-07-14T10:00:00.000Z')).toMatch(/about 60 minutes/);
  });
});

// Fake D1: the COUNT query returns `count`; records upserts + prunes.
function makeDB(count) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      let params = [];
      return {
        bind(...p) { params = p; return this; },
        first: async () => (/COUNT\(\*\)/.test(sql) ? { c: count } : null),
        run: async () => { calls.push({ sql, params }); return { success: true }; },
      };
    },
  };
}
function routes(db) {
  const r = {};
  const router = { post: (p, h) => { r['POST ' + p] = h; }, get: (p, h) => { r['GET ' + p] = h; } };
  registerRoomRoutes(router, { jsonResponse: (body, status = 200) => ({ body, status }) });
  const env = { DB: db };
  return {
    beat: (payload) => r['POST /api/room/heartbeat']({ json: async () => payload }, env),
    count: () => r['GET /api/room/count']({}, env),
  };
}

describe('POST /api/room/heartbeat + GET /api/room/count', () => {
  it('heartbeat upserts, prunes stale rows, and returns the live count + line', async () => {
    const db = makeDB(3);
    const res = await routes(db).beat({ client_id: 'abc-123' });
    expect(res.status).toBe(200);
    expect(res.body.focusing).toBe(3);
    expect(res.body.line).toMatch(/2 others/);
    expect(res.body.next_sprint_line).toMatch(/sprint/);
    expect(db.calls.find((c) => /INSERT INTO focus_presence/.test(c.sql))).toBeTruthy();
    expect(db.calls.find((c) => /DELETE FROM focus_presence/.test(c.sql))).toBeTruthy();
  });

  it('rejects a missing or over-long client_id with 400 (never writes)', async () => {
    const db1 = makeDB(0);
    expect((await routes(db1).beat({})).status).toBe(400);
    expect(db1.calls.find((c) => /INSERT INTO focus_presence/.test(c.sql))).toBeFalsy();
    expect((await routes(makeDB(0)).beat({ client_id: 'x'.repeat(65) })).status).toBe(400);
  });

  it('GET count returns the count + the warm solo line when quiet', async () => {
    const res = await routes(makeDB(1)).count();
    expect(res.status).toBe(200);
    expect(res.body.focusing).toBe(1);
    expect(res.body.line).toMatch(/quiet room/);
  });
});
