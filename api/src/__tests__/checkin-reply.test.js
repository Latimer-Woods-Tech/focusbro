/**
 * One-tap reply: the ticket, and the endpoint that honors it.
 *
 * The ticket is the only credential a service worker can hold: bound to one
 * check-in occurrence, HMAC-signed with the worker secret, self-expiring. The
 * endpoint resolves through the SAME path as the in-app "I did it" button —
 * so the kept-word ledger, the kept copy, the events and a recurring word's
 * rhythm all behave identically whichever surface answered. Proven here on a
 * real migrated SQLite, end to end through the router.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import worker from '../index.js';
import { signReplyTicket, verifyReplyTicket, REPLY_TTL_MS } from '../checkin-reply.js';
import { DatabaseSync, makeMigratedD1, makeKV } from './helpers/real-d1.js';

const SECRET = 'test-secret-that-is-long-enough-for-hs256-0123456789';

describe('reply ticket', () => {
  const NOW = 1_800_000_000_000;

  it('round-trips, bound to the check-in it was signed for', async () => {
    const t = await signReplyTicket(SECRET, 'ci-abc', { nowMs: NOW });
    expect(t.startsWith('ci-abc.')).toBe(true);
    expect(await verifyReplyTicket(SECRET, t, { nowMs: NOW + 1000 })).toEqual({ checkinId: 'ci-abc', exp: NOW + REPLY_TTL_MS });
  });

  it('rejects tampering, another secret, expiry, and junk (proof of rejection)', async () => {
    const t = await signReplyTicket(SECRET, 'ci-abc', { nowMs: NOW });
    const [id, exp, sig] = t.split('.');
    expect(await verifyReplyTicket(SECRET, `ci-other.${exp}.${sig}`, { nowMs: NOW })).toBeNull(); // re-pointed at another check-in
    expect(await verifyReplyTicket(SECRET, `${id}.${Number(exp) + 1}.${sig}`, { nowMs: NOW })).toBeNull(); // extended
    expect(await verifyReplyTicket(SECRET, `${id}.${exp}.${sig.slice(0, -1)}x`, { nowMs: NOW })).toBeNull(); // bit-flipped
    expect(await verifyReplyTicket('another-secret', t, { nowMs: NOW })).toBeNull();
    expect(await verifyReplyTicket(SECRET, t, { nowMs: NOW + REPLY_TTL_MS })).toBeNull(); // expired, exactly at exp
    for (const junk of [null, undefined, 42, '', 'a.b', 'a.b.c.d', `${id}.notanumber.${sig}`]) {
      expect(await verifyReplyTicket(SECRET, junk, { nowMs: NOW }), String(junk)).toBeNull();
    }
    expect(await signReplyTicket('', 'ci-abc')).toBeNull();
    expect(await signReplyTicket(SECRET, '')).toBeNull();
  });
});

const suite = DatabaseSync ? describe : describe.skip;
const ORIGIN = 'https://focusbro.net';
const ctx = { waitUntil() {}, passThroughOnException() {} };
const RUNTIME_CREATES = [...readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  .matchAll(/`(CREATE TABLE IF NOT EXISTS[\s\S]*?)`/g)].map((m) => m[1]);

function makeEnv() {
  const DB = makeMigratedD1();
  for (const sql of RUNTIME_CREATES) DB.sqlite.exec(sql);
  return { DB, KV_CACHE: makeKV(), JWT_SECRET: SECRET, BUILD_SHA: 'abc1234' };
}
function req(method, path, { cookie, body } = {}) {
  const h = {};
  if (cookie) h.Cookie = cookie;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; h.Origin = ORIGIN; }
  return new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function wordWithCheckin(env) {
  const g = await worker.fetch(req('POST', '/auth/guest', { body: {} }), env, ctx);
  expect(g.status).toBe(201);
  const cookie = g.headers.get('Set-Cookie').split(';')[0];
  const c = await worker.fetch(req('POST', '/api/commitments', {
    cookie, body: { title: 'start the taxes', start_at: '2099-01-01T15:00:00.000Z', persona: 'ally', channel: 'push' },
  }), env, ctx);
  expect(c.status).toBe(201);
  const { id: commitmentId } = (await c.json()).commitment || await c.clone().json();
  const row = env.DB.sqlite.prepare('SELECT id FROM commitment_checkins WHERE commitment_id = ? ORDER BY scheduled_for ASC LIMIT 1').get(commitmentId);
  expect(row && row.id, 'a new word queues its first check-in').toBeTruthy();
  // A ticket is only ever minted at delivery, so the faithful sequence is: the
  // cron marks the occurrence `sent` as it hands the push to the device, and
  // only THEN is there an open check-in to answer (an undelivered one answers
  // "got this one already" and writes nothing — the right behaviour, and the
  // first thing this suite found).
  env.DB.sqlite.prepare("UPDATE commitment_checkins SET status = 'sent', delivered_at = datetime('now') WHERE id = ?").run(row.id);
  return { cookie, commitmentId, checkinId: row.id };
}
const reply = (env, body) => worker.fetch(req('POST', '/api/checkins/reply', { body }), env, ctx);

suite('POST /api/checkins/reply', () => {
  it('"I did it" from the notification keeps the word — same ledger, same copy as the in-app button', async () => {
    const env = makeEnv();
    const { cookie, commitmentId, checkinId } = await wordWithCheckin(env);
    const ticket = await signReplyTicket(env.JWT_SECRET, checkinId);

    const r = await reply(env, { ticket, outcome: 'kept' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.streak.total_kept).toBe(1);
    expect(typeof b.message).toBe('string');
    expect(b.message.length).toBeGreaterThan(0);

    const word = env.DB.sqlite.prepare('SELECT status FROM commitments WHERE id = ?').get(commitmentId);
    expect(word.status).toBe('kept');
    const s = await worker.fetch(req('GET', '/api/accountability/streak', { cookie }), env, ctx);
    expect((await s.json()).streak.total_kept).toBe(1);
  });

  it('a second tap on the same notification answers warmly and writes nothing (never twice)', async () => {
    const env = makeEnv();
    const { checkinId } = await wordWithCheckin(env);
    const ticket = await signReplyTicket(env.JWT_SECRET, checkinId);
    expect((await reply(env, { ticket, outcome: 'kept' })).status).toBe(200);
    const again = await reply(env, { ticket, outcome: 'kept' });
    expect(again.status).toBe(200);
    expect((await again.json()).status).toBe('kept'); // the already-settled guard
    expect(env.DB.sqlite.prepare('SELECT total_kept FROM accountability_streaks').get().total_kept).toBe(1);
  });

  it('refuses a tampered, foreign-secret, or expired ticket — and never touches the word', async () => {
    const env = makeEnv();
    const { commitmentId, checkinId } = await wordWithCheckin(env);
    const good = await signReplyTicket(env.JWT_SECRET, checkinId);
    const [id, exp, sig] = good.split('.');
    for (const bad of [
      `${id}.${exp}.${sig.slice(0, -2)}zz`,
      await signReplyTicket('someone-elses-secret', checkinId),
      await signReplyTicket(env.JWT_SECRET, checkinId, { nowMs: Date.now() - REPLY_TTL_MS - 1 }),
      'nonsense', '', undefined,
    ]) {
      const r = await reply(env, { ticket: bad, outcome: 'kept' });
      expect(r.status, String(bad)).toBe(401);
    }
    expect(env.DB.sqlite.prepare('SELECT status FROM commitments WHERE id = ?').get(commitmentId).status).toBe('active');
  });

  it('only kept / missed can be answered in one tap; a reschedule needs the "when?" surface', async () => {
    const env = makeEnv();
    const { checkinId } = await wordWithCheckin(env);
    const ticket = await signReplyTicket(env.JWT_SECRET, checkinId);
    for (const outcome of ['reschedule', 'snooze', '', undefined]) {
      expect((await reply(env, { ticket, outcome })).status, String(outcome)).toBe(400);
    }
  });

  it('a valid ticket for a check-in that no longer exists is a 404, not a crash', async () => {
    const env = makeEnv();
    const ticket = await signReplyTicket(env.JWT_SECRET, 'ci-never-existed');
    expect((await reply(env, { ticket, outcome: 'kept' })).status).toBe(404);
  });

  it('the in-app route still works unchanged after the refactor (shared resolve path)', async () => {
    const env = makeEnv();
    const { cookie, commitmentId } = await wordWithCheckin(env);
    const r = await worker.fetch(req('POST', `/api/commitments/${commitmentId}/checkin`, { cookie, body: { outcome: 'kept' } }), env, ctx);
    expect(r.status).toBe(200);
    expect((await r.json()).streak.total_kept).toBe(1);
  });
});
