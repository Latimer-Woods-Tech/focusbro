// ════════════════════════════════════════════════════════════
// FOCUSBRO CLOUDFLARE WORKERS API
// Authentication, sync, data management
// ════════════════════════════════════════════════════════════

import { Router } from 'itty-router';
import extendedRouter from './extended-routes.js';
import htmlContent from './html.js';
import { guides, renderGuidePage, renderGuidesIndex } from './guides/index.js';
import { registerAccountabilityRoutes, nextOccurrenceISO } from './accountability.js';
import { registerCoachRoutes } from './coach.js';
import { registerConsentRoutes } from './consent.js';
import { registerPushRoutes } from './push-routes.js';
import { renderMePage } from './me.js';
import { runDueCheckins } from './checkins-cron.js';
import config from './config.js';
import syncModule from './sync.js';
import billingModule from './billing.js';
import {
  verifyAuth,
  validateEmail,
  validatePassword,
  errorResponse,
  successResponse,
  logEvent,
  extractRequestContext,
  generateUUID
} from './middleware.js';

const router = Router();

function slashRedirect(path) {
  return new Response(null, { status: 301, headers: { Location: path } });
}

function redirectHttpToHttps(request) {
  const url = new URL(request.url);
  const productionHost = url.hostname === 'focusbro.net' || url.hostname.endsWith('.focusbro.net');
  if (url.protocol !== 'http:' || !productionHost) return null;
  url.protocol = 'https:';
  return new Response(null, {
    status: 301,
    headers: {
      Location: url.toString(),
      'Cache-Control': 'public, max-age=3600'
    }
  });
}

