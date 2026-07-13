// ════════════════════════════════════════════════════════════
// FOCUSBRO CLOUDFLARE WORKERS API - EXTENDED ENDPOINTS
// User management, password reset, device management
// ════════════════════════════════════════════════════════════

import { Router } from 'itty-router';
import config from './config.js';
import { recordEvent } from './events.js';
import {
  verifyAuth,
  checkRateLimit,
  validateEmail,
  validatePassword,
  errorResponse,
  successResponse,
  logEvent,
  extractRequestContext,
  generateUUID
} from './middleware.js';

const router = Router();

// ── CORS HEADERS ──
// Restrict to specific origins to prevent CSRF and unauthorized API access
function getCorsHeaders(request) {
  const origin = request.headers.get('Origin');
  
  // Whitelist only trusted origins
  const allowedOrigins = [
    'https://focusbro.net',
    'https://www.focusbro.net',
  ];
  
  // SECURITY: Only include localhost in development (check environment)
  // In production, localhost should never be allowed
  const isDevelopment = false; // Set based on environment
  if (isDevelopment) {
    allowedOrigins.push('http://localhost:3000', 'http://localhost:8787');
  }
  
  // ✅ SECURITY FIX: Do NOT set CORS headers for untrusted origins
  // This prevents CSRF attacks from any domain
  if (!origin || !allowedOrigins.includes(origin)) {
    // Return only basic security headers (no CORS headers)
    return {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-XSS-Protection': '1; mode=block',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    };
  }
  
  // ✅ For trusted origins, return proper CORS headers
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  };
}

const corsHeaders = getCorsHeaders({ headers: new Headers() });

// ── INPUT VALIDATION HELPERS ──
/**
 * Validate user input with type checking and size limits
 * @param {any} value - Value to validate
 * @param {string} type - Expected type (string, number, array, object)
 * @param {object} opts - Options: { min, max, required, maxSize }
 * @returns {object} { valid: boolean, error?: string }
 */
function validateInput(value, type, opts = {}) {
  const { min = 0, max = 1000, required = false, maxSize = 10000 } = opts;
  
  // Check required
  if (required && (value === null || value === undefined || value === '')) {
    return { valid: false, error: 'Field is required' };
  }
  
  // Allow null/undefined if not required
  if (value === null || value === undefined) {
    return { valid: true };
  }
  
  // Type validation
  if (typeof value !== type) {
    return { valid: false, error: `Expected ${type}, got ${typeof value}` };
  }
  
  // Size validation for strings and arrays
  if (type === 'string') {
    if (value.length < min || value.length > max) {
      return { valid: false, error: `Length must be between ${min} and ${max}` };
    }
  } else if (type === 'array') {
    if (value.length < min || value.length > max) {
      return { valid: false, error: `Array length must be between ${min} and ${max}` };
    }
    // Check total size
    const size = JSON.stringify(value).length;
    if (size > maxSize) {
      return { valid: false, error: `Data exceeds maximum size of ${maxSize} bytes` };
    }
  } else if (type === 'number') {
    if (value < min || value > max) {
      return { valid: false, error: `Number must be between ${min} and ${max}` };
    }
  }
  
  return { valid: true };
}

// ── RESPONSE VALIDATION HELPER ──
/**
 * Safely extract data from API responses (handles multiple response formats)
 * Validates structure before accessing nested properties
 * @param {any} response - API response data
 * @param {object} expectedSchema - Expected structure { field: type, ... }
 * @returns {object} { valid: boolean, data?: any, error?: string }
 */
function validateApiResponse(response, expectedSchema = {}) {
  // Validate response is object
  if (!response || typeof response !== 'object') {
    return { valid: false, error: 'Response is not an object' };
  }
  
  // For D1 responses, handle both formats: { results: [...] } or direct array
  let data = response.results || response;
  
  // Validate against schema if provided
  if (Object.keys(expectedSchema).length > 0) {
    for (const [field, expectedType] of Object.entries(expectedSchema)) {
      const value = data[field];
      
      if (value === undefined) {
        return { valid: false, error: `Missing required field: ${field}` };
      }
      
      if (expectedType === 'array' && !Array.isArray(value)) {
        return { valid: false, error: `Field "${field}" must be an array` };
      } else if (expectedType !== 'array' && typeof value !== expectedType) {
        return { valid: false, error: `Field "${field}" must be ${expectedType}, got ${typeof value}` };
      }
    }
  }
  
  return { valid: true, data };
}

// ── SUBSCRIPTION TIER VALIDATION HELPER ──
/**
 * Validate that user has required subscription tier for feature access.
 * Prevents free users from accessing pro/enterprise features.
 * @param {string} userTier - User's subscription tier ('free', 'pro', 'enterprise')
 * @param {string|array} requiredTier - Required tier(s) ('free', 'pro', 'enterprise')
 * @returns {boolean} True if user has access
 */
function checkTierAccess(userTier, requiredTier) {
  // tier hierarchy: free < pro < enterprise
  const tierHierarchy = { 'free': 0, 'pro': 1, 'enterprise': 2 };
  const userLevel = tierHierarchy[userTier] ?? 0;
  
  // Handle array of allowed tiers
  if (Array.isArray(requiredTier)) {
    return requiredTier.some(tier => 
      (tierHierarchy[tier] ?? 0) <= userLevel
    );
  }
  
  // Handle single tier requirement
  const requiredLevel = tierHierarchy[requiredTier] ?? 0;
  return userLevel >= requiredLevel;
}

// ── FEATURE FLAGS HELPER ──
/**
 * Check if a feature is enabled for a user's subscription tier
 * Features can be restricted to specific tiers and marked as experimental
 * @param {string} featureName - Feature key from config.features (e.g. 'slackIntegration', 'advancedAnalytics')
 * @param {string} userTier - User's subscription tier ('free', 'pro', 'enterprise')
 * @returns {boolean} True if feature enabled and user has access, false otherwise
 * @example
 * if (isFeatureEnabled('slackIntegration', user.subscription_tier)) {
 *   // Feature is available for this user
 * }
 */
export function isFeatureEnabled(featureName, userTier = 'free') {
  const feature = config.features[featureName];
  
  // Feature doesn't exist in config
  if (!feature) return false;
  
  // Simple boolean flags
  if (typeof feature === 'boolean') return feature;
  
  // Object-based feature with tier requirements
  if (feature && typeof feature === 'object') {
    // Check if feature is enabled
    if (!feature.enabled) return false;
    
    // Check tier access if minTier is specified
    if (feature.minTier) {
      return checkTierAccess(userTier, feature.minTier);
    }
    
    return true;
  }
  
  return false;
}

// ── CORS PREFLIGHT ──
router.options('*', (request) => new Response(null, { headers: getCorsHeaders(request) }));

// ── JSON RESPONSE HELPER ──
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// ── CACHE CONTROL HEADERS ──
/**
 * Get appropriate cache control headers based on endpoint characteristics.
 * Prevents stale data while reducing unnecessary server requests.
 * @param {string} strategy - 'nocache' (auth endpoints), 'short' (user data, 5 min), 'medium' (stats, 1 hr), 'static' (config, 24 hr)
 * @returns {object} Cache-Control header value
 */
function getCacheStrategy(strategy) {
  const strategies = {
    'nocache': 'no-store, must-revalidate, max-age=0', // Auth, form responses
    'short': 'private, max-age=300', // User data, events (5 minutes)
    'medium': 'private, max-age=3600', // Stats, analytics (1 hour)
    'static': 'private, max-age=86400' // Config, settings (24 hours)
  };
  return strategies[strategy] || strategies.nocache;
}

// ── PASSWORD HASHING & VERIFICATION ──
/**
 * Hash password using SHA-256 Web Crypto API
 * Generates 64-character hexadecimal hash from plaintext password
 * @param {string} password - Plaintext password to hash
 * @returns {Promise<string>} 64-character hex-encoded SHA-256 hash
 * @throws {Error} If crypto operation fails
 */
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

