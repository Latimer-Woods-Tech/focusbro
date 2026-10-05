/**
 * FBQ-24 R2 — the /sync/* routes and GET /api/commitments/:id, over a REAL
 * migrated SQLite D1 through the Worker's own fetch().
 *
 * Note: /sync/data (cloud snapshot upload + download) is documented latent — no
 * shipped client calls it — but the route is mounted and Pro-gated, so it must
 * not leak across accounts or accept junk. /sync/events is the live analytics
 * ingest the timer bridge posts to.
 */
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from './helpers/real-d1.js';
import { call, count, makeEnv, register, row, rows } from './helpers/route-kit.js';

const suite = DatabaseSync ? describe : describe.skip;
const pro = (env, user) => env.DB.sqlite.prepare("UPDATE users SET subscription_tier = 'pro' WHERE id = ?").run(user.id);
const FORGED = { cookie: '__Host-focusbro_session=forged.token.value' };
const upload = (env, user, body, headers = {}) => call(env, '/sync/data', { method: 'POST', cookie: user?.cookie, body, headers });
const download = (env, user) => call(env, '/sync/data', { cookie: user?.cookie });

suite('/sync/data (real D1)', () => {
  it('is 401 without a session and with a forged one — for read and write', async () => {
    const env = makeEnv();
    expect((await download(env, null)).status).toBe(401);
    expect((await download(env, FORGED)).status).toBe(401);
    expect((await upload(env, null, { data: { a: 1 } })).status).toBe(401);
    expect((await upload(env, FORGED, { data: { a: 1 } })).status).toBe(401);
  });

  it('is 403 for a free account on both read and write, and stores nothing', async () => {
    const env = makeEnv();
    const free = await register(env, 'free@example.com');
    const down = await download(env, free);
    expect(down.status).toBe(403);
    expect((await down.json()).error).toMatch(/Pro/);
    expect((await upload(env, free, { data: { notes: 'x' } })).status).toBe(403);
    expect(count(env, 'SELECT COUNT(*) AS n FROM user_data_snapshots')).toBe(0);
    expect(await env.KV_CACHE.get(`user:${free.id}:latest`)).toBeNull();
  });

  it('a Pro account with nothing synced reads data:null', async () => {
    const env = makeEnv();
    const me = await register(env, 'pro-empty@example.com');
    pro(env, me);
    expect(await (await download(env, me)).json()).toMatchObject({ success: true, data: null });
  });

  it('round-trips a snapshot: written to D1 and KV, read back from cache then from the database', async () => {
    const env = makeEnv();
    const me = await register(env, 'pro-roundtrip@example.com');
    pro(env, me);
    const payload = { sessions: [{ tool: 'box-breathing', seconds: 240 }], settings: { theme: 'dark' } };
    const up = await upload(env, me, { data: payload, device_id: 'phone-1', base_revision: null });
    expect(up.status).toBe(200);
    const meta = await up.json();
    expect(meta).toMatchObject({ success: true });
    expect(meta.revision_id).toBeTruthy();
    expect(row(env, 'SELECT user_id, revision_id, snapshot_data FROM user_data_snapshots')).toEqual({
      user_id: me.id, revision_id: meta.revision_id, snapshot_data: JSON.stringify(payload),
    });

    const cached = await (await download(env, me)).json();
    expect(cached).toMatchObject({ success: true, source: 'cache', data: payload, revision_id: meta.revision_id });
    await env.KV_CACHE.delete(`user:${me.id}:latest`);
    const fromDb = await (await download(env, me)).json();
    expect(fromDb).toMatchObject({ success: true, source: 'database', data: payload, revision_id: meta.revision_id });
  });

  it('refuses a stale base_revision with 409 and writes nothing new', async () => {
    const env = makeEnv();
    const me = await register(env, 'pro-stale@example.com');
    pro(env, me);
    const first = await (await upload(env, me, { data: { v: 1 }, base_revision: null })).json();
    const stale = await upload(env, me, { data: { v: 2 }, base_revision: null });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'stale_revision', current_revision: first.revision_id });
    expect(count(env, 'SELECT COUNT(*) AS n FROM user_data_snapshots WHERE user_id = ?', me.id)).toBe(1);

    const next = await upload(env, me, { data: { v: 2 }, base_revision: first.revision_id });
    expect(next.status).toBe(200);
    expect(count(env, 'SELECT COUNT(*) AS n FROM user_data_snapshots WHERE user_id = ?', me.id)).toBe(2);
  });

  it('replays an Idempotency-Key instead of writing a second snapshot', async () => {
    const env = makeEnv();
    const me = await register(env, 'pro-idem@example.com');
    pro(env, me);
    const a = await upload(env, me, { data: { v: 1 } }, { 'Idempotency-Key': 'key-1' });
    const b = await upload(env, me, { data: { v: 1 } }, { 'Idempotency-Key': 'key-1' });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(count(env, 'SELECT COUNT(*) AS n FROM user_data_snapshots')).toBe(1);
  });

  it.each([
    ['malformed JSON', 'not json'],
    ['an array', '[1,2,3]'],
    ['an empty object', '{}'],
    ['an unsafe __proto__ key', '{"data":{"__proto__":{"admin":true}}}'],
    ['a device_id that is not a string', '{"data":{"a":1},"device_id":7}'],
  ])('rejects %s with 400 and stores nothing', async (_n, raw) => {
    const env = makeEnv();
    const me = await register(env, 'pro-bad@example.com');
    pro(env, me);
    const res = await upload(env, me, raw, { 'Content-Type': 'application/json' });
    expect(res.status).toBe(400);
    expect(count(env, 'SELECT COUNT(*) AS n FROM user_data_snapshots')).toBe(0);
    expect(await env.KV_CACHE.get(`user:${me.id}:latest`)).toBeNull();
  });

  it('refuses an over-limit payload with 413 and stores nothing', async () => {
    const env = makeEnv();
    const me = await register(env, 'pro-big@example.com');
    pro(env, me);
    const res = await upload(env, me, JSON.stringify({ data: { blob: 'x'.repeat(1024 * 1024 + 10) } }), { 'Content-Type': 'application/json' });
    expect(res.status).toBe(413);
    expect(count(env, 'SELECT COUNT(*) AS n FROM user_data_snapshots')).toBe(0);
  });

  it('never serves one account\'s snapshot to another, from cache or database', async () => {
    const env = makeEnv();
    const a = await register(env, 'iso-a@example.com');
    const b = await register(env, 'iso-b@example.com');
    pro(env, a); pro(env, b);
    await upload(env, a, { data: { secret: 'a-only' }, base_revision: null });
    const seenByB = await (await download(env, b)).json();
    expect(seenByB.data).toBeNull();
    expect(JSON.stringify(seenByB)).not.toContain('a-only');
    await env.KV_CACHE.delete(`user:${a.id}:latest`);
    expect(JSON.stringify(await (await download(env, b)).json())).not.toContain('a-only');
  });
});

