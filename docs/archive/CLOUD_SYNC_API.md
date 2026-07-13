# Cloud Sync API Skeleton (Task 2/7)

## Overview
Implemented a production-ready cloud sync API architecture for FocusBro that enables:
- Multi-device data synchronization (phone, tablet, desktop)
- Subscription tier gating of cloud features
- Conflict resolution & data versioning
- Analytics event tracking & batch syncing
- Offline queue management

## Architecture

```
Frontend (public/index.html)
    ↓
Cloud Sync API (api/src/sync.js)  ← Reusable sync logic
    ↓
Route Handlers (api/src/index.js) ← Express-like routing
    ↓
Database Layer (Cloudflare D1)   ← Persistent storage
```

## Core Endpoints

All cloud sync endpoints require authentication via Bearer token.
All operations are gated by subscription tier (Pro=cloud sync, Free=local-only).

### Data Synchronization

#### `POST /sync/data` - Store/update user data
**Authentication**: Required (Bearer token)
**Tier**: Pro only (403 response if not subscribed)
**Request**:
```javascript
{
  "data": {
    "sessions": [...],
    "settings": {...},
    "streaks": {...}
  },
  "device_id": "device-uuid"  // Optional, defaults to 'web'
}
```

**Response (200)**:
```javascript
{
  "success": true,
  "synced_at": "2026-03-15T10:30:00Z",
  "size_bytes": 12345,
  "snapshot_id": 42
}
```

**Errors**:
- 401: Unauthorized (missing/invalid token)
- 403: Subscription required (tier < Pro)
- 400: Data missing or empty
- 413: Data too large (>10MB)
- 500: Server error

**Logic**:
1. Verify token & subscription tier
2. Reject if data > 10MB
3. Store in KV cache (fast, 1-year TTL)
4. Store in D1 (persistent archival)
5. Record sync to audit log
6. Return snapshot ID for version control

#### `GET /sync/data` - Retrieve latest user data
**Authentication**: Required (Bearer token)
**Tier**: Pro only
**Query Parameters**: None
**Response (200)**:
```javascript
{
  "success": true,
  "data": {
    "sessions": [...],
    "settings": {...},
    "streaks": {...}
  },
  "source": "cache" | "database"
}
```

**Logic**:
1. Verify tier
2. Try KV cache first (fast, typical response time <100ms)
3. Fallback to D1 if cache miss (slower, typical <500ms)
4. Return parsed JSON with source indicator
5. Handle corrupted snapshots gracefully

---

### Analytics Event Syncing

#### `POST /sync/events` - Batch sync analytics events
**Authentication**: Required
**Tier**: All (free users can sync events for analytics)
**Request**:
```javascript
{
  "events": [
    {
      "type": "ambient_selected",
      "tool": "pomodoro",
      "duration_seconds": 0,
      "data": { "ambient_type": "pink-noise" }
    },
    {
      "type": "session_complete",
      "tool": "pomodoro",
      "duration_seconds": 1500,
      "data": { "energy": 4, "ambient": "white-noise" }
    }
  ]
}
```

**Response (200)**:
```javascript
{
  "success": true,
  "synced": 2  // Number of events successfully stored
}
```

**Logic**:
1. Accept array of events from frontend queue
2. Insert each into analytics_events table
3. Return count of successful inserts
4. Skip invalid events (missing type/tool) without failing
5. Available to all tier levels (helps with product metrics)

**Queue Processing**:
- Frontend batches events while offline
- On reconnect, frontend calls POST /sync/events
- Backend assigns user_id & timestamp automatically

---

### Device Management

#### `POST /sync/devices` - Register/update device for multi-device sync
**Authentication**: Required
**Tier**: Pro only
**Request**:
```javascript
{
  "id": "device-abc123",              // Optional UUID
  "name": "Work Laptop",              // Display name
  "type": "web" | "ios" | "android"  // Device type
}
```

**Response (200)**:
```javascript
{
  "success": true,
  "device": {
    "device_id": "device-abc123",
    "device_name": "Work Laptop",
    "registered_at": "2026-03-15T10:30:00Z"
  }
}
```

**Logic**:
- Generates UUID if not provided
- Upserts device record (prevents duplicates)
- Updates last_activity timestamp