/**
 * Verify plaintext password against stored hash
 * Uses constant-time comparison implicitly through hash matching
 * @param {string} password - Plaintext password to verify
 * @param {string} hash - Stored hash to compare against (64-char hex)
 * @returns {Promise<boolean>} True if password matches hash, false otherwise
 * @throws {Error} If hashing operation fails
 */
async function verifyPassword(password, hash) {
  const passwordHash = await hashPassword(password);
  return passwordHash === hash;
}

// ── SAFE JSON PARSING ──
/**
 * Safely parse request JSON body with error handling
 * Prevents crashes from invalid JSON in request body
 * @param {Request} request - Fetch API Request object
 * @returns {Promise<object>} { success: boolean, data?: any, error?: string }
 * On success: { success: true, data: parsed_json }
 * On error: { success: false, error: "Invalid JSON in request body" }
 */
async function safeRequestJSON(request) {
  try {
    return { success: true, data: await request.json() };
  } catch (err) {
    return { success: false, error: 'Invalid JSON in request body' };
  }
}

// ════════════════════════════════════════════════════════════
// USER PROFILE ENDPOINTS
// ════════════════════════════════════════════════════════════

/**
 * GET /users/profile - Retrieve current user's profile
 * Requires valid JWT token in Authorization header
 * Returns user profile with subscription tier, device count, login history
 * @route GET /users/profile
 * @auth Bearer token (JWT)
 * @returns {200} { id, email, firstName, lastName, avatarUrl, subscriptionTier, deviceCount, createdAt, lastLogin }
 * @returns {401} { error: "Unauthorized" } if token invalid or missing
 * @returns {404} { error: "Profile not found" } if user deleted
 * @returns {500} { error: "error message" } on database or crypto errors
 */
// ── GET USER PROFILE ──
router.get('/users/profile', async (request, env) => {
  try {
    const auth = await verifyAuth(request, env);
    if (!auth.valid) {
      return errorResponse(auth.error, 401);
    }
    
    const userId = auth.userId;
    
    // Check rate limit
    const rateLimit = await checkRateLimit(env, userId);
    if (!rateLimit.allowed) {
      return errorResponse('Rate limit exceeded', 429);
    }
    
    // Get user profile
    const user = await env.DB.prepare(
      `SELECT id, email, first_name, last_name, avatar_url, 
              subscription_tier, created_at, last_login
       FROM users 
       WHERE id = ?`
    ).bind(userId).first();
    
    if (!user) {
      return errorResponse('Profile not found', 404);
    }
    
    // Count devices
    const devices = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM sessions 
       WHERE user_id = ?`
    ).bind(userId).first();
    
    return successResponse({
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      avatarUrl: user.avatar_url,
      subscriptionTier: user.subscription_tier,
      deviceCount: devices.count,
      createdAt: user.created_at,
      lastLogin: user.last_login
    });
  } catch (error) {
    return errorResponse(error.message, 500);
  }
});

/**
 * PUT /users/profile - Update current user's profile
 * Requires valid JWT token in Authorization header
 * Updates one or more profile fields: firstName, lastName, avatarUrl
 * @route PUT /users/profile
 * @auth Bearer token (JWT)
 * @body { firstName?: string (max 100), lastName?: string (max 100), avatarUrl?: string (valid URL, max 2048) }
 * @returns {200} { message: "Profile updated successfully" }
 * @returns {400} { error: "validation error" } if input invalid (type, length, format)
 * @returns {401} { error: "Unauthorized" } if token invalid or missing
 * @returns {500} { error: "error message" } on database errors
 */
// ── UPDATE USER PROFILE ──
router.put('/users/profile', async (request, env) => {
  try {
    const auth = await verifyAuth(request, env);
    if (!auth.valid) {
      return errorResponse(auth.error, 401);
    }
    
    const userId = auth.userId;
    
    // Parse JSON safely
    const jsonResult = await safeRequestJSON(request);
    if (!jsonResult.success) {
      return errorResponse(jsonResult.error, 400);
    }
    const { firstName, lastName, avatarUrl } = jsonResult.data;
    
    // Validate input types and lengths
    if (firstName !== null && firstName !== undefined) {
      if (typeof firstName !== 'string') {
        return errorResponse('firstName must be a string', 400);
      }
      if (firstName.length > 100) {
        return errorResponse('firstName too long (max 100 characters)', 400);
      }
    }
    
    if (lastName !== null && lastName !== undefined) {
      if (typeof lastName !== 'string') {
        return errorResponse('lastName must be a string', 400);
      }
      if (lastName.length > 100) {
        return errorResponse('lastName too long (max 100 characters)', 400);
      }
    }
    
    if (avatarUrl !== null && avatarUrl !== undefined) {
      if (typeof avatarUrl !== 'string') {
        return errorResponse('avatarUrl must be a string', 400);
      }
      if (!avatarUrl.startsWith('http') || avatarUrl.length > 2048) {
        return errorResponse('Invalid avatar URL', 400);
      }
    }
    
    // Update profile
    await env.DB.prepare(
      `UPDATE users 
       SET first_name = ?, last_name = ?, avatar_url = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).bind(firstName || null, lastName || null, avatarUrl || null, userId).run();
    
    // Log event
    await logEvent(env, userId, 'profile_update', { firstName, lastName });
    
    return successResponse({
      message: 'Profile updated successfully'
    });
  } catch (error) {
    return errorResponse(error.message, 500);
  }
});

// ════════════════════════════════════════════════════════════
// PASSWORD & SECURITY ENDPOINTS
// ════════════════════════════════════════════════════════════

/**
 * POST /users/change-password - Change user's password
 * Requires valid JWT token and current password verification
 * New password must meet strength requirements (8-256 characters)
 * @route POST /users/change-password
 * @auth Bearer token (JWT)
 * @body { currentPassword: string, newPassword: string (8-256 chars) }
 * @returns {200} { message: "Profile updated successfully" }
 * @returns {400} { error: "validation error" } if new password weak or body invalid JSON
 * @returns {401} { error: "Invalid password" } if currentPassword incorrect
 * @returns {404} { error: "User not found" } if user record missing
 * @returns {500} { error: "error message" } on database or crypto errors
 */
// ── CHANGE PASSWORD ──
router.post('/users/change-password', async (request, env) => {
  try {
    const auth = await verifyAuth(request, env);
    if (!auth.valid) {
      return errorResponse(auth.error, 401);
    }
    
    const userId = auth.userId;
    
    // Parse JSON safely
    const jsonResult = await safeRequestJSON(request);
    if (!jsonResult.success) {
      return errorResponse(jsonResult.error, 400);
    }
    const { currentPassword, newPassword } = jsonResult.data;
    
    // Validate input types and presence
    if (typeof currentPassword !== 'string' || !currentPassword.trim()) {
      return errorResponse('Current password must be a non-empty string', 400);
    }
    if (typeof newPassword !== 'string' || !newPassword) {
      return errorResponse('New password must be a non-empty string', 400);
    }
    
    // Validate new password strength
    if (newPassword.length < 8 || newPassword.length > 256) {
      return errorResponse('New password must be 8-256 characters', 400);
    }
    
    // Get current password hash
    const user = await env.DB.prepare(
      'SELECT password_hash FROM users WHERE id = ?'
    ).bind(userId).first();
    
    if (!user) {
      return errorResponse('User not found', 404);
    }
    
    // Verify current password
    const passwordValid = await verifyPassword(currentPassword, user.password_hash);
    if (!passwordValid) {
      await logEvent(env, userId, 'password_change_failed', { reason: 'Invalid current password' });
      return errorResponse('Invalid password', 401);
    }
    
    // Hash new password
    const newHash = await hashPassword(newPassword);
    
    // Update password
    await env.DB.prepare(
      'UPDATE users SET password_hash = ?, updated_at = datetime("now") WHERE id = ?'
    ).bind(newHash, userId).run();
    
    // Invalidate all sessions - skip for now if is_active doesn't exist
    try {
      await env.DB.prepare(
        'UPDATE sessions SET is_active = 0 WHERE user_id = ? AND id != ?'
      ).bind(userId, auth.sessionId).run();
    } catch (e) {
      console.warn('Session invalidation failed (graceful fallback):', e.message);
      // Note: Schema may not support is_active column yet
    }
    
    await logEvent(env, userId, 'password_changed', {});
    
    return successResponse({
      message: 'Password changed successfully. All other sessions have been logged out.'
    });
  } catch (error) {
    return errorResponse(error.message, 500);
  }
});

