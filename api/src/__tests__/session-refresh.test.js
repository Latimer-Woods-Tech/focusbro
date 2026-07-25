import { describe, expect, it } from 'vitest';
import worker, {
  createSessionRecord,
  generateToken,
  hashSessionCredential,
  verifySignedToken,
  verifyToken
} from '../index.js';
import config from '../config.js';

const JWT_SECRET = 'refresh-test-secret-with-enough-entropy';
const USER_ID = 'user-123';
const SESSION_ID = 'session-123';

function makeEnv(currentToken, options = {}) {
  const state = {
    currentToken,
    currentTokenHash: null,
    sessionLookups: 0,
    rotations: 0
  };

  const env = {
    JWT_SECRET,
    KV_CACHE: { get: async () => null, put: async () => {} },
    DB: {
      prepare(sql) {
        let bindings = [];
        const statement = {
          bind(...values) {
            bindings = values;
            return statement;
          },
          async first() {
            if (sql.includes('FROM sessions s')) {
              state.sessionLookups += 1;
              const [presentedHash, presentedToken, presentedUserId] = bindings;
              if (
                options.revoked
                || options.inactiveUser
                || options.expiredSession
                || (
                  presentedToken !== state.currentToken
                  && presentedHash !== state.currentTokenHash
                )
                || presentedUserId !== USER_ID
              ) {
                return null;
              }
              return { session_id: SESSION_ID, user_id: USER_ID };
            }
            return { count: 1 };
          },
          async all() {
            return { results: [] };
          },
          async run() {
            if (sql.includes('UPDATE sessions') && sql.includes("SET token = ''")) {
              state.rotations += 1;
              const [newTokenHash, sessionId, userId, previousHash, previousToken] = bindings;
              if (
                options.rotationConflict
                || sessionId !== SESSION_ID
                || userId !== USER_ID
                || (
                  previousToken !== state.currentToken
                  && previousHash !== state.currentTokenHash
                )
              ) {
                return { success: true, meta: { changes: 0 } };
              }
              state.currentToken = null;
              state.currentTokenHash = newTokenHash;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
        };
        return statement;
      }
    }
  };

  return { env, state };
}

function requestRefresh(env, token) {
  return worker.fetch(
    new Request('https://focusbro.net/auth/refresh', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    }),
    env,
    {}
  );
}

describe('session refresh', () => {
  it('stores only a one-way hash for a newly issued credential', async () => {
    const token = await generateToken(USER_ID, JWT_SECRET, SESSION_ID);
    let sql;
    let bindings;
    const env = {
      DB: {
        prepare(statementSql) {
          sql = statementSql;
          return {
            bind(...values) {
              bindings = values;
              return { run: async () => ({ success: true }) };
            }
          };
        }
      }
    };

    await createSessionRecord(env, SESSION_ID, USER_ID, token);

    expect(sql).toContain("VALUES (?, ?, '', ?");
    expect(bindings).toEqual([
      SESSION_ID,
      USER_ID,
      await hashSessionCredential(token)
    ]);
    expect(bindings).not.toContain(token);
  });

  it('rotates the exact active session credential', async () => {
    const originalToken = await generateToken(USER_ID, JWT_SECRET, SESSION_ID);
    const { env, state } = makeEnv(originalToken);

    const response = await requestRefresh(env, originalToken);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.token).not.toBe(originalToken);
    expect(body.session_id).toBe(SESSION_ID);
    expect(state.currentToken).toBeNull();
    await expect(hashSessionCredential(body.token)).resolves.toBe(state.currentTokenHash);
    expect(state.rotations).toBe(1);
    await expect(verifyToken(body.token, JWT_SECRET)).resolves.toMatchObject({
      sub: USER_ID,
      sid: SESSION_ID
    });
  });

  it('rejects replay of the rotated credential', async () => {
    const originalToken = await generateToken(USER_ID, JWT_SECRET, SESSION_ID);
    const { env } = makeEnv(originalToken);

    expect((await requestRefresh(env, originalToken)).status).toBe(200);
    expect((await requestRefresh(env, originalToken)).status).toBe(401);
  });

  it.each([
    ['revoked session', { revoked: true }],
    ['inactive user', { inactiveUser: true }],
    ['server session outside grace', { expiredSession: true }]
  ])('rejects a %s', async (_scenario, options) => {
    const token = await generateToken(USER_ID, JWT_SECRET, SESSION_ID);
    const { env } = makeEnv(token, options);

    expect((await requestRefresh(env, token)).status).toBe(401);
  });

  it('rejects a credential bound to the wrong session', async () => {
    const token = await generateToken(USER_ID, JWT_SECRET, 'different-session');
    const { env } = makeEnv(token);

    expect((await requestRefresh(env, token)).status).toBe(401);
  });

  it('allows only a short expiration grace window', async () => {
    const now = Math.floor(Date.now() / 1000);
    const withinGrace = await generateToken(USER_ID, JWT_SECRET, SESSION_ID, {
      now: now - config.auth.tokenExpirationSeconds - 60
    });
    const tooOld = await generateToken(USER_ID, JWT_SECRET, SESSION_ID, {
      now: now - config.auth.tokenExpirationSeconds - 301
    });

    await expect(verifyToken(withinGrace, JWT_SECRET)).resolves.toBeNull();
    await expect(verifySignedToken(withinGrace, JWT_SECRET, 300)).resolves.toBeTruthy();
    await expect(verifySignedToken(tooOld, JWT_SECRET, 300)).resolves.toBeNull();

    const accepted = makeEnv(withinGrace);
    expect((await requestRefresh(accepted.env, withinGrace)).status).toBe(200);

    const rejected = makeEnv(tooOld);
    expect((await requestRefresh(rejected.env, tooOld)).status).toBe(401);
    expect(rejected.state.sessionLookups).toBe(0);
  });

  it('rejects malformed signed claims before querying a session', async () => {
    const malformedToken = await generateToken(null, JWT_SECRET, SESSION_ID);
    const { env, state } = makeEnv(malformedToken);

    expect((await requestRefresh(env, malformedToken)).status).toBe(401);
    expect(state.sessionLookups).toBe(0);
  });

  it('rejects a compare-and-swap race instead of issuing two credentials', async () => {
    const token = await generateToken(USER_ID, JWT_SECRET, SESSION_ID);
    const { env, state } = makeEnv(token, { rotationConflict: true });

    expect((await requestRefresh(env, token)).status).toBe(401);
    expect(state.rotations).toBe(1);
  });
});