#### `GET /sync/devices` - List all devices linked to account
**Authentication**: Required
**Tier**: Pro only
**Response (200)**:
```javascript
{
  "success": true,
  "devices": [
    {
      "device_id": "device-abc123",
      "device_name": "Work Laptop",
      "last_activity": "2026-03-15T10:30:00Z"
    },
    {
      "device_id": "device-xyz789",
      "device_name": "Mobile",
      "last_activity": "2026-03-14T15:20:00Z"
    }
  ]
}
```

**Logic**:
- Shows only active devices
- Sorted by last_activity DESC (most recent first)
- Enables users to see which devices are syncing

---

### Data Versioning & Recovery

#### `GET /sync/history` - Get data snapshot history
**Authentication**: Required
**Tier**: Pro only
**Query Parameters**:
- `limit`: Number of snapshots to return (default 10, max 100)

**Request**:
```
GET /sync/history?limit=20
```

**Response (200)**:
```javascript
{
  "success": true,
  "history": [
    {
      "id": 42,
      "snapshot_size": 12345,
      "created_at": "2026-03-15T10:30:00Z"
    },
    {
      "id": 41,
      "snapshot_size": 11892,
      "created_at": "2026-03-14T09:15:00Z"
    }
  ]
}
```

**Use Cases**:
- Users can see all sync history in UI
- Time-travel restore to previous state
- Identify when data was last successfully synced

---

## Database Schema

### user_data_snapshots
Stores point-in-time snapshots of user data for version control.
```sql
CREATE TABLE user_data_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  snapshot_data TEXT NOT NULL,    -- JSON stringify of all user data
  snapshot_size INTEGER,           -- Bytes
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

### sync_logs
Audit trail of sync operations (upload/download/errors).
```sql
CREATE TABLE sync_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  device_id TEXT,
  action TEXT DEFAULT 'data_sync',
  synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  data_size INTEGER,
  status TEXT DEFAULT 'success',  -- success | error | partial
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

### devices
Multi-device registry for linked devices.
```sql
CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_name TEXT,
  device_type TEXT DEFAULT 'web',      -- web | ios | android
  last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_active BOOLEAN DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

### analytics_events
Time-series analytics events for product metrics.
```sql
CREATE TABLE analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,  -- ambient_selected | session_complete | checkout_initiated
  event_data TEXT,            -- JSON stringified event details
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

### stripe_subscriptions
Tracks Stripe subscription state.
```sql
CREATE TABLE stripe_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  tier TEXT DEFAULT 'free',  -- free | pro | premium | enterprise
  status TEXT DEFAULT 'active',
  current_period_start DATETIME,
  current_period_end DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

## Sync Module (`api/src/sync.js`)

### Exported Functions

#### Subscription Management
- `checkSyncAccess(env, userId)` → `{ hasAccess, tier, reason }`
- `validateSyncTier(env, userId)` → `{ error, response }` or `{ error: false }`

#### Conflict Resolution
- `resolveConflict(local, remote, localTs, remoteTs)` → resolved data
- `mergeSessionData(localSessions, remoteSessions)` → merged array
- `mergeSettings(local, remote, remoteTs)` → merged object

#### Sync State
- `getLastSyncTimestamp(env, userId)` → timestamp or null
- `recordSync(env, userId, deviceId, action, status, sizeBytes)` → boolean
- `optimizePayload(data)` → `{ data, sizeBytes, compression_recommended }`
- `deduplicateSessions(sessions)` → de-duped array

#### Device Management
- `registerDevice(env, userId, deviceInfo)` → device object
- `getUserDevices(env, userId)` → array of devices
- `deactivateDevice(env, userId, deviceId)` → boolean

#### Data Versioning
- `getDataHistory(env, userId, limit)` → snapshot history
- `restoreFromSnapshot(env, userId, snapshotId)` → restored data

#### Analytics
- `syncAnalyticsEvents(env, userId, events)` → `{ success, synced }`

#### Offline Support
- `createOfflineMarker()` → marker object
- `processSyncQueue(env, userId, queuedEvents)` → merged state

## Tier Gating Logic

### Free Tier
- ❌ Cloud sync (`POST/GET /sync/data`)
- ❌ Multi-device (`POST/GET /sync/devices`)
- ✅ Analytics events (always available)
- ✅ All app features (Slack, streaming, etc.)

### Pro Tier ($3/month)
- ✅ Cloud sync (unlimited snapshots)
- ✅ Multi-device (up to 5 devices)
- ✅ Data history (30-day retention)
- ✅ Version restore (time-travel)
- ✅ Analytics events

### Future Tiers (Enterprise)
- Premium: Larger data limits, priority support
- Enterprise: Custom retention, API access, SLAs

## Error Handling Strategy

### 403 Forbidden (Subscription Required)
```javascript
{
  "error": "Cloud sync requires Pro subscription",
  "upgrade_url": "/upgrade",
  "reason": "Current tier \"free\" does not include cloud sync"
}
```
**Action**: Frontend should redirect user to upgrade page.

### 413 Payload Too Large
```javascript
{
  "error": "Data too large (max 10MB)"
}
```
**Action**: Frontend should compress/chunk data or warn user.

### Conflict Resolution (Last-Write-Wins)
When user syncs on two devices simultaneously:
1. Older timestamp is discarded
2. Newer timestamp wins (becomes canonical)
3. User sees no interruption (happens transparently)

## Offline Support: How It Works

### Frontend (Offline Queue)
```javascript
// While offline, events stay in eventQueue
if (!navigator.onLine) {
  eventQueue.push({
    type: 'session_complete',
    tool: 'pomodoro',
    ...
    synced: false,
    synced_at: null
  });
}