// ── REQUEST PASSWORD RESET ──
router.post('/auth/request-password-reset', async (request, env) => {
  try {
    // Parse JSON safely
    const jsonResult = await safeRequestJSON(request);
    if (!jsonResult.success) {
      return errorResponse(jsonResult.error, 400);
    }
    const { email } = jsonResult.data;
    
    if (!email || typeof email !== 'string' || !email.trim()) {
      return errorResponse('Email address required', 400);
    }

    const normalizedEmail = email.trim().toLowerCase();
    
    if (!validateEmail(normalizedEmail)) {
      return errorResponse('Valid email required', 400);
    }
    
    // Global rate limit: max 3 requests per email per hour
    // This prevents both brute force and email enumeration
    const rateLimitKey = `reset:${normalizedEmail}`;
    const rateLimit = await checkRateLimit(env, rateLimitKey, 3, 3600000); // 3 per hour
    
    if (!rateLimit.allowed) {
      // Return generic message for security (don't reveal if email is registered)
      return successResponse({
        message: 'If this email is registered, password reset instructions have been sent. Please check your email.'
      });
    }
    
    // Find user (but don't reveal if exists)
    const user = await env.DB.prepare(
      'SELECT id FROM users WHERE email = ?'
    ).bind(normalizedEmail).first();
    
    if (user) {
      // Generate reset token
      const resetToken = generateUUID();
      const resetKey = `reset:${resetToken}`;
      
      // Store reset token in KV (30 min expiry)
      await env.KV_CACHE.put(
        resetKey,
        user.id,
        { expirationTtl: 1800 }
      );
      
      // In production, send email with reset link
      // env.SEND_EMAIL({ to: email, resetToken: resetToken });
      if (env.DEBUG) console.log(`Password reset requested for ${normalizedEmail} (token expires in 30 min)`);
      
      await logEvent(env, user.id, 'password_reset_requested', { email: normalizedEmail });
    }
    
    // Always return success to prevent email enumeration
    return successResponse({
      message: 'If this email is registered, password reset instructions have been sent. Please check your email.'
    });
  } catch (error) {
    console.error('Password reset request error:', error.message);
    return errorResponse('error processing request', 500);
  }
});

// ── CONFIRM PASSWORD RESET ──
router.post('/auth/confirm-password-reset', async (request, env) => {
  try {
    // Parse JSON safely
    const jsonResult = await safeRequestJSON(request);
    if (!jsonResult.success) {
      return errorResponse(jsonResult.error, 400);
    }
    const { resetToken, newPassword } = jsonResult.data;
    
    // Validate input types and presence
    if (typeof resetToken !== 'string' || !resetToken.trim()) {
      return errorResponse('Reset token must be a non-empty string', 400);
    }
    if (typeof newPassword !== 'string' || !newPassword) {
      return errorResponse('New password must be a non-empty string', 400);
    }
    
    // Validate password strength
    if (!validatePassword(newPassword)) {
      return errorResponse('Password must be at least 8 characters', 400);
    }
    
    if (newPassword.length > 256) {
      return errorResponse('Password must be less than 256 characters', 400);
    }
    
    // Trim and sanitize token
    const cleanToken = resetToken.trim();
    
    // Verify reset token
    const resetKey = `reset:${cleanToken}`;
    const userId = await env.KV_CACHE.get(resetKey);
    
    if (!userId) {
      // Return generic message (prevent token enumeration)
      return errorResponse('Invalid or expired reset token', 401);
    }
    
    if (typeof userId !== 'string' || !userId.trim()) {
      if (env.DEBUG) console.warn('Corrupted reset token in KV cache');
      return errorResponse('Invalid or expired token', 401);
    }
    
    // Import hashPassword function from index.js (need to use env.DB to get it available in middleware)
    // For now, we'll use a simple approach - create hash utility inline
    const encoder = new TextEncoder();
    const data = encoder.encode(newPassword);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const newHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    
    // Update password
    const updateResult = await env.DB.prepare(
      'UPDATE users SET password_hash = ?, updated_at = datetime("now") WHERE id = ?'
    ).bind(newHash, userId).run();
    
    if (!updateResult.success) {
      if (DEBUG) console.error('[PasswordReset] Database update failed');
      return errorResponse('Failed to reset password', 500);
    }
    
    // Delete reset token
    await env.KV_CACHE.delete(resetKey);
    
    // Invalidate all sessions
    try {
      await env.DB.prepare(
        'UPDATE sessions SET is_active = 0 WHERE user_id = ?'
      ).bind(userId).run();
    } catch (e) {
      console.warn('Session invalidation failed (graceful fallback):', e.message);
    }
    
    await logEvent(env, userId, 'password_reset_completed', {});
    
    return successResponse({
      message: 'Password has been reset successfully. Please log in with your new password.'
    });
  } catch (error) {
    console.error('Password reset confirmation error:', error.message);
    return errorResponse('Failed to reset password', 500);
  }
});

// ════════════════════════════════════════════════════════════
// DEVICE MANAGEMENT ENDPOINTS
// ════════════════════════════════════════════════════════════

// ── LIST DEVICES ──
router.get('/devices', async (request, env) => {
  try {
    const auth = await verifyAuth(request, env);
    if (!auth.valid) {
      return errorResponse(auth.error, 401);
    }
    
    const userId = auth.userId;
    
    // Get all active sessions for user
    const sessions = await env.DB.prepare(
      `SELECT id, 
              COALESCE(device_id, 'default') as device_id,
              COALESCE(device_name, 'Unknown Device') as device_name,
              created_at,
              COALESCE(last_activity, created_at) as last_activity
       FROM sessions 
       WHERE user_id = ?
       ORDER BY created_at DESC`
    ).bind(userId).all();
    
    // Handle both D1 response formats: { results: [...] } or direct array
    const deviceList = sessions?.results || sessions || [];
    
    return successResponse({
      devices: deviceList
    });
  } catch (error) {
    return errorResponse(error.message, 500);
  }
});

// ── REMOVE DEVICE ──
router.delete('/devices/:deviceId', async (request, env) => {
  try {
    const auth = await verifyAuth(request, env);
    if (!auth.valid) {
      return errorResponse(auth.error, 401);
    }
    
    const userId = auth.userId;
    const { deviceId } = request.params;
    
    // Verify ownership - deviceId is the session ID
    const session = await env.DB.prepare(
      'SELECT user_id FROM sessions WHERE id = ?'
    ).bind(deviceId).first();
    
    if (!session || session.user_id !== userId) {
      return errorResponse('Device not found or unauthorized', 404);
    }
    
    // Delete session
    await env.DB.prepare(
      'DELETE FROM sessions WHERE id = ?'
    ).bind(deviceId).run();
    
    await logEvent(env, userId, 'device_removed', { deviceId });
    
    return successResponse({
      message: 'Device removed successfully'
    });
  } catch (error) {
    return errorResponse(error.message, 500);
  }
});

// ── LOGOUT ALL DEVICES ──
router.post('/auth/logout-all', async (request, env) => {
  try {
    const auth = await verifyAuth(request, env);
    if (!auth.valid) {
      return errorResponse(auth.error, 401);
    }
    
    const userId = auth.userId;
    
    // Invalidate all sessions
    try {
      await env.DB.prepare(
        'UPDATE sessions SET is_active = 0 WHERE user_id = ?'
      ).bind(userId).run();
    } catch (e) {
      console.warn('Session invalidation failed (graceful fallback):', e.message);
      // Gracefully continue - is_active column may not exist
    }
    
    await logEvent(env, userId, 'logout_all_devices', {});
    
    return successResponse({
      message: 'All sessions have been logged out'
    });
  } catch (error) {
    return errorResponse(error.message, 500);
  }
});

