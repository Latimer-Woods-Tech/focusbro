curl -H "Authorization: Bearer YOUR_TOKEN" \
  "https://api.cloudflare.com/client/v4/user/tokens/verify"# FocusBro Resilience & Error Handling Audit

**Date**: March 25, 2026  
**Scope**: Missing error boundaries, incomplete sync handlers, token refresh, offline detection, error recovery, unvalidated responses

---

## 1. MISSING ERROR BOUNDARIES - TIMER LOOPS

### Issue: No error boundaries in setInterval callbacks
Timer functions can crash silently if DOM mutation fails, leaving app in broken state.

#### 1A. Pomodoro Timer Loop
**File**: [public/index.html](public/index.html#L3847)  
**Lines**: 3847-3867  
**Severity**: HIGH

```javascript
pomodoroTimer = setInterval(() => {
  const elapsed = Math.floor((Date.now() - pomodoroStartTime) / 1000);
  const remaining = Math.max(0, defaultDuration * 60 - elapsed);
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  document.getElementById('pomodoroDisplay').textContent = `${m}:${String(s).padStart(2, '0')}`;
  // ❌ NO ERROR BOUNDARY - If element doesn't exist, timer continues but display breaks
  if (remaining === 0) {
    stopPomodoro(true);
  }
}, 100);
```

**Problem**:
- `document.getElementById('pomodoroDisplay')` can return null if element unmounted
- Timer continues running even if DOM operation fails
- User sees stuck display, timer invisible

---

#### 1B. Meditation Timer Loop
**File**: [public/index.html](public/index.html#L3524)  
**Lines**: 3524-3540  
**Severity**: HIGH

```javascript
meditationTimer = setInterval(() => {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  remaining = Math.max(0, minutes * 60 - elapsed);
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  document.getElementById('meditationTimer').textContent = `${m}:${String(s).padStart(2, '0')}`;
  // ❌ NO TRY-CATCH - Crashes if element doesn't exist
  if (remaining <= 0) {
    stopMeditation();
    showToast('Meditation complete!', 'success');
  }
}, 100);
```

**Risk**:
- If user closes meditation modal during active timer, element removal causes silent failure
- Timer interval keeps executing but becomes ineffective
- No logging of the failure

---

#### 1C. Activity Simulation Interval
**File**: [public/index.html](public/index.html#L3621)  
**Lines**: 3621-3627  
**Severity**: MEDIUM

```javascript
activityInterval = setInterval(() => {
  simulateActivity();  // ❌ No error boundary
  updatePresenceTimer();  // ❌ No error boundary
}, 2000 + Math.random() * 56000);
```

**Dependencies on unchecked DOM elements**:
- `updatePresenceTimer()` (line 3759) accesses `document.getElementById('activeTimer')` without null check
- If sidebar is closed/reopened, element may not exist

**Code at line 3759**:
```javascript
document.getElementById('activeTimer').textContent = `${String(hours).padStart(2, '0')}:...`;
// ❌ Will throw TypeError if 'activeTimer' doesn't exist
```

---

#### 1D. Body Scan Interval  
**File**: [public/index.html](public/index.html#L3475)  
**Lines**: 3475-3490  
**Severity**: MEDIUM

```javascript
bodyScanInterval = setInterval(() => {
  if (current >= checks.length) {
    stopBodyScan();
    playNotificationChime();
    showToast('Body scan complete! 📊', 'success');
    return;
  }
  const check = checks[current];
  document.getElementById('bodyScanDisplay').innerHTML = `...${check}...`;
  // ❌ NO ERROR BOUNDARY - innerHTML fails if element closes
  bodyScanData.push({ area: check.split(' - ')[0], timestamp: new Date().toISOString() });
  current++;
}, 20000);
```

**Problem**:
- Modal can be closed before interval completes
- `bodyScanDisplay` element removal causes unhandled error
- `bodyScanInterval` continues running in background

---

### 2. INCOMPLETE SYNC HANDLERS - NO RETRY LOGIC

#### 2A. syncDataToServer() - No Retry Queue
**File**: [public/index.html](public/index.html#L2920)  
**Lines**: 2920-2950  
**Severity**: HIGH

```javascript
async function syncDataToServer() {
  if (!user) return;

  try {
    const response = await apiCall('/sync/data', {
      method: 'POST',
      body: JSON.stringify({ sessionCount, energyLogs, pomodoroSettings: {...}, synced_at: ...})
    });

    if (response && response.ok) {
      console.debug('✓ Data synced to server');
      return true;
    } else if (response) {
      const errorData = await response.json().catch(() => ({}));
      console.warn('⚠ Data sync failed:', response.status, errorData.error);
      // ❌ NO RETRY - Data is lost if network fails
    }
  } catch (error) {
    console.debug('Data sync error (continuing offline):', error.message);
    // ❌ NO BACKOFF or RETRY QUEUE
  }
  return false;
}
```

**Issues**:
1. Network fails → data dropped → no queue to retry later
2. User may have no internet briefly (mobile switching networks)
3. Transient 5xx errors not retried
4. **Missing**: Exponential backoff, retry counter, dead letter queue

---

#### 2B. syncEventQueue() - Incomplete Error Recovery
**File**: [public/index.html](public/index.html#L2956)  
**Lines**: 2956-3000  
**Severity**: HIGH

```javascript
async function syncEventQueue() {
  if (!user) return;
  fbEvents = safeJSONParse('fbEvents', []);
  const unsyncedEvents = fbEvents.filter(e => !e.synced);
  if (unsyncedEvents.length === 0) return;
  
  try {
    const response = await apiCall('/events', {
      method: 'POST',
      body: JSON.stringify({ events: unsyncedEvents }),
    });

    if (response && response.ok) {
      const result = await response.json();  // ❌ UNVALIDATED - could crash
      
      if (result.accepted_ids && Array.isArray(result.accepted_ids)) {
        fbEvents.forEach(e => {
          if (result.accepted_ids.includes(e.id)) {
            e.synced = true;
          }
        });
        localStorage.setItem('fbEvents', JSON.stringify(fbEvents));
        log(`Synced ${result.accepted} events to backend`);
      }
      // ❌ MISSING: What if result structure is different? Silent failure
      return true;
    } else if (response) {
      const errorData = await response.json().catch(() => ({}));
      warn('Event sync failed:', response.status, errorData.error);
      // ❌ NO RETRY LOGIC - Events lost if server returns 5xx
    }
  } catch (e) {
    warn('Event sync error (will retry):', e.message);
    // ❌ Says "will retry" but there's NO retry implementation
  }
  return false;
}
```

**Problems**:
1. **Unvalidated response** (line 2973) - assumes `result.accepted_ids` exists
2. **No retry queue** - Claims retry but doesn't actually retry
3. **Sync rate** (line 4043) - Fixed 5-minute interval, no backoff
4. **Failed events disappear** - If backend rejects, events are lost

---

#### 2C. apiCall() Returns null on 401 - No Recovery
**File**: [public/index.html](public/index.html#L2895)  
**Lines**: 2895-2919  
**Severity**: MEDIUM

```javascript
async function apiCall(endpoint, options = {}) {
  const token = getAuthToken();
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const response = await fetch(`${env.API_ORIGIN}${endpoint}`, {
    ...options, headers,
  });

  if (response.status === 401) {
    logout();  // ❌ Immediate logout, no refresh attempt
    showToast('Session expired. Please log in again.', 'error');
    return null;
  }

  return response;
}
```

**Issues**:
1. 401 triggers immediate logout (harsh UX)
2. **No refresh token mechanism** - Could silently extend session
3. `apiCall()` returns `null` → callers must check for null
4. Example caller doesn't handle null: `syncDataToServer()` line 2938 checks `if (response && response.ok)` but treats null as falsy (works by accident)

---

### 3. TOKEN REFRESH/EXPIRATION - MISSING IMPLEMENTATION

#### 3A. Token Expiration Not Validated
**File**: [public/index.html](public/index.html#L3995)  
**Lines**: 3995-3998  
**Severity**: HIGH

```javascript
// ✅ VALIDATION: Token should be JWT format (Header.Payload.Signature)
if (isSignedMode) {
  if (!token.match(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)) {
    throw new Error('Token is not valid JWT format');
  }
}
```

**Missing**:
- ❌ Expiration time extraction from JWT payload
- ❌ Comparison with current time
- ❌ Automatic token refresh endpoint
- ❌ Refresh token implementation

**Consequence**: Token validity only checked on 401 error (reactive), not proactive

---

#### 3B. No Refresh Token Lifecycle
**File**: [public/index.html](public/index.html#L3040-3100)  
**API**: [api/src/index.js](api/src/index.js#L320-380)  
**Severity**: HIGH

**Missing from registration/login**:
- No refresh token generated alongside JWT
- No refresh token stored in httpOnly cookie
- No `/auth/refresh` endpoint
- No automatic token renewal before expiration

**Actual token storage** (line 3040):
```javascript
localStorage.setItem('fbToken', data.token);  // ❌ Stored in localStorage (XSS vulnerable)
localStorage.setItem('fbSessionId', data.session_id);
```

**Issue**: If token expires mid-session:
1. Next sync fails with 401
2. `apiCall()` logs user out
3. All unsync'd data lost
4. No recovery possible without manual re-login

---

### 4. MISSING OFFLINE DETECTION

#### 4A. No navigator.onLine Check
**File**: [public/index.html](public/index.html)  
**Severity**: MEDIUM

**Current behavior**:
- `syncDataToServer()` (line 2920) calls `apiCall()` without checking network state
- Assumes fetch will fail gracefully, but no offline queue

**Missing**:
```javascript
// ❌ MISSING: Check before attempting sync
if (!navigator.onLine) {
  // Queue for later instead of attempting network call
  queueFailedSync(data);
  return;
}
```

**Current**: Network calls fail → caught in catch (line 2945) → logged → ignored

---

#### 4B. No Offline UI Indicator
**File**: [public/index.html](public/index.html)  
**Severity**: MEDIUM

**Missing features**:
- No visible offline badge
- No notification when going offline
- No sync queue UI showing pending events
- No retry button for failed syncs

**Related code** (line 1604):
```javascript
console.warn('⚠️ Service Worker registration failed (app will continue offline):', err.message);
// Says "continue offline" but no UI to indicate offline state
```

---

### 5. INCOMPLETE ERROR RECOVERY - NO RETRY LOGIC

#### 5A. Gallery API Failure - No Retry
**File**: [public/index.html](public/index.html#L3180)  
**Lines**: 3180-3210  
**Severity**: LOW (non-critical feature)

```javascript
async function initGallery() {
  try {
    const userId = getOrCreateUserId();
    const category = 'random';
    const response = await fetch(`/api/gallery?seed=...`);  // ❌ No timeout
    
    if (response.ok) {
      const data = await response.json();
      if (data.images && data.images.length > 0) {
        galleryImages = data.images.map(img => ({...}));
        log(`✅ Loaded ${galleryImages.length} images from API`);
      }
    }
    // ❌ NO ELSE - Doesn't log failure if response is not ok
  } catch (e) {
    warn('Gallery API unavailable, using fallback SVGs:', e.message);
    galleryImages = [...FALLBACK_GALLERY];  // Falls back silently
  }
  currentGalleryIndex = 0;
  renderGallery();
}
```

**Issues**:
1. No retry on transient network errors
2. No exponential backoff
3. If API recovers later, user still sees fallback

---

#### 5B. Slack Webhook - No Retry on Failure
**File**: [api/src/extended-routes.js](api/src/extended-routes.js#L1715)  
**Lines**: 1715-1730  
**Severity**: MEDIUM (affects user notifications)

```javascript
try {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(webhookBody)
  });
  // ❌ NO ERROR HANDLING FOR NON-200 RESPONSE
  if (!response.ok) {
    // ❌ MISSING: Retry with exponential backoff
    // ❌ MISSING: Dead letter queue for failed messages
    // ❌ MISSING: User notification of failure
  }
} catch (e) {
  // ❌ Network error - message lost forever
  console.error('Webhook send failed:', e.message);
}
```

**Consequence**: User completes session → Slack notification fails → User never knows

---

### 6. UNVALIDATED ENDPOINT RESPONSES

#### 6A. /events Endpoint - Unsafe Response Parsing
**File**: [public/index.html](public/index.html#L2973)  
**Lines**: 2973-2980  
**Severity**: HIGH

```javascript
if (response && response.ok) {
  const result = await response.json();  // ❌ No validation
  
  if (result.accepted_ids && Array.isArray(result.accepted_ids)) {
    fbEvents.forEach(e => {
      if (result.accepted_ids.includes(e.id)) {
        e.synced = true;
      }
    });
    localStorage.setItem('fbEvents', JSON.stringify(fbEvents));
    log(`Synced ${result.accepted} events to backend`);  // ❌ result.accepted may be undefined
  }
  // ❌ MISSING: What if response is { error: "duplicate events" }?
  // ❌ MISSING: What if response is not JSON?
  // ❌ MISSING: What if accepted_ids is too large?
  return true;  // Claims success even if silently failed
}
```

**Unvalidated fields**:
- `result.accepted` - Type not checked (line 2984)
- `result.accepted_ids` - Only checked for existence, not array structure
- `result` itself - Could be error response with { error: string }

---

#### 6B. getAnalyticsData() - Unsafe API Response
**File**: [public/index.html](public/index.html#L2206)  
**Lines**: 2206-2210  
**Severity**: MEDIUM

```javascript
async function getAnalyticsData(days, page = 0, limit = 100) {
  if (user && user.id) {
    try {
      const response = await apiCall(`/events?days=${days}&page=${page}&limit=${limit}`);
      if (response && response.ok) {
        const data = await response.json();  // ❌ UNVALIDATED
        if (data.success && data.events) {
          return data.events;  // Assumes array, could be null
        }
      }
    } catch (e) {
      warn('Failed to fetch paginated events from API, falling back to localStorage:', e.message);
    }
  }
  // Falls back to localStorage but response.json() error isn't distinguishable from data.success === false
}
```

**Issues**:
1. `data.events` not validated as array before returning
2. Malformed JSON silently falls back to localStorage
3. No distinction between "server error" vs "no data"

---

#### 6C. POST /events - Incomplete Response Validation
**File**: [api/src/extended-routes.js](api/src/extended-routes.js#L865)  
**Lines**: 865-920  
**Severity**: HIGH

```javascript
// ── POST /events - Batch upload  
router.post('/events', async (request, env) => {
  try {
    const auth = await verifyAuth(request, env);
    if (!auth.valid) return errorResponse('Unauthorized', 401);

    const contentType = request.headers.get('Content-Type') || '';
    if (!contentType.includes('application/json')) {
      return errorResponse('Content-Type must be application/json', 400);
    }

    let body;
    try {
      body = await request.json();  // ❌ Can throw on invalid JSON
    } catch (e) {
      return errorResponse('Invalid JSON in request body', 400);
    }

    const { events } = body;
    if (!Array.isArray(events)) {
      return errorResponse('events must be an array', 400);
    }

    if (events.length > 500) {
      return errorResponse('Maximum 500 events per request', 400);
    }

    // ❌ MISSING: Validate individual event structure
    const validEvents = events.filter(e => {
      if (!e.id || !e.type || !e.timestamp) return false;
      const ts = new Date(e.timestamp);
      if (isNaN(ts.getTime())) return false;
      const now = new Date();
      const diffDays = (now - ts) / (1000 * 60 * 60 * 24);
      if (diffDays > 730 || diffDays < -7) return false;
      // ❌ MISSING: Validate e.data object size to prevent storage attacks
      // ❌ MISSING: Validate e.type is one of known types
      return true;
    });
    // ... continues at line 920
  } catch (error) {
    console.error('POST /events error:', error);
    return errorResponse('Internal server error', 500);
  }
});
```

**Missing validations**:
- Event `data` field size not checked (DoS vulnerability)
- Event `type` not validated against whitelist
- No rate limit per user per batch
- Error response (line 944) generic 500, doesn't distinguish errors

---

#### 6D. GET /events - Response Structure Assumptions
**File**: [api/src/extended-routes.js](api/src/extended-routes.js#L945)  
**Lines**: 945-1010  
**Severity**: MEDIUM

```javascript
router.get('/events', async (request, env) => {
  // ...parsing pagination...
  try {
    const result = await env.DB.prepare(
      `SELECT ... FROM focus_events WHERE user_id = ? ORDER BY ...`
    ).bind(auth.user.id).all();  // ❌ Database might return empty

    // ❌ MISSING: Validate result structure
    const events = result.results || [];  // Assumes .results property
    const totalCount = ...  // ❌ Calculation assumes queryCount succeeds
    
    return successResponse({
      success: true,
      events,
      pagination: {
        page, limit, total: totalCount,
        hasMore: offset + limit < totalCount
      }
    });
  } catch (error) {
    console.error('GET /events error:', error);
    return errorResponse('Internal server error', 500);  // ❌ Generic, no context
  }
});
```

**Issues**:
- `result.results` assumed without validation
- Database timeout → generic 500 → client can't distinguish
- Missing metadata about response freshness
- No cache headers despite potentially expensive query

---

## Summary by Severity

| Severity | Count | Category |
|----------|-------|----------|
| **HIGH** | 8 | Missing error boundaries (timers), unvalidated responses, token expiration, no refresh token, incomplete sync |
| **MEDIUM** | 6 | Incomplete error recovery, activity simulation errors, offline detection, Slack retries, analytics response validation |
| **LOW** | 2 | Gallery fallback (non-critical), generic error messages |

---

### 7. WAKE LOCK SIDE EFFECTS - PRESENCE MANAGEMENT

#### 7A. Screen Wake Lock Causes Teams Away Status
**Date Reported**: March 26, 2026  
**Severity**: MEDIUM (UX impact)

**Issue**: Wake lock successfully prevents screen sleep during focus sessions, but causes communication apps (Teams, Slack) to detect user as "away" due to lack of keyboard/mouse activity.

**Test Result**:
- ✅ Screen stays awake (wake lock working)
- ❌ Teams status changes to "away" automatically
- ❌ User appears inactive to colleagues during focus time

**Root Cause**:
- `navigator.wakeLock.request('screen')` prevents display sleep
- Does not simulate user activity for presence detection
- Communication apps use separate idle detection (typically 5-15 minutes of no input)

**Current Implementation** (from activity simulation):
```javascript
activityInterval = setInterval(() => {
  simulateActivity();  // Only affects internal app state
  updatePresenceTimer();  // Updates UI timer display
}, 2000 + Math.random() * 56000);
```

**Problems**:
1. `simulateActivity()` doesn't trigger OS-level activity events
2. Teams/Slack presence based on actual input events, not app simulation
3. Wake lock + no activity = "away" status in professional tools

**Potential Solutions**:
- **Option A**: Periodic fake mouse move (undesirable, may violate terms)
- **Option B**: User education - "Screen will stay on, but you'll appear away"
- **Option C**: Configurable presence simulation (opt-in)
- **Option D**: Integration with OS presence APIs (if available)

**Current Fix**: 
- Added UI warning when wake lock is enabled to inform users about presence impact
- Enhanced activity simulation: dispatch events to document.body instead of window
- Added rare safe keyboard events (Shift key) to potentially trigger presence detection

**Recommendation**: Monitor if enhanced activity simulation resolves presence detection issues.

---

## Recommendations

### Immediate Fixes (HIGH)
1. ✅ Wrap all `setInterval` callbacks in try-catch
2. ✅ Validate API response structures before use
3. ✅ Implement retry queue for sync failures
4. ✅ Add refresh token mechanism
5. ✅ Check `navigator.onLine` before network calls

### Short-term Improvements (MEDIUM)
6. Add exponential backoff for retries
7. Implement offline sync queue UI
8. Add network state change listeners
9. Validate domain on Slack webhook URL
10. **Add wake lock presence impact warning**

### Long-term Enhancements (LOW)
11. Implement dead letter queue pattern
12. Add distributed tracing for sync operations
13. Build comprehensive error telemetry
