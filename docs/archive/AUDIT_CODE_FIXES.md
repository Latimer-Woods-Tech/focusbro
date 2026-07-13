# FocusBro: Code Fixes & Implementation Guide

Quick reference for fixing the 12 HIGH priority issues with exact code examples.

---

## Issue #1: Remove console.log Statements

**Status:** 20+ console.log calls in production code  
**Time:** 30 minutes  
**Risk:** Low (formatting only)

### ❌ Current Code
```javascript
// api/src/index.js
console.log('Initializing database schema...');

// api/src/extended-routes.js  
console.log(`Password reset requested for ${normalizedEmail}`);
console.log('Push subscription saved for user:', userId);
```

### ✅ Fix: Option A (Remove completely)
```javascript
// Simply delete the console.log lines
// OR use search-replace in editor:
// Find: console\.log\([^)]*\);\n
// Replace: (empty)
```

### ✅ Fix: Option B (Gate behind DEBUG flag)
```javascript
// Create logger helper
const DEBUG = process.env.DEBUG === '1';
const log = (msg, ...args) => DEBUG && console.log('[FB]', msg, ...args);

// Then use:
log('Database initialized');
log(`Reset requested for user: ${userId}`);

// Keep console.error and console.warn for actual issues:
console.error('Database connection failed:', err);
console.warn('Cache asset missing:', assetUrl);
```

### ✅ Implementation Steps
1. Search for all `console.log` in `api/src/` and `public/`
2. For debug messages → wrap with DEBUG check
3. For Info messages → use `console.info` (searchable)
4. For errors → keep `console.error`
5. Test: Open DevTools → no unnecessary logs should appear

---

## Issue #2: Fix CORS 'null' Origin Vulnerability

**File:** `api/src/extended-routes.js`  
**Severity:** High (CSRF/auth bypass)  
**Time:** 1 hour with testing  

### ❌ Current Code (Vulnerable)
```javascript
function getCorsHeaders(request) {
  const origin = request.headers.get('Origin');
  const allowedOrigins = [
    'https://focusbro.net',
    'https://www.focusbro.net',
    'http://localhost:3000',
    'http://localhost:8787',
  ];
  
  // ❌ PROBLEM: 'null' string is known CORS bypass
  const corsOrigin = allowedOrigins.includes(origin) ? origin : 'null';
  
  return {
    'Access-Control-Allow-Origin': corsOrigin,  // ← Sets header to 'null'
    'Access-Control-Allow-Methods': corsOrigin === 'null' ? '' : 'GET, POST, ...',
    // ...
  };
}
```

### ✅ Fixed Code
```javascript
function getCorsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  
  // ✅ Whitelist approach
  const allowedOrigins = [
    'https://focusbro.net',
    'https://www.focusbro.net',
  ];
  
  // Only add localhost in development
  if (env.ENVIRONMENT !== 'production') {
    allowedOrigins.push(
      'http://localhost:3000',
      'http://localhost:8787'
    );
  }
  
  // ✅ Return no CORS headers for untrusted origins (don't set to 'null' string)
  if (!origin || !allowedOrigins.includes(origin)) {
    return {
      'X-Content-Type-Options': 'nosniff',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    };
  }
  
  // ✅ Return proper headers only for trusted origins
  return {
    'Access-Control-Allow-Origin': origin,         // Actual origin, not 'null'
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',   // For cookies if needed
    'Access-Control-Max-Age': '86400',
    'X-Content-Type-Options': 'nosniff',
  };
}

// Update route handler
router.options('*', (request, env) => 
  new Response(null, { headers: getCorsHeaders(request, env) })
);
```

### ✅ Testing
```bash
# Test untrusted origin (should NOT get Access-Control-Allow-Origin header)
curl -H "Origin: https://evil.com" \
     -X OPTIONS https://api.focusbro.net/users/profile \
     -v | grep -i "Access-Control-Allow-Origin"
# Should return nothing (no header)

# Test trusted origin (should get header)
curl -H "Origin: https://focusbro.net" \
     -X OPTIONS https://api.focusbro.net/users/profile \
     -v | grep -i "Access-Control-Allow-Origin"
# Should return: Access-Control-Allow-Origin: https://focusbro.net
```

---

## Issue #3: Add Rate Limiting to Auth Endpoints

**Files:** `api/src/index.js` routes `/auth/login` and `/auth/register`  
**Time:** 1 hour  

