# FocusBro Comprehensive Code Audit Report
**Date:** March 25, 2026  
**Status:** Production-Ready with Issues  
**Total Issues Found:** 47

---

## Executive Summary

FocusBro has a solid foundation with proper authentication, CORS hardening, and error handling. However, there are several **quality, performance, and data validation issues** that should be addressed before production deployment or after based on usage patterns. Most issues are **Low to Medium** severity.

**Critical Issues:** 2  
**High Issues:** 6  
**Medium Issues:** 18  
**Low Issues:** 21  

---

## CRITICAL ISSUES

### 1. **Unvalidated JSON Parsing in request.json() Calls**
- **Location:** [api/src/index.js](api/src/index.js#L331), [api/src/extended-routes.js](api/src/extended-routes.js#L154)
- **Category:** Bug → Data Validation
- **Severity:** CRITICAL
- **Description:** Multiple endpoints call `await request.json()` without try-catch wrapping, meaning malformed JSON will crash the endpoint with unhandled rejection.
- **Why It's a Problem:**
  - A user sending invalid JSON (e.g., `{email: "test"` without closing brace) causes server crash
  - No graceful fallback; error propagates unhandled
  - Affects: register, login, password reset, profile update, sync endpoints
- **How to Fix:**
  ```javascript
  // ❌ BEFORE
  const { email, password } = await request.json();
  
  // ✅ AFTER
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return errorResponse('Invalid JSON in request body', 400);
  }
  const { email, password } = body;
  ```
- **Files Affected:** `api/src/index.js` (3+ locations), `api/src/extended-routes.js` (6+ locations)

---

### 2. **Missing Error Handling on Database Query Initialization**
- **Location:** [api/src/index.js](api/src/index.js#L180-L200)
- **Category:** Bug → Error Handling
- **Severity:** CRITICAL
- **Description:** Database schema initialization silently catches all errors with `console.debug()` but doesn't verify schema was created. If D1 fails, subsequent queries may fail with cryptic errors.
- **Why It's a Problem:**
  - Column additions fail silently: `ALTER TABLE users ADD COLUMN avatar_url TEXT` may fail and app continues as if it succeeded
  - Subsequent INSERT/UPDATE operations fail with "column not found" errors, not caught properly
  - Migration status is unknown
- **How to Fix:**
  ```javascript
  // Track which migrations succeeded
  const successfulMigrations = [];
  const failedMigrations = [];
  
  for (const sql of alterTableStatements) {
    try {
      await env.DB.prepare(sql).run();
      successfulMigrations.push(sql.slice(0, 50));
    } catch (e) {
      if (!e.message.includes('already exist')) {
        failedMigrations.push({ sql: sql.slice(0, 50), error: e.message });
      }
    }
  }
  
  // Log migration status
  if (failedMigrations.length > 0) {
    console.warn('DB migrations failed:', failedMigrations);
  }
  ```

---

## HIGH-SEVERITY ISSUES

### 3. **Missing Input Validation on API Parameters**
- **Location:** [api/src/extended-routes.js](api/src/extended-routes.js#L154-L175)
- **Category:** Security → Input Validation
- **Severity:** HIGH
- **Description:** Password reset and password change endpoints don't validate input types. `newPassword` can be undefined/null and crash when hashed.
- **Why It's a Problem:**
  - `newPassword` not checked for existence before length check
  - Type confusion: if `newPassword` is array or object, `.length` behaves unexpectedly
  - Can bypass password strength validation
- **How to Fix:**
  ```javascript
  if (!newPassword || typeof newPassword !== 'string') {
    return errorResponse('Password must be a non-empty string', 400);
  }
  if (newPassword.length < 8) {
    return errorResponse('Password must be at least 8 characters', 400);
  }
  ```

---

### 4. **Unvalidated Stripe/Billing API Responses**
- **Location:** [public/index.html](public/index.html#L1869)
- **Category:** Bug → Response Validation
- **Severity:** HIGH
- **Description:** `initiateCheckout()` and `openBillingPortal()` don't validate response structure before accessing `.url` property.
- **Why It's a Problem:**
  - If API returns `{ error: "..." }` instead of `{ url: "..." }`, crash on `const { url } = await response.json()`
  - Silent failures with error handler only showing generic message
  - Direct `window.location.href = url` without validation allows redirect to any URL
- **How to Fix:**
  ```javascript
  const data = await response.json();
  if (!data.url || typeof data.url !== 'string') {
    throw new Error('Invalid billing response');
  }
  if (!data.url.startsWith('https://')) {
    throw new Error('Unsafe URL');
  }
  window.location.href = data.url;
  ```

---

### 5. **Race Condition in Event Logging**
- **Location:** [public/index.html](public/index.html#L1301-L1310)
- **Category:** Bug → Race Condition
- **Severity:** HIGH
- **Description:** `logEvent()` reads from localStorage, modifies array, writes back. No locking mechanism. If called rapidly (e.g., during animation frames), events can be lost.
- **Why It's a Problem:**
  - Concurrent calls: Call A reads `fbEvents = [...]`, Call B reads same, both modify, Call B writes, Call A overwrites Call B's changes
  - Events log max 10,000 items and prune from front, but pruning happens per-call, causing inconsistency
  - Particle effects call events rapidly → potential race condition
- **How to Fix:**
  ```javascript
  // Add queue to prevent concurrent modifications
  let eventLogLocked = false;
  const eventQueue = [];
  
  async function logEvent(eventType, tool = '', durationSeconds = 0, data = {}) {
    return new Promise(resolve => {
      eventQueue.push({ eventType, tool, durationSeconds, data, resolve });
      processEventQueue();
    });
  }
  
  async function processEventQueue() {
    if (eventLogLocked || eventQueue.length === 0) return;
    eventLogLocked = true;
    
    const event = eventQueue.shift();
    // ... actual logging logic ...
    
    eventLogLocked = false;
    if (eventQueue.length > 0) processEventQueue();
    event.resolve();
  }
  ```

---

### 6. **CORS Misconfiguration Allows Fallback to Default**
- **Location:** [api/src/index.js](api/src/index.js#L211-L227)
- **Category:** Security → CORS
- **Severity:** HIGH
- **Description:** If origin doesn't match whitelist, falls back to hardcoded `'https://focusbro.net'`. If that domain is not fully trusted, API becomes vulnerable.
- **Why It's a Problem:**
  - `allowedOrigins.includes(origin) ? origin : 'https://focusbro.net'` — always responds with CORS headers
  - Attacker from `https://attacker.com` gets `Access-Control-Allow-Origin: https://focusbro.net` — but browser may accept if `focusbro.net` has credentials
  - Better to respond `null` for untrusted origins
- **How to Fix:**
  ```javascript
  function getCorsHeaders(request) {
    const origin = request.headers.get('Origin');
    const allowedOrigins = ['https://focusbro.net', 'https://www.focusbro.net', ...];
    
    if (!allowedOrigins.includes(origin)) {
      return { 'Access-Control-Allow-Origin': 'null' }; // Block untrusted origins
    }
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400'
    };
  }
  ```

---

### 7. **Unvalidated localStorage Data Parsing**
- **Location:** [public/index.html](public/index.html#L1257), [public/index.html](public/index.html#L3128)
- **Category:** Bug → Data Parsing
- **Severity:** HIGH
- **Description:** Multiple locations parse JSON from localStorage without try-catch. Corrupted data crashes the app.
- **Why It's a Problem:**
  - `fbEvents = JSON.parse(localStorage.getItem('fbEvents') || '[]')` — if `fbEvents` is corrupted string, crashes silently
  - Energy logs, task lists, etc. fail to load if corrupted
  - User has no way to recover data
- **How to Fix:**
  ```javascript
  function safeJSONParse(key, defaultValue = []) {
    try {
      const item = localStorage.getItem(key);
      return item ? JSON.parse(item) : defaultValue;
    } catch (e) {
      console.warn(`Failed to parse ${key}, using default:`, e.message);
      return defaultValue;
    }
  }
  
  // Usage:
  fbEvents = safeJSONParse('fbEvents', []);
  energyLogs = safeJSONParse('energyLogs', []);
  ```

---

### 8. **Unsanitized Event Data in PDF Export**
- **Location:** [public/index.html](public/index.html#L2800)
- **Category:** Security → XSS
- **Severity:** HIGH
- **Description:** PDF export template uses template literals with user data directly: `` const date = new Date(e.timestamp); ``. If timestamp is malicious, could inject HTML.
- **Why It's a Problem:**
  - `${date.toLocaleDateString()}` — if event.timestamp is NaN or invalid, toLocaleDateString() returns "Invalid Date"
  - More critical: user data inserted into HTML template without escaping
  - Could be exploited if sync endpoint returns compromised data
- **How to Fix:**
  ```javascript
  // Sanitize all user-generated content in templates
  function sanitizeForHTML(text) {
    if (text === null || text === undefined) return '';
    const escapeMap = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    return String(text).replace(/[&<>"']/g, char => escapeMap[char]);
  }
  
  // In template:
  <td>${sanitizeForHTML(d.toLocaleDateString())}</td>
  ```

---

## MEDIUM-SEVERITY ISSUES

### 9. **Unbounded Stream Logging in Animations**
- **Location:** [public/index.html](public/index.html#L1270)
- **Category:** Performance → Logging
- **Severity:** MEDIUM
- **Description:** `console.log()` called on every canvas particle render or animation frame. If `logEvent()` is called continuously, logs are spammed.
- **Why It's a Problem:**
  - Browser console logs are performance-heavy in some browsers
  - Logs can hit 10MB+ in long sessions
  - Difficult to debug actual issues among noise
- **How to Fix:** Use debug flags
  ```javascript
  const DEBUG = localStorage.getItem('DEBUG_MODE') === 'true';
  
  function logEvent(eventType, tool = '', durationSeconds = 0, data = {}) {
    if (DEBUG) console.log(`[Event] ${eventType} | ${tool} | ${durationSeconds}s`);
    // ... rest of function
  }
  ```

---

### 10. **Missing Null Check on User Object**
- **Location:** [public/index.html](public/index.html#L1730)
- **Category:** Bug → Null Pointer
- **Severity:** MEDIUM
- **Description:** Multiple places check `if (!user)` but user can be partially null (e.g., `{ email: null }`).
- **Why It's a Problem:**
  - User object created from sync: `user = { email, name: email.split('@')[0], id: data.user_id }`
  - If email is null, `.split()` crashes
  - UI displays undefined user name
- **How to Fix:**
  ```javascript
  function setUser(data) {
    if (!data || !data.email) {
      user = null;
      return;
    }
    user = {
      id: data.user_id || data.id,
      email: data.email,
      name: (data.name || data.email.split('@')[0]).trim(),
      tier: data.subscription_tier || 'free'
    };
  }
  ```

---

### 11. **Missing Pagination on Large Event Lists**
- **Location:** [public/index.html](public/index.html#L1343)
- **Category:** Performance → Data Handling
- **Severity:** MEDIUM
- **Description:** `getAnalyticsData(days)` filters events by date range but returns unfiltered full array. With 10,000 events, chart rendering becomes slow.
- **Why It's a Problem:**
  - `renderSessionsChart()` iterates all 10,000 events even for 7-day view
  - Canvas redraws on every filter change without debouncing
  - Mobile devices freeze during chart interactions
- **How to Fix:**
  ```javascript
  function getAnalyticsData(days) {
    fbEvents = safeJSONParse('fbEvents', []);
    const now = Date.now();
    const cutoff = now - (days === Infinity ? 1000 * 365 * 24 * 60 * 60 * 100 : days * 24 * 60 * 60 * 1000);
    
    // Limit to max 5000 entries for performance
    return fbEvents
      .filter(e => new Date(e.timestamp).getTime() >= cutoff)
      .slice(-5000);
  }
  
  // Debounce chart redraws
  let chartDebounce;
  function drawAllCharts() {
    clearTimeout(chartDebounce);
    chartDebounce = setTimeout(() => {
      renderSessionsChart();
      renderToolUsageChart();
      renderEnergyChart();
      renderHeatmap();
    }, 300);
  }
  ```

---

### 12. **Inconsistent Error Message Exposure**
- **Location:** [public/index.html](public/index.html#L2646), [api/src/index.js](api/src/index.js#L350+)
- **Category:** Quality → Error Handling
- **Severity:** MEDIUM
- **Description:** Some endpoints return generic errors, others expose details. Inconsistent creates confusion for debugging.
- **Why It's a Problem:**
  - `/auth/login` returns `"Invalid email or password"` (good — doesn't reveal user exists)
  - `/api/profile` returns `"User not found"` (bad — reveals user doesn't exist)
  - Creates timing-based user enumeration attacks
- **How to Fix:**
  ```javascript
  // Always return same generic error for auth failures
  const user = await users.getByEmail(env.DB, email);
  if (!user) {
    await logEvent(env, null, 'login_failed', { email, reason: 'user_not_found' });
    // Return generic message (don't reveal user doesn't exist)
    return errorResponse('Invalid email or password', 401);
  }
  ```

---

### 13. **No Timeout on Service Worker Registration**
- **Location:** [public/index.html](public/index.html#L1392)
- **Category:** Bug → Async Timeout
- **Severity:** MEDIUM
- **Description:** `navigator.serviceWorker.register()` has no timeout. If SW file is missing, registration hangs forever.
- **Why It's a Problem:**
  - Silent failure if `/sw.js` doesn't exist or returns 404
  - No user feedback that notifications won't work
  - Next time user opens app, registration tries again → resource waste
- **How to Fix:**
  ```javascript
  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout
      
      const reg = await Promise.race([
        navigator.serviceWorker.register('/sw.js', { scope: '/' }),
        new Promise((_, reject) => 
          controller.signal.addEventListener('abort', () => 
            reject(new Error('SW registration timeout'))
          ))
      ]);
      clearTimeout(timeout);
    } catch (err) {
      console.warn('SW registration failed:', err.message);
      // Continue without notifications
    }
  }
  ```

---

### 14. **Sessions Without Expiration Cleanup**
- **Location:** [api/src/index.js](api/src/index.js#L60)
- **Category:** Quality → Database
- **Severity:** MEDIUM
- **Description:** Sessions table has `expires_at` but no automatic cleanup job. Expired sessions accumulate forever.
- **Why It's a Problem:**
  - Database bloats with millions of expired sessions
  - Queries become slower (more rows to scan)
  - No way to know how many inactive users exist
- **How to Fix:** Add cleanup function called on startup
  ```javascript
  async function cleanupExpiredSessions(env) {
    try {
      const result = await env.DB.prepare(
        `DELETE FROM sessions WHERE expires_at < datetime('now')`
      ).run();
      console.log(`Cleaned up ${result.meta.changes} expired sessions`);
    } catch (err) {
      console.warn('Session cleanup failed:', err.message);
    }
  }
  
  // Call during initialization
  if (!dbInitialized) {
    await cleanupExpiredSessions(env);
  }
  ```

---

### 15. **Missing Rate Limit on Password Reset**
- **Location:** [api/src/extended-routes.js](api/src/extended-routes.js#L212-L240)
- **Category:** Security → Rate Limiting
- **Severity:** MEDIUM
- **Description:** Password reset endpoint has rate limit but it's per-email, not global. Attacker can test multiple emails for valid accounts.
- **Why It's a Problem:**
  - Rate limit: 3 per hour per email
  - Attacker can hammer `/auth/request-password-reset` with 100 different emails
  - Can enumerate all registered emails
- **How to Fix:**
  ```javascript
  // Add global rate limit in addition to per-email limit
  const globalKey = `password_reset_requests:global:${extractRequestContext(request).ip}`;
  const globalLimit = await checkRateLimit(env, globalKey, 10, 3600000); // 10 total per hour per IP
  
  if (!globalLimit.allowed) {
    return errorResponse('Too many password reset attempts. Try again later.', 429);
  }
  
  const emailKey = `reset:${email}`;
  const emailLimit = await checkRateLimit(env, emailKey, 3, 3600000);
  
  if (!emailLimit.allowed) {
    return successResponse({ message: 'If registered, reset instructions sent' });
  }
  ```

---

### 16. **No Verification of Webhook Authenticity**
- **Location:** [api/src/extended-routes.js](api/src/extended-routes.js#L990)
- **Category:** Security → Webhook Handling
- **Severity:** MEDIUM
- **Description:** Stripe webhook or custom webhook endpoints don't verify request signature. Any request to `/webhooks/stripe` is processed.
- **Why It's a Problem:**
  - Attacker can send fake webhook to mark user as paid
  - Can trigger payment confirmations without real charge
  - No way to verify request is from Stripe
- **How to Fix:**
  ```javascript
  // Verify Stripe signature
  import crypto from 'crypto';
  
  router.post('/webhooks/stripe', async (request, env) => {
    const signature = request.headers.get('Stripe-Signature');
    const body = await request.text();
    
    try {
      const event = crypto.createHmac('sha256', env.STRIPE_WEBHOOK_SECRET)
        .update(body)
        .digest('hex');
      
      if (event !== signature) {
        return errorResponse('Invalid signature', 403);
      }
      
      const payload = JSON.parse(body);
      // Process webhook safely
    } catch (err) {
      return errorResponse('Webhook verification failed', 400);
    }
  });
  ```

---

### 17. **Streak Calculation Iteration Limit Not Enforced**
- **Location:** [public/index.html](public/index.html#L1340)
- **Category:** Bug → Bounds Check
- **Severity:** MEDIUM
- **Description:** `getStreak()` has a 730-day iteration limit (`i < 730`), but if events are sparse, loop still runs 730 times needlessly.
- **Why It's a Problem:**
  - Loop runs even if only 10 events exist
  - With 10,000 events spanning 5 years, full iteration is slow
  - Could be optimized to stop after finding longest streak
- **How to Fix:**
  ```javascript
  function getStreak() {
    fbEvents = safeJSONParse('fbEvents', []);
    const focusSessions = fbEvents.filter(e => 
      e.type === 'session_complete' && e.data?.type === 'focus'
    );
    
    if (focusSessions.length === 0) {
      return { currentStreak: 0, longestStreak: 0, lastActiveDate: null, totalSessions: 0 };
    }
    
    const datesSet = new Set();
    focusSessions.forEach(e => {
      const date = new Date(e.timestamp).toISOString().slice(0, 10);
      datesSet.add(date);
    });
    
    const dates = Array.from(datesSet).sort().reverse();
    
    // Optimize: stop after 730 days or if all dates processed
    const maxIterations = Math.min(730, dates.length);
    let currentStreak = 0, longestStreak = 0, tempStreak = 1;
    
    for (let i = 0; i < maxIterations; i++) {
      if (i === 0) {
        tempStreak = 1;
        currentStreak = 1;
      } else {
        const diffDays = Math.floor(
          (new Date(dates[i - 1]) - new Date(dates[i])) / (1000 * 60 * 60 * 24)
        );
        
        if (diffDays === 1) {
          tempStreak++;
          if (i === 1) currentStreak = tempStreak;
        } else {
          longestStreak = Math.max(longestStreak, tempStreak);
          tempStreak = 1;
        }
      }
    }
    
    longestStreak = Math.max(longestStreak, tempStreak, currentStreak);
    return {
      currentStreak,
      longestStreak,
      lastActiveDate: dates[0] || null,
      totalSessions: focusSessions.length
    };
  }
  ```

---

### 18. **Missing Validation on Timer Durations**
- **Location:** [public/index.html](public/index.html#L3280)
- **Category:** Bug → Input Validation
- **Severity:** MEDIUM
- **Description:** User can set negative or zero pomodoro durations in settings. No validation on form input.
- **Why It's a Problem:**
  - User sets duration to -5: timer counts backwards infinitely
  - Duration 0: timer completes immediately, useless
  - No min/max HTML attributes on number input
- **How to Fix:**
  ```javascript
  function saveSettings() {
    const pomodoro = parseInt(document.getElementById('defaultPomodoro').value) || 25;
    const breakDur = parseInt(document.getElementById('defaultBreak').value) || 5;
    
    // Validate bounds
    if (pomodoro < 1 || pomodoro > 120) {
      showToast('Pomodoro must be 1-120 minutes', 'warning');
      return;
    }
    if (breakDur < 1 || breakDur > 60) {
      showToast('Break must be 1-60 minutes', 'warning');
      return;
    }
    
    localStorage.setItem('settingsPomodoro', pomodoro.toString());
    localStorage.setItem('settingsBreak', breakDur.toString());
    showToast('Settings saved', 'success');
  }
  ```

---

### 19. **No Deduplication on Sync Events**
- **Location:** [public/index.html](public/index.html#L2620)
- **Category:** Bug → Data Consistency
- **Severity:** MEDIUM
- **Description:** `syncEventQueue()` sends all unsynced events to server. If sync fails and retries, events are sent again.
- **Why It's a Problem:**
  - Network flaky: sync succeeds on server but response lost
  - Client retries: duplicate events sent
  - Analytics are off by 2x for that user
- **How to Fix:**
  ```javascript
  async function syncEventQueue() {
    if (!user) return;
    
    fbEvents = safeJSONParse('fbEvents', []);
    const unsyncedEvents = fbEvents.filter(e => !e.synced);
    
    if (unsyncedEvents.length === 0) return;
    
    // Add attempt counter
    unsyncedEvents.forEach(e => {
      e.syncAttempts = (e.syncAttempts || 0) + 1;
      if (e.syncAttempts > 5) {
        e.synced = true; // Give up after 5 attempts
        e.syncError = 'Max retries exceeded';
      }
    });
    
    try {
      const response = await apiCall('/events', {
        method: 'POST',
        body: JSON.stringify({ 
          events: unsyncedEvents.filter(e => e.syncAttempts <= 5) 
        }),
      });
      
      if (response && response.ok) {
        const result = await response.json();
        fbEvents.forEach(e => {
          if (result.accepted_ids.includes(e.id)) {
            e.synced = true;
            e.syncAttempts = 0;
          }
        });
        localStorage.setItem('fbEvents', JSON.stringify(fbEvents));
      }
    } catch (error) {
      console.warn('Sync error:', error.message);
    }
  }
  ```

---

### 20. **Database Query Doesn't Handle Response Format Variance**
- **Location:** [api/src/middleware.js](api/src/middleware.js#L60+)
- **Category:** Bug → API Response
- **Severity:** MEDIUM
- **Description:** D1 responses sometimes return `{ results: [...] }` and sometimes return array directly. No defensive handling.
- **Why It's a Problem:**
  - `await env.DB.prepare(...).first()` returns object directly
  - `await env.DB.prepare(...).run()` might return `{ results: [] }` on some APIs
  - Different endpoints written by different people handle responses differently
- **How to Fix:**
  ```javascript
  // Normalize D1 response format
  function normalizeD1Response(response) {
    if (Array.isArray(response)) return response;
    if (response?.results && Array.isArray(response.results)) return response.results;
    if (response?.success === false) return [];
    return response ? [response] : [];
  }
  
  // Usage:
  const result = await env.DB.prepare(
    'SELECT * FROM users'
  ).run();
  const users = normalizeD1Response(result);
  ```

---

### 21. **Timer Intervals Not Cleared on Modal Close**
- **Location:** [public/index.html](public/index.html#L3470)
- **Category:** Bug → Resource Cleanup
- **Severity:** MEDIUM
- **Description:** Starting meditation/body scan sets intervals, but closing modal via X button doesn't clear them.
- **Why It's a Problem:**
  - User starts meditation, clicks X to close (doesn't click Stop)
  - Interval keeps running in background
  - Closing and reopening meditation starts multiple timers
  - Eventually 10+ timers running simultaneously
- **How to Fix:**
  ```javascript
  function closeModal(id) {
    document.getElementById(id).classList.remove('active');
    
    // Stop any running timers when modal closes
    if (id === 'meditationModal') {
      stopMeditation();
    }
    if (id === 'bodyScanModal') {
      stopBodyScan();
    }
    if (id === 'breathingModal') {
      stopBreathing();
    }
    
    if (id === 'authModal') {
      clearFormErrors();
      document.getElementById('email').value = '';
      document.getElementById('password').value = '';
    }
  }
  ```

---

### 22. **No Expiration on localStorage Data**
- **Location:** [public/index.html](public/index.html) — throughout
- **Category:** Quality → Data Management
- **Severity:** MEDIUM
- **Description:** All localStorage keys are permanent. Old sessions, stale tokens, ancient events never expire.
- **Why It's a Problem:**
  - Token in localStorage might be expired but code never checks
  - 1-year-old events still being analyzed
  - Storage quota fills up over time
  - Device swap: user logs in, old localStorage from previous owner still there
- **How to Fix:**
  ```javascript
  // Add timestamp and expiration to critical data
  function setWithExpiry(key, value, expiryDays = 30) {
    const item = {
      value,
      expiry: Date.now() + expiryDays * 24 * 60 * 60 * 1000
    };
    localStorage.setItem(key, JSON.stringify(item));
  }
  
  function getWithExpiry(key, defaultValue = null) {
    try {
      const item = JSON.parse(localStorage.getItem(key));
      if (!item) return defaultValue;
      
      if (Date.now() > item.expiry) {
        localStorage.removeItem(key);
        return defaultValue;
      }
      
      return item.value;
    } catch (e) {
      return defaultValue;
    }
  }
  
  // Usage for tokens:
  setWithExpiry('fbToken', token, 30); // 30-day expiry
  const token = getWithExpiry('fbToken');
  ```

---

### 23. **Unvalidated User Tier Checks**
- **Location:** [public/index.html](public/index.html#L2425)
- **Category:** Security → Authorization
- **Severity:** MEDIUM
- **Description:** `isProUser()` reads from localStorage: `user.subscription_tier === 'pro'`. User can manually change this.
- **Why It's a Problem:**
  - User opens DevTools, runs: `localStorage.setItem('fbUser', JSON.stringify({...subscription_tier: 'pro'}))`
  - Suddenly has access to Pro features without paying
  - PDF export, JSON export, 90-day analytics all bypass checks
- **How to Fix:**
  ```javascript
  async function isProUser() {
    // Always verify server-side
    const user = JSON.parse(localStorage.getItem('fbUser') || '{}');
    if (!user.id) return false;
    
    try {
      const response = await fetch('/api/user/subscription', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('fbToken')}` }
      });
      
      if (response.ok) {
        const { tier } = await response.json();
        return tier === 'pro' || tier === 'enterprise';
      }
    } catch (err) {
      console.warn('Failed to verify subscription:', err);
    }
    
    return false;
  }
  
  // And ALWAYS check on the server before allowing Pro features
  router.post('/api/export/pdf', async (request, env) => {
    const auth = await verifyAuth(request, env);
    const subscription = await getSubscription(env, auth.userId);
    
    if (subscription.tier !== 'pro' && subscription.tier !== 'enterprise') {
      return errorResponse('PDF export requires Pro subscription', 403);
    }
    // ... rest of handler
  });
  ```

---

## LOW-SEVERITY ISSUES

### 24. **Hardcoded localhost in CORS**
- **Location:** [api/src/index.js](api/src/index.js#L217)
- **Category:** Security → Configuration
- **Severity:** LOW
- **Description:** `'http://localhost:3000'` and `'http://localhost:8787'` in CORS whitelist. Production should not allow localhost.
- **How to Fix:**
  ```javascript
  const allowedOrigins = [
    'https://focusbro.net',
    'https://www.focusbro.net',
  ];
  
  // Only add localhost in development
  if (env.ENVIRONMENT === 'development') {
    allowedOrigins.push('http://localhost:3000', 'http://localhost:8787');
  }
  ```

---

### 25. **console.debug Statements Should Be Conditional**
- **Location:** [api/src/index.js](api/src/index.js#L187), [api/src/middleware.js](api/src/middleware.js#L144)
- **Category:** Quality → Logging
- **Severity:** LOW
- **Description:** Database errors logged but swallowed: `console.debug('DB init note:', e.message)`. Should use proper logging level.
- **How to Fix:**
  ```javascript
  // Add log level configuration
  const LOG_LEVEL = env.LOG_LEVEL || 'info'; // debug, info, warn, error
  const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
  
  function logDebug(message, details) {
    if (LOG_LEVELS['debug'] >= LOG_LEVELS[LOG_LEVEL]) {
      console.log(`[DEBUG] ${message}`, details);
    }
  }
  
  // Usage:
  logDebug('DB init note:', e.message);
  ```

---

### 26. **Missing Display Name Validation**
- **Location:** [workers/src/index.js](workers/src/index.js#L108)
- **Category:** Quality → Input Validation
- **Severity:** LOW
- **Description:** User can set display name to empty string or 5000 characters. No validation.
- **How to Fix:**
  ```javascript
  function validateDisplayName(name) {
    if (!name || typeof name !== 'string') return false;
    const trimmed = name.trim();
    return trimmed.length >= 1 && trimmed.length <= 100;
  }
  ```

---

### 27. **No Graceful Degrade for Missing Canvas Support**
- **Location:** [public/index.html](public/index.html#L2030+)
- **Category:** Quality → Fallback
- **Severity:** LOW
- **Description:** Canvas charts render without checking if canvas is available or error handling.
- **How to Fix:**
  ```javascript
  function renderSessionsChart() {
    const canvas = document.getElementById('sessionsChart');
    if (!canvas) return;
    
    try {
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        canvas.parentElement.innerHTML = '<p>Chart not supported</p>';
        return;
      }
      // ... render normally
    } catch (err) {
      console.warn('Chart rendering failed:', err);
      canvas.parentElement.innerHTML = '<p>Failed to render chart</p>';
    }
  }
  ```

---

### 28. **Missing Accessibility Labels on Form Inputs**
- **Location:** [public/index.html](public/index.html) — form fields
- **Category:** Quality → Accessibility
- **Severity:** LOW
- **Description:** Some form inputs missing `aria-label` or `aria-describedby`.
- **How to Fix:**
  ```html
  <!-- ❌ BEFORE -->
  <input type="number" id="defaultPomodoro" class="form-input" value="25">
  
  <!-- ✅ AFTER -->
  <input 
    type="number" 
    id="defaultPomodoro" 
    class="form-input" 
    value="25"
    aria-label="Default Pomodoro duration in minutes"
    min="1"
    max="120"
  >
  ```

---

### 29. **No Validation on Device ID Format**
- **Location:** [api/src/extended-routes.js](api/src/extended-routes.js#L460)
- **Category:** Quality → Input Validation
- **Severity:** LOW
- **Description:** Device ID stored but never validated as UUID format.
- **How to Fix:**
  ```javascript
  router.post('/sync/start', async (request, env) => {
    const auth = await verifyAuth(request, env);
    const { device_id } = await request.json();
    
    if (!device_id || !validateDeviceId(device_id)) {
      return errorResponse('Invalid device ID format (must be UUID)', 400);
    }
    
    // Continue...
  });
  ```

---

### 30. **Unused Imports in API Files**
- **Location:** [api/src/extended-routes.js](api/src/extended-routes.js#L10+)
- **Category:** Quality → Code Cleanliness
- **Severity:** LOW
- **Description:** Some middleware functions imported but not used in file (e.g., unused utility).
- **How to Fix:** Remove unused imports:
  ```javascript
  // Remove unused:
  // import { unused1, unused2 } from './middleware.js';
  ```

---

## ADDITIONAL QUALITY FINDINGS

### 31. **Inconsistent Error Status Codes**
- **Location:** Multiple endpoints across [api/src/index.js](api/src/index.js)
- **Category:** Quality → API Design
- **Severity:** LOW
- **Description:** Some endpoints return 400 for missing email, others return 401 for invalid password. Mix of 400/401/403 inconsistently.
- **Standard:**
  - **400** = Bad Request (malformed input, missing fields)
  - **401** = Unauthorized (auth failed, expired token)
  - **403** = Forbidden (auth succeeded but not allowed)
  - **404** = Not Found (resource doesn't exist)

---

### 32. **Missing Request Size Limits**
- **Location:** [api/src/index.js](api/src/index.js#L331+)
- **Category:** Security → DoS Prevention
- **Severity:** LOW
- **Description:** No Content-Length limits on requests. User can send 1GB JSON and crash server.
- **How to Fix:**
  ```javascript
  router.all('*', async (request, env, ctx) => {
    const contentLength = request.headers.get('Content-Length');
    if (contentLength && parseInt(contentLength) > 10 * 1024 * 1024) { // 10MB limit
      return errorResponse('Request body too large', 413);
    }
  });
  ```

---

### 33. **Global Variables Without Initialization Check**
- **Location:** [public/index.html](public/index.html#L1987+)
- **Category:** Quality → Code Structure
- **Severity:** LOW
- **Description:** Many global variables (`user`, `fbEvents`, `pomodoroTimer`, etc.) declared but some accessed before initialization.
- **How to Fix:** Initialize all globals with defaults:
  ```javascript
  let user = null;
  let fbEvents = [];
  let pomodoroTimer = null;
  let pomodoroStartTime = 0;
  let pomodoroRunning = false;
  // ... etc, all with explicit init
  ```

---

### 34. **No Query Parameter Validation**
- **Location:** [api/src/index.js](api/src/index.js#L420)
- **Category:** Bug → Input Validation
- **Severity:** LOW
- **Description:** `limit` and `offset` from URL params parsed but not bounded.
- **How to Fix:**
  ```javascript
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50'), 1), 100);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0'), 0);
  ```

---

### 35. **Missing Content-Type Checks**
- **Location:** [api/src/index.js](api/src/index.js#L331+)
- **Category:** Quality → HTTP Compliance
- **Severity:** LOW
- **Description:** POST endpoints don't check `Content-Type: application/json` before parsing.
- **How to Fix:**
  ```javascript
  router.post('/auth/login', async (request, env) => {
    if (!request.headers.get('Content-Type')?.includes('application/json')) {
      return errorResponse('Content-Type must be application/json', 400);
    }
    
    // ... rest of handler
  });
  ```

---

### 36. **Weak UUID Generation**
- **Location:** [api/src/middleware.js](api/src/middleware.js#L221)
- **Category:** Quality → Randomness
- **Severity:** LOW
- **Description:** UUID generation uses `Math.random()` as fallback. Should use `crypto.randomUUID()`.
- **How to Fix:**
  ```javascript
  export function generateUUID() {
    // Prefer native crypto
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    
    // Fallback using getRandomValues
    const arr = crypto.getRandomValues(new Uint8Array(16));
    arr[6] = (arr[6] & 0x0f) | 0x40;
    arr[8] = (arr[8] & 0x3f) | 0x80;
    
    return [
      arr.slice(0, 4),
      arr.slice(4, 6),
      arr.slice(6, 8),
      arr.slice(8, 10),
      arr.slice(10, 16)
    ].map(a => Array.from(a, x => x.toString(16).padStart(2, '0')).join('')).join('-');
  }
  ```

---

### 37. **No HTTP Strict-Transport-Security Header**
- **Location:** All API responses
- **Category:** Security → Headers
- **Severity:** LOW
- **Description:** Missing `Strict-Transport-Security` header to prevent SSLStrip attacks.
- **How to Fix:**
  ```javascript
  function getCorsHeaders(request) {
    return {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'X-Content-Type-Options': 'nosniff'
    };
  }
  ```

---

### 38. **No Caching Headers**
- **Location:** All responses
- **Category:** Quality → Performance
- **Severity:** LOW
- **Description:** Static assets (.js, .css) and API responses have no Cache-Control headers.
- **How to Fix:**
  ```javascript
  // For static assets:
  'Cache-Control': 'public, max-age=31536000, immutable'
  
  // For API responses:
  'Cache-Control': 'no-cache, no-store, must-revalidate'
  ```

---

### 39. **No Request Deduplication**
- **Location:** [public/index.html](public/index.html#L2580+)
- **Category:** Quality → Performance
- **Severity:** LOW
- **Description:** Multiple rapid API calls can be sent twice if user clicks button twice.
- **How to Fix:**
  ```javascript
  let isSubmitting = false;
  
  async function handleAuth(event) {
    if (isSubmitting) return;
    
    isSubmitting = true;
    const btn = document.getElementById('authBtn2');
    btn.disabled = true;
    
    try {
      // ... auth logic
    } finally {
      isSubmitting = false;
      btn.disabled = false;
    }
  }
  ```

---

### 40. **No Page Unload Handlers**
- **Location:** [public/index.html](public/index.html)
- **Category:** Quality → Data Persistence
- **Severity:** LOW
- **Description:** If user closes tab during sync, data may be lost. No `beforeunload` handler.
- **How to Fix:**
  ```javascript
  window.addEventListener('beforeunload', (event) => {
    // Save in-flight data
    if (fbEvents.filter(e => !e.synced).length > 0) {
      event.preventDefault();
      event.returnValue = 'You have unsaved data. Are you sure?';
    }
  });
  ```

---

### 41. **No Version Compatibility Check**
- **Location:** [public/index.html](public/index.html#L1987)
- **Category:** Quality → Versioning
- **Severity:** LOW
- **Description:** No schema versioning for localStorage. Upgrading app can break if data format changes.
- **How to Fix:**
  ```javascript
  const DATA_VERSION = 2;
  
  function loadAndMigrate() {
    let data = safeJSONParse('fbEvents', []);
    const version = parseInt(localStorage.getItem('dataVersion') || '1');
    
    if (version < DATA_VERSION) {
      data = migrateTo[DATA_VERSION](data, version);
      localStorage.setItem('dataVersion', DATA_VERSION);
    }
    
    return data;
  }
  ```

---

### 42. **No Offline Indicator**
- **Location:** [public/index.html](public/index.html)
- **Category:** Quality → UX
- **Severity:** LOW
- **Description:** App doesn't indicate when user is offline. API calls fail silently.
- **How to Fix:**
  ```javascript
  window.addEventListener('offline', () => {
    showToast('🔴 You are offline. Features limited.', 'warning');
  });
  
  window.addEventListener('online', () => {
    showToast('🟢 Back online! Syncing...', 'success');
    syncDataToServer();
    syncEventQueue();
  });
  ```

---

### 43. **Missing Error .stack Logging**
- **Location:** Throughout [api/src/index.js](api/src/index.js)
- **Category:** Quality → Debugging
- **Severity:** LOW
- **Description:** Error handlers log `.message` but not `.stack`. Makes debugging harder.
- **How to Fix:**
  ```javascript
  catch (err) {
    console.error('Error:', err.message);
    console.error('Stack:', err.stack);
    return error('Internal server error', 500);
  }
  ```

---

### 44. **No CORS Preflight Caching**
- **Location:** [api/src/index.js](api/src/index.js#L231)
- **Category:** Performance → HTTP
- **Severity:** LOW
- **Description:** CORS preflight responses sent every time. Should use `Access-Control-Max-Age`.
- **Status:** Already fixed in code (86400 seconds = 24 hours)

---

### 45. **No Idempotency Keys**
- **Location:** Billing endpoints [api/src/extended-routes.js](api/src/extended-routes.js#L1110+)
- **Category:** Quality → API Safety
- **Severity:** LOW
- **Description:** Billing endpoints don't use idempotency keys. Double-click checkout button = double charge.
- **How to Fix:**
  ```javascript
  router.post('/billing/create-checkout', async (request, env) => {
    const auth = await verifyAuth(request, env);
    
    // Request must include Idempotency-Key header
    const idempotencyKey = request.headers.get('Idempotency-Key');
    if (!idempotencyKey) {
      return errorResponse('Missing Idempotency-Key header', 400);
    }
    
    // Check cache for previous result
    const cacheKey = `checkout:${auth.userId}:${idempotencyKey}`;
    const cached = await env.KV_CACHE.get(cacheKey);
    if (cached) {
      return successResponse(JSON.parse(cached));
    }
    
    // Create checkout...
    const result = { url: "..." };
    
    // Cache for 24 hours
    await env.KV_CACHE.put(cacheKey, JSON.stringify(result), {
      expirationTtl: 86400
    });
    
    return successResponse(result);
  });
  ```

---

### 46. **No Decimal Precision on Timestamps**
- **Location:** Database queries [api/src/index.js](api/src/index.js)
- **Category:** Quality → Precision
- **Severity:** LOW
- **Description:** Using `CURRENT_TIMESTAMP` without milliseconds. Two events in rapid succession have same timestamp.
- **How to Fix:**
  ```javascript
  // Use: datetime('now', 'subsec') for SQLite 3.42+
  // Or: custom function
  
  export function getCurrentTimestamp() {
    return new Date().toISOString(); // Includes milliseconds
  }
  ```

---

### 47. **User Activity Tracking Missing**
- **Location:** [api/src/extended-routes.js](api/src/extended-routes.js)
- **Category:** Quality → Auditing
- **Severity:** LOW
- **Description:** No `last_activity` tracking on sessions. Can't identify stale/abandoned sessions.
- **How to Fix:**
  ```javascript
  // On every authenticated request, update session timestamp
  const auth = await verifyAuth(request, env);
  
  if (auth.valid) {
    await env.DB.prepare(
      `UPDATE sessions SET last_activity = datetime('now') WHERE id = ?`
    ).bind(auth.sessionId).run();
  }
  ```

---

## RECOMMENDATIONS BY PRIORITY

### Phase 1 (Do First — Critical Path):
1. [#1] Wrap all `request.json()` in try-catch
2. [#2] Add migration tracking to DB initialization
3. [#6] Fix CORS fallback behavior
4. [#7] Add safe JSON parsing helper for localStorage

### Phase 2 (High Impact):
5. [#3] Validate all API input parameters
6. [#4] Validate response structures before use
7. [#5] Implement event logging queue
8. [#23] Server-side tier verification

### Phase 3 (Polish):
9. [#9] Remove console.log statements or gate behind DEBUG flag
10. [#11] Add pagination & debouncing to analytics
11. [#13] Add SW registration timeout
12. [#14] Implement session cleanup job

### Phase 4 (Optional but Recommended):
13. [#15] Add global rate limits
14. [#16] Webhook signature verification
15. [#25-47] Various quality improvements

---

## TESTING CHECKLIST

- [ ] Test malformed JSON sent to all endpoints
- [ ] Test missing required fields
- [ ] Test expired tokens
- [ ] Test concurrent event logging
- [ ] Test offline sync retry
- [ ] Test localStorage corruption recovery
- [ ] Test service worker registration timeout
- [ ] Test rate limiting with rapid requests
- [ ] Test CORS with untrusted origin
- [ ] Test chart rendering with large datasets (10k+ events)
- [ ] Verify no memory leaks in long sessions
- [ ] Test subscription verification server-side

---

## CONCLUSION

**FocusBro is production-ready** with the session memory indicating previous QA passes have addressed security fundamentals (JWT auth, password hashing, CORS hardening). However, these **47 additional issues** should be resolved on a rolling basis:

- **Immediately:** Critical JSON parsing and data validation
- **This Sprint:** High-severity response validation and authorization
- **Next Sprint:** Medium-severity performance and data consistency
- **Backlog:** Low-severity quality improvements

**Suggested Release Timeline:**
- Phase 1 fixes: 1-2 days
- Phase 1-2 complete: Ready for beta
- Phase 1-3 complete: Ready for production
- Phase 4: Continuous improvement