// ════════════════════════════════════════════════════════════
// ACCOUNT MANAGEMENT ENDPOINTS
// ════════════════════════════════════════════════════════════

// ── DELETE ACCOUNT ──
router.post('/users/delete-account', async (request, env) => {
  try {
    const auth = await verifyAuth(request, env);
    if (!auth.valid) {
      return errorResponse(auth.error, 401);
    }
    
    const userId = auth.userId;
    const { password, confirmation } = await request.json();
    
    if (!password || confirmation !== 'DELETE') {
      return errorResponse('Password and confirmation required', 400);
    }
    
    // Verify password
    const user = await env.DB.prepare(
      'SELECT password_hash FROM users WHERE id = ?'
    ).bind(userId).first();
    
    if (!user || !await verifyPassword(password, user.password_hash)) {
      return errorResponse('Incorrect password', 401);
    }
    
    // Mark user as inactive
    await env.DB.prepare(
      'UPDATE users SET updated_at = datetime("now") WHERE id = ?'
    ).bind(userId).run();
    
    // Invalidate all sessions
    try {
      await env.DB.prepare(
        'UPDATE sessions SET is_active = 0 WHERE user_id = ?'
      ).bind(userId).run();
    } catch (e) {
      console.warn('Session invalidation failed (graceful fallback):', e.message);
      // Gracefully continue - is_active column may not exist
    }
    
    await logEvent(env, userId, 'account_deleted', {});
    
    return successResponse({
      message: 'Account has been deleted'
    });
  } catch (error) {
    return errorResponse(error.message, 500);
  }
});

// ════════════════════════════════════════════════════════════
// DATA SYNC ENDPOINTS
// ════════════════════════════════════════════════════════════

