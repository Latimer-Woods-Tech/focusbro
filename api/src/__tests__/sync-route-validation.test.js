import { describe, expect, it } from 'vitest';
import worker, { generateToken } from '../index.js';

const JWT_SECRET = 'sync-validation-test-secret';

function makeEnv() {
  const state = { dbWrites: 0, kvWrites: 0 };
  const statement = {
    bind() { return statement; },
    first: async () => ({ user_id: 'sync-user', subscription_tier: 'pro' }),
    all: async () => ({ results: [] }),
    run: async () => {
      state.dbWrites += 1;
      return { success: true };
    },
  };

  return {
    state,
    env: {
      JWT_SECRET,
      DB: { prepare: () => statement },
      KV_CACHE: {
        get: async () => null,
        put: async () => { state.kvWrites += 1; },
      },
    },
  };
}

async function syncRequest(body, headers = {}) {
  const { env, state } = makeEnv();
  const token = await generateToken('sync-user', JWT_SECRET);
  const response = await worker.fetch(new Request('https://focusbro.net/sync/data', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, ...headers },
    body,
  }), env, {});
  return { response, state };
}

function makeRevisionEnv({ replay = null, currentRevision = null } = {}) {
  const state = { dbWrites: 0, kvWrites: 0, kvDeletes: [], statements: [] };
  const db = {
    prepare(sql) {
      state.statements.push(sql);
      const statement = {
        bind() { return statement; },
        first: async () => {
          if (sql.includes('idempotency_key')) return replay;
          if (sql.includes('SELECT id, revision_id')) {
            return currentRevision ? { id: 'snapshot-current', revision_id: currentRevision } : null;
          }
          if (sql.includes('subscription_tier')) return { subscription_tier: 'pro' };
          return { user_id: 'sync-user' }; // active session lookup
        },
        all: async () => ({ results: [] }),
        run: async () => {
          state.dbWrites += 1;
          return { success: true, meta: { changes: 1, last_row_id: 7 } };
        },
      };
      return statement;
    },
  };
  return {
    state,
    env: {
      JWT_SECRET,
      DB: db,
      KV_CACHE: {
        get: async () => null,
        put: async () => { state.kvWrites += 1; },
        delete: async key => { state.kvDeletes.push(key); },
      },
    },
  };
}

async function revisionSyncRequest(body, options = {}) {
  const { env, state } = makeRevisionEnv(options);
  const token = await generateToken('sync-user', JWT_SECRET);
  const response = await worker.fetch(new Request('https://focusbro.net/sync/data', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'retry-1' },
    body: JSON.stringify(body),
  }), env, {});
  return { response, state };
}

describe('sync route input boundary', () => {
  it('rejects malformed JSON without KV or D1 writes', async () => {
    const { response, state } = await syncRequest('{invalid');

    expect(response.status).toBe(400);
    expect(state).toEqual({ dbWrites: 0, kvWrites: 0 });
  });

  it('rejects declared oversized uploads before parsing or persistence', async () => {
    const { response, state } = await syncRequest('{}', { 'Content-Length': String(1024 * 1024 + 1) });

    expect(response.status).toBe(413);
    expect(state).toEqual({ dbWrites: 0, kvWrites: 0 });
  });

  it('rejects unexpected snapshot structures without KV or D1 writes', async () => {
    const { response, state } = await syncRequest(JSON.stringify({ data: [] }));

    expect(response.status).toBe(400);
    expect(state).toEqual({ dbWrites: 0, kvWrites: 0 });
  });

  it('returns an existing revision for an idempotent retry without writing', async () => {
    const { response, state } = await revisionSyncRequest(
      { data: { sessionCount: 1 }, base_revision: 'old-revision' },
      { replay: { id: 'snapshot-1', revision_id: 'rev-1', size_bytes: 18, created_at: '2026-07-26T00:00:00Z' } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ idempotent_replay: true, revision_id: 'rev-1' });
    expect(state.dbWrites).toBe(0);
    expect(state.kvWrites).toBe(0);
  });

  it('refuses a stale base revision without overwriting the current snapshot', async () => {
    const { response, state } = await revisionSyncRequest(
      { data: { sessionCount: 1 }, base_revision: 'old-revision' },
      { currentRevision: 'current-revision' },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'stale_revision', current_revision: 'current-revision' });
    expect(state.dbWrites).toBe(0);
    expect(state.kvWrites).toBe(0);
  });

  it('stores a new snapshot with size_bytes and returns its revision', async () => {
    const { response, state } = await revisionSyncRequest({ data: { sessionCount: 1 }, base_revision: null });

    expect(response.status).toBe(200);
    expect((await response.json()).revision_id).toEqual(expect.any(String));
    expect(state.kvWrites).toBe(2); // quota counter plus latest snapshot cache
    expect(state.statements.some(sql => /size_bytes, revision_id, idempotency_key/.test(sql))).toBe(true);
  });

  it('deletes both the cached and durable synced data on a privacy request', async () => {
    const { env, state } = makeRevisionEnv();
    const token = await generateToken('sync-user', JWT_SECRET);
    const response = await worker.fetch(new Request('https://focusbro.net/privacy/delete', {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    }), env, {});

    expect(response.status).toBe(200);
    expect(state.kvDeletes).toEqual(['user:sync-user:latest', 'sync:upload:sync-user']);
    expect(state.statements.some(sql => /DELETE FROM user_data_snapshots/.test(sql))).toBe(true);
  });
});
