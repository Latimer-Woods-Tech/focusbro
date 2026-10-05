/**
 * FBQ-11b / FBQ-11c (focusbro#391) — an inbound text answers an escalated PUSH
 * check-in only if the escalation text was ACTUALLY SENT, and only while it is
 * fresh. runEscalations latches `escalated_at` on every outcome (skip, failure,
 * ceiling, not_pro, unverified phone) so it never re-scans a row, which means
 * that latch alone says nothing about whether a text reached the person.
 * Driven through the real cron and the real inbound handler on a real migrated
 * SQLite; only the Telnyx fetch is stubbed.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { Router } from 'itty-router';
import { registerConsentRoutes } from '../consent.js';
import { runEscalations } from '../checkins-cron.js';
import { generateUUID } from '../middleware.js';
import { DatabaseSync, makeMigratedD1 } from './helpers/real-d1.js';

const suite = DatabaseSync ? describe : describe.skip;
const RUNTIME_CREATES = [...readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  .matchAll(/`(CREATE TABLE IF NOT EXISTS[\s\S]*?)`/g)].map((m) => m[1]);
const HOUR = 3600 * 1000;
const T0 = Date.parse('2026-10-05T14:00:00.000Z'); // push delivered
const ESC_NOW = new Date(T0 + 30 * 60 * 1000).toISOString(); // cron tick, 10:30 New York
const PHONE = '+15551234567';

function makeEnv({ pro = true, verified = true, ceiling = null, quiet = null } = {}) {
  const DB = makeMigratedD1();
  for (const sql of RUNTIME_CREATES) DB.sqlite.exec(sql);
  DB.sqlite.exec(`INSERT INTO users (id, email, phone, phone_verified_at, password_hash)
                  VALUES ('u1', 'a@x.test', '${PHONE}', ${verified ? "datetime('now')" : 'NULL'}, 'x');
                  INSERT INTO contact_consent (id, user_id, channel, status, phone, timezone, quiet_start, quiet_end)
                  VALUES ('cc1', 'u1', 'text', 'granted', '${PHONE}', 'America/New_York',
                          ${quiet ? quiet[0] : 'NULL'}, ${quiet ? quiet[1] : 'NULL'})`);
  if (pro) DB.sqlite.exec(`INSERT INTO pro_purchases (id, user_id, stripe_session_id, status) VALUES ('p1', 'u1', 's1', 'paid')`);
  if (ceiling) DB.sqlite.exec(`INSERT INTO escalation_prefs (user_id, ceiling) VALUES ('u1', '${ceiling}')`);
  DB.sqlite.exec(`INSERT INTO commitments (id, user_id, title, recurrence, timezone, local_time, channel, persona, status, start_at)
                  VALUES ('cm1', 'u1', 'stretch', 'none', 'America/New_York', '10:00', 'push', 'ally', 'active', '2026-10-05T14:00:00.000Z');
                  INSERT INTO commitment_checkins (id, commitment_id, user_id, scheduled_for, channel, status, delivered_at)
                  VALUES ('ck1', 'cm1', 'u1', '2026-10-05T14:00:00.000Z', 'push', 'sent', '2026-10-05T14:00:00.000Z')`);
  return { DB, TELNYX_API_KEY: 'k', TELNYX_FROM_NUMBER: '+15550001111', TELNYX_PUBLIC_KEY: 'test' };
}
const row = (env) => env.DB.sqlite.prepare('SELECT * FROM commitment_checkins WHERE id = ?').get('ck1');
const kept = (env) => (env.DB.sqlite.prepare('SELECT total_kept FROM accountability_streaks WHERE user_id = ?').get('u1') || { total_kept: 0 }).total_kept;

let n = 0;
async function reply(env, text) {
  const router = Router();
  registerConsentRoutes(router, {
    getAuthToken: () => null, verifyToken: async () => null, generateUUID,
    jsonResponse: (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }),
    verifyInboundSignature: async () => true,
  });
  const res = await router.handle(new Request('https://focusbro.net/api/webhooks/telnyx/inbound', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'telnyx-timestamp': '1', 'telnyx-signature-ed25519': 's' },
    body: JSON.stringify({ data: { id: `evt-${++n}`, event_type: 'message.received', payload: { from: { phone_number: PHONE }, text } } }),
  }), env);
  return res.json();
}
const at = (ms) => vi.setSystemTime(new Date(ms));

suite('FBQ-11b: only an escalation that was sent can be answered', () => {
  let telnyx;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(T0 + 40 * 60 * 1000);
    telnyx = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', telnyx);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  async function notAnswerable(env) {
    // (assert the outcome, not one action name)
    expect((await reply(env, 'done')).action).not.toBe('checkin_kept');
    expect(row(env).status).toBe('sent');
    expect(kept(env)).toBe(0);
  }

  it.each([
    ['not_pro', { pro: false }],
    ['ceiling_none', { ceiling: 'none' }],
    ['phone_unverified', { verified: false }],
  ])('skipped for %s: latched, never texted, a stray "yes" credits nothing', async (_n, opts) => {
    const env = makeEnv(opts);
    const s = await runEscalations(env, { now: ESC_NOW });
    expect(s.skipped).toBe(1);
    expect(row(env).escalated_at).toBeTruthy(); // the don't-re-escalate latch is unchanged
    expect(telnyx).not.toHaveBeenCalled();
    // The number is verified AFTER the skip (FBQ-12 only guards the sender lookup): still never texted.
    env.DB.sqlite.exec(`UPDATE users SET phone_verified_at = datetime('now') WHERE id = 'u1'`);
    await notAnswerable(env);
  });

  it('delivery failure: latched, but not answerable', async () => {
    const env = makeEnv();
    telnyx.mockImplementation(async () => ({ ok: false, status: 500 }));
    const s = await runEscalations(env, { now: ESC_NOW });
    expect(s.failed).toBe(1);
    expect(row(env).escalated_at).toBeTruthy();
    await notAnswerable(env);
  });

  it('quiet hours: deferred (not latched) and not answerable; once sent later it is', async () => {
    const env = makeEnv({ quiet: [10, 12] }); // 10:30 New York is quiet
    const s = await runEscalations(env, { now: ESC_NOW });
    expect(s.deferred).toBe(1);
    expect(row(env).escalated_at).toBeNull();
    await notAnswerable(env);
    const later = new Date(T0 + 2 * HOUR).toISOString(); // 12:00 local, window over
    at(T0 + 2 * HOUR + 60 * 1000);
    expect((await runEscalations(env, { now: later })).escalated).toBe(1);
    expect((await reply(env, 'done')).action).toBe('checkin_kept');
    expect(kept(env)).toBe(1);
  });

  it('a SENT escalation is answerable inside the window and records when it went out', async () => {
    const env = makeEnv();
    expect((await runEscalations(env, { now: ESC_NOW })).escalated).toBe(1);
    expect(row(env).escalation_sent_at).toBe(ESC_NOW);
    expect((await reply(env, 'done')).action).toBe('checkin_kept');
    expect(kept(env)).toBe(1);
  });

  it('a pre-migration row (escalated_at set, no sent marker) is not matchable', async () => {
    const env = makeEnv();
    env.DB.sqlite.prepare(`UPDATE commitment_checkins SET escalated_at = ? WHERE id = 'ck1'`).run(ESC_NOW);
    await notAnswerable(env);
  });
});

suite('FBQ-11c: an escalated row stops being answerable after 24h', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(T0 + 40 * 60 * 1000);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('answerable just inside 24h of the escalation text, not just past it', async () => {
    const inside = makeEnv();
    await runEscalations(inside, { now: ESC_NOW });
    at(Date.parse(ESC_NOW) + 24 * HOUR - 1000);
    expect((await reply(inside, 'done')).action).toBe('checkin_kept');

    const past = makeEnv();
    await runEscalations(past, { now: ESC_NOW });
    at(Date.parse(ESC_NOW) + 24 * HOUR + 1000);
    expect((await reply(past, 'done')).action).toBe('no_open_checkin');
    expect(row(past).status).toBe('sent');
    expect(kept(past)).toBe(0);
  });

  it('a TEXT check-in is deliberately NOT age-bounded (the person received that exact text)', async () => {
    const env = makeEnv();
    env.DB.sqlite.exec(`UPDATE commitment_checkins SET channel = 'text' WHERE id = 'ck1'`);
    at(T0 + 3 * 24 * HOUR);
    expect((await reply(env, 'done')).action).toBe('checkin_kept');
  });
});