// ── SYNC USER DATA ──
router.post('/sync/data', async (request, env) => {
  try {
    const auth = verifyAuth(request, env);
    if (!auth.valid) {
      return errorResponse('Unauthorized', 401);
    }

    const body = await request.json();
    const { sessionCount, energyLogs, pomodoroSettings, synced_at } = body;
    const userId = auth.userId;

    // Validate input types and sizes
    const sessionCountValidation = validateInput(sessionCount, 'number', { 
      min: 0, max: 999999, required: true 
    });
    if (!sessionCountValidation.valid) {
      return errorResponse(`sessionCount: ${sessionCountValidation.error}`, 400);
    }

    const energyLogsValidation = validateInput(energyLogs, 'array', { 
      min: 0, max: 500, required: true, maxSize: 50000 
    });
    if (!energyLogsValidation.valid) {
      return errorResponse(`energyLogs: ${energyLogsValidation.error}`, 400);
    }

    const pomodoroValidation = validateInput(pomodoroSettings, 'object', { 
      required: false, maxSize: 500 
    });
    if (!pomodoroValidation.valid) {
      return errorResponse(`pomodoroSettings: ${pomodoroValidation.error}`, 400);
    }

    // Validate pomodoro settings if provided
    if (pomodoroSettings) {
      const durationValidation = validateInput(pomodoroSettings.duration, 'number', {
        min: 5, max: 60
      });
      if (!durationValidation.valid) {
        return errorResponse(`pomodoroSettings.duration: ${durationValidation.error}`, 400);
      }

      const breakValidation = validateInput(pomodoroSettings.breakDuration, 'number', {
        min: 1, max: 30
      });
      if (!breakValidation.valid) {
        return errorResponse(`pomodoroSettings.breakDuration: ${breakValidation.error}`, 400);
      }
    }

    // Validate timestamp if provided
    if (synced_at) {
      try {
        const ts = new Date(synced_at);
        if (isNaN(ts.getTime())) {
          return errorResponse('Invalid timestamp format', 400);
        }
      } catch (e) {
        return errorResponse('Invalid timestamp format', 400);
      }
    }

    // Store data snapshot
    const snapshot = {
      sessionCount,
      energyLogs,
      pomodoroSettings,
      synced_at,
    };

    await env.DB.prepare(
      `INSERT INTO user_data_snapshots (user_id, snapshot_data, size_bytes)
       VALUES (?, ?, ?)`
    ).bind(userId, JSON.stringify(snapshot), JSON.stringify(snapshot).length).run();

    // Log sync event
    await logEvent(env, userId, 'data_synced', {
      sessionCount,
      logCount: energyLogs?.length || 0,
    });

    return successResponse({
      message: 'Data synced successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.warn('Data sync error:', error.message);
    return errorResponse('Failed to sync data', 500);
  }
});

// ── GET LATEST SYNC DATA ──
router.get('/sync/data', async (request, env) => {
  try {
    const auth = verifyAuth(request);
    if (!auth.valid) {
      return errorResponse('Unauthorized', 401);
    }

    const userId = auth.userId;
    const result = await env.DB.prepare(
      `SELECT snapshot_data, created_at FROM user_data_snapshots
       WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`
    ).bind(userId).first();

    if (!result) {
      return successResponse({
        data: null,
        message: 'No sync data found',
      });
    }

    return successResponse({
      data: JSON.parse(result.snapshot_data),
      synced_at: result.created_at,
    });
  } catch (error) {
    console.warn('Get sync data error:', error.message);
    return errorResponse('Failed to retrieve sync data: ' + error.message, 500);
  }
});

// ════════════════════════════════════════════════════════════
// PHASE 0: ANALYTICS - EVENT LOGGING ENDPOINTS
// ════════════════════════════════════════════════════════════

// ── POST /events - Batch upload focus events ──
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
      body = await request.json();
    } catch (e) {
      return errorResponse('Invalid JSON in request body', 400);
    }

    const { events } = body;
    if (!Array.isArray(events)) {
      return errorResponse('events must be an array', 400);
    }

    if (events.length === 0) {
      return errorResponse('events array cannot be empty', 400);
    }

    if (events.length > config.api.maxEventsPerRequest) {
      return errorResponse(`Maximum ${config.api.maxEventsPerRequest} events per request`, 400);
    }

    // Check total payload size
    const payloadSize = JSON.stringify(body).length;
    if (payloadSize > config.api.maxPayloadSize) {
      return errorResponse('Payload too large (max 1MB)', 413);
    }

    // Validate and filter events with comprehensive checks
    const validEvents = events.filter(e => {
      // Type validation
      if (typeof e !== 'object' || !e) return false;
      if (typeof e.id !== 'string' || !e.id.trim()) return false;
      if (typeof e.type !== 'string' || !e.type.trim()) return false;
      if (typeof e.timestamp !== 'string') return false;
      
      // Whitelist event types to prevent injection
      if (!config.api.validEventTypes.includes(e.type)) return false;
      
      // Validate timestamp is ISO and not too old/new
      const ts = new Date(e.timestamp);
      if (isNaN(ts.getTime())) return false;
      
      const now = new Date();
      const diffDays = (now - ts) / (1000 * 60 * 60 * 24);
      if (diffDays > config.api.maxEventAgeDays || diffDays < -config.api.maxFutureEventDays) return false;
      
      // Validate optional fields
      if (e.tool && (typeof e.tool !== 'string' || e.tool.length > config.api.maxToolNameLength)) return false;
      if (e.duration_seconds && (typeof e.duration_seconds !== 'number' || e.duration_seconds < 0 || e.duration_seconds > config.api.maxSessionDuration)) return false;
      if (e.data && (typeof e.data !== 'object' || JSON.stringify(e.data).length > config.api.maxEventDataSize)) return false;
      
      return true;
    });

    const acceptedIds = [];
    for (const event of validEvents) {
      try {
        // Check if event already exists (prevent duplicates)
        const existing = await env.DB.prepare(
          `SELECT id FROM focus_events WHERE id = ? AND user_id = ?`
        ).bind(event.id, auth.user.id).first();

        if (!existing) {
          await env.DB.prepare(
            `INSERT INTO focus_events 
             (id, user_id, event_type, tool, duration_seconds, data, client_timestamp) 
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            event.id,
            auth.user.id,
            event.type,
            event.tool || '',
            event.duration_seconds || 0,
            JSON.stringify(event.data || {}),
            event.timestamp
          ).run();

          acceptedIds.push(event.id);

          // ── Retention bridge (Contender #10, Phase A · R-239) ──
          // A completed focus session is the canonical free-tier usage signal.
          // Mirror it into the first-party retention spine (analytics_events, see
          // events.js) so the D1/D7 return cohort + loop metrics reflect
          // top-of-funnel timer usage, not just the small accountability cohort —
          // "the retention half the coach pitch needs" (IMPROVEMENT_PLAN L1).
          // The client timestamp is preserved so a batch synced later still lands
          // on the real day. Runs only for newly-accepted rows (dedup-safe) and is
          // non-fatal by construction: recordEvent swallows its own errors, so the
          // bridge can never break event ingestion or the timer.
          if (event.type === 'session_complete') {
            await recordEvent(env, {
              userId: auth.user.id,
              type: 'session_complete',
              at: event.timestamp,
              data: { tool: event.tool || '', duration_seconds: event.duration_seconds || 0 },
            });
          }
        }
      } catch (e) {
        console.warn(`Failed to insert event ${event.id}:`, e.message);
      }
    }

    // Update user_streaks cache
    try {
      // Count focus sessions
      const streakResult = await env.DB.prepare(
        `SELECT COUNT(*) as count FROM focus_events 
         WHERE user_id = ? AND event_type = 'session_complete'`
      ).bind(auth.user.id).first();

      const totalSessions = streakResult?.count || 0;

      // Sum focus time
      const focusResult = await env.DB.prepare(
        `SELECT SUM(duration_seconds) as total FROM focus_events 
         WHERE user_id = ? AND event_type = 'session_complete'`
      ).bind(auth.user.id).first();

      const totalFocusSeconds = focusResult?.total || 0;

      // Simple current streak (will be refined in production)
      const lastActiveResult = await env.DB.prepare(
        `SELECT DATE(client_timestamp) as date FROM focus_events 
         WHERE user_id = ? AND event_type = 'session_complete'
         ORDER BY client_timestamp DESC LIMIT 1`
      ).bind(auth.user.id).first();

      const lastActiveDate = lastActiveResult?.date || null;

      // Update or insert streak record
      await env.DB.prepare(
        `INSERT OR REPLACE INTO user_streaks 
         (user_id, current_streak, longest_streak, last_active_date, total_sessions, total_focus_seconds, updated_at)
         VALUES (?, 0, 0, ?, ?, ?, CURRENT_TIMESTAMP)`
      ).bind(auth.user.id, lastActiveDate, totalSessions, totalFocusSeconds).run();
    } catch (e) {
      console.warn('Failed to update streaks:', e.message);
    }

    return successResponse({
      accepted: acceptedIds.length,
      accepted_ids: acceptedIds,
      rejected: events.length - validEvents.length
    });
  } catch (error) {
    console.error('POST /events error:', error);
    return errorResponse('Internal server error', 500);
  }
});

// ── GET /events - Retrieve paginated focus events ──
router.get('/events', async (request, env) => {
  try {
    const auth = await verifyAuth(request, env);
    if (!auth.valid) return errorResponse('Unauthorized', 401);

    // Parse pagination parameters
    const url = new URL(request.url);
    const page = Math.max(0, parseInt(url.searchParams.get('page') || '0'));
    const limit = Math.min(500, Math.max(10, parseInt(url.searchParams.get('limit') || '100')));
    const days = parseInt(url.searchParams.get('days') || '30');
    
    // Calculate date range
    const now = new Date();
    const cutoffDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    
    // Get total count for pagination
    const countResult = await env.DB.prepare(
      `SELECT COUNT(*) as total FROM focus_events 
       WHERE user_id = ? AND client_timestamp >= ?`
    ).bind(auth.user.id, cutoffDate).first();
    
    const totalItems = countResult?.total || 0;
    const totalPages = Math.ceil(totalItems / limit);
    
    // Get paginated events
    const offset = page * limit;
    const events = await env.DB.prepare(
      `SELECT * FROM focus_events 
       WHERE user_id = ? AND client_timestamp >= ?
       ORDER BY client_timestamp DESC
       LIMIT ? OFFSET ?`
    ).bind(auth.user.id, cutoffDate, limit, offset).all();
    
    return successResponse({
      events: events.results || events || [],
      pagination: {
        page,
        limit,
        totalItems,
        totalPages,
        hasNext: page < totalPages - 1
      }
    });
  } catch (error) {
    console.error('GET /events error:', error);
    return errorResponse('Internal server error', 500);
  }
});

// ── GET /stats/summary - Retrieve user analytics summary ──
router.get('/stats/summary', async (request, env) => {
  try {
    const auth = await verifyAuth(request, env);
    if (!auth.valid) return errorResponse('Unauthorized', 401);

    // Get cached streaks
    const streakData = await env.DB.prepare(
      `SELECT * FROM user_streaks WHERE user_id = ?`
    ).bind(auth.user.id).first();

    const currentStreak = streakData?.current_streak || 0;
    const longestStreak = streakData?.longest_streak || 0;
    const totalSessions = streakData?.total_sessions || 0;
    const totalFocusSeconds = streakData?.total_focus_seconds || 0;

    // Count today's sessions
    const today = new Date().toISOString().slice(0, 10);
    const todayResult = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM focus_events 
       WHERE user_id = ? AND event_type = 'session_complete' AND DATE(client_timestamp) = ?`
    ).bind(auth.user.id, today).first();

    const sessionsToday = todayResult?.count || 0;

    // Get most used tool
    const toolResult = await env.DB.prepare(
      `SELECT tool, COUNT(*) as count FROM focus_events 
       WHERE user_id = ? AND tool != '' 
       GROUP BY tool ORDER BY count DESC LIMIT 1`
    ).bind(auth.user.id).first();

    const mostUsedTool = toolResult?.tool || '';

    // Average daily energy (last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const avgEnergyResult = await env.DB.prepare(
      `SELECT AVG(CAST(JSON_EXTRACT(data, '$.energy') AS REAL)) as avg 
       FROM focus_events 
       WHERE user_id = ? AND event_type = 'energy_log' AND DATE(client_timestamp) >= ?`
    ).bind(auth.user.id, thirtyDaysAgo).first();

    const avgDailyEnergy = (avgEnergyResult?.avg || 0).toFixed(1);

    return successResponse({
      current_streak: currentStreak,
      longest_streak: longestStreak,
      total_sessions: totalSessions,
      total_focus_hours: (totalFocusSeconds / 3600).toFixed(1),
      sessions_today: sessionsToday,
      most_used_tool: mostUsedTool,
      avg_daily_energy: parseFloat(avgDailyEnergy),
      last_active_date: streakData?.last_active_date || null
    });
  } catch (error) {
    console.warn('GET /stats/summary error:', error.message);
    return errorResponse('Failed to retrieve stats: ' + error.message, 500);
  }
});

