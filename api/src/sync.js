/**
 * Cloud Sync Module
 * Handles multi-device synchronization of FocusBro data
 * Manages conflict resolution, tier validation, and sync state
 */

import { errorResponse, successResponse, generateUUID } from './middleware.js';
import { recordEvent } from './events.js';

// Keep a sync snapshot comfortably below browser storage limits and small enough
// to validate at the edge without turning an upload into an expensive request.
export const MAX_SYNC_PAYLOAD_BYTES = 1024 * 1024;
export const MAX_SYNC_REQUESTS_PER_HOUR = 60;
export const MAX_SYNC_STORAGE_BYTES = 10 * 1024 * 1024;
export const MAX_SYNC_SNAPSHOTS = 30;
const MAX_SYNC_DEPTH = 10;
const MAX_SYNC_NODES = 10_000;
const MAX_SYNC_ROOT_KEYS = 256;
const MAX_SYNC_ARRAY_ITEMS = 2_000;
const UNSAFE_SYNC_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Validate a JSON snapshot before it is persisted to D1 or KV.
 */
export function validateSyncSnapshot(snapshot) {
  if (!isPlainObject(snapshot) || Object.keys(snapshot).length === 0) {
    return { ok: false, error: 'Data must be a non-empty object' };
  }

  if (Object.keys(snapshot).length > MAX_SYNC_ROOT_KEYS) {
    return { ok: false, error: 'Data has too many top-level fields' };
  }

  let nodes = 0;
  const visit = (value, depth) => {
    nodes += 1;
    if (nodes > MAX_SYNC_NODES) return 'Data has too many values';
    if (depth > MAX_SYNC_DEPTH) return 'Data is nested too deeply';
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return null;

    if (Array.isArray(value)) {
      if (value.length > MAX_SYNC_ARRAY_ITEMS) return 'Data contains an oversized list';
      for (const item of value) {
        const error = visit(item, depth + 1);
        if (error) return error;
      }
      return null;
    }

    if (!isPlainObject(value)) return 'Data contains an unsupported value';
    for (const [key, item] of Object.entries(value)) {
      if (UNSAFE_SYNC_KEYS.has(key)) return 'Data contains an unsafe field name';
      const error = visit(item, depth + 1);
      if (error) return error;
    }
    return null;
  };

  const error = visit(snapshot, 0);
  return error ? { ok: false, error } : { ok: true };
}

/**
 * Accept the established sync envelope or a direct snapshot without ambiguity.
 */
export function parseSyncPayload(body, headerIdempotencyKey = null) {
  if (!isPlainObject(body)) {
    return { ok: false, error: 'Request body must be an object' };
  }

  const keys = Object.keys(body);
  const isEnvelope = Object.hasOwn(body, 'data') && keys.every(key => (
    key === 'data' || key === 'device_id' || key === 'base_revision' || key === 'idempotency_key'
  ));
  const data = isEnvelope ? body.data : body;
  const deviceId = isEnvelope ? body.device_id : 'web';
  const baseRevision = isEnvelope ? body.base_revision : undefined;
  const bodyIdempotencyKey = isEnvelope ? body.idempotency_key : undefined;

  if (deviceId !== undefined && (typeof deviceId !== 'string' || deviceId.length > 128)) {
    return { ok: false, error: 'device_id must be a string up to 128 characters' };
  }

  if (baseRevision !== undefined && baseRevision !== null && (
    typeof baseRevision !== 'string' || baseRevision.length < 1 || baseRevision.length > 128
  )) {
    return { ok: false, error: 'base_revision must be a string up to 128 characters' };
  }

  if (bodyIdempotencyKey !== undefined && (typeof bodyIdempotencyKey !== 'string' || bodyIdempotencyKey.length < 1 || bodyIdempotencyKey.length > 128)) {
    return { ok: false, error: 'idempotency_key must be a string up to 128 characters' };
  }
  if (headerIdempotencyKey !== null && (headerIdempotencyKey.length < 1 || headerIdempotencyKey.length > 128)) {
    return { ok: false, error: 'Idempotency-Key must be 1 to 128 characters' };
  }
  if (bodyIdempotencyKey && headerIdempotencyKey && bodyIdempotencyKey !== headerIdempotencyKey) {
    return { ok: false, error: 'Idempotency key does not match request header' };
  }

  const validation = validateSyncSnapshot(data);
  return validation.ok
    ? {
      ok: true,
      data,
      deviceId: deviceId || 'web',
      baseRevision: baseRevision ?? null,
      idempotencyKey: headerIdempotencyKey || bodyIdempotencyKey || null,
    }
    : validation;
}