### ❌ Current Code (No Rate Limiting)
```javascript
router.post('/auth/login', async (request, env) => {
  const { email, password } = await request.json();
  
  // No rate limiting! Attacker can try unlimited passwords
  const user = await users.getByEmail(env.DB, email);
  if (!user) {
    return error('Invalid credentials', 401);
  }
  
  if (!await verifyPassword(password, user.password_hash)) {
    return error('Invalid credentials', 401); // ← No delay, no limiting
  }
  // ... continue with login
});
```

### ✅ Fixed Code
```javascript
router.post('/auth/login', async (request, env) => {
  const { email, password } = await request.json();
  
  if (!email || !password) {
    return error('Email and password required', 400);
  }
  
  // ✅ ADD RATE LIMITING: 5 attempts per 15 minutes per email
  const rateLimit = await checkRateLimit(env, email, 5, 900000); // 900s = 15min
  if (!rateLimit.allowed) {
    return error(
      `Too many login attempts. Try again in ${Math.ceil((rateLimit.resetAt - Date.now()) / 1000)} seconds`,
      429
    );
  }
  
  const user = await users.getByEmail(env.DB, email);
  if (!user) {
    return error('Invalid email or password', 401);
  }
  
  const passwordValid = await verifyPassword(password, user.password_hash);
  if (!passwordValid) {
    return error('Invalid email or password', 401);
  }
  
  // ✅ Login successful - clear rate limit
  await env.KV_CACHE.delete(`ratelimit:${email}`);
  
  // ... rest of login logic
});

// Same for register endpoint
router.post('/auth/register', async (request, env) => {
  const { email, password } = await request.json();
  
  // ✅ STRICTER rate limiting for registration: 3 attempts per hour
  const rateLimit = await checkRateLimit(env, `register:${email}`, 3, 3600000);
  if (!rateLimit.allowed) {
    return error('Too many registration attempts. Try again later.', 429);
  }
  
  // ... rest of register logic
});
```

### Expected Behavior
```
User attempts login for user@example.com:
1. Attempt 1 → Failed ✓
2. Attempt 2 → Failed ✓
3. Attempt 3 → Failed ✓
4. Attempt 4 → Failed ✓
5. Attempt 5 → Failed ✓
6. Attempt 6 → Blocked: "Too many login attempts. Try again in 899 seconds"
7. After 15 min → Allowed again
```

---

## Issue #4: Fix Billing URL Validation

**File:** `public/index.html` lines 2066-2081  
**Risk:** XSS/Redirect vulnerability  
**Time:** 30 minutes  

### ❌ Vulnerable Code
```javascript
async function initiateCheckout(plan) {
  try {
    const response = await fetch('/api/billing/create-checkout', {
      method: 'POST',
      body: JSON.stringify({ plan })
    });
    
    const result = await response.json();
    
    if (!result.url) {
      throw new Error('Invalid response');
    }
    
    // ❌ VULNERABLE: includes() can be bypassed
    const urlObj = new URL(result.url);
    if (!urlObj.hostname.includes('stripe.com')) {  // ← BAD
      throw new Error('Untrusted URL');
    }
    
    // ❌ Could be redirected to fake-stripe.com.attacker.com
    window.location.href = result.url;
  } catch (err) {
    showToast('Error: ' + err.message, 'warning');
  }
}
```

### ✅ Fixed Code
```javascript
async function initiateCheckout(plan) {
  if (!user) {
    showToast('Must be logged in', 'warning');
    return;
  }
  
  const btn = event.target;
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Redirecting to Stripe...';
  
  try {
    const response = await fetch('/api/billing/create-checkout', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('fbToken')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ plan })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const result = await response.json();
    
    // ✅ Validate response structure
    if (!result.url || typeof result.url !== 'string') {
      throw new Error('Invalid server response');
    }
    
    let urlObj;
    try {
      urlObj = new URL(result.url);
    } catch (e) {
      throw new Error('Invalid checkout URL format');
    }
    
    // ✅ SECURE: Strict domain matching (=== not includes)
    if (urlObj.hostname !== 'checkout.stripe.com') {
      console.warn('Rejecting non-Stripe URL:', urlObj.hostname);
      throw new Error('Checkout URL must be from Stripe');
    }
    
    // ✅ Verify HTTPS
    if (urlObj.protocol !== 'https:') {
      throw new Error('Checkout URL must use HTTPS');
    }
    
    // ✅ Safe redirect
    window.location.href = result.url;
  } catch (err) {
    console.error('Checkout error:', err.message);
    showToast('Unable to create checkout session', 'warning');
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}
```

