import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import worker from '../index.js';

const workerSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const entrypointSource = workerSource.slice(workerSource.indexOf('export default'));

function makeEnv() {
  return {
    KV_CACHE: { get: async () => null, put: async () => {} },
    DB: {
      prepare() {
        throw new Error('health must not access D1');
      },
    },
  };
}

describe('migrated D1 runtime boundary', () => {
  it('keeps CREATE, ALTER, and index DDL out of request and cron handlers', () => {
    expect(entrypointSource).not.toMatch(/\b(?:CREATE|ALTER)\s+(?:TABLE|INDEX)\b/i);
  });

  it('serves a cold health request without touching D1 and reports the schema version', async () => {
    const response = await worker.fetch(new Request('https://focusbro.net/health'), makeEnv(), {});
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ schema_version: '0005_sync_revisions' });
  });
});
