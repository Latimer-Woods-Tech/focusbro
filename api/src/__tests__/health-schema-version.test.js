/**
 * FocusBro — /health tells the truth about the schema.
 *
 * D1_SCHEMA_VERSION was a hand-typed constant: it read 0006 while migration
 * 0007 was live, so /health reported a schema the database no longer had.
 * Now the constant is pinned to the newest migration FILE (this test), and
 * /health also reads the newest APPLIED migration from d1_migrations and says
 * whether the two agree. FAILS on the tree with the stale constant.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import worker, { D1_SCHEMA_VERSION } from '../index.js';
import { CRON_HEALTH_KEYS, recordCronHealth, readCronHealth } from '../checkins-cron.js';

const newestMigrationFile = () => readdirSync(fileURLToPath(new URL('../../../migrations', import.meta.url)))
  .filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort().pop().replace(/\.sql$/, '');

describe('/health schema version', () => {
  it('the expected version is the newest migration file — it cannot drift again', () => {
    expect(D1_SCHEMA_VERSION).toBe(newestMigrationFile());
  });

  it('reports the applied version the cron stashed in KV — never touching D1 — and whether it is in step', async () => {
    const env = (applied) => ({
      BUILD_SHA: 'abc',
      KV_CACHE: { get: async (k) => (k === CRON_HEALTH_KEYS.schemaApplied ? applied : null), put: async () => {} },
      DB: { prepare() { throw new Error('health must not access D1'); } },
    });
    const ok = await (await worker.fetch(new Request('https://focusbro.net/health'), env(D1_SCHEMA_VERSION + '.sql'), {})).json();
    expect(ok).toMatchObject({ schema_version: D1_SCHEMA_VERSION, schema_applied: D1_SCHEMA_VERSION, schema_in_step: true });
    const behind = await (await worker.fetch(new Request('https://focusbro.net/health'), env('0006_sync_device_log_schema.sql'), {})).json();
    expect(behind).toMatchObject({ schema_applied: '0006_sync_device_log_schema', schema_in_step: false });
    const unknown = await (await worker.fetch(new Request('https://focusbro.net/health'), env(null), {})).json();
    expect(unknown).toMatchObject({ schema_applied: null, schema_in_step: null });
  });

  it('the cron tick records the applied version, and the reader returns it', async () => {
    const store = {};
    const env = { KV_CACHE: { get: async (k) => store[k] ?? null, put: async (k, v) => { store[k] = v; } } };
    await recordCronHealth(env, { nowISO: '2026-09-04T20:00:00.000Z', delivery: {}, escalation: {}, schemaApplied: '0007_guest_accounts.sql' });
    expect(store[CRON_HEALTH_KEYS.schemaApplied]).toBe('0007_guest_accounts.sql');
    const health = await readCronHealth(env, { nowMs: Date.parse('2026-09-04T20:00:30.000Z'), staleSeconds: 600 });
    expect(health.schema_applied).toBe('0007_guest_accounts.sql');
    // and a tick that could not read it leaves the previous value alone
    await recordCronHealth(env, { nowISO: '2026-09-04T20:01:00.000Z', delivery: {}, escalation: {}, schemaApplied: null });
    expect(store[CRON_HEALTH_KEYS.schemaApplied]).toBe('0007_guest_accounts.sql');
  });
});