suite('/sync/events (real D1)', () => {
  const send = (env, user, events) => call(env, '/sync/events', { method: 'POST', cookie: user?.cookie, body: { events } });
  const stored = (env) => rows(env, 'SELECT user_id, event_type, client_event_id FROM analytics_events WHERE event_type != ?', 'registered');

  it('is 401 without a session and with a forged one, and records nothing', async () => {
    const env = makeEnv();
    expect((await send(env, null, [{ type: 'session_complete', id: 'e1' }])).status).toBe(401);
    expect((await send(env, FORGED, [{ type: 'session_complete', id: 'e1' }])).status).toBe(401);
    expect(count(env, "SELECT COUNT(*) AS n FROM analytics_events WHERE event_type = 'session_complete'")).toBe(0);
  });

  it('stores allowlisted events against the SESSION user (never a user_id in the payload), dedups by client id, and counts refusals', async () => {
    const env = makeEnv();
    const me = await register(env, 'events@example.com');
    const victim = await register(env, 'events-victim@example.com');
    const at = new Date().toISOString();
    const res = await send(env, me, [
      { id: 'e1', type: 'session_complete', at, tool: 'pomodoro', user_id: victim.id },
      { id: 'e1', type: 'session_complete', at, tool: 'pomodoro' }, // in-batch duplicate
      { id: 'e2', type: 'a_type_invented_tomorrow', at },
    ]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, synced: 1, rejected: 1 });
    expect(stored(env)).toEqual([{ user_id: me.id, event_type: 'session_complete', client_event_id: 'e1' }]);
    expect(count(env, "SELECT COUNT(*) AS n FROM analytics_events WHERE user_id = ? AND event_type = 'session_complete'", victim.id)).toBe(0);

    // replay of the same client id from a later request does not double-count
    await send(env, me, [{ id: 'e1', type: 'session_complete', at, tool: 'pomodoro' }]);
    expect(count(env, "SELECT COUNT(*) AS n FROM analytics_events WHERE event_type = 'session_complete'")).toBe(1);
  });

  it('refuses events dated far in the past or the future', async () => {
    const env = makeEnv();
    const me = await register(env, 'events-time@example.com');
    const res = await send(env, me, [
      { id: 'old', type: 'session_complete', at: '2020-01-01T00:00:00.000Z' },
      { id: 'future', type: 'session_complete', at: '2099-01-01T00:00:00.000Z' },
    ]);
    expect((await res.json())).toMatchObject({ synced: 0, rejected: 2 });
    expect(count(env, "SELECT COUNT(*) AS n FROM analytics_events WHERE event_type = 'session_complete'")).toBe(0);
  });

  it('treats an empty batch as a no-op success', async () => {
    const env = makeEnv();
    const me = await register(env, 'events-empty@example.com');
    expect(await (await send(env, me, [])).json()).toMatchObject({ success: true, synced: 0 });
  });

  it('rejects a body that is not JSON (an error status, nothing recorded)', async () => {
    const env = makeEnv();
    const me = await register(env, 'events-junk@example.com');
    const res = await call(env, '/sync/events', { method: 'POST', cookie: me.cookie, body: 'nope', headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(count(env, "SELECT COUNT(*) AS n FROM analytics_events WHERE event_type = 'session_complete'")).toBe(0);
  });
});

suite('/sync/devices + /sync/history (real D1)', () => {
  const reg = (env, user, body) => call(env, '/sync/devices', { method: 'POST', cookie: user?.cookie, body });
  const list = (env, user) => call(env, '/sync/devices', { cookie: user?.cookie });
  const history = (env, user, q = '') => call(env, `/sync/history${q}`, { cookie: user?.cookie });

  it('is 401 without a session and with a forged one on all three', async () => {
    const env = makeEnv();
    for (const who of [null, FORGED]) {
      expect((await reg(env, who, { id: 'd1' })).status).toBe(401);
      expect((await list(env, who)).status).toBe(401);
      expect((await history(env, who)).status).toBe(401);
    }
    expect(count(env, 'SELECT COUNT(*) AS n FROM devices')).toBe(0);
  });

  it('registers a device for the caller, lists only the caller\'s devices, and re-registering is one row', async () => {
    const env = makeEnv();
    const a = await register(env, 'dev-a@example.com');
    const b = await register(env, 'dev-b@example.com');
    const res = await reg(env, a, { id: 'laptop-1', name: 'Work laptop' });
    expect(res.status).toBe(200);
    expect((await res.json()).device).toMatchObject({ device_id: 'laptop-1', device_name: 'Work laptop' });
    await reg(env, a, { id: 'laptop-1', name: 'Work laptop' });
    await reg(env, b, { id: 'phone-b', name: 'B phone' });

    expect(rows(env, 'SELECT device_id, user_id FROM devices ORDER BY device_id')).toEqual([
      { device_id: 'laptop-1', user_id: a.id }, { device_id: 'phone-b', user_id: b.id },
    ]);
    expect((await (await list(env, a)).json()).devices.map((d) => d.device_id)).toEqual(['laptop-1']);
    expect((await (await list(env, b)).json()).devices.map((d) => d.device_id)).toEqual(['phone-b']);
  });

  it('AUTHZ: registering another account\'s device_id does not steal or expose that device', async () => {
    const env = makeEnv();
    const a = await register(env, 'steal-a@example.com');
    const b = await register(env, 'steal-b@example.com');
    await reg(env, a, { id: 'a-device', name: 'A laptop' });
    env.DB.sqlite.prepare("UPDATE devices SET last_activity = '2020-01-01 00:00:00' WHERE device_id = 'a-device'").run();
    await reg(env, b, { id: 'a-device', name: 'B renamed it' });
    // B's replay must not even touch A's last_activity (it would look like A was just active)
    expect(row(env, "SELECT last_activity FROM devices WHERE device_id = 'a-device'")).toEqual({ last_activity: '2020-01-01 00:00:00' });
    expect(row(env, "SELECT user_id, device_name FROM devices WHERE device_id = 'a-device'")).toEqual({ user_id: a.id, device_name: 'A laptop' });
    expect((await (await list(env, b)).json()).devices).toEqual([]);
  });

  it('history lists only the caller\'s snapshots (ids, sizes and revisions, never the data), newest first, honouring limit', async () => {
    const env = makeEnv();
    const a = await register(env, 'hist-a@example.com');
    const b = await register(env, 'hist-b@example.com');
    const ins = env.DB.sqlite.prepare("INSERT INTO user_data_snapshots (user_id, snapshot_data, size_bytes, revision_id, created_at) VALUES (?, ?, ?, ?, ?)");
    ins.run(a.id, '{"secret":"a1"}', 15, 'rev-a1', '2026-10-01 10:00:00');
    ins.run(a.id, '{"secret":"a2"}', 15, 'rev-a2', '2026-10-02 10:00:00');
    ins.run(b.id, '{"secret":"b1"}', 15, 'rev-b1', '2026-10-03 10:00:00');

    const mine = await (await history(env, a)).json();
    expect(mine.history.map((h) => h.revision_id)).toEqual(['rev-a2', 'rev-a1']);
    expect(JSON.stringify(mine)).not.toMatch(/secret|rev-b1/);
    expect((await (await history(env, a, '?limit=1')).json()).history.map((h) => h.revision_id)).toEqual(['rev-a2']);
    expect((await (await history(env, b)).json()).history.map((h) => h.revision_id)).toEqual(['rev-b1']);
  });
});

suite('GET /api/commitments/:id (real D1)', () => {
  async function withWord() {
    const env = makeEnv();
    const owner = await register(env, 'owner@example.com');
    const other = await register(env, 'intruder@example.com');
    const made = await call(env, '/api/commitments', {
      method: 'POST', cookie: owner.cookie,
      body: { title: 'start the taxes', details: 'just the folder', start_at: '2099-01-01T15:00:00.000Z', persona: 'ally', channel: 'push' },
    });
    expect(made.status).toBe(201);
    return { env, owner, other, id: (await made.json()).commitment.id };
  }
  const read = (env, who, id) => call(env, `/api/commitments/${id}`, { cookie: who?.cookie });

  it('is 401 without a session and with a forged one', async () => {
    const { env, id } = await withWord();
    expect((await read(env, null, id)).status).toBe(401);
    expect((await read(env, FORGED, id)).status).toBe(401);
  });

  it('returns the owner\'s word as stored, with its check-ins', async () => {
    const { env, owner, id } = await withWord();
    const res = await read(env, owner, id);
    expect(res.status).toBe(200);
    const body = await res.json();
    const stored = row(env, 'SELECT title, details, start_at, status, persona, channel FROM commitments WHERE id = ?', id);
    expect(body.commitment).toMatchObject({ id, ...stored, title: 'start the taxes', status: 'active' });
    const checkins = rows(env, 'SELECT id, status FROM commitment_checkins WHERE commitment_id = ? ORDER BY scheduled_for', id);
    expect(body.checkins.map((c) => ({ id: c.id, status: c.status }))).toEqual(checkins);
    expect(checkins.length).toBeGreaterThan(0);
  });

  it('AUTHZ: another account gets 404 — the same answer as an id that does not exist — and no data', async () => {
    const { env, other, id } = await withWord();
    const cross = await read(env, other, id);
    const missing = await read(env, other, 'no-such-commitment');
    expect(cross.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await cross.json()).toEqual(await missing.json());
    expect(JSON.stringify(await (await read(env, other, id)).json())).not.toContain('taxes');
  });
});
