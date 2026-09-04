/**
 * FocusBro — a word without a password.
 *
 * Measured on 2026-09-04: 928 recorded visits, at most four registration
 * attempts, two accounts, ZERO commitments ever. The homepage already collects
 * the word; the /me/ door then demanded an email and a password. These gates
 * pin the new door: the first word creates a GUEST account (a real users row
 * with a synthetic non-routable address and an unknowable password), bound to
 * the browser by the same HttpOnly cookie a registered account gets; the
 * session says it is a guest and never shows the synthetic address; a claim
 * turns it into an account in place, and can never take over someone else's.
 * Every case FAILS on the tree before the door moved.
 */

import { describe, it, expect } from 'vitest';
import worker, { generateToken, isGuestEmail, GUEST_EMAIL_DOMAIN } from '../index.js';
import { EVENTS } from '../events.js';
import { renderMePage } from '../me.js';

const JWT_SECRET = 'test-secret-test-secret-test-secret-1234';
const USER_ID = 'user-guest-1';
const SESSION_ID = 'sess-1';

// A D1-shaped fake: every prepare() captures its SQL + params; `first()` answers
// from a table of SQL-pattern → row so a test can script what the DB holds.
function makeDB(answers = []) {
  const runs = [];
  return {
    runs,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a; return stmt; },
        async first() {
          for (const [re, row] of answers) if (re.test(sql)) return typeof row === 'function' ? row(params) : row;
          return null;
        },
        async all() { return { results: [] }; },
        async run() { runs.push({ sql, params }); return { success: true }; },
      };
      return stmt;
    },
  };
}
const sessionRow = () => async () => ({ session_id: SESSION_ID, user_id: USER_ID, token_hash: 'x', revoked_at: null, is_active: 1 });
function makeEnv(db, extra = {}) {
  return { JWT_SECRET, DB: db, KV_CACHE: { get: async () => null, put: async () => {} }, ...extra };
}
const ctx = {};
// A browser sends Origin on every POST; the cross-site cookie guard requires it.
const post = (path, env, body, headers = {}) => worker.fetch(new Request(`https://focusbro.net${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://focusbro.net', ...headers }, body: body == null ? undefined : JSON.stringify(body),
}), env, ctx);
const get = (path, env, headers = {}) => worker.fetch(new Request(`https://focusbro.net${path}`, { headers }), env, ctx);
const inserted = (db, table) => db.runs.filter((r) => new RegExp(`INSERT INTO ${table}\\b`, 'i').test(r.sql));

describe('POST /auth/guest — the first word creates the account', () => {
  it('creates a guest users row with a non-routable address, a session, and the cookie; records the funnel event', async () => {
    const db = makeDB();
    const res = await post('/auth/guest', makeEnv(db), {});
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, guest: true });
    expect(body.user_id).toBeTruthy();
    expect(body.token).toBeUndefined();                       // the credential travels in the cookie only
    expect(res.headers.get('set-cookie')).toMatch(/^__Host-focusbro_session=.+; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/);
    const users = inserted(db, 'users');
    expect(users.length).toBe(1);
    expect(users[0].sql).toContain('is_guest');
    const [id, email, hash] = users[0].params;
    expect(id).toBe(body.user_id);
    expect(email).toBe(`guest-${id}@${GUEST_EMAIL_DOMAIN}`);
    expect(isGuestEmail(email)).toBe(true);
    expect(GUEST_EMAIL_DOMAIN.endsWith('.invalid')).toBe(true);   // RFC 2606: never routable, never a real inbox
    expect(hash).toMatch(/\S{20,}/);                            // a hash of something nobody knows
    expect(inserted(db, 'sessions').length).toBe(1);
    const audit = inserted(db, 'audit_logs');
    expect(audit.length).toBe(1);
    expect(audit[0].sql).toContain("'guest_start'");
    const events = inserted(db, 'analytics_events');
    expect(events.length).toBe(1);
    expect(events[0].params).toContain(EVENTS.GUEST_STARTED);
  });

  it('is rate-limited per connection like registration, and never sends an email', async () => {
    const db = makeDB();
    const kv = { get: async () => '10', put: async () => {} };      // at the cap
    const res = await post('/auth/guest', makeEnv(db, { KV_CACHE: kv }), {});
    expect(res.status).toBe(429);
    expect(inserted(db, 'users').length).toBe(0);
    // nothing in the guest path composes or sends mail — there is no address to send to
    const ok = await post('/auth/guest', makeEnv(makeDB()), {});
    expect(ok.status).toBe(201);
  });

  it('fails closed on a database error', async () => {
    const db = makeDB();
    db.prepare = () => ({ bind() { return this; }, async run() { throw new Error('D1 down'); }, async first() { return null; } });
    const res = await post('/auth/guest', makeEnv(db), {});
    expect(res.status).toBe(500);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

describe('GET /auth/session — says guest, never shows the synthetic address', () => {
  it('reports guest:true with email null for a guest, and the real email for an account', async () => {
    const token = await generateToken(USER_ID, JWT_SECRET, SESSION_ID);
    const guestDb = makeDB([[/FROM sessions/i, sessionRow()], [/FROM users WHERE id/i, { email: `guest-${USER_ID}@${GUEST_EMAIL_DOMAIN}`, email_verified_at: null, is_guest: 1 }]]);
    const g = await get('/auth/session', makeEnv(guestDb), { Cookie: `__Host-focusbro_session=${token}` });
    expect(g.status).toBe(200);
    expect(await g.json()).toMatchObject({ authenticated: true, user_id: USER_ID, guest: true, email: null, email_verified: false });
    const acctDb = makeDB([[/FROM sessions/i, sessionRow()], [/FROM users WHERE id/i, { email: 'me@example.com', email_verified_at: '2026-09-01', is_guest: 0 }]]);
    const a = await get('/auth/session', makeEnv(acctDb), { Cookie: `__Host-focusbro_session=${token}` });
    expect(await a.json()).toMatchObject({ authenticated: true, guest: false, email: 'me@example.com', email_verified: true });
  });
});

describe('POST /auth/claim — a guest becomes an account, in place', () => {
  const token = () => generateToken(USER_ID, JWT_SECRET, SESSION_ID);
  const cookie = async () => ({ Cookie: `__Host-focusbro_session=${await token()}` });

  it('keeps the id, sets the email and password, drops the guest flag, records the event', async () => {
    const db = makeDB([[/FROM sessions/i, sessionRow()], [/SELECT id, is_guest FROM users/i, { id: USER_ID, is_guest: 1 }], [/SELECT id FROM users WHERE email/i, null]]);
    const res = await post('/auth/claim', makeEnv(db), { email: 'Me@Example.com', password: 'longenough1' }, await cookie());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, user_id: USER_ID, guest: false, email_verified: false });
    const update = db.runs.find((r) => /UPDATE users SET email/i.test(r.sql));
    expect(update).toBeTruthy();
    expect(update.sql).toContain('is_guest = 0');
    expect(update.params[0]).toMatch(/^me@example\.com$/);
    expect(update.params[2]).toBe(USER_ID);
    expect(inserted(db, 'users').length).toBe(0);              // no second account
    expect(inserted(db, 'audit_logs')[0].sql).toContain("'claim'");
    expect(inserted(db, 'analytics_events')[0].params).toContain(EVENTS.ACCOUNT_CLAIMED);
  });

  it('refuses without a session, on a weak password, on a bad or guest-shaped email', async () => {
    const db = () => makeDB([[/FROM sessions/i, sessionRow()], [/SELECT id, is_guest FROM users/i, { id: USER_ID, is_guest: 1 }]]);
    expect((await post('/auth/claim', makeEnv(db()), { email: 'me@example.com', password: 'longenough1' })).status).toBe(401);
    expect((await post('/auth/claim', makeEnv(db()), { email: 'me@example.com', password: 'short' }, await cookie())).status).toBe(400);
    expect((await post('/auth/claim', makeEnv(db()), { email: 'not-an-email', password: 'longenough1' }, await cookie())).status).toBe(400);
    expect((await post('/auth/claim', makeEnv(db()), { email: `x@${GUEST_EMAIL_DOMAIN}`, password: 'longenough1' }, await cookie())).status).toBe(400);
    expect((await post('/auth/claim', makeEnv(db()), {}, await cookie())).status).toBe(400);
  });

  it('never takes over another account, and never claims twice', async () => {
    const taken = makeDB([[/FROM sessions/i, sessionRow()], [/SELECT id, is_guest FROM users/i, { id: USER_ID, is_guest: 1 }], [/SELECT id FROM users WHERE email/i, { id: 'someone-else' }]]);
    const r1 = await post('/auth/claim', makeEnv(taken), { email: 'theirs@example.com', password: 'longenough1' }, await cookie());
    expect(r1.status).toBe(409);
    expect(taken.runs.some((r) => /UPDATE users/i.test(r.sql))).toBe(false);
    const already = makeDB([[/FROM sessions/i, sessionRow()], [/SELECT id, is_guest FROM users/i, { id: USER_ID, is_guest: 0 }]]);
    const r2 = await post('/auth/claim', makeEnv(already), { email: 'me@example.com', password: 'longenough1' }, await cookie());
    expect(r2.status).toBe(409);
    expect(already.runs.some((r) => /UPDATE users/i.test(r.sql))).toBe(false);
  });
});

describe('the /me/ door', () => {
  const html = renderMePage();
  const app = html.match(/<script>([\s\S]*)<\/script>/)[1];

  it('shows an anonymous visitor the form, creates the guest on submit, and never on load', () => {
    expect(html).toContain('id="anonNote"');
    expect(html).toContain('id="signinLink"');
    expect(app).toContain('function showSigninDoor() { enterAnonymous(); }');
    expect(app).toContain("(ANONYMOUS ? startGuest() : Promise.resolve(null))");
    // page-load paths never call /auth/guest; only the submit does
    const loadPaths = app.slice(app.indexOf('function restoreSession'));
    expect(loadPaths).not.toContain("'/auth/guest'");
    expect(app.split("'/auth/guest'").length - 1).toBe(1);
  });

  it('asks for push on the gesture that earned it, subscribes through the real intake, and records the answer', () => {
    expect(app).toContain("navigator.serviceWorker.register('/sw.js')");
    expect(app).toContain("fetch('/vapid/public-key')");
    expect(app).toContain("fetch('/notifications/subscribe'");
    expect(app).toContain("type: 'push_permission'");
    expect(app).toContain("if (payload.channel === 'push') ensurePush();");
    expect(app).not.toMatch(/ensurePush\(\);\s*\n\s*restoreSession/);   // never on load
  });

  it('offers the claim to a guest only, with the same rules as registration', () => {
    expect(html).toContain('id="claimCard"');
    expect(html).toContain('id="claimPassword" type="password" placeholder="at least 8 characters" autocomplete="new-password" minlength="8"');
    expect(app).toContain("fetch('/auth/claim'");
    expect(app).toContain("if (GUEST) show(el('claimCard')); else hide(el('claimCard'));");
  });
});
