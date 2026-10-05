// ════════════════════════════════════════════════════════════
// FOCUSBRO MIDDLEWARE & UTILITIES
// Authentication, validation, error handling
// ════════════════════════════════════════════════════════════

// ── RATE LIMITING ──
export async function checkRateLimit(env, userId, limit = 100, windowMs = 60000) {
  const key = `ratelimit:${userId}`;
  const count = await env.KV_CACHE.get(key);
  const currentCount = count ? parseInt(count) : 0;
  
  if (currentCount >= limit) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + windowMs).toISOString()
    };
  }
  
  // Increment counter
  await env.KV_CACHE.put(key, (currentCount + 1).toString(), {
    expirationTtl: Math.ceil(windowMs / 1000)
  });
  
  return {
    allowed: true,
    remaining: limit - currentCount - 1,
    resetAt: new Date(Date.now() + windowMs).toISOString()
  };
}

// ── INPUT VALIDATION ──
export function validateDeviceId(deviceId) {
  // UUID v4 format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(deviceId);
}

// ── ERROR RESPONSE BUILDER ──
export function errorResponse(message, status = 400, details = null) {
  const body = {
    success: false,
    error: message,
    timestamp: new Date().toISOString()
  };
  
  if (details) {
    body.details = details;
  }
  
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// ── SUCCESS RESPONSE BUILDER ──
export function successResponse(data, status = 200) {
  return new Response(JSON.stringify({
    success: true,
    data,
    timestamp: new Date().toISOString()
  }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// ── LOG EVENTS ──
export async function logEvent(env, userId, action, details = {}) {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_logs (user_id, action, status, details, created_at)
       VALUES (?, ?, 'success', ?, datetime('now'))`
    ).bind(userId, action, JSON.stringify(details)).run();
  } catch (error) {
    // Silently fail to avoid blocking main flow
    console.debug('Audit log failed:', error.message);
  }
}

// ── GENERATE DEVICE FINGERPRINT ──
export function generateDeviceFingerprint(userAgent, acceptLanguage) {
  const data = `${userAgent}:${acceptLanguage}`;
  // Simple hash for demo (use crypto in production)
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

// ── REQUEST CONTEXT EXTRACTION ──
export function extractRequestContext(request) {
  return {
    userAgent: request.headers.get('User-Agent'),
    acceptLanguage: request.headers.get('Accept-Language'),
    origin: request.headers.get('Origin'),
    ip: request.headers.get('CF-Connecting-IP'),
    country: request.headers.get('CF-IPCountry'),
    timestamp: new Date().toISOString()
  };
}

// ── DATA SIZE CALCULATOR ──
export function calculateDataSize(data) {
  return JSON.stringify(data).length;
}

// ── ENCRYPTION HELPERS (Basic - upgrade to libsodium in production) ──
export async function encryptData(data, _env) {
  // For now, just stringify and store as-is
  // In production, use proper encryption with keys from env
  return JSON.stringify(data);
}

export async function decryptData(encryptedData, _env) {
  // For now, just parse JSON
  // In production, use proper decryption
  return JSON.parse(encryptedData);
}

// ── DATABASE CLEANUP ──
export async function cleanupExpiredSessions(env) {
  try {
    const result = await env.DB.prepare(
      `DELETE FROM sessions 
       WHERE expires_at < datetime('now') 
       AND is_active = 1`
    ).run();
    
    return {
      success: true,
      deletedRows: result.meta.changes
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// ── FEATURE FLAGS ──
export async function checkFeatureFlag(env, userId, feature) {
  const key = `feature:${feature}:${userId}`;
  const value = await env.KV_CACHE.get(key);
  return value === 'enabled';
}

// ── UTILITY: Generate UUID ──
export function generateUUID() {
  // FBQ-17 R6: user, session and jti ids are credentials-adjacent — a CSPRNG v4
  // UUID, never Math.random (predictable from a handful of outputs).
  return crypto.randomUUID();
}