/**
 * Return the current revision for a user's latest snapshot.
 */
export async function getLatestSyncRevision(env, userId) {
  return env.DB.prepare(
    `SELECT id, revision_id
     FROM user_data_snapshots
     WHERE user_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 1`
  ).bind(userId).first();
}

/**
 * Return a completed upload when a client retries its idempotency key.
 */
export async function findIdempotentSync(env, userId, idempotencyKey) {
  if (!idempotencyKey) return null;
  return env.DB.prepare(
    `SELECT id, revision_id, size_bytes, created_at
     FROM user_data_snapshots
     WHERE user_id = ? AND idempotency_key = ?
     LIMIT 1`
  ).bind(userId, idempotencyKey).first();
}

/** Consume one bounded sync upload slot after a request has passed validation. */
export async function consumeSyncUploadQuota(env, userId) {
  const key = `sync:upload:${userId}`;
  const current = Number(await env.KV_CACHE.get(key) || 0);
  if (current >= MAX_SYNC_REQUESTS_PER_HOUR) return { allowed: false };
  await env.KV_CACHE.put(key, String(current + 1), { expirationTtl: 60 * 60 });
  return { allowed: true, remaining: MAX_SYNC_REQUESTS_PER_HOUR - current - 1 };
}

/** Return current snapshot storage usage for a user. */
export async function getSyncStorageUsage(env, userId) {
  return env.DB.prepare(
    'SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM user_data_snapshots WHERE user_id = ?'
  ).bind(userId).first();
}

/** Retain recent recovery points while preventing unbounded snapshot growth. */
export async function pruneSyncSnapshots(env, userId) {
  return env.DB.prepare(
    `DELETE FROM user_data_snapshots
     WHERE user_id = ? AND id NOT IN (
       SELECT id FROM user_data_snapshots
       WHERE user_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?
     )`
  ).bind(userId, userId, MAX_SYNC_SNAPSHOTS).run();
}

// ════════════════════════════════════════════════════════════
// SUBSCRIPTION TIER VALIDATION
// ════════════════════════════════════════════════════════════

/**
 * Check if user has cloud sync access (Pro tier or higher)
 */
export async function checkSyncAccess(env, userId) {
  try {
    const user = await env.DB.prepare(
      'SELECT subscription_tier FROM users WHERE id = ?'
    ).bind(userId).first();

    if (!user) {
      return { hasAccess: false, tier: null, reason: 'User not found' };
    }

    // Pro tier and higher get cloud sync access
    const syncTiers = ['pro', 'premium', 'enterprise'];
    const hasAccess = syncTiers.includes(user.subscription_tier);

    return {
      hasAccess,
      tier: user.subscription_tier,
      reason: hasAccess ? null : `Current tier "${user.subscription_tier}" does not include cloud sync`
    };
  } catch (error) {
    console.error('[SYNC] Error checking tier:', error.message);
    return { hasAccess: false, tier: null, reason: 'Failed to verify subscription' };
  }
}

/**
 * Verify user can perform sync operations
 * Returns 403 if tier check fails
 */
export async function validateSyncTier(env, userId) {
  const accessCheck = await checkSyncAccess(env, userId);
  if (!accessCheck.hasAccess) {
    return {
      error: true,
      response: new Response(
        JSON.stringify({
          error: 'Cloud sync requires Pro subscription',
          upgrade_url: '/upgrade',
          reason: accessCheck.reason
        }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        }
      )
    };
  }
  return { error: false };
}

// ════════════════════════════════════════════════════════════
// CONFLICT RESOLUTION
// ════════════════════════════════════════════════════════════

/**
 * Resolve conflicts between local and remote data
 * Strategy: Last-write-wins (LWW) with fallback to manual merge if timestamps are identical
 */
export function resolveConflict(local, remote, localTimestamp, remoteTimestamp) {
  // Last-write-wins: newer timestamp takes precedence
  if (remoteTimestamp > localTimestamp) {
    return { data: remote, source: 'remote', resolved: true };
  }

  if (localTimestamp > remoteTimestamp) {
    return { data: local, source: 'local', resolved: true };
  }

  // Timestamps are equal - need manual intervention or smart merge
  // For now, prefer remote (server is source of truth during sync)
  return { data: remote, source: 'remote', resolved: false, needsReview: true };
}

