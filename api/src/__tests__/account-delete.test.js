/**
 * Account deletion (Google Play User Data policy), driven through the WORKER's
 * own fetch() against a REAL SQLite schema: every migrations/NNNN_*.sql plus the
 * tables the Worker's runtime init creates (operators, coach_operators, …).
 *
 * What must hold:
 *   - after POST /api/account/delete, NOT ONE cell anywhere in the database
 *     still carries the person's user id or phone number;
 *   - a Pro purchase survives with its money facts and a tombstone, not the id;
 *   - every other person's rows are untouched (coach links to the deleted
 *     person go, on both sides);
 *   - the session cookie is cleared and the old session no longer works;
 *   - guards: signed-out 401, missing confirm 400, cross-origin 403 — and a
 *     rejected request deletes nothing;
 *   - the batch is all-or-nothing;
 *   - DRIFT: every table the schema has is named in ACCOUNT_DELETION_PLAN, and
 *     every table with a user-keyed or phone column is deleted or anonymised.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import worker from '../index.js';
import { DatabaseSync, makeMigratedD1, makeKV } from './helpers/real-d1.js';
import {
  ACCOUNT_DELETION_PLAN,
  plannedTables,
  accountDeleteCopySurface,
  renderMeDeleteSection,
  ACCOUNT_DELETE_SCRIPT,
} from '../account-delete.js';
import { renderMePage } from '../me.js';
import { assertDesignLawClean } from '../design-law.js';
import { privacySections } from '../privacy.js';
import servedHtml from '../html.js';

const suite = DatabaseSync ? describe : describe.skip;
const ORIGIN = 'https://focusbro.net';
const ctx = { waitUntil() {}, passThroughOnException() {} };

// The Worker's runtime-init CREATE TABLE statements (index.js initializeDatabase)
// — production carries tables created that way before migrations existed.
const RUNTIME_CREATES = [...readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  .matchAll(/`(CREATE TABLE IF NOT EXISTS[\s\S]*?)`/g)].map((m) => m[1]);

function makeEnv({ runtimeTables = true } = {}) {
  const DB = makeMigratedD1();
  if (runtimeTables) for (const sql of RUNTIME_CREATES) DB.sqlite.exec(sql);
  return { DB, KV_CACHE: makeKV(), JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256-0123456789', BUILD_SHA: 'abc1234' };
}

function req(method, path, { cookie, body, origin = ORIGIN, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.Cookie = cookie;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; if (origin) h.Origin = origin; }
  return new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function startGuest(env) {
  const res = await worker.fetch(req('POST', '/auth/guest', { body: {} }), env, ctx);
  expect(res.status).toBe(201);
  const cookie = res.headers.get('Set-Cookie').split(';')[0];
  const { user_id: userId } = await res.json();
  return { cookie, userId };
}

const tables = (sdb) => sdb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
const columns = (sdb, t) => sdb.prepare(`PRAGMA table_info("${t}")`).all();
const fks = (sdb, t) => sdb.prepare(`PRAGMA foreign_key_list("${t}")`).all();

/** Every (table, column) whose value equals / contains `needle`. */
function cellsCarrying(sdb, needle, { contains = false } = {}) {
  const hits = [];
  for (const t of tables(sdb)) {
    for (const c of columns(sdb, t)) {
      const where = contains ? `instr(CAST("${c.name}" AS TEXT), ?) > 0` : `"${c.name}" = ?`;
      const n = sdb.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE ${where}`).get(needle).n;
      if (n) hits.push(`${t}.${c.name}×${n}`);
    }
  }
  return hits;
}

function rowCounts(sdb) {
  return Object.fromEntries(tables(sdb).map((t) => [t, sdb.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n]));
}

/** Seed one person's data into every user-keyed table. */
function seedPerson(sdb, u, phone, tag) {
  const run = (sql, ...a) => sdb.prepare(sql).run(...a);
  run('UPDATE users SET phone = ? WHERE id = ?', phone, u);
  run('INSERT INTO user_data_snapshots (id, user_id, snapshot_data) VALUES (?, ?, ?)', `snap-${tag}`, u, '{"notes":"mine"}');
  run('INSERT INTO sync_logs (id, user_id, device_id, action) VALUES (?, ?, ?, ?)', `sl-${tag}`, u, `dev-${tag}`, 'upload');
  run('INSERT INTO api_keys (id, user_id, key_hash) VALUES (?, ?, ?)', `ak-${tag}`, u, 'h');
  run('INSERT INTO audit_logs (id, user_id, action, details) VALUES (?, ?, ?, ?)', `al-${tag}`, u, 'login', `user ${u}`);
  run('INSERT INTO focus_events (id, user_id, event_type, client_timestamp) VALUES (?, ?, ?, ?)', `fe-${tag}`, u, 'focus', '2026-10-01T10:00:00Z');
  run('INSERT INTO user_streaks (user_id, current_streak) VALUES (?, 3)', u);
  run('INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, ?)', `ps-${tag}`, u, `https://push.example/${tag}`, 'k', 'a');
  run('INSERT INTO notification_prefs (user_id) VALUES (?)', u);
  run('INSERT INTO slack_integrations (id, user_id, webhook_url) VALUES (?, ?, ?)', `sk-${tag}`, u, 'https://hooks.example/x');
  run('INSERT INTO subscriptions (id, user_id, stripe_customer_id) VALUES (?, ?, ?)', `sub-${tag}`, u, `cus_${tag}`);
  run('INSERT INTO commitments (id, user_id, title, start_at) VALUES (?, ?, ?, ?)', `c-${tag}`, u, `write the report ${tag}`, '2026-10-01T10:00:00Z');
  run('INSERT INTO commitment_checkins (id, commitment_id, user_id, scheduled_for, note) VALUES (?, ?, ?, ?, ?)', `ck-${tag}`, `c-${tag}`, u, '2026-10-01T11:00:00Z', 'did it');
  run('INSERT INTO accountability_streaks (user_id, total_kept) VALUES (?, 4)', u);
  run('INSERT INTO contact_consent (id, user_id, channel, phone, consent_text) VALUES (?, ?, ?, ?, ?)', `cc-${tag}`, u, 'text', phone, 'ok to text');
  run('INSERT INTO analytics_events (id, user_id, event_type) VALUES (?, ?, ?)', `ae-${tag}`, u, 'word_given');
  run('INSERT INTO escalation_prefs (user_id, ceiling) VALUES (?, ?)', u, 'text');
  run('INSERT INTO coach_note_consent (user_id, shared) VALUES (?, 1)', u);
  run('INSERT INTO auth_action_tokens (id, user_id, purpose, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)', `at-${tag}`, u, 'password_reset', `th-${tag}`, '2099-01-01');
  run('INSERT INTO devices (device_id, user_id, device_name) VALUES (?, ?, ?)', `dev-${tag}`, u, 'phone');
  run('INSERT INTO pro_purchases (id, user_id, stripe_session_id, status, amount_total, currency, paid_at) VALUES (?, ?, ?, ?, ?, ?, ?)', `pp-${tag}`, u, `cs_live_${tag}`, 'paid', 999, 'usd', '2026-10-02 12:00:00');
  run(`INSERT INTO webhook_inbox (provider, event_id, event_type, raw_payload) VALUES ('telnyx', ?, 'message.received', ?)`,
    `evt-${tag}`, JSON.stringify({ data: { id: `evt-${tag}`, event_type: 'message.received', payload: { from: { phone_number: phone }, text: 'done' } } }));
  if (tablesHave(sdb, 'coach_operators')) {
    const now = '2026-10-01T00:00:00Z';
    run('INSERT INTO operators (id, slug, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', `op-${tag}`, `coach-${tag}`, `Coach ${tag}`, now, now);
    run('INSERT INTO coach_operators (user_id, operator_id) VALUES (?, ?)', u, `op-${tag}`);
    run('INSERT INTO coach_checkin_config (operator_id, cadence, voice_persona, script) VALUES (?, ?, ?, ?)', `op-${tag}`, 'daily', 'ally', 'hey');
  }
}
const tablesHave = (sdb, t) => tables(sdb).includes(t);

suite('account deletion — the real schema, through the Worker', () => {
  async function world({ runtimeTables = true } = {}) {
    const env = makeEnv({ runtimeTables });
    const a = await startGuest(env);
    const b = await startGuest(env);
    const c = await startGuest(env);
    const sdb = env.DB.sqlite;
    seedPerson(sdb, a.userId, '+15551110001', 'a');
    seedPerson(sdb, b.userId, '+15552220002', 'b');
    // Coach links on both sides: A coaches B, B coaches A, B coaches C.
    const link = (id, coach, client) => sdb.prepare('INSERT INTO coach_clients (id, coach_user_id, client_user_id, status) VALUES (?, ?, ?, ?)').run(id, coach, client, 'active');
    link('l-ab', a.userId, b.userId); link('l-ba', b.userId, a.userId); link('l-bc', b.userId, c.userId);
    if (runtimeTables) {
      const now = '2026-10-01T00:00:00Z';
      const seat = (id, op, client) => sdb.prepare('INSERT INTO operator_clients (id, operator_id, external_org_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, op, client, 'Client', now, now);
      seat('oc-a-b', 'op-a', b.userId); seat('oc-b-a', 'op-b', a.userId); seat('oc-b-c', 'op-b', c.userId);
    }
    await env.KV_CACHE.put(`user:${a.userId}:latest`, '{}');
    await env.KV_CACHE.put(`sync:upload:${a.userId}`, '1');
    await env.KV_CACHE.put(`returnnudge:${a.userId}`, 'x');
    await env.KV_CACHE.put(`user:${b.userId}:latest`, '{}');
    return { env, sdb, a, b, c };
  }

  const del = (env, cookie, opts = {}) => worker.fetch(req('POST', '/api/account/delete', { cookie, body: { confirm: 'DELETE' }, ...opts }), env, ctx);

  it('deletes every trace of the person in one go, keeps the purchase anonymised, clears the cookie', async () => {
    const { env, sdb, a, b, c } = await world();
    expect(cellsCarrying(sdb, a.userId).length).toBeGreaterThan(20); // the seed really landed everywhere
    const bBefore = cellsCarrying(sdb, b.userId);

    const res = await del(env, a.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(res.headers.get('Set-Cookie')).toMatch(/__Host-focusbro_session=;.*Max-Age=0/);

    // Not one cell anywhere still holds the id or the phone number.
    expect(cellsCarrying(sdb, a.userId)).toEqual([]);
    expect(cellsCarrying(sdb, a.userId, { contains: true })).toEqual([]);
    expect(cellsCarrying(sdb, '+15551110001', { contains: true })).toEqual([]);

    // The purchase survives for tax records with no link to the person.
    const kept = sdb.prepare("SELECT * FROM pro_purchases WHERE stripe_session_id = 'cs_live_a'").get();
    expect(kept).toMatchObject({ status: 'paid', amount_total: 999, currency: 'usd', paid_at: '2026-10-02 12:00:00' });
    expect(kept.user_id).toMatch(/^deleted:[0-9a-f]{24}$/);

    // Everyone else is untouched — except their links TO the deleted person.
    const bAfter = cellsCarrying(sdb, b.userId);
    const lost = bBefore.filter((x) => !bAfter.includes(x));
    // Only B's links to A changed: B coached A (2 → 1 coach rows), A coached B
    // (client row gone), and B's seat on A's operator roster (gone with op-a).
    expect(lost.sort()).toEqual(['coach_clients.client_user_id×1', 'coach_clients.coach_user_id×2', 'operator_clients.external_org_id×1']);
    expect(bAfter).toContain('coach_clients.coach_user_id×1'); // B still coaches C
    expect(sdb.prepare("SELECT COUNT(*) AS n FROM coach_clients WHERE id = 'l-bc'").get().n).toBe(1);
    expect(sdb.prepare("SELECT COUNT(*) AS n FROM operator_clients WHERE id = 'oc-b-c'").get().n).toBe(1);
    expect(sdb.prepare("SELECT COUNT(*) AS n FROM operators WHERE id = 'op-b'").get().n).toBe(1);
    expect(sdb.prepare("SELECT COUNT(*) AS n FROM operators WHERE id = 'op-a'").get().n).toBe(0);
    expect(sdb.prepare("SELECT user_id FROM pro_purchases WHERE stripe_session_id = 'cs_live_b'").get().user_id).toBe(b.userId);
    expect(cellsCarrying(sdb, '+15552220002', { contains: true }).length).toBeGreaterThanOrEqual(3);
    expect(cellsCarrying(sdb, c.userId).length).toBeGreaterThan(0);

    // KV keyed by the person is gone; others' stays.
    expect(await env.KV_CACHE.get(`user:${a.userId}:latest`)).toBeNull();
    expect(await env.KV_CACHE.get(`sync:upload:${a.userId}`)).toBeNull();
    expect(await env.KV_CACHE.get(`returnnudge:${a.userId}`)).toBeNull();
    expect(await env.KV_CACHE.get(`user:${b.userId}:latest`)).toBe('{}');

    // The old cookie no longer opens anything.
    const s = await worker.fetch(req('GET', '/auth/session', { cookie: a.cookie }), env, ctx);
    expect(s.status).toBe(401);
    expect((await del(env, a.cookie)).status).toBe(401);
  });

  it('an inbound text is matched on the whole number — a longer number that contains it is kept', async () => {
    const { env, sdb, a } = await world();
    sdb.prepare(`INSERT INTO webhook_inbox (provider, event_id, event_type, raw_payload) VALUES ('telnyx', 'evt-other', 'message.received', ?)`)
      .run(JSON.stringify({ data: { payload: { from: { phone_number: '+155511100019' }, text: 'hi' } } }));
    expect((await del(env, a.cookie)).status).toBe(200);
    expect(sdb.prepare("SELECT event_id FROM webhook_inbox WHERE provider = 'telnyx' ORDER BY event_id").all().map((r) => r.event_id))
      .toEqual(['evt-b', 'evt-other']);
  });

  it('works on a database without the runtime-only coach tables (production may lack them)', async () => {
    const { env, sdb, a } = await world({ runtimeTables: false });
    expect(tablesHave(sdb, 'coach_operators')).toBe(false);
    const res = await del(env, a.cookie);
    expect(res.status).toBe(200);
    expect(cellsCarrying(sdb, a.userId, { contains: true })).toEqual([]);
  });

  it('guards: signed out 401, missing confirm 400, cross-origin 403 — and a refusal deletes nothing', async () => {
    const { env, sdb, a } = await world();
    const before = rowCounts(sdb);

    expect((await del(env, undefined)).status).toBe(401);
    for (const body of [{}, { confirm: 'delete me' }, { confirm: true }]) {
      const r = await worker.fetch(req('POST', '/api/account/delete', { cookie: a.cookie, body }), env, ctx);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    const notJson = await worker.fetch(new Request(ORIGIN + '/api/account/delete', {
      method: 'POST', headers: { Cookie: a.cookie, Origin: ORIGIN, 'Content-Type': 'text/plain' }, body: 'DELETE',
    }), env, ctx);
    expect(notJson.status).toBe(415);
    expect((await del(env, a.cookie, { origin: 'https://evil.example' })).status).toBe(403);
    // A bearer caller from another origin is refused too (the global cookie guard does not cover it).
    const bearer = a.cookie.split('=').slice(1).join('=');
    const r = await worker.fetch(req('POST', '/api/account/delete', {
      body: { confirm: 'DELETE' }, origin: 'https://evil.example', headers: { Authorization: `Bearer ${decodeURIComponent(bearer)}` },
    }), env, ctx);
    expect(r.status).toBe(403);
    const fetchSite = await worker.fetch(req('POST', '/api/account/delete', {
      body: { confirm: 'DELETE' }, origin: null, headers: { Authorization: `Bearer ${decodeURIComponent(bearer)}`, 'Sec-Fetch-Site': 'cross-site' },
    }), env, ctx);
    expect(fetchSite.status).toBe(403);

    expect(rowCounts(sdb)).toEqual(before);
  });

  it('is all-or-nothing: a failure part-way deletes nothing', async () => {
    const { env, sdb, a } = await world();
    sdb.exec("CREATE TRIGGER block_user_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'blocked'); END;");
    const before = rowCounts(sdb);
    const res = await del(env, a.cookie);
    expect(res.status).toBe(500);
    expect(rowCounts(sdb)).toEqual(before);
    expect(cellsCarrying(sdb, a.userId).length).toBeGreaterThan(20);
  });
});

suite('account deletion — drift: every table is in the plan', () => {
  function fullSchema() {
    const env = makeEnv({ runtimeTables: true });
    return env.DB.sqlite;
  }

  it('the migrations directory is what the schema is built from', () => {
    const dir = fileURLToPath(new URL('../../../migrations', import.meta.url));
    expect(readdirSync(dir).filter((n) => /^\d{4}_.*\.sql$/.test(n)).length).toBeGreaterThanOrEqual(9);
  });

  it('every table in the schema is named in ACCOUNT_DELETION_PLAN', () => {
    const sdb = fullSchema();
    const planned = new Set(plannedTables());
    const unplanned = tables(sdb).filter((t) => !planned.has(t));
    expect(unplanned, 'add each new table to ACCOUNT_DELETION_PLAN in account-delete.js').toEqual([]);
  });

  it('every table with a user-keyed or phone column is deleted or anonymised', () => {
    const sdb = fullSchema();
    const byTable = Object.fromEntries(ACCOUNT_DELETION_PLAN.map((p) => [p.table, p]));
    const personal = tables(sdb).filter((t) => columns(sdb, t).some((c) => /(^|_)user_id$|^phone$/.test(c.name))
      || fks(sdb, t).some((f) => f.table === 'users'));
    expect(personal.length).toBeGreaterThan(20);
    const unhandled = personal.filter((t) => !byTable[t] || byTable[t].action === 'none');
    expect(unhandled).toEqual([]);
  });

  it('a new user-keyed table makes the drift check fail (proof it can reject)', () => {
    const sdb = fullSchema();
    sdb.exec('CREATE TABLE journal_entries (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, body TEXT)');
    const planned = new Set(plannedTables());
    expect(tables(sdb).filter((t) => !planned.has(t))).toEqual(['journal_entries']);
  });
});

describe('account deletion — pages and copy', () => {
  const stmt = { bind() { return stmt; }, first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }) };
  const env = { JWT_SECRET: 'test-secret', BUILD_SHA: 'test', KV_CACHE: makeKV(), DB: { prepare: () => stmt } };
  const get = (path) => worker.fetch(new Request(ORIGIN + path), env, ctx);

  it('GET /account/delete is a public 200 with the in-app steps and the email path, under the enforced CSP', async () => {
    const res = await get('/account/delete');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Security-Policy')).toBeTruthy();
    const html = await res.text();
    expect(html).toContain('Delete your FocusBro account');
    expect(html).toContain('href="/me/#delete"');
    expect(html).toContain('mailto:support@focusbro.net?subject=Delete%20my%20account');
    expect(html).toContain('What we keep');
    expect(html).toContain('Stripe receipt reference');
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/); // no inline script
  });

  it('GET /account/deleted and /account-delete.js are served', async () => {
    const gone = await get('/account/deleted');
    expect(gone.status).toBe(200);
    expect(await gone.text()).toContain('Your account is gone');
    const js = await get('/account-delete.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('Content-Type')).toContain('javascript');
    expect(await js.text()).toBe(ACCOUNT_DELETE_SCRIPT);
  });

  it('/me/ carries the delete card at the bottom and loads its first-party script', () => {
    const page = renderMePage();
    expect(page).toContain(renderMeDeleteSection());
    expect(page).toContain('<script src="/account-delete.js" defer></script>');
    expect(page.indexOf('id="deleteAccount"')).toBeGreaterThan(page.indexOf('id="signout"'));
  });

  it('the copy follows the design law (no shame, no "AI", no clinical claims)', () => {
    assertDesignLawClean(accountDeleteCopySurface(), { label: 'accountDeleteCopySurface' });
    for (const s of accountDeleteCopySurface()) expect(s).not.toMatch(/sure you want to leave|sad to see|miss you/i);
  });

  it('the privacy policy says what the code collects: phone + texts, notifications, payments, email, retention, deletion, children', async () => {
    const res = await get('/privacy.html');
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const [heading] of privacySections()) expect(html, heading).toContain(`<h2>${heading}</h2>`);
    for (const fact of [
      'Phone number and text messages', 'Telnyx', 'Reply STOP',
      'Notifications', 'push address', 'local notifications', 'not sent through any third-party push service',
      'Stripe', 'never see or store card numbers',
      'Resend', 'Cloudflare Web Analytics, which does not use cookies',
      'How long we keep data', 'with the link to you removed',
      'href="/account/delete"', 'children under 13', 'no ads',
    ]) expect(html, fact).toContain(fact);
  });

  it('public/privacy.html and the in-app privacy modal carry the same sections', () => {
    const file = readFileSync(new URL('../../../public/privacy.html', import.meta.url), 'utf8');
    const modalStart = servedHtml.indexOf('id="privacyContent"');
    const modal = servedHtml.slice(modalStart, servedHtml.indexOf('id="termsContent"'));
    expect(modalStart).toBeGreaterThan(0);
    for (const [heading] of privacySections()) {
      expect(file, `public/privacy.html: ${heading}`).toContain(`<h2>${heading}</h2>`);
      expect(modal, `modal: ${heading}`).toContain(`>${heading}</h3>`);
    }
    expect(modal).toContain('href="/account/delete"');
  });

  it('the footer and privacy policy link the deletion page', async () => {
    const privacy = await (await get('/privacy.html')).text();
    expect(privacy).toContain('href="/account/delete"');
    const shell = await (await get('/')).text();
    expect(shell).toContain('href="/account/delete"');
  });
});
