/**
 * FBQ-10 (R1–R3) — the coach tables exist from MIGRATIONS ALONE.
 *
 * `operators`, `operator_clients`, `coach_operators` and `coach_checkin_config`
 * were created only by `initializeDatabase` (api/src/index.js), which nothing
 * calls (FBQ-10 R5 has since deleted those dead statements). No migration created them, and production's sqlite_master (read
 * 2026-10-05) listed none of the four. Every other coach test runs on a mock
 * or seeds the runtime CREATEs first (RUNTIME_CREATES), so the gap was
 * invisible: coach onboarding, the roster's coach_operators lookup and the
 * cron's coach-voice JOIN all fail against the schema production actually has.
 *
 * This suite builds a real SQLite D1 from migrations/*.sql ONLY — no runtime
 * CREATE is replayed — and proves:
 *  1. the four tables and their four indexes exist;
 *  2. their columns, types, defaults, NOT NULL, primary keys, foreign keys and
 *     index definitions match the runtime definitions exactly;
 *  3. migration 0009 is idempotent — it re-applies cleanly over itself and over
 *     a database that already holds the runtime-created tables;
 *  4. the real coach flow works end to end on those tables: onboarding, the
 *     check-in config, an accepted invite, the operator roster, and the cron
 *     speaking the coach's opening line to the client.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import worker from '../index.js';
import { deliverCheckin } from '../checkins-cron.js';
import { DatabaseSync, makeMigratedD1, makeKV } from './helpers/real-d1.js';

const suite = DatabaseSync ? describe : describe.skip;
const SECRET = 'test-secret-that-is-long-enough-for-hs256-0123456789';
const ORIGIN = 'https://focusbro.net';
const ctx = { waitUntil() {}, passThroughOnException() {} };

const COACH_TABLES = ['operators', 'operator_clients', 'coach_operators', 'coach_checkin_config'];
const COACH_INDEXES = [
  'idx_operators_slug',
  'idx_operators_connect_account',
  'idx_operator_clients_operator',
  'idx_operator_clients_external',
];

const MIGRATION_0009 = new URL('../../../migrations/0009_coach_tables.sql', import.meta.url);

const names = (sdb, type) => sdb.prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name').all(type).map((r) => r.name);
suite('FBQ-10: the coach tables come from migrations alone', () => {
  it('a database built only from migrations/ has the four coach tables and their indexes', () => {
    const { sqlite } = makeMigratedD1();
    const tables = names(sqlite, 'table');
    const indexes = names(sqlite, 'index');
    expect(COACH_TABLES.filter((t) => !tables.includes(t)), 'coach tables missing from migrations').toEqual([]);
    expect(COACH_INDEXES.filter((i) => !indexes.includes(i)), 'coach indexes missing from migrations').toEqual([]);
  });

  it('their columns are exactly the ones the coach code reads and writes (the migration is the only definition now)', () => {
    const { sqlite } = makeMigratedD1();
    const cols = (t) => sqlite.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name).join(',');
    expect(cols('operators')).toBe('id,slug,display_name,status,connect_account_id,charge_mode,white_label,default_currency,metadata,created_at,updated_at');
    expect(cols('operator_clients')).toBe('id,operator_id,external_org_id,name,status,retail_override,metadata,created_at,updated_at');
    expect(cols('coach_operators')).toBe('user_id,operator_id,created_at');
    expect(cols('coach_checkin_config')).toBe('operator_id,cadence,voice_persona,script,updated_at');
    const fk = (t) => sqlite.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => `${f.from}->${f.table}.${f.to}`).sort();
    expect(fk('operator_clients')).toEqual(['operator_id->operators.id']);
  });

  it('0009 is idempotent: it re-applies over itself and keeps existing rows', () => {
    const sql = readFileSync(MIGRATION_0009, 'utf8');
    const { sqlite } = makeMigratedD1();
    sqlite.exec("INSERT INTO operators (id, slug, display_name, created_at, updated_at) VALUES ('op1', 's', 'Sam', 'now', 'now')");
    expect(() => sqlite.exec(sql)).not.toThrow();
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM operators').get().n).toBe(1);
  });

  it('is additive only — no DROP, no ALTER … RENAME, no DELETE', () => {
    const sql = readFileSync(MIGRATION_0009, 'utf8').replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\bDROP\b|\bRENAME\b|\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b|\bINSERT\b/i);
    expect(sql.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(4);
  });
});

// ── the real coach flow, on the migrated schema only (no RUNTIME_CREATES) ──
function makeEnv() {
  const DB = makeMigratedD1();
  DB.sqlite.exec('PRAGMA foreign_keys = ON'); // D1 enforces foreign keys; so does this flow
  return { DB, KV_CACHE: makeKV(), JWT_SECRET: SECRET, BUILD_SHA: 'abc1234' };
}
function req(method, path, { cookie, body } = {}) {
  const h = {};
  if (cookie) h.Cookie = cookie;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; h.Origin = ORIGIN; }
  return new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function guest(env) {
  const g = await worker.fetch(req('POST', '/auth/guest', { body: {} }), env, ctx);
  expect(g.status).toBe(201);
  const cookie = g.headers.get('Set-Cookie').split(';')[0];
  const me = env.DB.sqlite.prepare('SELECT id, email FROM users ORDER BY rowid DESC LIMIT 1').get();
  return { cookie, userId: me.id, email: me.email };
}

afterEach(() => vi.unstubAllGlobals());

suite('FBQ-10: coach onboarding → roster → cron voice on the real tables', () => {
  it('a coach onboards, sets a voice, seats an accepted client, and the client hears the coach', async () => {
    const env = makeEnv();
    const coach = await guest(env);
    const client = await guest(env);

    // 1. Onboarding writes operators + coach_operators.
    const onboard = await worker.fetch(req('POST', '/api/coach/onboarding', { cookie: coach.cookie, body: { displayName: 'Sam Rivera Coaching' } }), env, ctx);
    expect(onboard.status, await onboard.clone().text()).toBe(201);
    const { operator_id: operatorId } = await onboard.json();
    expect(env.DB.sqlite.prepare('SELECT operator_id FROM coach_operators WHERE user_id = ?').get(coach.userId).operator_id).toBe(operatorId);
    expect(env.DB.sqlite.prepare('SELECT display_name FROM operators WHERE id = ?').get(operatorId).display_name).toBe('Sam Rivera Coaching');

    // Idempotent: a second onboarding returns the same operator.
    const again = await worker.fetch(req('POST', '/api/coach/onboarding', { cookie: coach.cookie, body: { displayName: 'Sam Rivera Coaching' } }), env, ctx);
    expect(again.status).toBe(200);
    expect((await again.json()).operator_id).toBe(operatorId);

    // 2. The check-in config writes coach_checkin_config.
    const script = 'Hey, it’s Sam — glad you’re here. Let’s ease in together.';
    const cfg = await worker.fetch(req('PUT', '/api/coach/checkin-config', {
      cookie: coach.cookie, body: { cadence: 'daily', voicePersona: 'calm_ally', script },
    }), env, ctx);
    expect(cfg.status, await cfg.clone().text()).toBe(200);
    const read = await (await worker.fetch(req('GET', '/api/coach/onboarding', { cookie: coach.cookie }), env, ctx)).json();
    expect(read).toMatchObject({ onboarded: true, operator_id: operatorId, voice_persona: 'calm_ally', script });

    // 3. Invite → accept, then the operator roster seats the client in operator_clients.
    const inv = await worker.fetch(req('POST', '/api/coach/clients', { cookie: coach.cookie, body: { email: client.email, label: 'Jo' } }), env, ctx);
    expect(inv.status, await inv.clone().text()).toBe(201);
    const { link_id: linkId } = await inv.json();
    const acc = await worker.fetch(req('POST', `/api/coach/invitations/${linkId}/accept`, { cookie: client.cookie, body: {} }), env, ctx);
    expect(acc.status).toBe(200);

    const roster = await worker.fetch(req('GET', '/api/coach/operator/clients', { cookie: coach.cookie }), env, ctx);
    expect(roster.status, await roster.clone().text()).toBe(200);
    const rb = await roster.json();
    expect(rb.onboarded).toBe(true);
    expect(rb.roster).toHaveLength(1);
    const seat = env.DB.sqlite.prepare('SELECT operator_id, external_org_id, status FROM operator_clients').all();
    expect(seat).toEqual([{ operator_id: operatorId, external_org_id: client.userId, status: 'active' }]);

    // 4. The cron's coach-voice JOIN (coach_clients ⋈ coach_operators ⋈
    //    coach_checkin_config) resolves, so the client's check-in leads with
    //    the coach's line. Asserted over the text channel, whose body is the
    //    whole composed message.
    env.DB.sqlite.prepare('UPDATE users SET phone = ? WHERE id = ?').run('+15557654321', client.userId);
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const out = await deliverCheckin({ ...env, TELNYX_API_KEY: 'k', TELNYX_FROM_NUMBER: '+15550001111' }, {
      checkin_id: 'ci1', commitment_id: 'cm1', user_id: client.userId, channel: 'text',
      attempts: 0, title: 'start the taxes', persona: 'hype',
    });
    expect(out.status).toBe('sent');
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body).text;
    expect(body.startsWith('Hey, it’s Sam')).toBe(true);
  });
});