### Testing
```javascript
// These should FAIL:
'https://checkout.stripe.com.evil.com'  // ← Fails (!= exact match)
'https://fake-stripe.com'                // ← Fails
'http://checkout.stripe.com'             // ← Fails (not HTTPS)
'javascript:alert("xss")'                // ← Fails (not URL)

// This should PASS:
'https://checkout.stripe.com/...'        // ← Good!
```

---

## Issue #5: Add Input Validation for Settings

**File:** `public/index.html` Settings section  
**Time:** 45 minutes  

### ❌ Current Code (No Validation)
```html
<!-- Client-side only, can be bypassed -->
<input type="number" id="defaultPomodoro" value="25" min="5" max="60">
<input type="number" id="defaultBreak" value="5" min="1" max="30">

<script>
function saveSettings() {
  // No validation! User could set negative values, non-integers, etc.
  const pomDuration = document.getElementById('defaultPomodoro').value;
  const breakDuration = document.getElementById('defaultBreak').value;
  
  localStorage.setItem('settingsPomodoro', pomDuration);
  localStorage.setItem('settingsBreak', breakDuration);
  
  showToast('Settings saved', 'success');
}
</script>
```

### ✅ Fixed Code
```javascript
function validateSettings() {
  const pom = document.getElementById('defaultPomodoro').value;
  const brk = document.getElementById('defaultBreak').value;
  
  const errors = [];
  
  // Validate pomodoro duration
  const pomInt = parseInt(pom);
  if (!Number.isInteger(pomInt) || pomInt < 1 || pomInt > 120) {
    errors.push('Focus duration must be 1-120 minutes');
  }
  
  // Validate break duration
  const brkInt = parseInt(brk);
  if (!Number.isInteger(brkInt) || brkInt < 1 || brkInt > 60) {
    errors.push('Break duration must be 1-60 minutes');
  }
  
  if (errors.length > 0) {
    errors.forEach(err => showToast(err, 'error'));
    return false;
  }
  
  return { pomDuration: pomInt, breakDuration: brkInt };
}

async function saveSettings() {
  // ✅ Validate client-side
  const validated = validateSettings();
  if (!validated) return;
  
  const { pomDuration, breakDuration } = validated;
  
  // ✅ Save to localStorage
  localStorage.setItem('settingsPomodoro', pomDuration);
  localStorage.setItem('settingsBreak', breakDuration);
  
  // ✅ If logged in, sync to server
  if (user) {
    try {
      const response = await apiCall('/settings/pomodoro', {
        method: 'PUT',
        body: JSON.stringify({ 
          focus_duration_minutes: pomDuration,
          break_duration_minutes: breakDuration
        })
      });
      
      if (!response || !response.ok) {
        throw new Error('Server rejected settings');
      }
      
      showToast('✅ Settings saved', 'success');
    } catch (err) {
      showToast('⚠️ Local save OK, server sync failed', 'warning');
    }
  } else {
    showToast('✅ Settings saved locally', 'info');
  }
}

// Server-side validation (api/src/extended-routes.js)
router.put('/settings/pomodoro', async (request, env) => {
  const auth = await verifyAuth(request, env);
  if (!auth.valid) {
    return errorResponse('Unauthorized', 401);
  }
  
  try {
    const body = await request.json();
    const { focus_duration_minutes, break_duration_minutes } = body;
    
    // ✅ Server-side validation
    if (!Number.isInteger(focus_duration_minutes) || 
        focus_duration_minutes < 1 || 
        focus_duration_minutes > 120) {
      return errorResponse('Invalid focus duration (1-120 minutes)', 400);
    }
    
    if (!Number.isInteger(break_duration_minutes) || 
        break_duration_minutes < 1 || 
        break_duration_minutes > 60) {
      return errorResponse('Invalid break duration (1-60 minutes)', 400);
    }
    
    // Save to database
    await env.DB.prepare(`
      UPDATE settings 
      SET focus_duration_minutes = ?, break_duration_minutes = ?
      WHERE user_id = ?
    `).bind(focus_duration_minutes, break_duration_minutes, auth.userId).run();
    
    return successResponse({
      focus_duration_minutes,
      break_duration_minutes
    });
  } catch (err) {
    return errorResponse(err.message, 500);
  }
});
```

---

## Issue #6: Move Secrets to .env

**Time:** 30 minutes  

