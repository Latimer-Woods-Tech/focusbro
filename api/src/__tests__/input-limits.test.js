/**
 * FBQ-17 (focusbro#391): input limits and id hygiene — proven against a REAL
 * migrated SQLite D1 through the Worker's own fetch().
 *
 * Mutants killed: no heartbeat limiter / no client_id charset; parseWhen with no
 * range bound (RangeError → 500); an uncaught decodeURIComponent; a timezone that
 * is never checked (recurring word never repeats, night guard off); no active cap
 * (or one that counts released words); Math.random ids; /auth/* accepting
 * text/plain; a list that skips or repeats rows across cursor pages.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../index.js';
import { generateUUID } from '../middleware.js';
import { DatabaseSync, makeMigratedD1, makeKV } from './helpers/real-d1.js';
import { config } from '../config.js';

const HEARTBEAT_LIMIT = 30; // room.js budget; asserted by behaviour below, not imported (a missing export must fail the TEST, not the import)
const suite = DatabaseSync ? describe : describe.skip;
const ORIGIN = 'https://focusbro.net';
const ctx = { waitUntil() {}, passThroughOnException() {} };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function makeEnv() {
  return {
    DB: makeMigratedD1(),
    KV_CACHE: makeKV(),
    JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256-0123456789',
    AUDIO: { head: async () => null, get: async () => null },
  };
}

let ipCounter = 0;
const call = (env, path, { method = 'GET', body, headers = {}, ip } = {}) => worker.fetch(new Request(ORIGIN + path, {
  method,
  headers: { Origin: ORIGIN, 'CF-Connecting-IP': ip || `198.51.100.${(ipCounter += 1) % 250}`, ...headers },
  body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
}), env, ctx);
const json = { 'Content-Type': 'application/json' };

async function guest(env) {
  const res = await call(env, '/auth/guest', { method: 'POST', headers: json, body: {} });
  expect(res.status).toBe(201);
  const cookie = res.headers.get('Set-Cookie').split(';')[0];
  return { cookie, id: (await res.json()).user_id };
}
const create = (env, g, over = {}) => call(env, '/api/commitments', {
  method: 'POST', headers: { ...json, Cookie: g.cookie },
  body: { title: 'walk', start_at: new Date(Date.now() + 3600e3).toISOString(), ...over },
});
const rowCount = (env, sql, ...a) => env.DB.sqlite.prepare(sql).get(...a).n;

afterEach(() => { vi.restoreAllMocks(); });

suite('FBQ-17 R1 heartbeat (real D1)', () => {
  const beat = (env, client_id, ip = '203.0.113.50') => call(env, '/api/room/heartbeat', { method: 'POST', headers: json, body: { client_id }, ip });

  it('answers 429 past the per-IP budget and stops writing', async () => {
    const env = makeEnv();
    for (let i = 0; i < HEARTBEAT_LIMIT; i += 1) expect((await beat(env, `c-${i}-abcdef`)).status).toBe(200);
    const over = await beat(env, 'c-over-abcdef');
    expect(over.status).toBe(429);
    expect(Number(over.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(rowCount(env, 'SELECT COUNT(*) AS n FROM focus_presence')).toBe(HEARTBEAT_LIMIT);
    // another address is unaffected
    expect((await beat(env, 'c-other-abcdef', '203.0.113.51')).status).toBe(200);
  });

  it('keeps the real client working (uuid and the c-<base36> fallback ids)', async () => {
    const env = makeEnv();
    expect((await beat(env, crypto.randomUUID())).status).toBe(200);
    expect((await beat(env, 'c-' + Date.now().toString(36))).status).toBe(200);
  });

  it('rejects ids with a bad charset with 400 and writes nothing', async () => {
    const env = makeEnv();
    for (const bad of ["x'; DROP TABLE focus_presence;--", 'has space', 'émoji-é', '<script>']) {
      expect((await beat(env, bad)).status).toBe(400);
    }
    expect(rowCount(env, 'SELECT COUNT(*) AS n FROM focus_presence')).toBe(0);
  });
});

suite('FBQ-17 R2 extremes answer 400, not 500 (real D1)', () => {
  it('start_at at the edge of Date → 400, nothing written', async () => {
    const env = makeEnv();
    const g = await guest(env);
    for (const start_at of ['+275760-09-13T00:00:00.000Z', 8.64e15, '1000-01-01T00:00:00Z']) {
      const res = await create(env, g, { start_at });
      expect(res.status, String(start_at)).toBe(400);
    }
    expect(rowCount(env, 'SELECT COUNT(*) AS n FROM commitments')).toBe(0);
  });

  it('a malformed % path on /audio/* → 400', async () => {
    const env = makeEnv();
    expect((await call(env, '/audio/%E0%A4%A')).status).toBe(400);
    expect((await call(env, '/audio/nope.m4a')).status).toBe(404);
  });
});

suite('FBQ-17 R3 time zone (real D1)', () => {
  it('an unknown or over-long zone → 400 on create, never stored', async () => {
    const env = makeEnv();
    const g = await guest(env);
    expect((await create(env, g, { timezone: 'Mars/Olympus_Mons' })).status).toBe(400);
    expect((await create(env, g, { timezone: 'America/' + 'x'.repeat(70) })).status).toBe(400);
    expect(rowCount(env, 'SELECT COUNT(*) AS n FROM commitments')).toBe(0);
    expect((await create(env, g, { timezone: 'America/Chicago', recurrence: 'daily', local_time: '08:40' })).status).toBe(201);
    expect((await create(env, g, {})).status).toBe(201); // blank → UTC still fine
  });

  it('an edit to a bad zone → 400, the stored zone is untouched', async () => {
    const env = makeEnv();
    const g = await guest(env);
    const made = await (await create(env, g, { timezone: 'America/Chicago' })).json();
    const id = made.commitment.id;
    const res = await call(env, `/api/commitments/${id}/edit`, { method: 'POST', headers: { ...json, Cookie: g.cookie }, body: { timezone: 'Nope/Zone' } });
    expect(res.status).toBe(400);
    expect(env.DB.sqlite.prepare('SELECT timezone FROM commitments WHERE id = ?').get(id).timezone).toBe('America/Chicago');
  });

  it('a stored row that already has a bad zone still reads (list + detail) without a 500', async () => {
    const env = makeEnv();
    const g = await guest(env);
    const made = await (await create(env, g)).json();
    env.DB.sqlite.prepare('UPDATE commitments SET timezone = ? WHERE id = ?').run('Bad/Zone', made.commitment.id);
    expect((await call(env, '/api/commitments', { headers: { Cookie: g.cookie } })).status).toBe(200);
    expect((await call(env, `/api/commitments/${made.commitment.id}`, { headers: { Cookie: g.cookie } })).status).toBe(200);
  });
});

suite('FBQ-17 R4 active-word cap (real D1)', () => {
  const insertWord = (env) => env.DB.sqlite.prepare(
    `INSERT INTO commitments (id, user_id, title, start_at, checkin_at, status) VALUES (?, ?, 'w', ?, ?, ?)`);

  it('refuses the word past the cap; releasing one frees a slot', async () => {
    const env = makeEnv();
    const g = await guest(env);
    const cap = 50; // the documented default; config is checked in the next line
    expect(config.data.maxActiveCommitments).toBe(cap);
    // Seed straight into D1 (50 API creates would only re-test the same route).
    const ins = insertWord(env);
    for (let i = 0; i < cap - 1; i += 1) ins.run(`seed-${i}`, g.id, `2030-01-01T00:${String(i).padStart(2, '0')}:00.000Z`, '2030-01-01T01:00:00.000Z', 'active');
    ins.run('settled-1', g.id, '2030-02-01T00:00:00.000Z', '2030-02-01T01:00:00.000Z', 'released'); // not counted
    expect((await create(env, g)).status).toBe(201);
    const fiftyFirst = await create(env, g);
    expect(fiftyFirst.status).toBe(409);
    expect((await fiftyFirst.json()).error).toMatch(/set one down/i);
    expect(rowCount(env, "SELECT COUNT(*) AS n FROM commitments WHERE user_id = ? AND status = 'active'", g.id)).toBe(cap);
    const rel = await call(env, '/api/commitments/seed-0/release', { method: 'POST', headers: { ...json, Cookie: g.cookie }, body: {} });
    expect(rel.status).toBe(200);
    expect((await create(env, g)).status).toBe(201);
  });

  it('is per person: another user is unaffected', async () => {
    const env = makeEnv();
    const a = await guest(env);
    const b = await guest(env);
    const ins = insertWord(env);
    for (let i = 0; i < 50; i += 1) ins.run(`a-${i}`, a.id, '2030-01-01T00:00:00.000Z', '2030-01-01T01:00:00.000Z', 'active');
    expect((await create(env, a)).status).toBe(409);
    expect((await create(env, b)).status).toBe(201);
  });
});

describe('FBQ-17 R6 ids come from crypto.randomUUID', () => {
  it('generateUUID returns a v4 UUID, delegates to crypto, and never touches Math.random', () => {
    const rnd = vi.spyOn(Math, 'random');
    const spy = vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-2222-4333-8444-555555555555');
    expect(generateUUID()).toBe('11111111-2222-4333-8444-555555555555');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(generateUUID()).toMatch(UUID_V4);
    expect(rnd).not.toHaveBeenCalled();
  });
});

suite('FBQ-17 R7 /auth/* requires JSON (real D1)', () => {
  it('text/plain and form posts to /auth/login → 415 before any work', async () => {
    const env = makeEnv();
    const body = JSON.stringify({ email: 'a@b.co', password: 'whatever-long-enough' });
    const plain = await call(env, '/auth/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body });
    expect(plain.status).toBe(415);
    const form = await call(env, '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=a@b.co&password=x' });
    expect(form.status).toBe(415);
    expect(rowCount(env, 'SELECT COUNT(*) AS n FROM rate_limits')).toBe(0);
  });

  it('JSON (with a charset) and the body-less logout/exchange posts still reach their handlers', async () => {
    const env = makeEnv();
    const body = JSON.stringify({ email: 'a@b.co', password: 'whatever-long-enough' });
    expect((await call(env, '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body })).status).toBe(401);
    expect((await call(env, '/auth/logout', { method: 'POST' })).status).not.toBe(415);
    expect((await call(env, '/auth/exchange', { method: 'POST' })).status).not.toBe(415);
    expect((await call(env, '/auth/guest', { method: 'POST', headers: json, body: '{}' })).status).toBe(201);
  });
});

suite('FBQ-17 R8 pagination (real D1)', () => {
  async function seeded(n) {
    const env = makeEnv();
    const g = await guest(env);
    const ins = env.DB.sqlite.prepare(
      `INSERT INTO commitments (id, user_id, title, start_at, checkin_at, status) VALUES (?, ?, 'w', ?, ?, ?)`);
    for (let i = 0; i < n; i += 1) {
      // tied start_at on purpose (id breaks the tie), mixed statuses (active sorts first)
      ins.run(`id-${String(i).padStart(3, '0')}`, g.id, `2031-01-01T00:0${i % 3}:00.000Z`, '2031-01-01T01:00:00.000Z', i % 4 === 0 ? 'released' : 'active');
    }
    return { env, g };
  }
  const list = (env, g, q = '') => call(env, '/api/commitments' + q, { headers: { Cookie: g.cookie } });

  it('the default call keeps its shape: { commitments } and no next_cursor', async () => {
    const { env, g } = await seeded(12);
    const b = await (await list(env, g)).json();
    expect(Object.keys(b)).toEqual(['commitments']);
    expect(b.commitments).toHaveLength(12);
  });

  it('limit works and the cursor walks every row exactly once, in list order', async () => {
    const { env, g } = await seeded(23);
    const full = (await (await list(env, g)).json()).commitments.map((c) => c.id);
    const seen = [];
    let q = '?limit=5';
    for (let guard = 0; guard < 10; guard += 1) {
      const b = await (await list(env, g, q)).json();
      expect(b.commitments.length).toBeLessThanOrEqual(5);
      seen.push(...b.commitments.map((c) => c.id));
      if (!b.next_cursor) break;
      q = `?limit=5&cursor=${encodeURIComponent(b.next_cursor)}`;
    }
    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23);
    expect(seen).toEqual(full);
  });

  it('omits next_cursor on an exact-fit last page and rejects bad limit/cursor with 400', async () => {
    const { env, g } = await seeded(6);
    expect((await (await list(env, g, '?limit=6')).json()).next_cursor).toBeUndefined();
    for (const q of ['?limit=0', '?limit=201', '?limit=abc', '?cursor=!!!', '?cursor=' + btoa('[9,1,2]')]) {
      expect((await list(env, g, q)).status, q).toBe(400);
    }
  });
});
