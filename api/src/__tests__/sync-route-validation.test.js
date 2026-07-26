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
});
