/**
 * FBQ-11 (focusbro#391) — a reply to the escalation text resolves the ESCALATED
 * PUSH check-in. The escalation says "Reply DONE / LATER / HELP ME START" but
 * only ever exists on `channel = 'push'` rows, while the inbound handler matched
 * `channel = 'text'` only: every reply hit `no_open_checkin` and was dropped in
 * silence. Driven through the real inbound handler on a real migrated SQLite.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { Router } from 'itty-router';
import { registerConsentRoutes } from '../consent.js';
import { generateUUID } from '../middleware.js';
import { DatabaseSync, makeMigratedD1 } from './helpers/real-d1.js';

const suite = DatabaseSync ? describe : describe.skip;
const RUNTIME_CREATES = [...readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  .matchAll(/`(CREATE TABLE IF NOT EXISTS[\s\S]*?)`/g)].map((m) => m[1]);
const NOW = '2026-10-05T15:00:00.000Z';
const SENT_AT = '2026-10-05T14:00:00.000Z';
const ESC_AT = '2026-10-05T14:15:00.000Z';
const PHONE = '+15551234567';
const OTHER_PHONE = '+15557654321';

function makeEnv() {
  const DB = makeMigratedD1();
  for (const sql of RUNTIME_CREATES) DB.sqlite.exec(sql);
  DB.sqlite.exec(`INSERT INTO users (id, email, phone, password_hash) VALUES ('u1', 'a@x.test', '${PHONE}', 'x'),
                                                         ('u2', 'b@x.test', '${OTHER_PHONE}', 'x')`);
  return { DB, TELNYX_API_KEY: 'k', TELNYX_FROM_NUMBER: '+15550001111', TELNYX_PUBLIC_KEY: 'test' };
}
function word(env, { id = 'cm1', userId = 'u1', recurrence = 'none' } = {}) {
  env.DB.sqlite.prepare(
    `INSERT INTO commitments (id, user_id, title, recurrence, timezone, local_time, channel, persona, status, start_at)
     VALUES (?, ?, 'stretch', ?, 'America/New_York', '10:00', 'push', 'ally', 'active', '2026-10-05T14:00:00.000Z')`,
  ).run(id, userId, recurrence);
}
function checkin(env, o = {}) {
  const r = { id: 'ck1', commitment_id: 'cm1', user_id: 'u1', channel: 'push', status: 'sent',
    escalated_at: ESC_AT, responded_at: null, scheduled_for: SENT_AT, delivered_at: SENT_AT, ...o };
  env.DB.sqlite.prepare(
    `INSERT INTO commitment_checkins (id, commitment_id, user_id, scheduled_for, channel, status, delivered_at, escalated_at, responded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(r.id, r.commitment_id, r.user_id, r.scheduled_for, r.channel, r.status, r.delivered_at, r.escalated_at, r.responded_at);
}
const row = (env, id = 'ck1') => env.DB.sqlite.prepare('SELECT * FROM commitment_checkins WHERE id = ?').get(id);
const kept = (env, u = 'u1') => (env.DB.sqlite.prepare('SELECT total_kept FROM accountability_streaks WHERE user_id = ?').get(u) || { total_kept: 0 }).total_kept;

let n = 0;
async function reply(env, text, from = PHONE) {
  const router = Router();
  registerConsentRoutes(router, {
    getAuthToken: () => null, verifyToken: async () => null, generateUUID,
    jsonResponse: (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }),
    verifyInboundSignature: async () => true,
  });
  const res = await router.handle(new Request('https://focusbro.net/api/webhooks/telnyx/inbound', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'telnyx-timestamp': '1', 'telnyx-signature-ed25519': 's' },
    body: JSON.stringify({ data: { id: `evt-${++n}`, event_type: 'message.received', payload: { from: { phone_number: from }, text } } }),
  }), env);
  return res.json();
}

suite('FBQ-11: replying to the escalation text', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('DONE on an escalated push row keeps it and credits exactly once', async () => {
    const env = makeEnv(); word(env); checkin(env);
    expect((await reply(env, 'done')).action).toBe('checkin_kept');
    expect(row(env).status).toBe('kept');
    expect(row(env).responded_at).toBeTruthy();
    expect(kept(env)).toBe(1);
    // a second DONE finds nothing open: no second credit
    expect((await reply(env, 'done')).action).toBe('no_open_checkin');
    expect(kept(env)).toBe(1);
  });

  it('a time reply ("tomorrow 9am") reschedules the push row to exactly one open occurrence', async () => {
    const env = makeEnv(); word(env); checkin(env);
    const out = await reply(env, 'tomorrow 9am');
    expect(out.action).toBe('rescheduled');
    const r = row(env);
    expect(r.status).toBe('pending');
    expect(r.scheduled_for).toBe(out.scheduled_for);
    expect(kept(env)).toBe(0);
    const open = env.DB.sqlite.prepare(
      `SELECT COUNT(*) AS n FROM commitment_checkins WHERE status IN ('pending','sending','sent','awaiting_time')`,
    ).get().n;
    expect(open).toBe(1);
  });

  it('bare LATER asks when, then the time answers it', async () => {
    const env = makeEnv(); word(env); checkin(env);
    expect((await reply(env, 'later')).action).toBe('reschedule_ask_when');
    expect(row(env).status).toBe('awaiting_time');
    expect((await reply(env, 'tomorrow 9am')).action).toBe('rescheduled');
    expect(row(env).status).toBe('pending');
  });

  it('HELP ME START runs the start-help flow on the push row', async () => {
    const env = makeEnv(); word(env); checkin(env);
    const out = await reply(env, 'help me start');
    expect(out.action).toBe('start_help');
    expect(row(env).status).toBe('pending');
    expect(row(env).scheduled_for).toBe(out.scheduled_for);
    expect(kept(env)).toBe(0);
  });

  it('a reply after the person already answered in-app credits nothing', async () => {
    const env = makeEnv(); word(env);
    checkin(env, { status: 'kept', responded_at: '2026-10-05T14:20:00.000Z' });
    expect((await reply(env, 'done')).action).toBe('no_open_checkin');
    expect(kept(env)).toBe(0);
  });

  it('a number belonging to another user resolves nothing', async () => {
    const env = makeEnv(); word(env); checkin(env);
    expect((await reply(env, 'done', OTHER_PHONE)).action).toBe('no_open_checkin');
    expect(row(env).status).toBe('sent');
    expect(kept(env, 'u1')).toBe(0);
    expect(kept(env, 'u2')).toBe(0);
  });

  it('a push row that was never escalated is not matched (it was never texted)', async () => {
    const env = makeEnv(); word(env); checkin(env, { escalated_at: null });
    expect((await reply(env, 'done')).action).toBe('no_open_checkin');
    expect(row(env).status).toBe('sent');
    expect(kept(env)).toBe(0);
  });

  it('with several open rows, resolves exactly the most recently escalated one', async () => {
    const env = makeEnv(); word(env); word(env, { id: 'cm2' });
    checkin(env, { id: 'old', escalated_at: '2026-10-04T14:15:00.000Z', scheduled_for: '2026-10-04T14:00:00.000Z' });
    checkin(env, { id: 'new', commitment_id: 'cm2' });
    expect((await reply(env, 'done')).action).toBe('checkin_kept');
    expect(row(env, 'new').status).toBe('kept');
    expect(row(env, 'old').status).toBe('sent');
    expect(kept(env)).toBe(1);
  });

  it('a text row still resolves as before', async () => {
    const env = makeEnv(); word(env);
    checkin(env, { channel: 'text', escalated_at: null });
    expect((await reply(env, 'done')).action).toBe('checkin_kept');
    expect(row(env).status).toBe('kept');
    expect(kept(env)).toBe(1);
  });
});
