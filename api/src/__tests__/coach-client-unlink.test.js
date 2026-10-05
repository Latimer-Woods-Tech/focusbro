/**
 * FBQ-10 R4 — a client can withdraw from an ACTIVE coach link, on real D1.
 * Before this, only the coach could end a link, contradicting the privacy
 * policy's "withdraw consent at any time".
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../index.js';
import { deliverCheckin } from '../checkins-cron.js';
import { renderMePage } from '../me.js';
import { DatabaseSync, makeMigratedD1, makeKV } from './helpers/real-d1.js';

const suite = DatabaseSync ? describe : describe.skip;
const SECRET = 'test-secret-that-is-long-enough-for-hs256-0123456789';
const ORIGIN = 'https://focusbro.net';
const ctx = { waitUntil() {}, passThroughOnException() {} };

function makeEnv() {
  const DB = makeMigratedD1();
  DB.sqlite.exec('PRAGMA foreign_keys = ON');
  return { DB, KV_CACHE: makeKV(), JWT_SECRET: SECRET, BUILD_SHA: 'abc1234' };
}
function req(method, path, { cookie, body } = {}) {
  const h = {};
  if (cookie) h.Cookie = cookie;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; h.Origin = ORIGIN; }
  return new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
}
// DELETE has no body but the Worker's origin guard wants an Origin header.
const del = (path, cookie) => new Request(ORIGIN + path, { method: 'DELETE', headers: { Cookie: cookie, Origin: ORIGIN } });
async function guest(env) {
  const g = await worker.fetch(req('POST', '/auth/guest', { body: {} }), env, ctx);
  expect(g.status).toBe(201);
  const cookie = g.headers.get('Set-Cookie').split(';')[0];
  const me = env.DB.sqlite.prepare('SELECT id, email FROM users ORDER BY rowid DESC LIMIT 1').get();
  return { cookie, userId: me.id, email: me.email };
}
const call = (r, env) => worker.fetch(r, env, ctx);

/** A coach with a voice, one accepted client, and the operator roster seated. */
async function seed() {
  const env = makeEnv();
  const coach = await guest(env);
  const client = await guest(env);
  const other = await guest(env);
  await call(req('POST', '/api/coach/onboarding', { cookie: coach.cookie, body: { displayName: 'Sam Rivera Coaching' } }), env);
  const cfg = await call(req('PUT', '/api/coach/checkin-config', {
    cookie: coach.cookie, body: { cadence: 'daily', voicePersona: 'calm_ally', script: 'Hey, it’s Sam — glad you’re here.' },
  }), env);
  expect(cfg.status).toBe(200);
  const inv = await call(req('POST', '/api/coach/clients', { cookie: coach.cookie, body: { email: client.email, label: 'Jo' } }), env);
  expect(inv.status).toBe(202);
  const { id: linkId } = env.DB.sqlite.prepare('SELECT id FROM coach_clients WHERE coach_user_id = ? AND client_user_id = ?').get(coach.userId, client.userId);
  return { env, coach, client, other, linkId };
}
async function accept(env, client, linkId) {
  const r = await call(req('POST', `/api/coach/invitations/${linkId}/accept`, { cookie: client.cookie, body: {} }), env);
  expect(r.status).toBe(200);
}
async function firstWord(env, client) {
  env.DB.sqlite.prepare('UPDATE users SET phone = ? WHERE id = ?').run('+15557654321', client.userId);
  const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
  const out = await deliverCheckin({ ...env, TELNYX_API_KEY: 'k', TELNYX_FROM_NUMBER: '+15550001111' }, {
    checkin_id: 'ci1', commitment_id: 'cm1', user_id: client.userId, channel: 'text',
    attempts: 0, title: 'start the taxes', persona: 'hype',
  });
  expect(out.status).toBe('sent');
  return JSON.parse(fetchSpy.mock.calls[0][1].body).text;
}

afterEach(() => vi.unstubAllGlobals());