/**
 * Smart merge for focus session data
 * Merges session arrays without duplicates
 */
export function mergeSessionData(localSessions, remoteSessions) {
  const sessionMap = new Map();

  // Add remote sessions first (treating server as source of truth)
  remoteSessions.forEach(session => {
    const key = `${session.tool}:${session.timestamp}`;
    sessionMap.set(key, { ...session, synced: true });
  });

  // Add local sessions that don't exist on server
  localSessions.forEach(session => {
    const key = `${session.tool}:${session.timestamp}`;
    if (!sessionMap.has(key)) {
      sessionMap.set(key, { ...session, synced: false });
    }
  });

  return Array.from(sessionMap.values());
}

/**
 * Deep merge for settings/preferences
 * Preserves local preferences unless explicitly overwritten by newer remote values
 */
export function mergeSettings(local = {}, remote = {}, remoteTimestamp = 0) {
  const merged = { ...local };

  for (const [key, remoteValue] of Object.entries(remote)) {
    if (
      !merged[key] ||
      (remoteValue && remoteValue.lastModified && remoteValue.lastModified > (merged[key].lastModified || 0))
    ) {
      merged[key] = remoteValue;
    }
  }

  return merged;
}

// ════════════════════════════════════════════════════════════
// SYNC STATE MANAGEMENT
// ════════════════════════════════════════════════════════════

/**
 * Get the last sync timestamp for a user to detect changes
 */
export async function getLastSyncTimestamp(env, userId) {
  try {
    const result = await env.DB.prepare(
      `SELECT synced_at FROM sync_logs 
       WHERE user_id = ? AND status = 'success'
       ORDER BY synced_at DESC 
       LIMIT 1`
    ).bind(userId).first();

    if (!result) {
      return null; // No previous syncs
    }

    return new Date(result.synced_at).getTime();
  } catch (error) {
    console.error('[SYNC] Error getting last sync time:', error.message);
    return null;
  }
}

/**
 * Record a sync operation in logs
 */
export async function recordSync(env, userId, deviceId, action, status, sizeBytes = 0, metadata = {}) {
  try {
    await env.DB.prepare(
      `INSERT INTO sync_logs (user_id, device_id, action, status, synced_at, data_size)
       VALUES (?, ?, ?, ?, datetime('now'), ?)`
    ).bind(userId, deviceId || 'web', action, status, sizeBytes).run();

    // Log to audit trail
    await env.DB.prepare(
      `INSERT INTO audit_logs (user_id, action, status)
       VALUES (?, ?, ?)`
    ).bind(userId, `sync:${action}:${status}`, status).run();

    return true;
  } catch (error) {
    console.error('[SYNC] Error recording sync:', error.message);
    return false;
  }
}

// ════════════════════════════════════════════════════════════
// MULTI-DEVICE COORDINATION
// ════════════════════════════════════════════════════════════

/**
 * Register device for multi-device sync
 * Returns a device token for future syncs
 */
export async function registerDevice(env, userId, deviceInfo) {
  try {
    const deviceId = deviceInfo.id || crypto.randomUUID?.() || generateUUID();
    const deviceName = deviceInfo.name || 'Unknown Device';

    const query = `
      INSERT INTO devices (user_id, device_id, device_name, last_activity)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(device_id) DO UPDATE SET last_activity = datetime('now')
    `;

    await env.DB.prepare(query).bind(userId, deviceId, deviceName).run();

    return {
      device_id: deviceId,
      device_name: deviceName,
      registered_at: new Date().toISOString()
    };
  } catch (error) {
    console.error('[SYNC] Error registering device:', error.message);
    throw error;
  }
}

/**
 * Get all devices for a user
 */
export async function getUserDevices(env, userId) {
  try {
    const devices = await env.DB.prepare(
      `SELECT device_id, device_name, last_activity 
       FROM devices 
       WHERE user_id = ? AND is_active = 1
       ORDER BY last_activity DESC`
    ).bind(userId).all();

    return devices.results || [];
  } catch (error) {
    console.error('[SYNC] Error fetching devices:', error.message);
    return [];
  }
}

/**
 * Mark device as inactive during logout or unlink
 */
