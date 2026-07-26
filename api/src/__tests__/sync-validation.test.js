import { describe, expect, it } from 'vitest';
import {
  MAX_SYNC_REQUESTS_PER_HOUR,
  consumeSyncUploadQuota,
  parseSyncPayload,
  validateSyncSnapshot,
} from '../sync.js';

describe('sync snapshot validation', () => {
  it('accepts a direct JSON snapshot and the supported envelope', () => {
    expect(parseSyncPayload({ sessionCount: 4, settings: { pomodoro: 25 } })).toMatchObject({
      ok: true,
      deviceId: 'web',
    });
    expect(parseSyncPayload({ data: { energyLogs: [] }, device_id: 'phone' })).toMatchObject({
      ok: true,
      deviceId: 'phone',
    });
    expect(parseSyncPayload(
      { data: { energyLogs: [] }, base_revision: 'rev-1', idempotency_key: 'retry-1' },
      'retry-1',
    )).toMatchObject({ ok: true, baseRevision: 'rev-1', idempotencyKey: 'retry-1' });
  });

  it('rejects malformed snapshot shapes before persistence', () => {
    expect(parseSyncPayload(null)).toMatchObject({ ok: false });
    expect(parseSyncPayload({ data: [] })).toMatchObject({ ok: false });
    expect(parseSyncPayload({ data: {}, device_id: 'phone' })).toMatchObject({ ok: false });
    expect(parseSyncPayload({ data: { sessionCount: 1 }, device_id: 4 })).toMatchObject({ ok: false });
    expect(parseSyncPayload({ data: { sessionCount: 1 }, idempotency_key: 'body' }, 'header')).toMatchObject({ ok: false });
  });

  it('rejects unsafe keys and excessive nesting', () => {
    expect(validateSyncSnapshot(JSON.parse('{"__proto__":{"polluted":true}}'))).toMatchObject({ ok: false });

    let nested = { value: true };
    for (let depth = 0; depth < 11; depth += 1) nested = { nested };
    expect(validateSyncSnapshot(nested)).toMatchObject({ ok: false });
  });

  it('bounds validated uploads per user without sharing quota between users', async () => {
    const values = new Map();
    const env = { KV_CACHE: {
      get: async key => values.get(key) || null,
      put: async (key, value) => values.set(key, value),
    } };
    values.set('sync:upload:user-a', String(MAX_SYNC_REQUESTS_PER_HOUR));

    await expect(consumeSyncUploadQuota(env, 'user-a')).resolves.toEqual({ allowed: false });
    await expect(consumeSyncUploadQuota(env, 'user-b')).resolves.toMatchObject({ allowed: true });
  });
});