### ✅ Create `.env.example`
```bash
# Database
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_TOKEN=your-api-token
D1_DATABASE_ID=your-database-id

# API
API_ORIGIN=https://api.focusbro.net
API_PORT=8787

# CORS
CORS_ALLOWED_ORIGINS=https://focusbro.net,https://www.focusbro.net

# Stripe Billing
STRIPE_SECRET_KEY=sk_live_xxx
STRIPE_PUBLISHABLE_KEY=pk_live_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
STRIPE_PRICE_PRO=price_xxx

# Push Notifications (Web Push API)
VAPID_PUBLIC_KEY=your-public-key
VAPID_PRIVATE_KEY=your-private-key

# Email (optional)
SENDGRID_API_KEY=your-sendgrid-key
SENDGRID_FROM_EMAIL=noreply@focusbro.net

# Error Tracking (optional)
SENTRY_DSN=your-sentry-dsn

# Environment
ENVIRONMENT=development
DEBUG=1
LOG_LEVEL=debug
```

### ✅ Update `wrangler.toml`
```toml
[env.production]
name = "focusbro-api-prod"
route = "https://api.focusbro.net/*"
vars = { ENVIRONMENT = "production", DEBUG = "0", LOG_LEVEL = "error" }
kv_namespaces = [
  { binding = "KV_CACHE", id = "prod-cache-id" }
]

[env.development]
name = "focusbro-api-dev"
route = "http://localhost:8787/*"
vars = { ENVIRONMENT = "development", DEBUG = "1", LOG_LEVEL = "debug" }
kv_namespaces = [
  { binding = "KV_CACHE", id = "dev-cache-id" }
]
```

### ✅ Usage in Code
```javascript
// Before (UNSAFE - hardcoded)
const STRIPE_KEY = 'sk_live_123456...';

// After (SAFE - from environment)
const STRIPE_KEY = env.STRIPE_SECRET_KEY;

// Check for required config
if (!env.STRIPE_SECRET_KEY || !env.VAPID_PRIVATE_KEY) {
  throw new Error('Missing required environment variables. Check .env file.');
}
```

---

## Issue #7: Add Error Logging to Audio Functions

**File:** `public/index.html` audio functions  
**Time:** 15 minutes  

### ❌ Current Code (Silent Failures)
```javascript
function playAmbientTone() {
  try {
    const ctx = initAudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    // ... audio code ...
  } catch(e) {} // ← No logging!
}
```