export async function deactivateDevice(env, userId, deviceId) {
  try {
    await env.DB.prepare(
      'UPDATE devices SET is_active = 0 WHERE user_id = ? AND device_id = ?'
    ).bind(userId, deviceId).run();

    await recordSync(env, userId, deviceId, 'device_deactivate', 'success');
    return true;
  } catch (error) {
    console.error('[SYNC] Error deactivating device:', error.message);
    return false;
  }
}

// ════════════════════════════════════════════════════════════
// DATA VERSIONING & HISTORY
// ════════════════════════════════════════════════════════════

/**
 * Get version history for user data
 * Returns array of snapshots (limited to avoid large responses)
 */
export async function getDataHistory(env, userId, limit = 10) {
  try {
    const snapshots = await env.DB.prepare(
      `SELECT id, size_bytes, revision_id, created_at
       FROM user_data_snapshots 
       WHERE user_id = ? 
       ORDER BY created_at DESC 
       LIMIT ?`
    ).bind(userId, limit).all();

    return snapshots.results || [];
  } catch (error) {
    console.error('[SYNC] Error fetching history:', error.message);
    return [];
  }
}

/**
 * Restore data from a previous snapshot
 * Creates a new snapshot of the restoration action
 */
export async function restoreFromSnapshot(env, userId, snapshotId) {
  try {
    // Get the snapshot to restore
    const snapshot = await env.DB.prepare(
      'SELECT snapshot_data FROM user_data_snapshots WHERE id = ? AND user_id = ?'
    ).bind(snapshotId, userId).first();

    if (!snapshot) {
      return { error: 'Snapshot not found' };
    }

    const data = JSON.parse(snapshot.snapshot_data);

    // Create a new snapshot that marks this as a restore
    const restoreData = {
      ...data,
      restored_from: snapshotId,
      restored_at: new Date().toISOString()
    };

    const dataString = JSON.stringify(restoreData);
    await env.DB.prepare(
      `INSERT INTO user_data_snapshots (user_id, snapshot_data, size_bytes, revision_id, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    ).bind(userId, dataString, dataString.length, generateUUID()).run();

    await recordSync(env, userId, 'web', 'data_restore', 'success', dataString.length);

    return { success: true, data: restoreData };
  } catch (error) {
    console.error('[SYNC] Error restoring snapshot:', error.message);
    return { error: 'Failed to restore snapshot', detail: error.message };
  }
}

// ════════════════════════════════════════════════════════════
// ANALYTICS EVENT SYNCING
// ════════════════════════════════════════════════════════════

/** Cap a single ingest batch so one request can't flood the spine. */
const MAX_EVENTS_PER_BATCH = 100;

/**
 * Ingest a batch of client-reported analytics events into the first-party
 * retention spine (`analytics_events`). This is the LIVE, authed ingest the
 * free-tier timer bridge posts `session_complete` to (Contender #10, R-239
 * follow-up) — the earlier attempt wired the bridge to a never-mounted route,
 * so it was inert; this route is reachable at `POST /sync/events`.
 *
 * Every event is written through `recordEvent` (the single first-party writer,
 * events.js) so three properties hold uniformly:
 *  - the CLIENT timestamp (`at` / `timestamp` / `ts`) lands the row on the real
 *    day the session happened, not the sync day (batched/offline sessions would
 *    otherwise collapse a week of usage onto one day and undercount return);
 *  - a client-generated event id (`id` / `cid`) makes the write idempotent —
 *    dedup in-batch here plus `INSERT OR IGNORE` at the DB, so an offline retry
 *    or a double-flush can't double-count;
 *  - it's non-fatal (recordEvent swallows its own errors), so a malformed event
 *    can never break the timer or the rest of the batch.
 *
 * Only `type` is required. A `tool` (e.g. `pomodoro`) is carried through in the
 * event data when present but is no longer mandatory — the canonical
 * `session_complete` event always has one, but requiring it here is what silently
 * dropped valid events before.
 *
 * @returns {Promise<object>} { success, synced } (synced = events accepted this
 *   batch; a deduped replay is idempotent, not an error)
 */
export async function syncAnalyticsEvents(env, userId, events) {
  try {
    if (!Array.isArray(events) || events.length === 0) {
      return { success: true, synced: 0 };
    }

    const batch = events.slice(0, MAX_EVENTS_PER_BATCH);
    const seenClientIds = new Set();
    let synced = 0;

    for (const event of batch) {
      if (!event || !event.type) continue; // must at least name an event type

      const clientEventId = event.id || event.cid || null;
      if (clientEventId) {
        if (seenClientIds.has(clientEventId)) continue; // in-batch dedup
        seenClientIds.add(clientEventId);
      }

      const at = event.at || event.timestamp || event.ts || null;

      // Store the meaningful payload (tool, duration, etc.), not the transport
      // envelope — id/at/timestamp/ts/type are columns or control fields, so
      // strip them (underscore-prefixed to mark them deliberately unused).
      const { id: _id, cid: _cid, at: _at, ts: _ts, timestamp: _timestamp, type: _type, ...data } = event;

      const wrote = await recordEvent(env, {
        userId,
        type: event.type,
        data,
        at,
        clientEventId,
      });
      if (wrote) synced++;
    }

    await recordSync(env, userId, 'web', 'analytics_sync', synced > 0 ? 'success' : 'partial', 0, {
      events_synced: synced,
      events_total: batch.length
    });

    return { success: true, synced };
  } catch (error) {
    console.error('[SYNC] Error syncing analytics:', error.message);
    return { error: 'Failed to sync analytics', detail: error.message };
  }
}

// ════════════════════════════════════════════════════════════
// BANDWIDTH OPTIMIZATION
// ════════════════════════════════════════════════════════════

/**
 * Compress sync payload if large
 * Returns { data, compressed: boolean }
 */
export function optimizePayload(data) {
  const jsonString = JSON.stringify(data);
  const sizeBytes = jsonString.length;

  // If > 50KB, recommend compression
  if (sizeBytes > 50 * 1024) {
    // In production, use brotli or gzip compression
    // For now, just return flag indicating compression would help
    return {
      data,
      sizeBytes,
      compression_recommended: true
    };
  }

  return {
    data,
    sizeBytes,
    compression_recommended: false
  };
}

/**
 * Deduplicate session data before sync
 * Removes duplicate focus sessions by timestamp and tool
 */
export function deduplicateSessions(sessions) {
  if (!Array.isArray(sessions)) return [];

  const seen = new Set();
  const deduplicated = [];

  for (const session of sessions) {
    const key = `${session.tool}:${session.timestamp}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduplicated.push(session);
    }
  }

  return deduplicated;
}

