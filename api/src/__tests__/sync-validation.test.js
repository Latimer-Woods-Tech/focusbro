import { describe, expect, it } from 'vitest';
import {
  checkSyncAccess,
  MAX_SYNC_REQUESTS_PER_HOUR,
  consumeSyncUploadQuota,
  deduplicateSessions,
  deactivateDevice,
  findIdempotentSync,
  getDataHistory,
  getLatestSyncRevision,
  getLastSyncTimestamp,
  getSyncStorageUsage,
  getUserDevices,
  mergeSessionData,
  mergeSettings,
  optimizePayload,
  parseSyncPayload,
  pruneSyncSnapshots,
  processSyncQueue,
  recordSync,
  registerDevice,
  restoreFromSnapshot,
  resolveConflict,
  validateSyncSnapshot,
  validateSyncTier,
} from '../sync.js';

function fakeDb({ first = async () => null, all = async () => ({ results: [] }), run = async () => ({ success: true }) } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      let values = [];
      const statement = {
        bind(...params) { values = params; return statement; },
        first: async () => { calls.push({ sql, values }); return first(sql, values); },
        all: async () => { calls.push({ sql, values }); return all(sql, values); },
        run: async () => { calls.push({ sql, values }); return run(sql, values); },
      };
      return statement;
    },
  };
}

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

  it('exposes tier decisions without granting access on a missing, free, or failed lookup', async () => {
    const pro = fakeDb({ first: async () => ({ subscription_tier: 'pro' }) });
    await expect(checkSyncAccess({ DB: pro }, 'u1')).resolves.toMatchObject({ hasAccess: true, tier: 'pro' });

    const free = fakeDb({ first: async () => ({ subscription_tier: 'free' }) });
    await expect(checkSyncAccess({ DB: free }, 'u1')).resolves.toMatchObject({ hasAccess: false, tier: 'free' });
    const rejection = await validateSyncTier({ DB: free }, 'u1');
    expect(rejection.error).toBe(true);
    expect(rejection.response.status).toBe(403);

    const missing = fakeDb({ first: async () => null });
    await expect(checkSyncAccess({ DB: missing }, 'u1')).resolves.toMatchObject({ hasAccess: false, reason: 'User not found' });
  });

  it('queries revision, idempotency, storage, and pruning with user-scoped statements', async () => {
    const db = fakeDb({ first: async (sql) => {
      if (sql.includes('idempotency_key')) return { id: 'snap-1', revision_id: 'rev-1' };
      if (sql.includes('SUM(size_bytes)')) return { bytes: 123 };
      return { id: 'latest', revision_id: 'rev-2' };
    } });
    const env = { DB: db };
    await expect(getLatestSyncRevision(env, 'u1')).resolves.toMatchObject({ revision_id: 'rev-2' });
    await expect(findIdempotentSync(env, 'u1', null)).resolves.toBeNull();
    await expect(findIdempotentSync(env, 'u1', 'retry-1')).resolves.toMatchObject({ id: 'snap-1' });
    await expect(getSyncStorageUsage(env, 'u1')).resolves.toEqual({ bytes: 123 });
    await pruneSyncSnapshots(env, 'u1');
    expect(db.calls.some(call => call.sql.includes('DELETE FROM user_data_snapshots'))).toBe(true);
    expect(db.calls.find(call => call.sql.includes('DELETE FROM user_data_snapshots')).values).toEqual(['u1', 'u1', 30]);
  });

  it('uses deterministic conflict, merge, session, and payload helper behavior', () => {
    expect(resolveConflict({ local: true }, { remote: true }, 3, 4)).toMatchObject({ source: 'remote', resolved: true });
    expect(resolveConflict({ local: true }, { remote: true }, 4, 3)).toMatchObject({ source: 'local', resolved: true });
    expect(resolveConflict({}, { remote: true }, 4, 4)).toMatchObject({ source: 'remote', needsReview: true });
    expect(mergeSessionData([{ tool: 'p', timestamp: '1' }], [{ tool: 'p', timestamp: '1' }, { tool: 'p', timestamp: '2' }]))
      .toHaveLength(2);
    expect(mergeSettings({ theme: { lastModified: 2, value: 'dark' } }, { theme: { lastModified: 1, value: 'light' } }))
      .toMatchObject({ theme: { value: 'dark' } });
    expect(deduplicateSessions([{ tool: 'p', timestamp: '1' }, { tool: 'p', timestamp: '1' }])).toHaveLength(1);
    expect(deduplicateSessions(null)).toEqual([]);
    expect(optimizePayload({ value: 'x' }).compression_recommended).toBe(false);
    expect(optimizePayload({ value: 'x'.repeat(60 * 1024) }).compression_recommended).toBe(true);
  });

  it('returns empty-safe timestamp and device results on no rows or database failure', async () => {
    const noRows = fakeDb({ first: async () => null, all: async () => ({ results: [] }) });
    await expect(getLastSyncTimestamp({ DB: noRows }, 'u1')).resolves.toBeNull();
    await expect(getUserDevices({ DB: noRows }, 'u1')).resolves.toEqual([]);
    const known = fakeDb({ first: async () => ({ synced_at: '2026-07-01T00:00:00Z' }) });
    await expect(getLastSyncTimestamp({ DB: known }, 'u1')).resolves.toBe(Date.parse('2026-07-01T00:00:00Z'));
  });

  it('records sync audit rows and keeps device registration scoped to the user', async () => {
    const db = fakeDb();
    await expect(recordSync({ DB: db }, 'u1', 'phone', 'data_upload', 'success', 42)).resolves.toBe(true);
    await expect(registerDevice({ DB: db }, 'u1', { id: 'phone', name: 'My Phone' })).resolves.toMatchObject({
      device_id: 'phone', device_name: 'My Phone',
    });
    expect(db.calls.filter(call => call.sql.includes('INSERT INTO sync_logs'))[0].values)
      .toEqual(['u1', 'phone', 'data_upload', 'success', 42]);
    expect(db.calls.some(call => call.sql.includes('INSERT INTO audit_logs'))).toBe(true);
    expect(db.calls.find(call => call.sql.includes('INSERT INTO devices')).values)
      .toEqual(['u1', 'phone', 'My Phone']);
  });

  it('returns safe failures for unavailable sync lifecycle writes', async () => {
    const unavailable = { DB: { prepare: () => { throw new Error('D1 unavailable'); } } };
    await expect(recordSync(unavailable, 'u1', 'web', 'data_upload', 'success')).resolves.toBe(false);
    await expect(deactivateDevice(unavailable, 'u1', 'phone')).resolves.toBe(false);
    await expect(getDataHistory(unavailable, 'u1')).resolves.toEqual([]);
  });

  it('deactivates devices and returns bounded data history', async () => {
    const db = fakeDb({ all: async () => ({ results: [{ id: 'snapshot-1', revision_id: 'rev-1' }] }) });
    await expect(deactivateDevice({ DB: db }, 'u1', 'phone')).resolves.toBe(true);
    await expect(getDataHistory({ DB: db }, 'u1', 5)).resolves.toEqual([{ id: 'snapshot-1', revision_id: 'rev-1' }]);
    expect(db.calls.find(call => call.sql.includes('UPDATE devices')).values).toEqual(['u1', 'phone']);
    expect(db.calls.find(call => call.sql.includes('LIMIT ?')).values).toEqual(['u1', 5]);
  });

  it('restores snapshots and merges offline queue state into a new revision', async () => {
    const restoreDb = fakeDb({ first: async () => ({ snapshot_data: JSON.stringify({ theme: 'dark' }) }) });
    const restored = await restoreFromSnapshot({ DB: restoreDb }, 'u1', 'snapshot-1');
    expect(restored).toMatchObject({ success: true, data: { theme: 'dark', restored_from: 'snapshot-1' } });
    expect(restoreDb.calls.some(call => call.sql.includes('INSERT INTO user_data_snapshots'))).toBe(true);

    const queueDb = fakeDb({ first: async () => ({ snapshot_data: JSON.stringify({ theme: { value: 'dark', lastModified: 2 } }) }) });
    const queued = await processSyncQueue({ DB: queueDb }, 'u1', { theme: { value: 'light', lastModified: 3 } });
    expect(queued).toEqual({ success: true, data: { theme: { value: 'light', lastModified: 3 } } });
    expect(queueDb.calls.find(call => call.sql.includes('INSERT INTO sync_logs')).values)
      .toContain('offline_queue_process');
  });

  it('reports missing or invalid snapshots and offline queue persistence failures', async () => {
    const missing = fakeDb({ first: async () => null });
    await expect(restoreFromSnapshot({ DB: missing }, 'u1', 'missing')).resolves.toEqual({ error: 'Snapshot not found' });
    const unavailable = { DB: { prepare: () => { throw new Error('D1 unavailable'); } } };
    await expect(processSyncQueue(unavailable, 'u1', {})).resolves.toMatchObject({ error: 'Failed to process offline queue' });
  });
});