### ✅ Fixed Code
```javascript
function playAmbientTone() {
  try {
    const ctx = initAudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    // ... audio code ...
    log('✅ Ambient tone played');
  } catch(e) {
    // Audio not supported - log and fallback
    console.warn('⚠️ Audio playback failed:', e.message);
    // Optional: Flash screen or provide other feedback
    flashScreenForNotification();
  }
}

function playNotificationChime() {
  try {
    const ctx = initAudioContext(), now = ctx.currentTime;
    // ... audio code ...
    log('✅ Notification chime played');
  } catch(e) {
    console.warn('⚠️ Notification chime failed:', e.message);
    // Fallback: Show visual notification instead
    showVisualNotification();
  }
}

function flashScreenForNotification() {
  // Visual fallback when audio unavailable
  const flash = document.createElement('div');
  flash.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(255,255,255,0.3);
    display: none;
    z-index: 999999;
  `;
  document.body.appendChild(flash);
  
  // Flash 3 times
  for (let i = 0; i < 3; i++) {
    setTimeout(() => { flash.style.display = 'block'; }, i * 200);
    setTimeout(() => { flash.style.display = 'none'; }, i * 200 + 100);
  }
  
  setTimeout(() => document.body.removeChild(flash), 700);
}
```

---

## Issue #8: Validate API Responses

**File:** `public/index.html` (handleAuth function)  
**Time:** 45 minutes  

### ❌ Assumes Response Structure
```javascript
async function handleAuth(event) {
  // ...
  const data = await response.json();
  
  // ❌ Assumes these fields exist - will crash if missing
  user = { email, name: email.split('@')[0], id: data.user_id };
  localStorage.setItem('fbToken', data.token);
  localStorage.setItem('fbSessionId', data.session_id);
}
```

### ✅ Fixed with Validation
```javascript
async function handleAuth(event) {
  event.preventDefault();
  
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  clearFormErrors();
  
  // Validate inputs
  if (!email || !validateEmail(email)) {
    showFormError('email', 'Invalid email');
    return;
  }
  if (!password || password.length < 8) {
    showFormError('password', 'Password too short');
    return;
  }
  
  const btn = document.getElementById('authBtn2');
  btn.disabled = true;
  btn.classList.add('loading');
  
  try {
    const endpoint = authMode === 'signin' ? '/auth/login' : '/auth/register';
    const response = await fetch(`${env.API_ORIGIN}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      showFormError('email', data.error || 'Authentication failed');
      return;
    }
    
    // ✅ VALIDATE response structure before using
    const data = await response.json();
    
    // Validate required fields
    const validationErrors = [];
    if (!data.user_id || typeof data.user_id !== 'string') {
      validationErrors.push('Invalid user ID in response');
    }
    if (!data.token || typeof data.token !== 'string') {
      validationErrors.push('Invalid token in response');
    }
    if (data.display_name !== undefined && typeof data.display_name !== 'string') {
      validationErrors.push('Invalid display name');
    }
    
    if (validationErrors.length > 0) {
      console.error('Response validation failed:', validationErrors);
      showFormError('email', 'Server response was invalid');
      return;
    }
    
    // ✅ NOW safe to use
    user = {
      id: data.user_id,
      email: email,
      name: data.display_name || email.split('@')[0],
      subscription_tier: data.subscription_tier || 'free',
      created_at: data.created_at || new Date().toISOString()
    };
    
    localStorage.setItem('fbUser', JSON.stringify(user));
    localStorage.setItem('fbToken', data.token);
    if (data.session_id) {
      localStorage.setItem('fbSessionId', data.session_id);
    }
    
    closeModal('authModal');
    setTimeout(() => {
      updateUI();
      showToast(`Welcome, ${user.name}!`, 'success');
    }, 50);
    
  } catch (err) {
    console.error('Auth error:', err);
    showFormError('email', 'Network error - please try again');
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
  }
}
```

---

## Issue #9: Service Worker Error Handling

**File:** `public/sw.js` line 22  
**Time:** 20 minutes  

### ❌ Silent Failures
```javascript
self.addEventListener('install', (event) => {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Caching static assets');
        return cache.addAll(STATIC_ASSETS).catch(err => {
          console.warn('[SW] Some assets failed to cache:', err.message);
          // ❌ Still "succeeds" even if cache failed
        });
      })
      .then(() => self.skipWaiting())
  );
});
```

### ✅ Fixed with Better Error Handling
```javascript
self.addEventListener('install', (event) => {
  console.log('[SW] Installing...');
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        console.log('[SW] Opened cache:', CACHE_NAME);
        
        try {
          await cache.addAll(STATIC_ASSETS);
          console.log('[SW] ✅ All static assets cached successfully');
        } catch (cacheErr) {
          // ✅ Log which assets failed
          console.warn('[SW] ⚠️ Some assets failed to cache:', {
            error: cacheErr.message,
            assets: STATIC_ASSETS,
            timestamp: new Date().toISOString()
          });
          
          // Try to cache what we can (partial cache is better than nothing)
          for (const asset of STATIC_ASSETS) {
            try {
              await cache.add(asset);
              console.log('[SW] Cached (individually):', asset);
            } catch (e) {
              console.warn('[SW] Failed to cache:', asset, e.message);
              // Continue trying other assets
            }
          }
        }
        
        // ✅ Help developers debug caching issues
        await self.skipWaiting();
        console.log('[SW] ✅ Installation complete');
      } catch (err) {
        console.error('[SW] ❌ Installation failed:', err);
        // Don't skip waiting on critical failure
      }
    })()
  );
});

// Also improve activate
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating...');
  event.waitUntil(
    (async () => {
      try {
        const cacheNames = await caches.keys();
        console.log('[SW] Found caches:', cacheNames);
        
        const deleteOld = cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => {
            console.log('[SW] Deleting old cache:', name);
            return caches.delete(name);
          });
        
        await Promise.all(deleteOld);
        await self.clients.claim();
        console.log('[SW] ✅ Activation complete');
      } catch (err) {
        console.error('[SW] ❌ Activation failed:', err);
      }
    })()
  );
});
```

---

## Summary: Time to Fix All 9 Issues

If you follow these exact examples:

| Issue | Time | Difficulty |
|-------|------|-----------|
| Remove console.log | 30m | Easy |
| Fix CORS 'null' | 1h | Medium |
| Add rate limiting | 1h | Medium |
| Fix billing URL validation | 30m | Easy |
| Add input validation | 45m | Medium |
| Move to .env | 30m | Easy |
| Audio error logging | 15m | Easy |
| Validate API responses | 45m | Medium |
| Service Worker errors | 20m | Medium |

**Total: ~5 hours of focused work**

---

**Next:** See `AUDIT_PRIORITIES.md` for Week 1 plan or `CODE_AUDIT_COMPREHENSIVE.md` for full context.