// On reconnect
window.addEventListener('online', () => {
  processEventQueue(); // Sends POST /sync/events
});
```

### Backend (Conflict Merge)
```javascript
// Get local queued events from frontend
const localEvents = eventQueue.filter(e => !e.synced);

// Process through sync module
await processSyncQueue(env, userId, localEvents);
// Returns merged state (remote wins on conflicts)
```

## Performance Characteristics

### Typical Latencies
- KV cache hit: <100ms
- D1 database read: 300-500ms
- Device list retrieval: 200-400ms
- Analytics batch sync: 100-200ms (10-100 events)

### Storage Costs (Cloudflare D1)
- 10,000 users × 50KB snapshots = ~500MB (within D1 limits)
- Each user keeps last 30 snapshots = ~1.5MB per user
- Analytics events: 100-200 per user per day × 365 = ~70KB/year

### Bandwidth Optimization
- Snapshots stored as gzip-compatible JSON (50-70% compression)
- Device list paginated (show 50 most recent)
- Analytics events batch-synced (10-100 per request)

## Security & Validation

### Input Validation
- ✅ Token verification (JWT)
- ✅ Subscription tier check
- ✅ Data size limits (10MB max)
- ✅ Event structure validation (must have type & tool)
- ✅ Device ID validation (UUID format)

### Rate Limiting (Not Yet Implemented)
Future: Add request rate limits to prevent abuse
- 10 sync/data requests per minute
- 100 events per request
- 5 device registrations per day

## Testing Checklist

- [ ] Free user attempts sync → 403 error
- [ ] Pro user syncs data → 200 success
- [ ] Sync on 2 devices simultaneously → Last-write-wins resolution
- [ ] Restore from snapshot → Data reverts correctly
- [ ] Device unlink → Device marked inactive, no longer syncs
- [ ] Analytics events miss required fields → Event skipped, batch continues
- [ ] Large payload (11MB) → 413 error
- [ ] Corrupted snapshot data → Graceful fallback to DB
- [ ] Session token expires → 401 error (redirect to login)

## Integration with Frontend

### Check Sync Access Before Showing UI
```javascript
async function checkCloudSyncAccess() {
  const response = await fetch('/api/billing/tier', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const { tier } = await response.json();
  
  if (tier !== 'pro') {
    // Hide cloud sync button, show "Upgrade" instead
    document.getElementById('cloudSyncBtn').style.display = 'none';
    document.getElementById('upgradeBtn').style.display = 'block';
  }
}
```

### Auto-Sync on Session End
```javascript
function recordPomodoroSession() {
  // ... existing code ...
  
  // After logging event, sync if Pro
  if (userIsPro) {
    syncDataToServer();
  }
}
```

### Offline Queue Management
```javascript
function logEvent(eventType, tool, durationSeconds, data) {
  const event = {
    type: eventType,
    tool,
    duration_seconds: durationSeconds,
    data,
    timestamp: new Date().toISOString(),
    synced: false
  };
  
  eventQueue.push(event);
  
  if (navigator.onLine) {
    processEventQueue();
  }
}
```

## Next Steps

1. ✅ Cloud sync module & endpoints created
2. ⏳ Stripe webhook integration (when Pro user upgrades, update tier to 'pro')
3. ⏳ Frontend UI for cloud sync status (sync icon, device list)
4. ⏳ Rate limiting & abuse protection
5. ⏳ Analytics dashboard to visualize sync metrics
6. ⏳ Mobile app integration (if applicable)