suite('FBQ-10 R4: the client ends their own coach link', () => {
  it('lists the active link for the client, then ending it drops the coach detail, the roster, the voice and note sharing', async () => {
    const { env, coach, client, linkId } = await seed();
    await accept(env, client, linkId);
    await call(req('POST', '/api/coach/note-consent', { cookie: client.cookie, body: { shared: true } }), env);

    // Before: the coach sees the client, the roster seats them, the coach's voice leads.
    expect((await call(req('GET', `/api/coach/clients/${client.userId}`, { cookie: coach.cookie }), env)).status).toBe(200);
    expect((await (await call(req('GET', '/api/coach/operator/clients', { cookie: coach.cookie }), env)).json()).roster).toHaveLength(1);
    expect((await firstWord(env, client)).startsWith('Hey, it’s Sam')).toBe(true);

    const list = await call(req('GET', '/api/coach/links', { cookie: client.cookie }), env);
    expect(list.status).toBe(200);
    const { links } = await list.json();
    expect(links).toHaveLength(1);
    expect(links[0].link_id).toBe(linkId);
    expect(links[0].coach_email).toBe(coach.email);

    const out = await call(del(`/api/coach/links/${linkId}`, client.cookie), env);
    expect(out.status).toBe(200);
    expect(await out.json()).toMatchObject({ ok: true, status: 'removed' });

    // After: nothing of the client reaches the coach, nothing of the coach shapes the client.
    expect((await call(req('GET', `/api/coach/clients/${client.userId}`, { cookie: coach.cookie }), env)).status).toBe(404);
    const rosterAfter = await (await call(req('GET', '/api/coach/operator/clients', { cookie: coach.cookie }), env)).json();
    expect(rosterAfter.roster).toHaveLength(0);
    const flat = await (await call(req('GET', '/api/coach/clients', { cookie: coach.cookie }), env)).json();
    expect(JSON.stringify(flat)).not.toContain(client.userId);
    expect((await firstWord(env, client)).startsWith('Hey, it’s Sam')).toBe(false);
    expect((await (await call(req('GET', '/api/coach/note-consent', { cookie: client.cookie }), env)).json()).shared).toBe(false);
    expect((await (await call(req('GET', '/api/coach/links', { cookie: client.cookie }), env)).json()).links).toEqual([]);
  });

  it('ending twice is safe (200 both times, no error)', async () => {
    const { env, client, linkId } = await seed();
    await accept(env, client, linkId);
    expect((await call(del(`/api/coach/links/${linkId}`, client.cookie), env)).status).toBe(200);
    expect((await call(del(`/api/coach/links/${linkId}`, client.cookie), env)).status).toBe(200);
  });

  it('another person’s link id is a 404 and leaves the link untouched', async () => {
    const { env, coach, client, other, linkId } = await seed();
    await accept(env, client, linkId);
    expect((await call(del(`/api/coach/links/${linkId}`, other.cookie), env)).status).toBe(404);
    // The coach is not the client of that link either.
    expect((await call(del(`/api/coach/links/${linkId}`, coach.cookie), env)).status).toBe(404);
    expect((await call(del('/api/coach/links/no-such-link', client.cookie), env)).status).toBe(404);
    expect(env.DB.sqlite.prepare('SELECT status FROM coach_clients WHERE id = ?').get(linkId).status).toBe('active');
  });

  it('a pending invitation is not an active link: it is not listed, and answering it still works', async () => {
    const { env, client, linkId } = await seed();
    const { links } = await (await call(req('GET', '/api/coach/links', { cookie: client.cookie }), env)).json();
    expect(links).toEqual([]);
    const { invitations } = await (await call(req('GET', '/api/coach/invitations', { cookie: client.cookie }), env)).json();
    expect(invitations.map((i) => i.link_id)).toEqual([linkId]);
    const dec = await call(req('POST', `/api/coach/invitations/${linkId}/decline`, { cookie: client.cookie, body: {} }), env);
    expect(dec.status).toBe(200);
  });

  it('requires sign-in', async () => {
    const { env, linkId } = await seed();
    expect((await call(new Request(`${ORIGIN}/api/coach/links`), env)).status).toBe(401);
    expect((await call(new Request(`${ORIGIN}/api/coach/links/${linkId}`, { method: 'DELETE', headers: { Origin: ORIGIN } }), env)).status).toBe(401);
  });
});

describe('FBQ-10 R4: /me/ page carries the coach card wiring', () => {
  const html = renderMePage();
  it('has the card, the confirm, and calls the existing + new endpoints', () => {
    expect(html).toContain('id="coachCard"');
    expect(html).toContain('/api/coach/links');
    expect(html).toContain('/api/coach/invitations');
    expect(html).toContain('Stop sharing with my coach');
    expect(html).toContain('/accept');
    expect(html).toContain('/decline');
  });
});
