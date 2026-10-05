/**
 * FocusBro Configuration
 * Centralized configuration for all hardcoded values
 */

/**
 * The D1 schema step this build expects (the newest migrations/NNNN_*.sql).
 * Lives here, not in index.js: a Worker entry module may export only handlers —
 * workerd refuses to start on any other named export ("Incorrect type for map
 * entry 'D1_SCHEMA_VERSION'"), which is what broke `wrangler dev --local` (G798).
 */
export const D1_SCHEMA_VERSION = '0014_return_nudge_latch';

/** A guest account's synthetic, non-routable address domain (also not an entry-module export, same reason). */
export const GUEST_EMAIL_DOMAIN = 'guest.invalid';

export const config = {
  // ── Authentication ──
  auth: {
    // JWT token expiration (30 days)
    tokenExpirationSeconds: 30 * 24 * 60 * 60,
    // Max register / guest creates per IP per window
    maxLoginAttempts: 10,
    // Rate limit window (15 minutes)
    rateLimitWindowSeconds: 15 * 60,
    // FBQ-13 login budgets: unsuccessful attempts per 15-minute window. Past a
    // budget the login answers 429 BEFORE the password is checked — even a
    // correct one. Account+IP is the tight key (an attacker elsewhere cannot
    // lock the owner out); account-wide is a high backstop against a spread
    // attack; IP-wide stops one address spraying many accounts.
    loginAccountNetworkFailures: 10,
    loginAccountFailures: 50,
    loginNetworkFailures: 30,
  },

  // ── Data Limits ──
  data: {
    // Maximum stored data size per user
    maxUserDataSize: 10485760, // 10MB
    // Maximum daily sync operations
    maxSyncsPerDay: 1000,
    // Pagination limits
    maxPageSize: 100,
    defaultPageSize: 20,
  },

  // ── Streaks & Tracking ──
  streaks: {
    // Maximum days to check for streak (no need to iterate beyond 2 years)
    maxStreakLookbackDays: 730,
    // Streak reset hour (UTC)
    streakResetHourUTC: 0,
  },

  // ── Error Recovery ──
  retry: {
    // Maximum retry attempts for transient failures
    maxRetries: 3,
    // Base retry delay (ms)
    baseDelayMs: 1000,
    // Exponential backoff multiplier
    backoffMultiplier: 2,
  },

  // ── Timeouts ──
  timeouts: {
    // Database operation timeout (10 seconds)
    dbOperationMs: 10000,
    // API response timeout (30 seconds)
    apiResponseMs: 30000,
    // Webhook delivery timeout (15 seconds)
    webhookTimeoutMs: 15000,
  },

  // ── Feature Flags (Per-Tier Access & Experimental Features) ──
  features: {
    // ── Infrastructure Features ──
    webhookRetries: true,
    compression: true,
    caching: false,
    
    // ── Pro-Only Features ──
    slackIntegration: {
      enabled: true,
      minTier: 'pro', // 'free', 'pro', 'enterprise'
    },
    advancedAnalytics: {
      enabled: true,
      minTier: 'pro',
    },
    customReports: {
      enabled: true,
      minTier: 'pro',
    },
    conflictResolution: {
      enabled: false, // Experimental
      minTier: 'enterprise',
    },
    
    // ── Experimental Features (Beta) ──
    darkModeApi: {
      enabled: true,
      minTier: 'free',
      experimental: true,
    },
    offlineSyncV2: {
      enabled: false,
      minTier: 'free',
      experimental: true,
    },
    aiInsights: {
      enabled: false,
      minTier: 'pro',
      experimental: true,
    },
    // Promise-first home (council plan, move C): the home view is the promise
    // and your words; the toolkit lives one tap away in Focus / Restore.
    // Off by default. Flip here, or at runtime with HOME_PROMISE_FIRST=1;
    // preview any time with /?home=promise (or force the toolkit: ?home=toolkit).
    homePromiseFirst: {
      enabled: false,
      minTier: 'free',
      experimental: true,
    },
  },

  // ── CORS ──
  cors: {
    // Allowed origins (set in production)
    allowedOrigins: [
      'http://localhost:3000',
      'http://localhost:8000',
      'https://focusbro.app',
      'https://www.focusbro.app'
    ],
  },

  // ── Logging ──
  logging: {
    // Enable debug logging (set via DEBUG env var in production)
    debug: false, // Will be overridden at runtime from env.DEBUG
    // Log sensitive data (NEVER in production)
    logSensitiveData: false,
  }
};

export default config;
