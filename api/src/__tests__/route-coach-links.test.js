/**
 * FBQ-24 R2 — the coach <-> client consent routes (coach.js): invite, list
 * invitations, accept / decline, remove, and the own-words sharing switch. QA
 * found these handlers with zero hits. The product promise they carry is that a
 * coach sees NOTHING about a person until that person accepts, and that only the
 * invited person can answer. So every test reads coach_clients /
 * coach_note_consent back and, where it matters, asks the coach's detail route
 * what a coach can actually see afterwards.
 */
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from './helpers/real-d1.js';
import { call, count, makeEnv, register, row } from './helpers/route-kit.js';

const suite = DatabaseSync ? describe : describe.skip;
const invite = (env, coach, body) => call(env, '/api/coach/clients', { method: 'POST', cookie: coach?.cookie, body });
const link = (env, coachId, clientId) => row(env, 'SELECT * FROM coach_clients WHERE coach_user_id = ? AND client_user_id = ?', coachId, clientId);
const answer = (env, who, id, verb) => call(env, `/api/coach/invitations/${id}/${verb}`, { method: 'POST', cookie: who?.cookie });
const detail = (env, coach, clientId) => call(env, `/api/coach/clients/${clientId}`, { cookie: coach.cookie });

async function trio() {
  const env = makeEnv();
  const coach = await register(env, 'coach@example.com');
  const client = await register(env, 'client@example.com');
  const other = await register(env, 'other@example.com');
  return { env, coach, client, other };
}
async function invited() {
  const t = await trio();
  const res = await invite(t.env, t.coach, { email: t.client.email, label: 'Sam' });
  expect(res.status).toBe(202);
  // the response deliberately carries no link id (enumeration guard) — read it back
  return { ...t, linkId: link(t.env, t.coach.id, t.client.id).id };
}