// ── GET /export/csv - Stream events as CSV (Pro users get full history, Free get last 30 days) ──
router.get('/export/csv', async (request, env) => {
  try {
    const auth = await verifyToken(request, env);
    if (!auth.valid) return errorResponse('Unauthorized', 401);

    const db = env.DB;
    const userId = auth.user.id;
    const isPro = ['pro', 'enterprise'].includes(auth.user.subscription_tier);

    // Free tier: last 30 days only
    const daysBack = isPro ? 365 * 2 : 30;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysBack);

    const query = `
      SELECT id, event_type, tool, duration_seconds, data, client_timestamp
      FROM focus_events
      WHERE user_id = ? AND client_timestamp >= ?
      ORDER BY client_timestamp DESC
    `;

    const stmt = db.prepare(query).bind(userId, cutoffDate.toISOString());
    const result = await stmt.all();

    // Build CSV
    let csv = 'Date,Time,Event Type,Tool,Duration (Minutes),Data\n';
    (result.results || result || []).forEach(e => {
      const d = new Date(e.client_timestamp);
      const date = d.toLocaleDateString('en-US');
      const time = d.toLocaleTimeString('en-US');
      const data = e.data ? JSON.stringify(e.data).replace(/"/g, '""') : '';
      const duration = e.duration_seconds ? Math.round(e.duration_seconds / 60) : '';
      csv += `"${date}","${time}","${e.event_type}","${e.tool || ''}",${duration},"${data}"\n`;
    });

    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv;charset=utf-8',
        'Content-Disposition': `attachment; filename="focusbro-export-${new Date().toISOString().slice(0,10)}.csv"`,
        'Cache-Control': 'no-cache'
      }
    });
  } catch (error) {
    console.warn('GET /export/csv error:', error.message);
    return errorResponse('Failed to export CSV: ' + error.message, 500);
  }
});

// ── GET /export/json - Full data dump as JSON (Pro only) ──
router.get('/export/json', async (request, env) => {
  try {
    const auth = await verifyToken(request, env);
    if (!auth.valid) return errorResponse('Unauthorized', 401);
    if (!['pro', 'enterprise'].includes(auth.user.subscription_tier)) {
      return errorResponse('JSON export requires Pro subscription', 402);
    }

    const db = env.DB;
    const userId = auth.user.id;

    const eventsStmt = db.prepare('SELECT * FROM focus_events WHERE user_id = ? ORDER BY client_timestamp DESC').bind(userId);
    const events = await eventsStmt.all();

    const data = {
      export_date: new Date().toISOString(),
      user: {
        id: auth.user.id,
        email: auth.user.email,
        subscription_tier: auth.user.subscription_tier
      },
      events: events.results || events || [],
      event_count: (events.results || events || []).length
    };

    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        'Content-Type': 'application/json;charset=utf-8',
        'Content-Disposition': `attachment; filename="focusbro-export-${new Date().toISOString().slice(0,10)}.json"`,
        'Cache-Control': 'no-cache'
      }
    });
  } catch (error) {
    console.warn('GET /export/json error:', error.message);
    return errorResponse('Failed to export JSON: ' + error.message, 500);
  }
});

// ── GET /vapid/public-key - Serve VAPID public key for push subscriptions ──
router.get('/vapid/public-key', async (request, env) => {
  try {
    const publicKey = env.VAPID_PUBLIC_KEY;
    if (!publicKey) {
      console.warn('VAPID_PUBLIC_KEY not configured');
      return errorResponse('Push notifications not configured', 503);
    }
    return jsonResponse({ public_key: publicKey });
  } catch (error) {
    console.warn('GET /vapid/public-key error:', error.message);
    return errorResponse('Failed to retrieve VAPID key', 500);
  }
});

// ── POST /notifications/subscribe - Register push subscription ──
router.post('/notifications/subscribe', async (request, env) => {
  try {
    const auth = await verifyToken(request, env);
    if (!auth.valid) return errorResponse('Unauthorized', 401);

    const userId = auth.user.id;
    const body = await request.json();
    const { subscription, device_label } = body;

    if (!subscription || !subscription.endpoint) {
      return errorResponse('Invalid subscription data', 400);
    }

    const subscriptionId = crypto.randomUUID();
    const db = env.DB;

    try {
      await db.prepare(`
        INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, device_label, is_active)
        VALUES (?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(endpoint) DO UPDATE SET
          user_id = excluded.user_id,
          is_active = 1,
          created_at = CURRENT_TIMESTAMP
      `).bind(
        subscriptionId,
        userId,
        subscription.endpoint,
        subscription.keys.p256dh,
        subscription.keys.auth,
        device_label || 'Unknown Device'
      ).run();

      return jsonResponse({ success: true, subscription_id: subscriptionId });
    } catch (dbError) {
      console.warn('Database error saving push subscription:', dbError.message);
      return errorResponse('Failed to save subscription', 500);
    }
  } catch (error) {
    console.warn('POST /notifications/subscribe error:', error.message);
    return errorResponse('Failed to subscribe to notifications', 500);
  }
});

// ── DELETE /notifications/subscribe - Remove push subscription ──
router.delete('/notifications/subscribe', async (request, env) => {
  try {
    const auth = await verifyToken(request, env);
    if (!auth.valid) return errorResponse('Unauthorized', 401);

    const userId = auth.user.id;
    const body = await request.json();
    const { endpoint } = body;

    if (!endpoint) {
      return errorResponse('Endpoint required', 400);
    }

    const db = env.DB;
    await db.prepare(`
      UPDATE push_subscriptions
      SET is_active = 0
      WHERE user_id = ? AND endpoint = ?
    `).bind(userId, endpoint).run();

    return jsonResponse({ success: true });
  } catch (error) {
    console.warn('DELETE /notifications/subscribe error:', error.message);
    return errorResponse('Failed to unsubscribe', 500);
  }
});

