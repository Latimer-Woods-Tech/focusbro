/**
 * Cloud Sync Module
 * Handles multi-device synchronization of FocusBro data
 * Manages conflict resolution, tier validation, and sync state
 */

import { errorResponse, successResponse, generateUUID } from './middleware.js';

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
      `SELECT id, snapshot_size, created_at 
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
      `INSERT INTO user_data_snapshots (user_id, snapshot_data, snapshot_size, created_at)
       VALUES (?, ?, ?, datetime('now'))`
    ).bind(userId, dataString, dataString.length).run();

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

/**
 * Save analytics events (session data, ambient preferences, etc.)
 * Events are batched and synced periodically or on demand
 */
export async function syncAnalyticsEvents(env, userId, events) {
  try {
    if (!Array.isArray(events) || events.length === 0) {
      return { success: true, synced: 0 };
    }

    // Insert events into analytics table
    const insertQuery = `
      INSERT INTO analytics_events (user_id, event_type, event_data, created_at)
      VALUES (?, ?, ?, datetime('now'))
    `;

    let synced = 0;
    for (const event of events) {
      if (!event.type || !event.tool) continue; // Skip invalid events

      try {
        await env.DB.prepare(insertQuery)
          .bind(userId, event.type, JSON.stringify(event))
          .run();
        synced++;
      } catch (eventError) {
        console.warn(`[SYNC] Failed to insert event ${event.type}:`, eventError.message);
      }
    }

    await recordSync(env, userId, 'web', 'analytics_sync', synced > 0 ? 'success' : 'partial', 0, {
      events_synced: synced,
      events_total: events.length
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
      `INSERT INTO user_data_snapshots (user_id, snapshot_data, snapshot_size, created_at)
       VALUES (?, ?, ?, datetime('now'))`
    ).bind(userId, mergedString, mergedString.length).run();

    await recordSync(env, userId, 'web', 'offline_queue_process', 'success', mergedString.length);

    return { success: true, data: mergedData };
  } catch (error) {
    console.error('[SYNC] Error processing offline queue:', error.message);
    return { error: 'Failed to process offline queue', detail: error.message };
  }
}

export default {
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