suite('POST /api/coach/clients — invite (real D1)', () => {
  it('is 401 unauthenticated and creates nothing', async () => {
    const { env, client } = await trio();
    expect((await invite(env, null, { email: client.email })).status).toBe(401);
    expect(count(env, 'SELECT COUNT(*) AS n FROM coach_clients')).toBe(0);
  });

  it('creates a PENDING link and the coach sees nothing about the person until they accept', async () => {
    const { env, coach, client, linkId } = await invited();
    expect(link(env, coach.id, client.id)).toMatchObject({ id: linkId, status: 'pending', client_label: 'Sam' });
    expect((await detail(env, coach, client.id)).status).toBe(404);
    const roster = await (await call(env, '/api/coach/clients', { cookie: coach.cookie })).json();
    expect(JSON.stringify(roster)).not.toMatch(/current_streak|commitments/);
  });

  it.each([
    ['no email', {}],
    ['a malformed email', { email: 'not-an-email' }],
    ['an email that is not a string', { email: 42 }],
  ])('rejects %s with 400 and creates nothing', async (_n, body) => {
    const { env, coach } = await trio();
    expect((await invite(env, coach, body)).status).toBe(400);
    expect(count(env, 'SELECT COUNT(*) AS n FROM coach_clients')).toBe(0);
  });

  it('rejects a body that is not JSON with 400', async () => {
    const { env, coach } = await trio();
    const res = await call(env, '/api/coach/clients', { method: 'POST', cookie: coach.cookie, body: 'nope', headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(400);
  });

  it('refuses to invite yourself', async () => {
    const { env, coach } = await trio();
    expect((await invite(env, coach, { email: coach.email })).status).toBe(400);
    expect(count(env, 'SELECT COUNT(*) AS n FROM coach_clients')).toBe(0);
  });

  it('writes no link for an email with no account, and answers IDENTICALLY (status and body) to one with an account', async () => {
    const { env, coach, client } = await trio();
    const known = await invite(env, coach, { email: client.email });
    const unknown = await invite(env, coach, { email: 'nobody@example.com' });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    const kb = await known.json();
    const ub = await unknown.json();
    expect(Object.keys(kb).sort()).toEqual(Object.keys(ub).sort());
    expect(ub.message.replace('nobody@example.com', 'X')).toBe(kb.message.replace(client.email, 'X'));
    expect(ub.status).toBe(kb.status);
    // the pending link is still created for the real account, and only for it
    expect(link(env, coach.id, client.id)).toMatchObject({ status: 'pending' });
    expect(count(env, 'SELECT COUNT(*) AS n FROM coach_clients')).toBe(1);
  });

  it('does not link a deactivated account', async () => {
    const { env, coach, client } = await trio();
    env.DB.sqlite.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(client.id);
    await invite(env, coach, { email: client.email });
    expect(count(env, 'SELECT COUNT(*) AS n FROM coach_clients')).toBe(0);
  });

  it('is idempotent: a repeat invite reuses the one link', async () => {
    const { env, coach, client, linkId } = await invited();
    const again = await invite(env, coach, { email: client.email.toUpperCase() });
    expect(again.status).toBe(202);
    expect((await again.json()).link_id).toBeUndefined();
    expect(link(env, coach.id, client.id).id).toBe(linkId);
    expect(count(env, 'SELECT COUNT(*) AS n FROM coach_clients')).toBe(1);
  });

  it('re-opens a declined or removed link as pending again (same row) instead of piling up rows', async () => {
    const { env, coach, client, linkId } = await invited();
    await answer(env, client, linkId, 'decline');
    expect(link(env, coach.id, client.id).status).toBe('declined');
    const again = await invite(env, coach, { email: client.email });
    expect(again.status).toBe(202);
    expect(link(env, coach.id, client.id)).toMatchObject({ id: linkId, status: 'pending', responded_at: null });

    await answer(env, client, linkId, 'accept');
    await call(env, `/api/coach/clients/${client.id}`, { method: 'DELETE', cookie: coach.cookie });
    expect(link(env, coach.id, client.id).status).toBe('removed');
    await invite(env, coach, { email: client.email });
    expect(link(env, coach.id, client.id)).toMatchObject({ id: linkId, status: 'pending' });
    expect(count(env, 'SELECT COUNT(*) AS n FROM coach_clients')).toBe(1);
  });
});

suite('GET /api/coach/invitations + accept / decline (real D1)', () => {
  it('is 401 unauthenticated for list, accept and decline', async () => {
    const { env, linkId } = await invited();
    expect((await call(env, '/api/coach/invitations')).status).toBe(401);
    expect((await answer(env, null, linkId, 'accept')).status).toBe(401);
    expect((await answer(env, null, linkId, 'decline')).status).toBe(401);
  });

  it('shows the invited person the pending invitation (with the coach\'s email), and nobody else', async () => {
    const { env, coach, client, other, linkId } = await invited();
    const mine = await (await call(env, '/api/coach/invitations', { cookie: client.cookie })).json();
    expect(mine.invitations).toHaveLength(1);
    expect(mine.invitations[0]).toMatchObject({ link_id: linkId, coach_email: coach.email });
    expect((await (await call(env, '/api/coach/invitations', { cookie: other.cookie })).json()).invitations).toEqual([]);
    // the coach who sent it does not see it as an invitation to answer
    expect((await (await call(env, '/api/coach/invitations', { cookie: coach.cookie })).json()).invitations).toEqual([]);
  });

  it('accept activates the link, stamps responded_at, and only THEN can the coach see the client', async () => {
    const { env, coach, client, linkId } = await invited();
    const res = await answer(env, client, linkId, 'accept');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'active' });
    expect(link(env, coach.id, client.id)).toMatchObject({ status: 'active' });
    expect(link(env, coach.id, client.id).responded_at).toBeTruthy();
    expect((await detail(env, coach, client.id)).status).toBe(200);
    expect((await (await call(env, '/api/coach/invitations', { cookie: client.cookie })).json()).invitations).toEqual([]);
  });

  it('decline records the refusal and the coach still sees nothing', async () => {
    const { env, coach, client, linkId } = await invited();
    const res = await answer(env, client, linkId, 'decline');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'declined' });
    expect(link(env, coach.id, client.id).status).toBe('declined');
    expect((await detail(env, coach, client.id)).status).toBe(404);
  });

  it('AUTHZ: the coach cannot accept their own invitation — the client\'s consent is not theirs to give', async () => {
    const { env, coach, client, linkId } = await invited();
    const res = await answer(env, coach, linkId, 'accept');
    expect(res.status).toBe(404);
    expect(link(env, coach.id, client.id).status).toBe('pending');
    expect((await detail(env, coach, client.id)).status).toBe(404);
  });

  it('AUTHZ: a third person can neither accept nor decline someone else\'s invitation', async () => {
    const { env, coach, client, other, linkId } = await invited();
    expect((await answer(env, other, linkId, 'accept')).status).toBe(404);
    expect((await answer(env, other, linkId, 'decline')).status).toBe(404);
    expect(link(env, coach.id, client.id)).toMatchObject({ status: 'pending', responded_at: null });
  });

  it('answers 404 for an unknown invitation, and a settled invitation cannot be answered again', async () => {
    const { env, coach, client, linkId } = await invited();
    expect((await answer(env, client, 'no-such-link', 'accept')).status).toBe(404);
    await answer(env, client, linkId, 'accept');
    expect((await answer(env, client, linkId, 'decline')).status).toBe(404);
    expect((await answer(env, client, linkId, 'accept')).status).toBe(404);
    expect(link(env, coach.id, client.id).status).toBe('active');
  });
});