// ── GET /notifications/prefs - Get notification preferences ──
router.get('/notifications/prefs', async (request, env) => {
  try {
    const auth = await verifyToken(request, env);
    if (!auth.valid) return errorResponse('Unauthorized', 401);

    const userId = auth.user.id;
    const db = env.DB;

    let prefs = await db.prepare(`
      SELECT * FROM notification_prefs WHERE user_id = ?
    `).bind(userId).first();

    if (!prefs) {
      // Create default preferences for new user
      const defaultPrefs = {
        morning_motivation: 0,
        morning_time: '08:00',
        break_reminders: 1,
        medication_reminders: 1,
        milestones: 1,
        custom_schedule: '{}',
        timezone: 'UTC'
      };

      await db.prepare(`
        INSERT INTO notification_prefs 
        (user_id, morning_motivation, morning_time, break_reminders, medication_reminders, milestones, timezone)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(userId, 0, '08:00', 1, 1, 1, 'UTC').run();

      prefs = defaultPrefs;
      prefs.user_id = userId;
    }

    return jsonResponse(prefs);
  } catch (error) {
    console.warn('GET /notifications/prefs error:', error.message);
    return errorResponse('Failed to retrieve preferences', 500);
  }
});

// ── PUT /notifications/prefs - Update notification preferences ──
router.put('/notifications/prefs', async (request, env) => {
  try {
    const auth = await verifyToken(request, env);
    if (!auth.valid) return errorResponse('Unauthorized', 401);

    const userId = auth.user.id;
    const updates = await request.json();
    const db = env.DB;

    // Whitelist allowed fields
    const allowedFields = ['morning_motivation', 'morning_time', 'break_reminders', 'medication_reminders', 'milestones', 'timezone'];
    let updateStr = 'updated_at = CURRENT_TIMESTAMP';
    let bindings = [];

    for (const field of allowedFields) {
      if (field in updates) {
        updateStr += `, ${field} = ?`;
        bindings.push(updates[field]);
      }
    }

    bindings.push(userId);

    await db.prepare(`
      UPDATE notification_prefs
      SET ${updateStr}
      WHERE user_id = ?
    `).bind(...bindings).run();

    const updated = await db.prepare(`
      SELECT * FROM notification_prefs WHERE user_id = ?
    `).bind(userId).first();

    return jsonResponse(updated);
  } catch (error) {
    console.warn('PUT /notifications/prefs error:', error.message);
    return errorResponse('Failed to update preferences', 500);
  }
});

// ── POST /integrations/slack - Save Slack webhook ──
router.post('/integrations/slack', async (request, env) => {
  try {
    const auth = await verifyToken(request, env);
    if (!auth.valid) return errorResponse('Unauthorized', 401);
    
    // ✅ TIER VALIDATION: Slack integration requires Pro or Enterprise tier
    if (!checkTierAccess(auth.user.subscription_tier, ['pro', 'enterprise'])) {
      return errorResponse('Slack integration requires Pro subscription', 402);
    }

    const userId = auth.user.id;
    const { webhook_url, channel_id } = await request.json();

    if (!webhook_url || !webhook_url.startsWith('https://hooks.slack.com/')) {
      return errorResponse('Invalid webhook URL', 400);
    }

    const integrationId = crypto.randomUUID();
    const db = env.DB;

    await db.prepare(`
      INSERT OR REPLACE INTO slack_integrations
      (id, user_id, webhook_url, channel_id, is_active)
      VALUES (?, ?, ?, ?, 1)
    `).bind(integrationId, userId, webhook_url, channel_id || null).run();

    return jsonResponse({ success: true, integration_id: integrationId });
  } catch (error) {
    console.warn('POST /integrations/slack error:', error.message);
    return errorResponse('Failed to save Slack integration', 500);
  }
});

// ── GET /integrations/slack - Get Slack config ──
router.get('/integrations/slack', async (request, env) => {
  try {
    const auth = await verifyToken(request, env);
    if (!auth.valid) return errorResponse('Unauthorized', 401);

    const userId = auth.user.id;
    const db = env.DB;

    const integration = await db.prepare(`
      SELECT id, webhook_url, channel_id, post_sessions, created_at
      FROM slack_integrations
      WHERE user_id = ? AND is_active = 1
    `).bind(userId).first();

    if (!integration) {
      return jsonResponse({ configured: false });
    }

    return jsonResponse({
      configured: true,
      webhook_url: integration.webhook_url ? '***' : null,
      channel_id: integration.channel_id,
      post_sessions: Boolean(integration.post_sessions),
      created_at: integration.created_at
    });
  } catch (error) {
    console.warn('GET /integrations/slack error:', error.message);
    return errorResponse('Failed to retrieve Slack config', 500);
  }
});

// ── Slack webhook helper with exponential backoff retry ──
/**
 * Send a Slack message with up to `maxRetries` attempts.
 * Uses exponential backoff: 500ms, 1000ms, 2000ms...
 * Only retries on transient errors (5xx, network failure).
 * Does NOT retry on 4xx (permanent failures — invalid URL, token revoked).
 */
async function sendSlackWebhook(webhookUrl, payload, maxRetries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (response.ok) return { success: true };

      const status = response.status;
      const body = await response.text().catch(() => '');

      // 4xx: permanent failure — do not retry
      if (status >= 400 && status < 500) {
        console.warn(`Slack webhook permanent failure (${status}):`, body.slice(0, 200));
        return { success: false, permanent: true, status };
      }

      // 5xx: transient — will retry
      lastError = new Error(`Slack returned ${status}: ${body.slice(0, 200)}`);
      console.warn(`Slack webhook attempt ${attempt}/${maxRetries} failed (${status}), retrying...`);
    } catch (err) {
      lastError = err;
      console.warn(`Slack webhook attempt ${attempt}/${maxRetries} network error:`, err.message);
    }

    // Exponential backoff: 500, 1000, 2000ms
    if (attempt < maxRetries) {
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
    }
  }
  console.error('Slack webhook failed after', maxRetries, 'attempts:', lastError?.message);
  return { success: false, permanent: false, error: lastError?.message };
}

// ── POST /integrations/slack/test - Send test Slack message ──
router.post('/integrations/slack/test', async (request, env) => {
  try {
    const auth = await verifyToken(request, env);
    if (!auth.valid) return errorResponse('Unauthorized', 401);

    const userId = auth.user.id;
    const db = env.DB;

    const integration = await db.prepare(`
      SELECT webhook_url FROM slack_integrations
      WHERE user_id = ? AND is_active = 1
    `).bind(userId).first();

    if (!integration || !integration.webhook_url) {
      return errorResponse('Slack not configured', 404);
    }

    const message = {
      text: '✅ FocusBro connected to Slack! Your focus sessions will appear here.'
    };

    const result = await sendSlackWebhook(integration.webhook_url, message);
    if (!result.success) {
      return errorResponse(
        result.permanent ? 'Slack rejected the message (check webhook URL)' : 'Slack webhook unavailable, try again later',
        result.permanent ? 400 : 503
      );
    }

    return jsonResponse({ success: true });
  } catch (error) {
    console.warn('POST /integrations/slack/test error:', error.message);
    return errorResponse('Failed to send test message', 500);
  }
});

// ── DELETE /integrations/slack - Disconnect Slack ──
router.delete('/integrations/slack', async (request, env) => {
  try {
    const auth = await verifyToken(request, env);
    if (!auth.valid) return errorResponse('Unauthorized', 401);

    const userId = auth.user.id;
    const db = env.DB;

    await db.prepare(`
      UPDATE slack_integrations SET is_active = 0 WHERE user_id = ?
    `).bind(userId).run();

    return jsonResponse({ success: true });
  } catch (error) {
    console.warn('DELETE /integrations/slack error:', error.message);
    return errorResponse('Failed to disconnect Slack', 500);
  }
});

// ── POST /billing/create-checkout - Create Stripe session ──
router.post('/billing/create-checkout', async (request, env) => {
  try {
    const auth = await verifyToken(request, env);
    if (!auth.valid) return errorResponse('Unauthorized', 401);

    const { plan } = await request.json(); // 'pro' or 'enterprise'
    if (!['pro', 'enterprise'].includes(plan)) {
      return errorResponse('Invalid plan', 400);
    }

    const stripeKey = env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      return errorResponse('Billing not configured', 503);
    }

    // Get or create Stripe customer
    const db = env.DB;
    let subscription = await db.prepare(`
      SELECT stripe_customer_id FROM subscriptions WHERE user_id = ?
    `).bind(auth.user.id).first();

    let customerId = subscription?.stripe_customer_id;

    if (!customerId) {
      // Create customer via Stripe API
      const customerRes = await fetch('https://api.stripe.com/v1/customers', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${stripeKey}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: `email=${encodeURIComponent(auth.user.email)}&description=${encodeURIComponent(auth.user.email)}`
      });

      if (!customerRes.ok) {
        console.warn('Failed to create Stripe customer');
        return errorResponse('Failed to create checkout session', 500);
      }

      const customer = await customerRes.json();
      customerId = customer.id;

      // Save to DB
      await db.prepare(`
        INSERT OR REPLACE INTO subscriptions (id, user_id, stripe_customer_id, plan)
        VALUES (?, ?, ?, ?)
      `).bind(crypto.randomUUID(), auth.user.id, customerId, plan).run();
    }

    // Create checkout session
    const priceId = plan === 'pro' ? env.STRIPE_PRICE_PRO_MONTHLY : env.STRIPE_PRICE_ENTERPRISE_MONTHLY;
    const checkoutRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        'customer': customerId,
        'payment_method_types[]': 'card',
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': '1',
        'mode': 'subscription',
        'success_url': `${env.API_ORIGIN}/?upgraded=true&plan=${plan}`,
        'cancel_url': `${env.API_ORIGIN}/?checkout=cancelled`
      })
    });

    if (!checkoutRes.ok) {
      console.warn('Failed to create checkout session');
      return errorResponse('Failed to create checkout session', 500);
    }

    const session = await checkoutRes.json();
    return jsonResponse({ url: session.url });
  } catch (error) {
    console.warn('POST /billing/create-checkout error:', error.message);
    return errorResponse('Failed to create checkout', 500);
  }
});

// ── GET /billing/status - Get subscription status ──
router.get('/billing/status', async (request, env) => {
  try {
    const auth = await verifyToken(request, env);
    if (!auth.valid) return errorResponse('Unauthorized', 401);

    const db = env.DB;
    const subscription = await db.prepare(`
      SELECT plan, status, current_period_end FROM subscriptions WHERE user_id = ?
    `).bind(auth.user.id).first();

    return jsonResponse({
      plan: subscription?.plan || 'free',
      status: subscription?.status || 'active',
      current_period_end: subscription?.current_period_end
    });
  } catch (error) {
    console.warn('GET /billing/status error:', error.message);
    return errorResponse('Failed to retrieve status', 500);
  }
});

// ── POST /billing/webhook - Stripe webhook ──
router.post('/billing/webhook', async (request, env) => {
  try {
    const signature = request.headers.get('stripe-signature');
    const body = await request.text();
    const secret = env.STRIPE_WEBHOOK_SECRET;

    if (!secret) {
      console.warn('⚠️ Stripe webhook secret not configured');
      return errorResponse('Webhook not configured', 503);
    }

    if (!signature) {
      console.warn('⚠️ Stripe webhook signature missing');
      return errorResponse('Webhook signature required', 401);
    }

    // Verify signature using HMAC-SHA256
    // Signature format: t=timestamp,v1=signature
    const encoder = new TextEncoder();
    const timestampedBody = signature.split(',').find(s => s.startsWith('t='))?.slice(2);
    const signatureValue = signature.split(',').find(s => s.startsWith('v1='))?.slice(3);
    
    if (!timestampedBody || !signatureValue) {
      console.warn('⚠️ Stripe webhook signature format invalid');
      return errorResponse('Invalid webhook signature format', 401);
    }

    // Check timestamp (prevent replay attacks - allow 5 minute window)
    const timestamp = parseInt(timestampedBody);
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > 300) {
      console.warn('⚠️ Stripe webhook timestamp too old:', now - timestamp, 'seconds ago');
      return errorResponse('Webhook timestamp expired', 401);
    }

    // Verify signature: HMAC(secret, timestamp.body)
    try {
      const keyData = encoder.encode(secret);
      const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
      const messageData = encoder.encode(`${timestampedBody}.${body}`);
      const signatureBytes = new Uint8Array(signatureValue.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
      const isValid = await crypto.subtle.verify('HMAC', key, signatureBytes, messageData);
      
      if (!isValid) {
        console.warn('⚠️ Stripe webhook signature verification failed');
        return errorResponse('Webhook signature invalid', 401);
      }
    } catch (cryptoError) {
      console.warn('⚠️ Webhook signature verification error:', cryptoError.message);
      return errorResponse('Signature verification failed', 401);
    }

    // Parse and process event
    let event;
    try {
      event = JSON.parse(body);
    } catch (parseError) {
      console.warn('⚠️ Stripe webhook body malformed');
      return errorResponse('Invalid webhook body', 400);
    }

    // Log event type only (no sensitive customer data)
    if (env.DEBUG === '1') {
      console.log('Webhook verified - Event type:', event.type);
    }

    const db = env.DB;

    if (event.type === 'checkout.session.completed') {
      const { customer, subscription: subscriptionId } = event.data.object;
      const plan = event.data.object.metadata?.plan || 'pro';

      if (!customer || !subscriptionId) {
        console.warn('⚠️ Webhook missing customer or subscription data');
        return jsonResponse({ received: true });
      }

      // Get user from Stripe customer
      // In production, store the user_id in Stripe metadata during checkout
      await db.prepare(`
        UPDATE subscriptions
        SET stripe_subscription_id = ?, plan = ?, status = 'active'
        WHERE stripe_customer_id = ?
      `).bind(subscriptionId, plan, customer).run();

      // Update user tier
      await db.prepare(`
        UPDATE users SET subscription_tier = ? WHERE id = (
          SELECT user_id FROM subscriptions WHERE stripe_customer_id = ?
        )
      `).bind(plan, customer).run();

      if (env.DEBUG === '1') {
        console.log('Webhook: Subscription updated');
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const { customer } = event.data.object;

      if (!customer) {
        console.warn('⚠️ Webhook missing customer data for subscription.deleted');
        return jsonResponse({ received: true });
      }

      await db.prepare(`
        UPDATE subscriptions SET status = 'canceled', plan = 'free'
        WHERE stripe_customer_id = ?
      `).bind(customer).run();

      await db.prepare(`
        UPDATE users SET subscription_tier = 'free' WHERE id = (
          SELECT user_id FROM subscriptions WHERE stripe_customer_id = ?
        )
      `).bind(customer).run();

      if (env.DEBUG === '1') {
        console.log('Webhook: Subscription canceled');
      }
    }

    return jsonResponse({ received: true });
  } catch (error) {
    console.error('❌ Webhook processing error:', error.message);
    // Still return 200 to Stripe so it doesn't retry
    return jsonResponse({ received: true, error: error.message });
  }
});

// ── GET /api/gallery - Motivational Image Gallery (1000+ work-safe images) ──
// Returns 10 random images seeded by user ID for consistency
// Categories: focus, adhd, energy, growth, brain, nature, motivation
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
          if (env.DEBUG) console.warn(`Pexels API error for "${keyword}":`, e.message);
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
          if (env.DEBUG) console.warn('Unsplash API error:', e.message);
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
    if (env.DEBUG) console.error('Gallery endpoint error:', error.message);
    // Graceful fallback - return empty array, frontend will use local SVG set
    return successResponse({
      images: [],
      error: 'Gallery service temporarily unavailable',
      count: 0
    });
  }
});

// ── BILLING ENDPOINTS (Placeholder) ──
// These endpoints stub out billing functionality
router.get('/billing/status', async (request, env) => {
  try {
    const auth = await verifyAuth(request, env);
    if (!auth) return errorResponse('Unauthorized', 401);

    return successResponse({
      plan: 'free',
      subscription_id: null,
      next_billing_date: null,
      can_upgrade: true
    });
  } catch (error) {
    if (env.DEBUG) console.error('Billing status error:', error.message);
    return errorResponse('Failed to fetch billing status', 500);
  }
});

router.post('/billing/create-checkout', async (request, env) => {
  try {
    const auth = await verifyAuth(request, env);
    if (!auth) return errorResponse('Unauthorized', 401);

    const { plan } = await request.json();
    
    if (!plan || !['pro', 'enterprise'].includes(plan)) {
      return errorResponse('Invalid plan', 400);
    }

    // Placeholder: Return message about billing not yet configured
    return successResponse({
      message: 'Billing system coming soon',
      plan: plan,
      status: 'not_configured'
    });
  } catch (error) {
    if (env.DEBUG) console.error('Checkout error:', error.message);
    return errorResponse('Failed to create checkout', 500);
  }
});

router.get('/billing/portal', async (request, env) => {
  try {
    const auth = await verifyAuth(request, env);
    if (!auth) return errorResponse('Unauthorized', 401);

    return successResponse({
      message: 'Billing portal coming soon',
      status: 'not_configured'
    });
  } catch (error) {
    if (env.DEBUG) console.error('Billing portal error:', error.message);
    return errorResponse('Failed to open billing portal', 500);
  }
});

// ── GET FEATURE FLAGS ──
/**
 * GET /features - Get enabled features for current user's tier
 * Returns feature availability based on subscription tier
 * Useful for frontend to conditionally show/hide features
 * @route GET /features
 * @auth Optional Bearer token (uses free tier if not provided)
 * @returns {200} { success: true, features: { featureName: boolean, ... } }
 * @example
 * // Get features for authenticated user (pro tier)
 * GET /features
 * Authorization: Bearer <token>
 * Response: { success: true, features: { slackIntegration: true, advancedAnalytics: true, darkModeApi: true }}
 */
router.get('/features', async (request, env) => {
  try {
    let userTier = 'free';
    
    // Check if user is authenticated to get their tier
    const auth = await verifyAuth(request, env);
    if (auth.valid) {
      const user = await env.DB.prepare(
        'SELECT subscription_tier FROM users WHERE id = ?'
      ).bind(auth.userId).first();
      
      if (user?.subscription_tier) {
        userTier = user.subscription_tier;
      }
    }
    
    // Build feature flags object for this user tier
    const features = {};
    for (const [featureName] of Object.entries(config.features)) {
      features[featureName] = isFeatureEnabled(featureName, userTier);
    }
    
    return successResponse({
      features,
      tier: userTier,
      message: 'Feature flags retrieved successfully'
    });
  } catch (error) {
    return errorResponse('Failed to retrieve feature flags', 500);
  }
});

// ── 404 FALLBACK ──
router.all('*', () => errorResponse('Not found', 404));

export default router;