// ════════════════════════════════════════════════════════════
// OFFLINE SUPPORT
// ════════════════════════════════════════════════════════════

/**
 * Mark events/data for offline queue
 * Client stores locally when offline, syncs when reconnected
 */
export function createOfflineMarker() {
  return {
    offline_queued: true,
    queued_at: new Date().toISOString()
  };
}

/**
 * Process offline queue on reconnect
 * Merges offline changes with any remote changes
 */
export async function processSyncQueue(env, userId, queuedEvents) {
  try {
    // Get current remote state
    const latestSnapshot = await env.DB.prepare(
      `SELECT snapshot_data FROM user_data_snapshots 
       WHERE user_id = ? 
       ORDER BY created_at DESC 
       LIMIT 1`
    ).bind(userId).first();

    const remoteData = latestSnapshot ? JSON.parse(latestSnapshot.snapshot_data) : {};

    // Merge queued events with remote
    const mergedData = mergeSettings(remoteData, queuedEvents);

    // Save merged state
    const mergedString = JSON.stringify(mergedData);
    await env.DB.prepare(
      `INSERT INTO user_data_snapshots (user_id, snapshot_data, size_bytes, revision_id, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    ).bind(userId, mergedString, mergedString.length, generateUUID()).run();

    await recordSync(env, userId, 'web', 'offline_queue_process', 'success', mergedString.length);

    return { success: true, data: mergedData };
  } catch (error) {
    console.error('[SYNC] Error processing offline queue:', error.message);
    return { error: 'Failed to process offline queue', detail: error.message };
  }
}

export default {
  MAX_SYNC_PAYLOAD_BYTES,
  validateSyncSnapshot,
  parseSyncPayload,
  getLatestSyncRevision,
  findIdempotentSync,
  consumeSyncUploadQuota,
  getSyncStorageUsage,
  pruneSyncSnapshots,
  checkSyncAccess,
  validateSyncTier,
  resolveConflict,
  mergeSessionData,
  mergeSettings,
  getLastSyncTimestamp,
  recordSync,
  registerDevice,
  getUserDevices,
  deactivateDevice,
  getDataHistory,
  restoreFromSnapshot,
  syncAnalyticsEvents,
  optimizePayload,
  deduplicateSessions,
  createOfflineMarker,
  processSyncQueue
};