suite('DELETE /api/coach/clients/:clientId (real D1)', () => {
  async function active() {
    const t = await invited();
    await answer(t.env, t.client, t.linkId, 'accept');
    return t;
  }
  const remove = (env, who, clientId) => call(env, `/api/coach/clients/${clientId}`, { method: 'DELETE', cookie: who?.cookie });

  it('is 401 unauthenticated and the link survives', async () => {
    const { env, coach, client } = await active();
    expect((await remove(env, null, client.id)).status).toBe(401);
    expect(link(env, coach.id, client.id).status).toBe('active');
  });

  it('removes the link softly (row kept, status removed) and the coach loses sight of the client', async () => {
    const { env, coach, client } = await active();
    expect((await detail(env, coach, client.id)).status).toBe(200);
    const res = await remove(env, coach, client.id);
    expect(res.status).toBe(200);
    expect(link(env, coach.id, client.id).status).toBe('removed');
    expect((await detail(env, coach, client.id)).status).toBe(404);
    const roster = await (await call(env, '/api/coach/clients', { cookie: coach.cookie })).json();
    expect(JSON.stringify(roster)).not.toContain(client.email);
  });

  it('AUTHZ: another coach cannot remove my link, whichever ids they pass', async () => {
    const { env, coach, client, other } = await active();
    expect((await remove(env, other, client.id)).status).toBe(200); // a no-op for them
    expect(link(env, coach.id, client.id).status).toBe('active');
    // the client passing the coach's id does not remove it either (the row is keyed on the caller as COACH)
    await remove(env, client, coach.id);
    expect(link(env, coach.id, client.id).status).toBe('active');
  });
});

suite('GET/POST /api/coach/note-consent (real D1)', () => {
  const read = (env, who) => call(env, '/api/coach/note-consent', { cookie: who?.cookie });
  const write = (env, who, body) => call(env, '/api/coach/note-consent', { method: 'POST', cookie: who?.cookie, body });

  it('is 401 unauthenticated for read and write, and writes nothing', async () => {
    const { env } = await trio();
    expect((await read(env, null)).status).toBe(401);
    expect((await write(env, null, { shared: true })).status).toBe(401);
    expect(count(env, 'SELECT COUNT(*) AS n FROM coach_note_consent')).toBe(0);
  });

  it('defaults OFF, turns on and off for the caller only, and keeps one row per person', async () => {
    const { env, client, other } = await trio();
    expect(await (await read(env, client)).json()).toEqual({ shared: false });

    const on = await write(env, client, { shared: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ ok: true, shared: true });
    expect(row(env, 'SELECT shared FROM coach_note_consent WHERE user_id = ?', client.id).shared).toBe(1);
    expect(await (await read(env, client)).json()).toEqual({ shared: true });
    // nobody else's switch moved
    expect(await (await read(env, other)).json()).toEqual({ shared: false });
    expect(row(env, 'SELECT shared FROM coach_note_consent WHERE user_id = ?', other.id)).toBeUndefined();

    expect((await write(env, client, { shared: false })).status).toBe(200);
    expect(await (await read(env, client)).json()).toEqual({ shared: false });
    expect(count(env, 'SELECT COUNT(*) AS n FROM coach_note_consent WHERE user_id = ?', client.id)).toBe(1);
  });

  it.each([
    ['a string "true"', { shared: 'true' }],
    ['the number 1', { shared: 1 }],
    ['null', { shared: null }],
    ['a missing field', {}],
  ])('rejects %s with 400 and does not flip the switch', async (_n, body) => {
    const { env, client } = await trio();
    await write(env, client, { shared: true });
    expect((await write(env, client, body)).status).toBe(400);
    expect(row(env, 'SELECT shared FROM coach_note_consent WHERE user_id = ?', client.id).shared).toBe(1);
  });

  it('rejects a body that is not JSON with 400', async () => {
    const { env, client } = await trio();
    const res = await call(env, '/api/coach/note-consent', { method: 'POST', cookie: client.cookie, body: 'nope', headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(400);
    expect(count(env, 'SELECT COUNT(*) AS n FROM coach_note_consent')).toBe(0);
  });
});