function responseWithoutBody(response) {
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

// During the JWT migration, production may carry the old plain-text binding
// (`JWT_SECRET`) while the new secret lands under `JWT_SECRET_NEXT`.
export function withJwtSecretFallback(env) {
  if (!env || env.JWT_SECRET || !env.JWT_SECRET_NEXT) return env;
  return { ...env, JWT_SECRET: env.JWT_SECRET_NEXT };
}

// ── DEBUG LOGGING ──
const DEBUG = false; // Set to true only during development/debugging
const dbLog = (msg, ...args) => {
  if (DEBUG) console.log('[DB]', msg, ...args);
};

// ── RATE LIMITING ──
/**
 * Rate limiter for auth endpoints using KV storage
 * Limits requests per IP to prevent brute force attacks
 */
async function checkRateLimit(request, env, endpoint) {
  // Get client IP from CF headers
  const clientIP = request.headers.get('CF-Connecting-IP') || 
                   request.headers.get('X-Forwarded-For') || 
                   'unknown';
  
  const rateLimitKey = `ratelimit:${endpoint}:${clientIP}`;
  
  try {
    // Get current count from KV
    const countStr = await env.KV_CACHE.get(rateLimitKey);
    const count = countStr ? parseInt(countStr) : 0;
    
    const MAX_ATTEMPTS = config.auth.maxLoginAttempts;
    const TIME_WINDOW = config.auth.rateLimitWindowSeconds;
    
    if (count >= MAX_ATTEMPTS) {
      return {
        limited: true,
        retryAfter: TIME_WINDOW,
        message: 'Too many login attempts. Please try again in 15 minutes.'
      };
    }
    
    // Increment counter and set expiration
    await env.KV_CACHE.put(rateLimitKey, (count + 1).toString(), { expirationTtl: TIME_WINDOW });
    
    return { limited: false };
  } catch (e) {
    // If KV fails, allow the request (fail open)
    console.warn('Rate limit check failed (allowing request):', e.message);
    return { limited: false };
  }
}

// ── DATABASE INITIALIZATION ──
let dbInitialized = false;

async function initializeDatabase(env) {
  try {
    // Only run CREATE statements once
    if (!dbInitialized) {
      dbLog('Initializing database schema...');
      
    const createTableStatements = [
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        first_name TEXT,
        last_name TEXT,
        avatar_url TEXT,
        subscription_tier TEXT DEFAULT 'free',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_login DATETIME,
        is_active INTEGER DEFAULT 1
      )`,
      `CREATE TABLE IF NOT EXISTS user_data_snapshots (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
        user_id TEXT NOT NULL,
        snapshot_data TEXT NOT NULL,
        size_bytes INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS sync_logs (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
        user_id TEXT NOT NULL,
        device_id TEXT,
        action TEXT,
        synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'pending',
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
        user_id TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME,
        is_active INTEGER DEFAULT 1,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
        user_id TEXT NOT NULL,
        device_id TEXT,
        device_name TEXT,
        token TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME,
        is_active INTEGER DEFAULT 1,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
        user_id TEXT,
        action TEXT NOT NULL,
        details TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
      )`,
      // ── PHASE 0: ANALYTICS INFRASTRUCTURE ──
      `CREATE TABLE IF NOT EXISTS focus_events (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
        user_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        tool TEXT,
        duration_seconds INTEGER DEFAULT 0,
        data TEXT DEFAULT '{}',
        client_timestamp DATETIME NOT NULL,
        server_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS user_streaks (
        user_id TEXT PRIMARY KEY,
        current_streak INTEGER DEFAULT 0,
        longest_streak INTEGER DEFAULT 0,
        last_active_date TEXT,
        total_sessions INTEGER DEFAULT 0,
        total_focus_seconds INTEGER DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_events_user_time ON focus_events(user_id, client_timestamp)`,
      `CREATE INDEX IF NOT EXISTS idx_events_type ON focus_events(user_id, event_type)`,
      // ── PHASE 3 TABLES ──
      `CREATE TABLE IF NOT EXISTS push_subscriptions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        device_label TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_active INTEGER DEFAULT 1,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS notification_prefs (
        user_id TEXT PRIMARY KEY,
        morning_motivation INTEGER DEFAULT 0,
        morning_time TEXT DEFAULT '08:00',
        break_reminders INTEGER DEFAULT 1,
        medication_reminders INTEGER DEFAULT 1,
        milestones INTEGER DEFAULT 1,
        custom_schedule TEXT DEFAULT '{}',
        timezone TEXT DEFAULT 'UTC',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_notif_prefs_user ON notification_prefs(user_id)`,
      // ── END PHASE 3 TABLES ──
      // ── PHASE 4 TABLES ──
      `CREATE TABLE IF NOT EXISTS slack_integrations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE,
        webhook_url TEXT,
        access_token TEXT,
        team_id TEXT,
        channel_id TEXT,
        post_sessions INTEGER DEFAULT 1,
        update_presence INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_active INTEGER DEFAULT 1,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_slack_user ON slack_integrations(user_id)`,
      // ── END PHASE 4 TABLES ──
      // ── PHASE 5 TABLES ──
      `CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE,
        stripe_customer_id TEXT UNIQUE,
        stripe_subscription_id TEXT,
        plan TEXT DEFAULT 'free',
        status TEXT DEFAULT 'active',
        current_period_end DATETIME,
        trial_end DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_sub_user ON subscriptions(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_sub_stripe ON subscriptions(stripe_customer_id)`,
      // ── END PHASE 5 TABLES ──
      // ── ACCOUNTABILITY CORE (Contender track, issue #10, Phase A) ──
      `CREATE TABLE IF NOT EXISTS commitments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        details TEXT DEFAULT '',
        start_at DATETIME NOT NULL,
        checkin_at DATETIME,
        channel TEXT DEFAULT 'push',
        persona TEXT DEFAULT 'ally',
        timezone TEXT DEFAULT 'UTC',
        recurrence TEXT DEFAULT 'none',
        local_time TEXT,
        status TEXT DEFAULT 'active',
        rescheduled_from TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS commitment_checkins (
        id TEXT PRIMARY KEY,
        commitment_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        scheduled_for DATETIME NOT NULL,
        channel TEXT DEFAULT 'push',
        status TEXT DEFAULT 'pending',
        responded_at DATETIME,
        note TEXT DEFAULT '',
        delivered_at DATETIME,
        attempts INTEGER DEFAULT 0,
        last_error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(commitment_id) REFERENCES commitments(id) ON DELETE CASCADE,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS accountability_streaks (
        user_id TEXT PRIMARY KEY,
        current_streak INTEGER DEFAULT 0,
        longest_streak INTEGER DEFAULT 0,
        total_kept INTEGER DEFAULT 0,
        last_kept_date TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_commitments_user ON commitments(user_id, status)`,
      `CREATE INDEX IF NOT EXISTS idx_commitments_checkin_at ON commitments(checkin_at)`,
      `CREATE INDEX IF NOT EXISTS idx_checkins_commitment ON commitment_checkins(commitment_id)`,
      `CREATE INDEX IF NOT EXISTS idx_checkins_scheduled ON commitment_checkins(user_id, scheduled_for)`,
      `CREATE INDEX IF NOT EXISTS idx_checkins_due ON commitment_checkins(status, scheduled_for)`,
      // ── COACH ROSTER (skeleton coach dashboard — Contender #10, Phase A) ──
      // Consent-gated coach→client link; coach sees data only when status='active'.
      // Full white-label/wholesale billing is Phase C (operator UNBLOCK gated).
      `CREATE TABLE IF NOT EXISTS coach_clients (
        id TEXT PRIMARY KEY,
        coach_user_id TEXT NOT NULL,
        client_user_id TEXT NOT NULL,
        client_label TEXT DEFAULT '',
        status TEXT DEFAULT 'pending',
        invited_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        responded_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(coach_user_id, client_user_id),
        FOREIGN KEY(coach_user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(client_user_id) REFERENCES users(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_coach_clients_coach ON coach_clients(coach_user_id, status)`,
      `CREATE INDEX IF NOT EXISTS idx_coach_clients_client ON coach_clients(client_user_id, status)`,
      // ── CONTACT CONSENT (TCPA consent-by-construction — Contender #10, Phase A) ──
      // Delivery-side consent state; a text/voice check-in cannot send without a
      // 'granted' row. Quiet hours (recipient-local) hold a due check-in; STOP revokes.
      `CREATE TABLE IF NOT EXISTS contact_consent (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        status TEXT DEFAULT 'granted',
        consent_text TEXT DEFAULT '',
        consent_version TEXT DEFAULT '',
        phone TEXT,
        quiet_start INTEGER,
        quiet_end INTEGER,
        timezone TEXT DEFAULT 'UTC',
        granted_at DATETIME,
        revoked_at DATETIME,
        revoke_source TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, channel),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_contact_consent_user ON contact_consent(user_id, channel)`,
      // ── END ACCOUNTABILITY CORE ──
      `CREATE INDEX IF NOT EXISTS idx_snapshots_user ON user_data_snapshots(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_sync_logs_user ON sync_logs(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id)`
    ];

    // Add missing columns to users table
    const alterTableStatements = [
      `ALTER TABLE users ADD COLUMN avatar_url TEXT`,
      `ALTER TABLE users ADD COLUMN subscription_tier TEXT DEFAULT 'free'`,
      `ALTER TABLE users ADD COLUMN last_login DATETIME`,
      `ALTER TABLE sessions ADD COLUMN is_active INTEGER DEFAULT 1`,
      `ALTER TABLE sessions ADD COLUMN device_id TEXT`,
      `ALTER TABLE sessions ADD COLUMN device_name TEXT`,
      `ALTER TABLE sessions ADD COLUMN last_activity DATETIME DEFAULT CURRENT_TIMESTAMP`
    ];

    for (const sql of createTableStatements) {
      try {
        await env.DB.prepare(sql).run();
      } catch (e) {
        // Table might already exist - this is expected
        // But log if it's something serious
        if (!e.message.includes('already exists') && !e.message.includes('duplicate')) {
          console.warn('DB initialization notice:', e.message.slice(0, 100));
        }
      }
      }
    }

    // Try to add columns - will fail silently if they already exist
    const alterTableStatements = [
      // ── ACCOUNTABILITY delivery cron (Contender #10, Phase A · R-205) ──
      // New columns on the existing production commitment_checkins table so the
      // delivery cron can track send state without recreating the table.
      `ALTER TABLE commitment_checkins ADD COLUMN delivered_at DATETIME`,
      `ALTER TABLE commitment_checkins ADD COLUMN attempts INTEGER DEFAULT 0`,
      `ALTER TABLE commitment_checkins ADD COLUMN last_error TEXT`,
      // Phone for the 'text' check-in channel (Telnyx); null until a user adds one.
      `ALTER TABLE users ADD COLUMN phone TEXT`,
      // ── RECURRING CHECK-INS (Contender #10, Phase A) ──
      // Cadence on the existing production commitments table so "the bro who
      // calls you every day at the same time" works without recreating it.
      `ALTER TABLE commitments ADD COLUMN recurrence TEXT DEFAULT 'none'`,
      `ALTER TABLE commitments ADD COLUMN local_time TEXT`,
    ];
    
    for (const sql of alterTableStatements) {
      try {
        await env.DB.prepare(sql).run();
      } catch (e) {
        // Ignore - column might already exist
        console.debug('Column update note:', e.message.slice(0, 100));
      }
    }
    
    // Verify critical tables exist
    try {
      const userTable = await env.DB.prepare('SELECT COUNT(*) as count FROM users LIMIT 1').first();
      dbLog('✅ Database schema verified - users table accessible');
    } catch (verifyError) {
      console.error('⚠️ Database schema verification failed (requests may fail):', verifyError.message);
    }
    
    dbInitialized = true;
    dbLog('✅ Database initialization complete');
  } catch (e) {
    console.error('❌ Database initialization error:', e.message);
    // Don't throw - let requests continue and handle DB errors individually
  }
}

// ── CORS HEADERS ──
// Restrict to specific origins to prevent CSRF and unauthorized API access
function getCorsHeaders(request) {
  const origin = request.headers.get('Origin');
  const allowedOrigins = [
    'https://focusbro.net',
    'https://www.focusbro.net',
    'http://localhost:3000',
    'http://localhost:8787',
  ];
  
  // ⚠️  SECURITY: Return 'null' for untrusted origins (not a default safe origin)
  const corsOrigin = allowedOrigins.includes(origin) ? origin : 'null';
  
  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': corsOrigin === 'null' ? '' : 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': corsOrigin === 'null' ? '' : 'Content-Type, Authorization',
    'Access-Control-Max-Age': corsOrigin === 'null' ? '' : '86400',
  };
}

const corsHeaders = getCorsHeaders({ headers: new Headers() });

// ── CACHE STRATEGY HELPER ──
/**
 * Get cache control headers based on endpoint characteristics.
 * Reduces bandwidth and server load while keeping data fresh.
 * @param {string} strategy - 'nocache' (auth), 'short' (5min), 'medium' (1hr), 'static' (24hr)
 * @returns {string} Cache-Control header value
 */
function getCacheControl(strategy) {
  const strategies = {
    'nocache': 'no-store, must-revalidate, max-age=0',
    'short': 'private, max-age=300', // 5 minutes for user data, events
    'medium': 'private, max-age=3600', // 1 hour for stats, analytics
    'static': 'private, max-age=86400' // 24 hours for config, settings
  };
  return strategies[strategy] || strategies.nocache;
}

/**
 * Create JSON response with CORS and cache control headers
 * @param {any} data - Data to serialize as JSON
 * @param {number} status - HTTP status code
 * @param {string} cacheStrategy - Cache strategy ('nocache', 'short', 'medium', 'static')
 * @returns {Response}
 */
function jsonResponse(data, status = 200, cacheStrategy = 'nocache') {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      'Cache-Control': getCacheControl(cacheStrategy)
    }
  });
}

// ── UTILITY: Handle CORS ──
router.options('*', (request) => new Response(null, { headers: getCorsHeaders(request) }));

// ── UTILITY: Secure Password Hashing (Web Crypto API) ──
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

// ── UTILITY: Verify Password ──
async function verifyPassword(password, hash) {
  const passwordHash = await hashPassword(password);
  return passwordHash === hash;
}

// ── EXPORT UTILITIES FOR OTHER MODULES ──
export { hashPassword, verifyPassword, generateToken, verifyToken, generateUUID };

/**
 * Generate HMAC-SHA256 JWT token with 30-day expiration.
 * Uses 256-bit key material for cryptographic strength.
 * Token format: header.payload.signature (all base64url encoded)
 * @param {string} userId - User ID for 'sub' claim
 * @param {string} jwtSecret - Secret key (min 32 chars recommended, min 256 bits)
 * @returns {Promise<string>} Signed JWT token
 */
async function generateToken(userId, jwtSecret) {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = btoa(JSON.stringify({
    sub: userId,
    iat: now,
    exp: now + config.auth.tokenExpirationSeconds,
  }));
  
  // Create HMAC-SHA256 signature
  const headerPayload = `${header}.${payload}`;
  const encoder = new TextEncoder();
  const keyData = encoder.encode(jwtSecret);
  const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(headerPayload));
  
  // Convert signature to base64url
  const signatureArray = Array.from(new Uint8Array(signature));
  const signatureBase64 = btoa(String.fromCharCode(...signatureArray))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  
  return `${headerPayload}.${signatureBase64}`;
}

/**
 * Verify HMAC-SHA256 JWT token signature and expiration.
 * Rejects tokens with invalid signature or exp > current time.
 * @param {string} token - JWT token to verify (format: header.payload.signature)
 * @param {string} jwtSecret - Secret key (must match generation key)
 * @returns {Promise<object|null>} Decoded payload or null if invalid
 */
async function verifyToken(token, jwtSecret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    // Re-create signature to verify
    const headerPayload = `${parts[0]}.${parts[1]}`;
    const encoder = new TextEncoder();
    const keyData = encoder.encode(jwtSecret);
    const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    
    // Convert base64url signature back to binary
    const signaturePadded = parts[2] + '='.repeat((4 - parts[2].length % 4) % 4);
    const signatureBinary = atob(signaturePadded.replace(/-/g, '+').replace(/_/g, '/'));
    const signatureArray = new Uint8Array(signatureBinary.length);
    for (let i = 0; i < signatureBinary.length; i++) {
      signatureArray[i] = signatureBinary.charCodeAt(i);
    }
    
    // Verify signature
    const isValid = await crypto.subtle.verify('HMAC', key, signatureArray, encoder.encode(headerPayload));
    if (!isValid) return null;
    
    // Check expiration
    const payload = JSON.parse(atob(parts[1]));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) return null;
    
    return payload;
  } catch (e) {
    console.error('Token verification error:', e.message);
    return null;
  }
}

// ════════════════════════════════════════════════════════════
// AUTHENTICATION ENDPOINTS
// ════════════════════════════════════════════════════════════

// ── REGISTER ──
router.post('/auth/register', async (request, env) => {
  try {
    // ✅ Apply rate limiting
    const rateLimitResult = await checkRateLimit(request, env, 'register');
    if (rateLimitResult.limited) {
      return new Response(JSON.stringify({ error: rateLimitResult.message }), {
        status: 429, // Too Many Requests
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Retry-After': rateLimitResult.retryAfter.toString()
        }
      });
    }
    
    // Parse JSON with error handling
    let body;
    try {
      body = await request.json();
    } catch (jsonErr) {
      return new Response(JSON.stringify({ error: 'Invalid JSON in request body' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    const { email, password } = body;
    
    // Validate input
    if (!email || !password) {
      return new Response(JSON.stringify({ error: 'Email and password required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    if (!email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
      return new Response(JSON.stringify({ error: 'Invalid email format' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    if (!password || password.length < 8) {
      return new Response(JSON.stringify({ error: 'Password must be at least 8 characters' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    // Check if user exists
    const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (existing) {
      return new Response(JSON.stringify({ error: 'Email already registered' }), {
        status: 409,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    const userId = generateUUID();
    const passwordHash = await hashPassword(password);
    
    // Create user
    await env.DB.prepare(
      `INSERT INTO users (id, email, password_hash, created_at, updated_at) 
       VALUES (?, ?, ?, datetime('now'), datetime('now'))`
    ).bind(userId, email, passwordHash).run();
    
    // Create session with proper JWT
    const sessionId = generateUUID();
    const token = await generateToken(userId, env.JWT_SECRET);
    
    await env.DB.prepare(
      `INSERT INTO sessions (id, user_id, token, created_at, expires_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now', '+30 days'))`
    ).bind(sessionId, userId, token).run();
    
    // Log audit
    await env.DB.prepare(
      `INSERT INTO audit_logs (user_id, action, details, created_at)
       VALUES (?, 'register', 'success', datetime('now'))`
    ).bind(userId).run();
    
    return new Response(JSON.stringify({
      success: true,
      user_id: userId,
      email,
      token,
      session_id: sessionId
    }), {
      status: 201,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('[AUTH] Registration error:', error.message);
    return new Response(JSON.stringify({ error: 'Registration failed' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// ── LOGIN ──
router.post('/auth/login', async (request, env) => {
  try {
    // ✅ Apply rate limiting
    const rateLimitResult = await checkRateLimit(request, env, 'login');
    if (rateLimitResult.limited) {
      return new Response(JSON.stringify({ error: rateLimitResult.message }), {
        status: 429, // Too Many Requests
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Retry-After': rateLimitResult.retryAfter.toString()
        }
      });
    }
    
    // Parse JSON with error handling
    let body;
    try {
      body = await request.json();
    } catch (jsonErr) {
      return new Response(JSON.stringify({ error: 'Invalid JSON in request body' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    const { email, password } = body;
    
    // Validate input
    if (!email || !password) {
      return new Response(JSON.stringify({ error: 'Email and password required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    // Find user
    const user = await env.DB.prepare('SELECT id, password_hash FROM users WHERE email = ? AND is_active = 1').bind(email).first();
    
    if (!user) {
      // Generic error to prevent email enumeration attacks
      return new Response(JSON.stringify({ error: 'Invalid email or password' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    // Verify password
    const isValid = await verifyPassword(password, user.password_hash);
    if (!isValid) {
      return new Response(JSON.stringify({ error: 'Invalid email or password' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    // Create session with proper JWT
    const sessionId = generateUUID();
    const token = await generateToken(user.id, env.JWT_SECRET);
    
    await env.DB.prepare(
      `INSERT INTO sessions (id, user_id, token, created_at, expires_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now', '+30 days'))`
    ).bind(sessionId, user.id, token).run();
    
    // Update last_login
    await env.DB.prepare('UPDATE users SET last_login = datetime("now"), updated_at = datetime("now") WHERE id = ?').bind(user.id).run();
    
    // Log audit
    await env.DB.prepare(
      `INSERT INTO audit_logs (user_id, action, details, created_at)
       VALUES (?, 'login', 'success', datetime('now'))`
    ).bind(user.id).run();
    
    return jsonResponse({
      success: true,
      user_id: user.id,
      email,
      token,
      session_id: sessionId
    }, 200, 'nocache');
  } catch (error) {
    console.error('[AUTH] Login error:', error.message);
    return new Response(JSON.stringify({ error: 'Login failed' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// ── TOKEN REFRESH ENDPOINT ──
/**
 * POST /auth/refresh
 * Refresh an expiring JWT token without requiring re-login
 * Uses existing token to validate identity and issue a new token
 */
router.post('/auth/refresh', async (request, env) => {
  try {
    const token = getAuthToken(request);
    
    if (!token) {
      return new Response(JSON.stringify({ error: 'No token provided' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    // Verify existing token (allows expired tokens within grace period)
    const parts = token.split('.');
    if (parts.length !== 3) {
      return new Response(JSON.stringify({ error: 'Invalid token format' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    try {
      // Verify signature even if expired
      const headerPayload = `${parts[0]}.${parts[1]}`;
      const encoder = new TextEncoder();
      const keyData = encoder.encode(env.JWT_SECRET);
      const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
      
      const signaturePadded = parts[2] + '='.repeat((4 - parts[2].length % 4) % 4);
      const signatureBinary = atob(signaturePadded.replace(/-/g, '+').replace(/_/g, '/'));
      const signatureArray = new Uint8Array(signatureBinary.length);
      for (let i = 0; i < signatureBinary.length; i++) {
        signatureArray[i] = signatureBinary.charCodeAt(i);
      }
      
      const isValid = await crypto.subtle.verify('HMAC', key, signatureArray, encoder.encode(headerPayload));
      if (!isValid) {
        return new Response(JSON.stringify({ error: 'Invalid token' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      
      // Extract payload
      const payload = JSON.parse(atob(parts[1]));
      const userId = payload.sub;
      
      // Verify user still exists and is active
      const user = await env.DB.prepare('SELECT id, email FROM users WHERE id = ? AND is_active = 1').bind(userId).first();
      if (!user) {
        return new Response(JSON.stringify({ error: 'User not found or inactive' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      
      // Generate new token
      const newToken = await generateToken(userId, env.JWT_SECRET);
      
      // Update session with new token
      await env.DB.prepare(
        `UPDATE sessions SET token = ?, last_activity = datetime('now')
         WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`
      ).bind(newToken, userId).run();
      
      return new Response(JSON.stringify({
        success: true,
        token: newToken,
        user_id: userId
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    } catch (tokenErr) {
      console.error('[AUTH] Token refresh error:', tokenErr.message);
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  } catch (error) {
    console.error('[AUTH] Refresh endpoint error:', error.message);
    return new Response(JSON.stringify({ error: 'Refresh failed' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// ════════════════════════════════════════════════════════════
// DATA SYNC ENDPOINTS
// ════════════════════════════════════════════════════════════

// ── MIDDLEWARE: Verify Auth ──
function getAuthToken(request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7);
}

// ── SYNC USER DATA (Store/Update) ──
router.post('/sync/data', async (request, env) => {
  try {
    const token = getAuthToken(request);
    if (!token) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    const tokenPayload = await verifyToken(token, env.JWT_SECRET);
    if (!tokenPayload) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    const userId = tokenPayload.sub;
    
    // ✅ TIER CHECK: Verify user has cloud sync access
    const tierCheckResult = await syncModule.validateSyncTier(env, userId);
    if (tierCheckResult.error) {
      return tierCheckResult.response;
    }
    
    const body = await request.json();
    
    // Accept data either as { data: {...} } or directly as {...}
    const data = body.data || body;
    
    if (!data || Object.keys(data).length === 0) {
      return new Response(JSON.stringify({ error: 'Data required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    const dataString = JSON.stringify(data);
    const dataSize = dataString.length;
    
    // Limit data size (avoid abuse - max 10MB per sync)
    const MAX_SYNC_SIZE = 10 * 1024 * 1024;
    if (dataSize > MAX_SYNC_SIZE) {
      return new Response(JSON.stringify({ error: 'Data too large (max 10MB)' }), {
        status: 413,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    try {
      // Store in KV for fast access
      const kvKey = `user:${userId}:latest`;
      await env.KV_CACHE.put(kvKey, dataString, {
        expirationTtl: 365 * 24 * 60 * 60 // 1 year
      });
      
      // Store in D1 for archival
      const snapshotId = await env.DB.prepare(
        `INSERT INTO user_data_snapshots (user_id, snapshot_data, snapshot_size, created_at)
         VALUES (?, ?, ?, datetime('now'))`
      ).bind(userId, dataString, dataSize).run();
      
      // Record sync in logs
      const deviceId = body.device_id || 'web';
      await syncModule.recordSync(env, userId, deviceId, 'data_upload', 'success', dataSize);
      
      return jsonResponse({
        success: true,
        synced_at: new Date().toISOString(),
        size_bytes: dataSize,
        snapshot_id: snapshotId
      }, 200, 'short');
    } catch (error) {
      console.error('[SYNC] Data upload error:', error.message);
      await syncModule.recordSync(env, userId, body.device_id || 'web', 'data_upload', 'error', 0);
      return new Response(JSON.stringify({ error: 'Failed to sync data' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// ── FETCH USER DATA (Retrieve) ──
router.get('/sync/data', async (request, env) => {
  try {
    const token = getAuthToken(request);
    if (!token) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    const tokenPayload = await verifyToken(token, env.JWT_SECRET);
    if (!tokenPayload) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    const userId = tokenPayload.sub;
    
    // ✅ TIER CHECK: Verify user has cloud sync access
    const tierCheckResult = await syncModule.validateSyncTier(env, userId);
    if (tierCheckResult.error) {
      return tierCheckResult.response;
    }
    
    // Try KV first (faster)
    const kvKey = `user:${userId}:latest`;
    let data = await env.KV_CACHE.get(kvKey);
    
    if (data) {
      try {
        await syncModule.recordSync(env, userId, 'web', 'data_download', 'success', data.length);
        return new Response(JSON.stringify({
          success: true,
          data: JSON.parse(data),
          source: 'cache'
        }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (parseError) {
        console.error('[SYNC] Failed to parse cached data:', parseError.message);
        // Fall through to DB if cache is corrupt
      }
    }
    
    // Fallback to D1 (slower but persistent)
    const snapshot = await env.DB.prepare(
      `SELECT snapshot_data FROM user_data_snapshots 
       WHERE user_id = ? 
       ORDER BY created_at DESC 
       LIMIT 1`
    ).bind(userId).first();
    
    if (!snapshot) {
      return new Response(JSON.stringify({
        success: true,
        data: null,
        message: 'No data found'
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    try {
      const parsedData = JSON.parse(snapshot.snapshot_data);
      await syncModule.recordSync(env, userId, 'web', 'data_download', 'success', snapshot.snapshot_data.length);
      return new Response(JSON.stringify({
        success: true,
        data: parsedData,
        source: 'database'
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    } catch (parseError) {
      console.error('[SYNC] Failed to parse database snapshot:', parseError.message);
      await syncModule.recordSync(env, userId, 'web', 'data_download', 'error', 0);
      return new Response(JSON.stringify({
        success: true,
        data: null,
        message: 'Data corrupted, please resync'
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  } catch (error) {
    console.error('[SYNC] Data retrieval error:', error.message);
    return new Response(JSON.stringify({ error: 'Failed to retrieve data' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// ── SYNC ANALYTICS EVENTS ──
router.post('/sync/events', async (request, env) => {
  try {
    const token = getAuthToken(request);
    if (!token) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    const tokenPayload = await verifyToken(token, env.JWT_SECRET);
    if (!tokenPayload) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    const userId = tokenPayload.sub;
    const body = await request.json();
    const events = body.events || [];
    
    // Sync events (analytics tracking)
    const result = await syncModule.syncAnalyticsEvents(env, userId, events);
    
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('[SYNC] Analytics sync error:', error.message);
    return new Response(JSON.stringify({ error: 'Failed to sync events' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// ── REGISTER DEVICE ──
router.post('/sync/devices', async (request, env) => {
  try {
    const token = getAuthToken(request);
    if (!token) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    const tokenPayload = await verifyToken(token, env.JWT_SECRET);
    if (!tokenPayload) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    const userId = tokenPayload.sub;
    const deviceInfo = await request.json();
    
    // Register device for multi-device sync
    const device = await syncModule.registerDevice(env, userId, deviceInfo);
    
    return new Response(JSON.stringify({ success: true, device }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('[SYNC] Device registration error:', error.message);
    return new Response(JSON.stringify({ error: 'Failed to register device' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// ── GET USER DEVICES ──
router.get('/sync/devices', async (request, env) => {
  try {
    const token = getAuthToken(request);
    if (!token) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    const tokenPayload = await verifyToken(token, env.JWT_SECRET);
    if (!tokenPayload) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    const userId = tokenPayload.sub;
    const devices = await syncModule.getUserDevices(env, userId);
    
    return new Response(JSON.stringify({ success: true, devices }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('[SYNC] Device fetch error:', error.message);
    return new Response(JSON.stringify({ error: 'Failed to fetch devices' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// ── GET DATA HISTORY (version control) ──
router.get('/sync/history', async (request, env) => {
  try {
    const token = getAuthToken(request);
    if (!token) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    const tokenPayload = await verifyToken(token, env.JWT_SECRET);
    if (!tokenPayload) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    const userId = tokenPayload.sub;
    const limit = new URL(request.url).searchParams.get('limit') || 10;
    
    const history = await syncModule.getDataHistory(env, userId, parseInt(limit));
    
    return new Response(JSON.stringify({ success: true, history }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('[SYNC] History fetch error:', error.message);
    return new Response(JSON.stringify({ error: 'Failed to fetch history' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// ════════════════════════════════════════════════════════════
// BILLING & STRIPE INTEGRATION
// ════════════════════════════════════════════════════════════

// ── CREATE CHECKOUT SESSION ──
router.post('/api/billing/create-checkout', async (request, env) => {
  try {
    const token = getAuthToken(request);
    if (!token) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    const tokenPayload = await verifyToken(token, env.JWT_SECRET);
    if (!tokenPayload) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    const userId = tokenPayload.sub;
    const { plan } = await request.json();
    
    // Get user email
    const user = await env.DB.prepare(
      'SELECT email, subscription_tier FROM users WHERE id = ?'
    ).bind(userId).first();
    
    if (!user) {
      return new Response(JSON.stringify({ error: 'User not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    // Don't allow checkout if already subscribed
    if (user.subscription_tier !== 'free') {
      return new Response(JSON.stringify({
        error: 'Already subscribed',
        tier: user.subscription_tier,
        message: 'Use billing portal to manage your subscription'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    // Create Stripe checkout session
    const result = await billingModule.createCheckoutSession(env, userId, user.email, plan);
    
    if (!result.success) {
      return new Response(JSON.stringify({ error: result.error || 'Failed to create checkout' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    return new Response(JSON.stringify({
      url: result.url,
      sessionId: result.sessionId
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('[BILLING] Checkout creation error:', error.message);
    return new Response(JSON.stringify({ error: 'Failed to create checkout session' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// ── BILLING PORTAL ──
router.get('/api/billing/portal', async (request, env) => {
  try {
    const token = getAuthToken(request);
    if (!token) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    const tokenPayload = await verifyToken(token, env.JWT_SECRET);
    if (!tokenPayload) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    const userId = tokenPayload.sub;
    
    // Get Stripe customer ID
    const subscription = await env.DB.prepare(
      'SELECT stripe_customer_id FROM stripe_subscriptions WHERE user_id = ?'
    ).bind(userId).first();
    
    if (!subscription || !subscription.stripe_customer_id) {
      return new Response(JSON.stringify({ error: 'No active subscription found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    // Create Stripe billing portal session
    const response = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: `customer=${subscription.stripe_customer_id}&return_url=${env.APP_URL}/billing`
    });
    
    if (!response.ok) {
      const error = await response.json();
      console.error('[BILLING] Portal creation failed:', error);
      throw new Error(`Stripe error: ${error.error?.message || 'Unknown error'}`);
    }
    
    const session = await response.json();
    
    return new Response(JSON.stringify({
      url: session.url
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('[BILLING] Portal error:', error.message);
    return new Response(JSON.stringify({ error: 'Failed to open billing portal' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// ── WEBHOOK HANDLER ──
router.post('/api/billing/webhook', async (request, env) => {
  try {
    // Verify webhook signature
    const verification = await billingModule.verifyWebhookSignature(request, env);
    if (!verification.valid) {
      console.warn('[BILLING] Webhook signature verification failed:', verification.reason);
      return new Response(JSON.stringify({ error: 'Invalid signature' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    // Parse event body
    const body = await request.text();
    const event = JSON.parse(body);
    
    // Process webhook
    const result = await billingModule.processWebhookEvent(env, event);
    
    console.log(`[BILLING] Webhook processed: ${event.type} - ${result.processed ? 'success' : 'skipped'}`);
    
    return new Response(JSON.stringify({
      received: true,
      processed: result.processed
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('[BILLING] Webhook handler error:', error.message);
    // Always return 200 to acknowledge receipt (prevent Stripe retries)
    return new Response(JSON.stringify({
      received: true,
      error: error.message
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// ── GET CURRENT SUBSCRIPTION ──
router.get('/api/billing/tier', async (request, env) => {
  try {
    const token = getAuthToken(request);
    if (!token) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    const tokenPayload = await verifyToken(token, env.JWT_SECRET);
    if (!tokenPayload) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    const userId = tokenPayload.sub;
    const subscription = await billingModule.getUserSubscription(env, userId);
    
    return new Response(JSON.stringify(subscription), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('[BILLING] Tier fetch error:', error.message);
    return new Response(JSON.stringify({ error: 'Failed to fetch tier' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// ════════════════════════════════════════════════════════════
// UTILITY ENDPOINTS
// ════════════════════════════════════════════════════════════

// ── HEALTH CHECK ──
// ── ACCOUNTABILITY CORE ROUTES (Contender track, issue #10, Phase A) ──
// Registered here so the module-private helpers (getAuthToken, verifyToken,
// jsonResponse, generateUUID) are all in scope. Paths are unique
// (/api/commitments*, /api/accountability/streak) so router order is safe.
registerAccountabilityRoutes(router, { getAuthToken, verifyToken, jsonResponse, generateUUID });

// ── COACH ROSTER ROUTES (skeleton coach dashboard — Contender #10, Phase A) ──
// Consent-gated coach→client roster + read-only client views. The dashboard
// PAGE is /coach/ (below). Full white-label is Phase C (operator UNBLOCK gated).
registerCoachRoutes(router, { getAuthToken, verifyToken, jsonResponse, generateUUID });

// ── CONTACT CONSENT ROUTES (TCPA consent-by-construction — Contender #10, Phase A) ──
// Express consent capture + durable STOP opt-out + inbound SMS webhook. The
// delivery cron consumes evaluateContactGate() so no text/voice check-in can be
// sent without granted consent, inside quiet hours, or after opt-out.
registerConsentRoutes(router, { getAuthToken, verifyToken, jsonResponse, generateUUID });

// ── WEB PUSH SUBSCRIPTION INTAKE (Contender #10, Phase A) ──
// The ONLY writer of push_subscriptions. Previously stranded in the unmounted
// extended-routes.js, so the delivery cron always found no subscription and
// every push check-in silently no-op'd. Mounted here on the same router/ctx so
// GET /vapid/public-key + POST /notifications/subscribe are actually reachable.
registerPushRoutes(router, { getAuthToken, verifyToken, jsonResponse, generateUUID });

// ── MANUAL CRON TRIGGER (Contender #10 · R-205) ──
// The same delivery pass the scheduled() handler runs, exposed for verification.
// Guarded by a shared secret; when CRON_TRIGGER_KEY is unset the route 404s so
// it can't be probed. Lets the founder curl a delivery pass on demand instead
// of waiting for the next cron tick.
router.post('/api/internal/run-checkins', async (request, env) => {
  if (!env.CRON_TRIGGER_KEY) return jsonResponse({ error: 'Not found' }, 404);
  const key = request.headers.get('x-cron-key') || '';
  if (key !== env.CRON_TRIGGER_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);
  try {
    const summary = await runDueCheckins(env, { now: new Date().toISOString(), limit: 100 });
    return jsonResponse({ ok: true, summary }, 200);
  } catch (err) {
    console.error('[cron] manual trigger failed:', err && err.message);
    return jsonResponse({ error: 'Delivery pass failed' }, 500);
  }
});

// ── DOGFOOD SEED (Contender #10) ──
// FocusBro's first real accountability user is the founder: a standing daily
// commitment to "send one outreach item" at 08:40 America/New_York (Factory#1960).
// This registers it as a recurring commitment so the moment a delivery channel
// (Telnyx + granted text consent, or push) is configured, the bro starts
// checking in. Guarded by the same shared secret as the manual cron trigger;
// 404s when unset so it can't be probed. Idempotent: re-running returns the
// existing commitment rather than creating a duplicate.
router.post('/api/internal/seed-dogfood', async (request, env) => {
  if (!env.CRON_TRIGGER_KEY) return jsonResponse({ error: 'Not found' }, 404);
  const key = request.headers.get('x-cron-key') || '';
  if (key !== env.CRON_TRIGGER_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);
  try {
    let body;
    try { body = await request.json(); } catch { body = {}; }
    const email = (typeof body.email === 'string' && body.email.trim())
      ? body.email.trim().toLowerCase()
      : 'adrper79@gmail.com';
    const title = (typeof body.title === 'string' && body.title.trim())
      ? body.title.trim().slice(0, 200)
      : 'Send one outreach item';
    const timezone = (typeof body.timezone === 'string' && body.timezone.trim()) || 'America/New_York';
    const localTime = (typeof body.local_time === 'string' && /^\d{1,2}:\d{2}$/.test(body.local_time.trim()))
      ? body.local_time.trim()
      : '08:40';
    const channel = body.channel === 'push' ? 'push' : 'text';

    const user = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).first();
    if (!user) {
      return jsonResponse({ error: `No account for ${email} yet — sign up at /me/ first, then re-seed.` }, 404);
    }

    const existing = await env.DB.prepare(
      `SELECT id, start_at FROM commitments
        WHERE user_id = ? AND title = ? AND recurrence != 'none' AND status = 'active' LIMIT 1`
    ).bind(user.id, title).first();
    if (existing) {
      return jsonResponse({ ok: true, already: true, commitment_id: existing.id, start_at: existing.start_at }, 200);
    }

    const startAt = nextOccurrenceISO({
      recurrence: 'daily', timezone, localTime, afterISO: new Date().toISOString(),
    });
    if (!startAt) return jsonResponse({ error: 'Could not compute the first check-in time.' }, 500);

    const id = generateUUID();
    await env.DB.prepare(
      `INSERT INTO commitments
         (id, user_id, title, details, start_at, checkin_at, channel, persona, timezone, recurrence, local_time, status)
       VALUES (?, ?, ?, '', ?, ?, ?, 'ally', ?, 'daily', ?, 'active')`
    ).bind(id, user.id, title, startAt, startAt, channel, timezone, localTime).run();

    const checkinId = generateUUID();
    await env.DB.prepare(
      `INSERT INTO commitment_checkins (id, commitment_id, user_id, scheduled_for, channel, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`
    ).bind(checkinId, id, user.id, startAt, channel).run();

    return jsonResponse({ ok: true, commitment_id: id, checkin_id: checkinId, start_at: startAt, channel }, 201);
  } catch (err) {
    console.error('[seed-dogfood] failed:', err && err.message);
    return jsonResponse({ error: 'Seed failed' }, 500);
  }
});

router.get('/health', async (request, env) => {
  return new Response(JSON.stringify({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
});

// ── DEBUG API PASSTHROUGH ROUTE ──
router.get('/api/test', async (request, env) => {
  return new Response(JSON.stringify({
    message: 'Direct /api test route works!',
    pathname: new URL(request.url).pathname
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
});

// ── TEST GALLERY ROUTE (hardcoded) ──
router.get('/api/gallery/test', async (request, env) => {
  return new Response(JSON.stringify({
    success: true,
    data: {
      images: [{
        url: 'data:image/svg+xml,<svg></svg>',
        alt: 'Test image',
        title: 'Test Gallery'
      }],
      category: 'test',
      count: 1
    },
    message: 'Hardcoded gallery test endpoint'
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
});

// ── DEBUG ROUTES ENDPOINT ──
router.get('/debug-routes', async (request, env) => {
  // List routes registered in the router
  const routesList = (router.routes || []).map(r => ({
    method: r.method || 'all',
    path: r.path || r.pathname || 'unknown'
  }));
  
  return new Response(JSON.stringify({
    message: 'Registered routes',
    routeCount: routesList.length,
    routes: routesList.slice(0, 20), // First 20 routes
    timestamp: new Date().toISOString()
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
});

// ── API TEST ROUTE (for debugging) ──
router.get('/debug-api', async (request, env) => {
  return new Response(JSON.stringify({
    message: 'Debug endpoint',
    extendedRouter: {
      type: typeof extendedRouter,
      isObject: extendedRouter !== null && typeof extendedRouter === 'object',
      hasFetch: typeof extendedRouter?.fetch === 'function',
      hasRoutes: Array.isArray(extendedRouter?.routes),
      routeCount: extendedRouter?.routes?.length || 0
    }
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
});

// ── ICON-192.PNG ──
router.get('/icon-192.png', async (request, env) => {
  // Serve SVG icon as PNG (browsers handle content-type appropriately)
  const svgIcon = `<svg width="192" height="192" xmlns="http://www.w3.org/2000/svg">
    <rect width="192" height="192" fill="#6366f1" rx="24"/>
    <text x="96" y="110" font-family="Arial, sans-serif" font-size="72" font-weight="bold" text-anchor="middle" fill="white">FB</text>
  </svg>`;
  
  return new Response(svgIcon, {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' }
  });
});

// ── ICON-512.PNG ──
router.get('/icon-512.png', async (request, env) => {
  // Serve larger SVG icon
  const svgIcon = `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
    <rect width="512" height="512" fill="#6366f1" rx="64"/>
    <text x="256" y="295" font-family="Arial, sans-serif" font-size="192" font-weight="bold" text-anchor="middle" fill="white">FB</text>
  </svg>`;
  
  return new Response(svgIcon, {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' }
  });
});

// ── ROOT PAGE (Serve HTML) ──
router.get('/', async (request, env) => {
  return new Response(htmlContent, {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' }
  });
});

router.get('/index.html', async () => {
  return new Response(htmlContent, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' }
  });
});

router.get('/privacy.html', async () => {
  const page = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>FocusBro Privacy Policy</title><meta name="description" content="How FocusBro handles your data, cookies, and third-party advertising, plus your GDPR and CCPA rights and ad opt-out links." /></head>
<body style="font-family:Arial,Helvetica,sans-serif;max-width:860px;margin:0 auto;padding:24px;line-height:1.65;color:#111827;">
<nav style="font-size:14px;color:#374151;"><a href="/">Home</a> | <a href="/terms.html">Terms</a> | <a href="/about.html">About</a> | <a href="/contact.html">Contact</a></nav>
<h1>Privacy Policy</h1>
<p><strong>Last updated: July 10, 2026</strong></p>

<p>FocusBro (focusbro.net) is a browser-first focus and wellness app operated by Latimer Woods Tech. This policy explains what data we handle, how cookies and third-party advertising work on the site, and the choices and rights you have.</p>

<h2>Data stored in your browser</h2>
<p>By default, the content you create in FocusBro &mdash; timer history, notes, gratitude entries, check-ins, and preferences &mdash; is stored locally in your browser using <em>localStorage</em>. This data stays on your device, is not transmitted to us, and is cleared when you clear your browser storage.</p>

<h2>Data sent to our servers</h2>
<p>Some data reaches our servers only when you deliberately use a connected feature:</p>
<ul>
<li><strong>Account &amp; cloud sync</strong> (optional): if you create an account, we store an email address and the synced data you choose to back up, so your sessions are available across devices.</li>
<li><strong>Payments</strong> (optional): paid plans are processed by Stripe. We do not store full card numbers; Stripe handles card data under its own privacy policy.</li>
<li><strong>Basic request logs</strong>: like most websites, our servers may temporarily log IP address, browser type, and requested pages for security and reliability.</li>
</ul>

<h2>Cookies and advertising</h2>
<p>FocusBro displays ads served by <strong>Google AdSense</strong>. To do this, Google and its partners use cookies and similar technologies. Specifically:</p>
<ul>
<li>Third-party vendors, <strong>including Google</strong>, use cookies to serve ads based on a user's prior visits to this website and other websites on the internet.</li>
<li>Google's use of advertising cookies &mdash; including the <strong>DoubleClick</strong> advertising cookie &mdash; enables it and its partners to serve ads to you based on your visit to this site and/or other sites on the internet.</li>
<li>These cookies may be used to measure ad performance and to limit how often you see the same ad.</li>
</ul>

<h2>Your advertising choices &amp; opt-out</h2>
<p>You can control or opt out of personalized advertising:</p>
<ul>
<li>Manage Google's ad personalization at <a href="https://adssettings.google.com" rel="noopener noreferrer" target="_blank">https://adssettings.google.com</a>.</li>
<li>Opt out of interest-based advertising from participating third-party vendors at <a href="https://www.aboutads.info/choices" rel="noopener noreferrer" target="_blank">https://www.aboutads.info/choices</a> (Digital Advertising Alliance).</li>
<li>European users can review vendor choices at <a href="https://www.youronlinechoices.eu" rel="noopener noreferrer" target="_blank">https://www.youronlinechoices.eu</a>.</li>
<li>Most browsers also let you block or delete cookies in their settings.</li>
</ul>
<p>You can read more about how Google uses information from sites that use its services at <a href="https://policies.google.com/technologies/partner-sites" rel="noopener noreferrer" target="_blank">policies.google.com/technologies/partner-sites</a>.</p>

<h2>Your rights (GDPR)</h2>
<p>If you are in the European Economic Area or the UK, you have the right to access, correct, export, restrict, or delete the personal data we hold, to object to certain processing, and to withdraw consent for advertising cookies at any time. To exercise these rights, email <a href="mailto:support@focusbro.net">support@focusbro.net</a>.</p>

<h2>Your rights (CCPA)</h2>
<p>If you are a California resident, you have the right to know what personal information is collected, to request deletion, and to opt out of the "sale" or "sharing" of personal information as those terms are defined by the CCPA/CPRA. We do not sell your personal information for money. To make a request, email <a href="mailto:support@focusbro.net">support@focusbro.net</a>.</p>

<h2>Children</h2>
<p>FocusBro is not directed to children under 13, and we do not knowingly collect personal information from them.</p>

<h2>Changes to this policy</h2>
<p>We may update this policy as the service evolves. Material changes will be reflected by updating the "Last updated" date above.</p>

<h2>Contact</h2>
<p>Privacy questions or data requests: <a href="mailto:support@focusbro.net">support@focusbro.net</a>.</p>
</body></html>`;
  return new Response(page, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
});

router.get('/terms.html', async () => {
  const page = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>FocusBro Terms of Service</title><meta name="description" content="Terms of Service for FocusBro." /></head>
<body style="font-family:Arial,sans-serif;max-width:860px;margin:0 auto;padding:24px;line-height:1.6;color:#111827;">
<nav><a href="/">Home</a> | <a href="/privacy.html">Privacy</a> | <a href="/about.html">About</a> | <a href="/contact.html">Contact</a></nav>
<h1>Terms of Service</h1><p><strong>Last updated: July 10, 2026</strong></p>
<p>FocusBro is provided for lawful productivity and wellness support. This service is informational and not medical advice.</p>
<h2>Advertising</h2><p>FocusBro may display third-party ads. Advertisers are responsible for their own products and claims.</p>
<h2>Contact</h2><p>Questions: <a href="mailto:support@focusbro.net">support@focusbro.net</a>.</p>
</body></html>`;
  return new Response(page, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
});

router.get('/about.html', async () => {
  const page = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>About FocusBro</title><meta name="description" content="What FocusBro is, the focus method behind it, and who builds it." /></head>
<body style="font-family:Arial,Helvetica,sans-serif;max-width:860px;margin:0 auto;padding:24px;line-height:1.65;color:#111827;">
<nav style="font-size:14px;color:#374151;"><a href="/">Home</a> | <a href="/privacy.html">Privacy</a> | <a href="/terms.html">Terms</a> | <a href="/contact.html">Contact</a></nav>
<h1>About FocusBro</h1>

<p>FocusBro is a browser-based focus and wellness toolkit. It brings together the small set of practices that reliably help people start work, stay with it, and recover between efforts: a Pomodoro timer, box and 4-7-8 breathing, a 5-4-3-2-1 grounding exercise, body scans, short movement breaks, a gratitude journal, and reminders to rest your eyes and drink water. Everything runs in the browser, so you can open a session and begin without installing anything or creating an account.</p>

<h2>The method</h2>
<p>The design follows a simple idea from attention research: focus is a finite resource that is spent by sustained effort and restored by deliberate rest. Instead of trying to concentrate for hours at a stretch, FocusBro structures work into timed intervals with real breaks in between, and gives you a short menu of ways to reset &mdash; a few paced breaths, a brief walk, or a moment of grounding &mdash; before the next interval begins. The tools are intentionally short and repeatable, because a practice you will actually do beats an ideal routine you abandon.</p>

<p>We keep the app calm and low-friction on purpose. There are no streak-shaming mechanics, no accounts required for the core tools, and your notes and history stay in your browser by default. The goal is to support your attention, not to compete for it.</p>

<h2>Who builds it</h2>
<p>FocusBro is built and maintained by Latimer Woods Tech. If you have feedback, a bug report, or a request for a tool you wish existed, we would like to hear it &mdash; see the <a href="/contact.html">Contact</a> page. To understand how we handle data and advertising, read our <a href="/privacy.html">Privacy Policy</a>.</p>
</body></html>`;
  return new Response(page, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
});

router.get('/contact.html', async () => {
  const page = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Contact FocusBro</title><meta name="description" content="How to reach FocusBro for support, privacy requests, and business inquiries." /></head>
<body style="font-family:Arial,Helvetica,sans-serif;max-width:860px;margin:0 auto;padding:24px;line-height:1.65;color:#111827;">
<nav style="font-size:14px;color:#374151;"><a href="/">Home</a> | <a href="/privacy.html">Privacy</a> | <a href="/terms.html">Terms</a> | <a href="/about.html">About</a></nav>
<h1>Contact</h1>

<p>FocusBro is built and maintained by Latimer Woods Tech. The best way to reach us is by email, and we read every message.</p>

<h2>Support</h2>
<p>Questions about using the app, bug reports, or feature ideas: <a href="mailto:support@focusbro.net">support@focusbro.net</a>. We aim to reply within two business days.</p>

<h2>Privacy &amp; data requests</h2>
<p>To access, export, or delete your data, or to ask a privacy question, email <a href="mailto:support@focusbro.net">support@focusbro.net</a> with "Privacy" in the subject line. See our <a href="/privacy.html">Privacy Policy</a> for the rights available to you.</p>

<h2>Business inquiries</h2>
<p>Partnerships and other business matters: <a href="mailto:hello@focusbro.net">hello@focusbro.net</a>.</p>
</body></html>`;
  return new Response(page, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
});

// ── COACH DASHBOARD (skeleton, read-only — Contender #10, Phase A) ──
// An operator-facing view of the clients a coach supports and each client's
// kept-word momentum. Self-contained: signs in against /auth/login, stores the
// token in localStorage ('focusbro_token'), and reads the /api/coach/* API.
// Authed surface → noindex, not in the sitemap. DESIGN LAW: momentum only, no
// miss tally. Full white-label (config, wholesale billing) is Phase C.
// ── CONSUMER ACCOUNTABILITY FRONT DOOR (/me/ — Contender #10, Phase A) ──
// The person-facing door to the accountability API: give your word, watch the
// kept-word streak, resolve a check-in as did-it / not-yet / move-it. Reads the
// same /api/commitments + /api/accountability/streak API the coach view reads.
// Authed surface → noindex, no-store, not in the sitemap. DESIGN LAW: a missed
// word is an open door here, never a failure tally.
router.get('/me/', async (request) => {
  if (new URL(request.url).pathname !== '/me/') return slashRedirect('/me/');
  return new Response(renderMePage(), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
});
router.get('/me', async () => slashRedirect('/me/'));

router.get('/coach/', async (request) => {
  if (new URL(request.url).pathname !== '/coach/') return slashRedirect('/coach/');
  const page = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex, nofollow" />
<title>Coach dashboard — FocusBro</title>
<meta name="description" content="A read-only view of the people you support and the words they're keeping." />
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; max-width: 880px; margin: 0 auto; padding: 24px; line-height: 1.55; color: #111827; }
  a { color: #4f46e5; }
  h1 { margin-bottom: 4px; }
  .intro { color: #4b5563; margin-top: 0; }
  .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px 18px; margin: 12px 0; }
  .client { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; align-items: center; }
  .streak { font-size: 28px; font-weight: 700; color: #4f46e5; line-height: 1; }
  .streak small { display: block; font-size: 12px; font-weight: 500; color: #6b7280; }
  .name { font-weight: 600; }
  .line { color: #4b5563; font-size: 14px; }
  .pending { opacity: .7; }
  .muted { color: #6b7280; font-size: 13px; }
  input, button { font-size: 15px; padding: 9px 12px; border-radius: 8px; border: 1px solid #d1d5db; }
  button { background: #4f46e5; color: #fff; border: none; cursor: pointer; }
  button.secondary { background: #f3f4f6; color: #374151; }
  form { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .hidden { display: none; }
  .err { color: #b91c1c; font-size: 14px; }
  .footnote { margin-top: 28px; font-size: 13px; color: #6b7280; border-top: 1px solid #e5e7eb; padding-top: 14px; }
  .rhythm { margin-top: 12px; border-top: 1px dashed #e5e7eb; padding-top: 10px; }
  .rhythm-intro { margin-bottom: 8px; }
  .rhythm-row { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; font-size: 14px; }
  .rhythm-title { color: #111827; }
  .rhythm-cadence { color: #4f46e5; white-space: nowrap; }
  .rhythm-toggle { font-size: 13px; }
</style></head>
<body>
<nav style="font-size:14px;color:#374151;"><a href="/">Home</a> | <a href="/about.html">About</a></nav>
<h1>Coach dashboard</h1>
<p class="intro" id="intro">The people you show up for, and the words they&rsquo;re keeping.</p>

<div id="signin" class="card hidden">
  <p class="muted">Sign in to see your roster.</p>
  <form id="signinForm">
    <input id="email" type="email" placeholder="you@example.com" autocomplete="username" required />
    <input id="password" type="password" placeholder="password" autocomplete="current-password" required />
    <button type="submit">Sign in</button>
  </form>
  <p class="err hidden" id="signinErr"></p>
</div>

<div id="app" class="hidden">
  <div class="card">
    <strong>Invite someone you support</strong>
    <p class="muted">They accept before you see anything &mdash; consent comes first.</p>
    <form id="inviteForm">
      <input id="inviteEmail" type="email" placeholder="their@email.com" required />
      <input id="inviteLabel" type="text" placeholder="a name for you (optional)" />
      <button type="submit">Send invitation</button>
    </form>
    <p class="err hidden" id="inviteMsg"></p>
  </div>
  <div id="roster"></div>
  <p class="muted"><a href="#" id="signout">Sign out</a></p>
</div>

<p class="footnote">
  This is the early skeleton of the coach view. Voice check-ins and the full
  white-label workspace (cadence, scripts, billing) are on the way. What you see
  here is kept-word momentum only &mdash; we count the words people keep, never
  the ones they don&rsquo;t, for you or for them.
</p>

<script>
(function () {
  var TOKEN_KEY = 'focusbro_token';
  var el = function (id) { return document.getElementById(id); };
  var show = function (n) { n.classList.remove('hidden'); };
  var hide = function (n) { n.classList.add('hidden'); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };
  var token = function () { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } };
  var authHeaders = function () { return { 'Authorization': 'Bearer ' + token(), 'Content-Type': 'application/json' }; };

  function render(data) {
    if (data && data.intro) { el('intro').textContent = data.intro; }
    var roster = (data && data.roster) || [];
    var host = el('roster');
    if (!roster.length) {
      host.innerHTML = '<div class="card muted">' + esc((data && data.empty_message) || 'No one on your roster yet.') + '</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < roster.length; i++) {
      var c = roster[i];
      var name = c.label || c.email || 'A client';
      if (c.status === 'active' && c.streak) {
        html += '<div class="card">'
          + '<div class="client">'
          +   '<div><div class="name">' + esc(name) + '</div>'
          +     '<div class="line">' + esc(c.status_line || '') + '</div>'
          +     '<div class="muted">' + esc(c.active_commitments || 0) + ' active commitment' + ((c.active_commitments === 1) ? '' : 's')
          +       ' &middot; <a href="#" class="rhythm-toggle" data-id="' + esc(c.client_id) + '">View rhythm</a></div></div>'
          +   '<div class="streak">' + esc(c.streak.current_streak || 0) + '<small>in a row</small></div>'
          + '</div>'
          + '<div class="rhythm hidden" id="rhythm-' + esc(c.client_id) + '"></div>'
          + '</div>';
      } else {
        html += '<div class="card client pending">'
          + '<div><div class="name">' + esc(name) + '</div>'
          + '<div class="line">' + esc(c.status_line || 'Invited.') + '</div></div>'
          + '<div class="muted">pending</div></div>';
      }
    }
    host.innerHTML = html;
  }

  function renderRhythm(panel, d) {
    var items = (d && d.active_commitments) || [];
    if (!items.length) {
      panel.innerHTML = '<div class="muted">' + esc((d && d.rhythm_empty) || 'Nothing on the books right now.') + '</div>';
      return;
    }
    var out = '<div class="muted rhythm-intro">' + esc((d && d.rhythm_intro) || '') + '</div>';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var tzRaw = (it.timezone && it.timezone !== 'UTC') ? ' (' + it.timezone + ')' : '';
      out += '<div class="rhythm-row"><span class="rhythm-title">' + esc(it.title) + '</span>'
        + '<span class="rhythm-cadence">' + esc((it.cadence || 'One-time') + tzRaw) + '</span></div>';
    }
    panel.innerHTML = out;
  }

  // The roster host is a stable node; delegate rhythm toggles so it survives
  // re-renders. A toggle fetches the client's read-only cadence on demand.
  el('roster').addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('.rhythm-toggle') : null;
    if (!a) return;
    ev.preventDefault();
    var id = a.getAttribute('data-id');
    var panel = document.getElementById('rhythm-' + id);
    if (!panel) return;
    if (!panel.classList.contains('hidden')) { hide(panel); a.textContent = 'View rhythm'; return; }
    a.textContent = 'Loading…';
    fetch('/api/coach/clients/' + encodeURIComponent(id), { headers: authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (data) { renderRhythm(panel, data); show(panel); a.textContent = 'Hide rhythm'; })
      .catch(function () { panel.innerHTML = '<div class="muted">Could not load their rhythm just now.</div>'; show(panel); a.textContent = 'View rhythm'; });
  });

  function loadRoster() {
    fetch('/api/coach/clients', { headers: authHeaders() })
      .then(function (r) {
        if (r.status === 401) { throw new Error('unauthorized'); }
        return r.json();
      })
      .then(function (data) { hide(el('signin')); show(el('app')); render(data); })
      .catch(function () { try { localStorage.removeItem(TOKEN_KEY); } catch (e) {} show(el('signin')); hide(el('app')); });
  }

  el('signinForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    hide(el('signinErr'));
    fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: el('email').value.trim(), password: el('password').value })
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
      .then(function (res) {
        if (!res.ok || !res.b.token) { throw new Error(res.b.error || 'Sign in failed'); }
        try { localStorage.setItem(TOKEN_KEY, res.b.token); } catch (e) {}
        loadRoster();
      })
      .catch(function (e) { var n = el('signinErr'); n.textContent = e.message || 'Sign in failed'; show(n); });
  });

  el('inviteForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var n = el('inviteMsg');
    hide(n);
    fetch('/api/coach/clients', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ email: el('inviteEmail').value.trim(), label: el('inviteLabel').value.trim() })
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
      .then(function (res) {
        n.textContent = res.b.message || res.b.error || 'Invitation sent.';
        n.className = res.ok ? 'muted' : 'err';
        show(n);
        el('inviteEmail').value = ''; el('inviteLabel').value = '';
        if (res.ok) { loadRoster(); }
      })
      .catch(function () { n.textContent = 'Could not send that invitation.'; n.className = 'err'; show(n); });
  });

  el('signout').addEventListener('click', function (ev) {
    ev.preventDefault();
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
    show(el('signin')); hide(el('app'));
  });

  if (token()) { loadRoster(); } else { show(el('signin')); }
})();
</script>
</body></html>`;
  return new Response(page, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
});
router.get('/coach', async () => slashRedirect('/coach/'));

// ── GUIDES (content layer) ──
const GUIDE_HTML_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' };

// Guides index: /guides/ and /guides
router.get('/guides/', async (request) => {
  if (new URL(request.url).pathname !== '/guides/') return slashRedirect('/guides/');
  return new Response(renderGuidesIndex(guides), { status: 200, headers: GUIDE_HTML_HEADERS });
});
router.get('/guides', async () => {
  return slashRedirect('/guides/');
});

// Individual guide pages, registered generically from the guides array.
guides.forEach((guide) => {
  router.get(`/guides/${guide.slug}.html`, async () => {
    return new Response(renderGuidePage(guide), { status: 200, headers: GUIDE_HTML_HEADERS });
  });
});

router.get('/ads.txt', async () => {
  return new Response('google.com, pub-1346297152611586, DIRECT, f08c47fec0942fa0\n', {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }
  });
});

router.get('/robots.txt', async () => {
  return new Response('User-agent: *\nAllow: /\n\nSitemap: https://focusbro.net/sitemap.xml\n', {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }
  });
});

router.get('/sitemap.xml', async () => {
  const guideUrls = guides.map((g) =>
    `  <url><loc>https://focusbro.net/guides/${g.slug}.html</loc><lastmod>${g.lastmod}</lastmod></url>`
  ).join('\n');
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://focusbro.net/</loc></url>
  <url><loc>https://focusbro.net/privacy.html</loc></url>
  <url><loc>https://focusbro.net/terms.html</loc></url>
  <url><loc>https://focusbro.net/about.html</loc></url>
  <url><loc>https://focusbro.net/contact.html</loc></url>
  <url><loc>https://focusbro.net/guides/</loc></url>
${guideUrls}
</urlset>`;
  return new Response(sitemap, {
    status: 200,
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }
  });
});

// ── FAVICON ──
router.get('/favicon.ico', async (request, env) => {
  // Serve professional SVG favicon (monogram "FB")
  const svgFavicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect fill="#1e40af" width="64" height="64"/><text x="32" y="45" font-size="36" font-weight="700" font-family="Inter, sans-serif" fill="#ffffff" text-anchor="middle">FB</text></svg>`;
  return new Response(svgFavicon, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=86400'
    }
  });
});

// ── MANIFEST.JSON (PWA Support) ──
router.get('/manifest.json', async (request, env) => {
  const manifest = {
    "name": "FocusBro - ADHD-Friendly Focus & Wellness",
    "short_name": "FocusBro",
    "description": "Professional focus management with breathing, grounding, and mental wellness tools for ADHD.",
    "start_url": "/",
    "scope": "/",
    "display": "standalone",
    "orientation": "portrait-primary",
    "background_color": "#ffffff",
    "theme_color": "#6366f1",
    "categories": ["productivity", "health", "wellness"],
    "icons": [
      {
        "src": "/favicon.ico",
        "sizes": "16x16 32x32",
        "type": "image/x-icon"
      },
      {
        "src": "/icon-192.png",
        "sizes": "192x192",
        "type": "image/png",
        "purpose": "any"
      },
      {
        "src": "/icon-512.png",
        "sizes": "512x512",
        "type": "image/png",
        "purpose": "any"
      }
    ],
    "shortcuts": [
      {
        "name": "Pomodoro Timer",
        "short_name": "Pomodoro",
        "description": "Start a focused work session",
        "url": "/?view=pomodoro",
        "icons": [{ "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" }]
      },
      {
        "name": "Breathing Exercise",
        "short_name": "Breathing",
        "description": "Guided breathing exercises",
        "url": "/?view=breathing",
        "icons": [{ "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" }]
      }
    ]
  };
  return new Response(JSON.stringify(manifest), {
    status: 200,
    headers: {
      'Content-Type': 'application/manifest+json',
      'Cache-Control': 'public, max-age=86400'
    }
  });
});

// ── SERVICE WORKER ──
router.get('/sw.js', async (request, env) => {
  // Service Worker from embedded HTML content
  const swCode = `/**
 * FocusBro Service Worker
 * Handles push notifications, offline support, and caching strategies
 */

const CACHE_NAME = 'focusbro-v1';
const STATIC_ASSETS = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS)
        .catch(err => {
          // ✅ LOGGING: SW cache failures (e.g., assets unavailable during install)
          console.warn('[SW] Cache install failed:', err.message, '— Will retry on next update');
        })
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(cacheNames => Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

// Push notifications
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let notificationData = {};
  try {
    notificationData = event.data.json();
  } catch (e) {
    notificationData = { title: 'FocusBro', body: event.data.text() };
  }
  const options = {
    icon: '/favicon.ico',
    tag: notificationData.tag || 'focusbro-notification',
    data: notificationData.data || {},
    ...notificationData
  };
  event.waitUntil(
    self.registration.showNotification(notificationData.title || 'FocusBro', options)
  );
});

// Notification clicks
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const targetUrl = data.action === 'open' ? \`/#\${data.view || 'dashboard'}\` : '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        for (let i = 0; i < clientList.length; i++) {
          const client = clientList[i];
          if (client.url === targetUrl && 'focus' in client) {
            return client.focus();
          }
        }
        if (clients.openWindow) return clients.openWindow(targetUrl);
      })
  );
});

// Fetch strategy: network-first for API, cache-first for assets
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;

  if (url.pathname.startsWith('/api/')) {
    return event.respondWith(
      fetch(request)
        .then(response => {
          // Clone immediately to avoid consuming the response
          if (response.ok) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, responseClone));
          }
          return response;
        })
        .catch(err => { console.warn('SW network fetch failed, falling back to cache:', err && err.message || err); return caches.match(request) || new Response(
          JSON.stringify({ error: 'Offline', offline: true }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        ))
    );
  }

  event.respondWith(
    caches.match(request)
      .then(cached => cached || fetch(request)
        .then(response => {
          // Clone immediately to avoid consuming the response
          if (response.ok) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, responseClone));
          }
          return response;
        })
      )
      .catch(err => { console.warn('SW fetch for asset failed, returning index.html from cache:', err && err.message || err); return caches.match('/index.html'); })
  );
});
`;

  return new Response(swCode, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'Service-Worker-Allowed': '/'
    }
  });
});

// ── GALLERY ENDPOINT (Direct in main router) ──
router.get('/api/gallery', async (request, env) => {
  try {
    const url = new URL(request.url);
    const seed = url.searchParams.get('seed') || Math.random().toString();
    let category = url.searchParams.get('category') || 'focus';
    const limit = Math.min(20, Math.max(5, parseInt(url.searchParams.get('limit') || '10')));

    // Safe keyword mappings (whitelist prevents NSFW content)
    const safeKeywords = {
      focus: ['focus work', 'concentration', 'productivity', 'mindfulness', 'deep work'],
      adhd: ['neurodiversity', 'colorful', 'creative chaos', 'vibrant energy', 'flowing'],
      energy: ['lightning', 'electricity', 'bright light', 'glowing', 'power'],
      growth: ['mountain climb', 'progress', 'success', 'achievement', 'growth'],
      brain: ['brain circuits', 'neurons', 'neural', 'mind', 'intelligence'],
      nature: ['forest', 'water', 'calm nature', 'peaceful landscape', 'zen'],
      motivation: ['inspiration', 'celebration', 'success', 'achievement', 'victory'],
    };

    // Randomize category if requested
    if (category === 'random') {
      const categories = Object.keys(safeKeywords);
      const hash = seed.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
      category = categories[hash % categories.length];
    }

    // Validate category
    if (!safeKeywords[category]) {
      return errorResponse('Invalid category', 400);
    }

    const keywords = safeKeywords[category];
    const cacheKey = `gallery:${category}`;
    
    // Check KV cache first
    const cached = await env.KV_CACHE.get(cacheKey);
    let images = [];

    if (cached) {
      images = JSON.parse(cached);
    } else {
      // Fetch from Pexels API (free tier, no auth required for basic requests)
      for (const keyword of keywords) {
        try {
          const response = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(keyword)}&per_page=80&page=1`, {
            headers: {
              'Authorization': env.PEXELS_API_KEY || 'PexelsSignup-Optional',
            }
          });

          if (response.ok) {
            const data = await response.json();
            
            // ✅ SECURITY: Validate Pexels response structure before accessing nested properties
            if (data.photos && Array.isArray(data.photos) && data.photos.length > 0) {
              // Safely extract photo data with defaults
              images = images.concat(data.photos.map(p => {
                // Defensive extraction: use optional chaining + defaults
                return {
                  url: p?.src?.medium || p?.src?.small || '',
                  alt: p?.photographer || 'Photo',
                  source: 'pexels'
                };
              }).filter(img => img.url)); // Filter out invalid entries
            }
          }
        } catch (e) {
          console.warn(`Pexels API error for "${keyword}":`, e.message);
        }
      }

      // Try Unsplash as fallback
      if (images.length < 50) {
        try {
          const keyword = keywords[0];
          const response = await fetch(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(keyword)}&per_page=80&page=1`, {
            headers: {
              'Authorization': 'Client-ID ' + (env.UNSPLASH_ACCESS_KEY || 'demo')
            }
          });

          if (response.ok) {
            const data = await response.json();
            
            // ✅ SECURITY: Validate Unsplash response structure before accessing nested properties
            if (data.results && Array.isArray(data.results) && data.results.length > 0) {
              // Safely extract photo data with defaults
              images = images.concat(data.results.map(p => {
                // Defensive extraction: use optional chaining + defaults
                return {
                  url: p?.urls?.regular || p?.urls?.full || '',
                  alt: p?.user?.name || 'Photo',
                  source: 'unsplash'
                };
              }).filter(img => img.url)); // Filter out invalid entries
            }
          }
        } catch (e) {
          console.warn('Unsplash API error:', e.message);
        }
      }

      // If we got at least some images, cache them (24 hour TTL)
      if (images.length > 0) {
        await env.KV_CACHE.put(cacheKey, JSON.stringify(images), { expirationTtl: 86400 });
      }
    }

    // Seeded random selection (deterministic based on user seed)
    // Same user always gets same images, different users get different random selections
    const seededShuffle = (arr, seed) => {
      const result = [...arr];
      let hash = seed.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
      
      for (let i = result.length - 1; i > 0; i--) {
        hash = (hash * 9301 + 49297) % 233280;
        const j = Math.floor((hash / 233280) * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
      }
      
      return result;
    };

    const shuffled = seededShuffle(images, seed);
    const selected = shuffled.slice(0, limit);

    return successResponse({
      images: selected,
      category,
      count: selected.length,
      total: images.length,
      seed: seed.substring(0, 8) // Return truncated seed
    });

  } catch (error) {
    console.error('Gallery endpoint error:', error.message);
    // Graceful fallback - return empty array, frontend will use local SVG set
    return successResponse({
      images: [],
      error: 'Gallery service temporarily unavailable',
      count: 0
    });
  }
});

// ── 404 Fallback ──
router.all('*', () => new Response(JSON.stringify({ error: 'Not found' }), {
  status: 404,
  headers: { ...corsHeaders, 'Content-Type': 'application/json' }
}));

// ── EXPORT WITH DATABASE INITIALIZATION ──
export default {
  async fetch(request, env, ctx) {
    const runtimeEnv = withJwtSecretFallback(env);
    const httpsRedirect = redirectHttpToHttps(request);
    if (httpsRedirect) return httpsRedirect;

    // Initialize database on first request
    await initializeDatabase(runtimeEnv);
    
    // ✅ BEST PRACTICE: Single unified router with all endpoints
    // Call the router's fetch method which handles request routing
    const routeRequest = request.method === 'HEAD' ? new Request(request, { method: 'GET' }) : request;
    const response = await router.fetch(routeRequest, runtimeEnv);
    return request.method === 'HEAD' ? responseWithoutBody(response) : response;
  },

  // ── SCHEDULED: accountability check-in delivery (Contender #10 · R-205) ──
  // Runs on the wrangler cron trigger. Finds pending check-ins whose time has
  // come and delivers the warm, anti-shame nudge (push/text). Fully guarded:
  // an error here never affects the fetch path or the timer product.
  async scheduled(event, env, ctx) {
    try {
      const runtimeEnv = withJwtSecretFallback(env);
      await initializeDatabase(runtimeEnv);
      const summary = await runDueCheckins(runtimeEnv, { now: new Date().toISOString(), limit: 100 });
      console.log('[cron] check-in delivery:', JSON.stringify(summary));
    } catch (err) {
      console.error('[cron] check-in delivery failed:', err && err.message);
    }
  }
};
