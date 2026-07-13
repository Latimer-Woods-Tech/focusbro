# FocusBro API Security Guide

Comprehensive guide to securing the FocusBro API and protecting user data.

---

## Table of Contents

1. [Authentication Security](#authentication-security)
2. [Data Protection](#data-protection)
3. [API Security](#api-security)
4. [Database Security](#database-security)
5. [Infrastructure Security](#infrastructure-security)
6. [Incident Response](#incident-response)
7. [Compliance](#compliance)

---

## Authentication Security

### 1. Password Security

#### Requirements
```
- Minimum 8 characters
- At least 1 uppercase letter (A-Z)
- At least 1 lowercase letter (a-z)
- At least 1 number (0-9)
- At least 1 special character (!@#$%^&*)
```

#### Implementation
```javascript
function validatePassword(password) {
  const regex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
  return regex.test(password);
}
```

#### Hashing Strategy
- Use SHA-256 for hashing (minimum)
- Future: Upgrade to bcrypt or Argon2
- Never store plaintext passwords
- Use salt rounds: 10+

### 2. Session Management

#### Token Lifecycle
```
- Issued: On login/register
- Duration: 30 days
- Refresh: On each login
- Revocation: On logout, password change
```

#### JWT Token Structure
```
Header.Payload.Signature

Header: {"alg": "HS256", "typ": "JWT"}
Payload: {
  "sub": "user-id",
  "iat": 1234567890,
  "exp": 1234567890 + (30 * 24 * 60 * 60)
}
```

#### Implementation
```javascript
function generateToken(userId) {
  const payload = {
    sub: userId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60)
  };
  
  // In production, use proper JWT libraries:
  // import jwt from 'jsonwebtoken';
  // return jwt.sign(payload, process.env.JWT_SECRET);
}
```

#### Token Security
- Always use HTTPS for token transmission
- Store tokens securely client-side (secure cookies or secure storage)
- Implement token rotation
- Validate token expiration
- Invalidate tokens on logout

### 3. Device Detection

#### Device Fingerprinting
```javascript
function generateDeviceFingerprint(userAgent, acceptLanguage) {
  const data = `${userAgent}:${acceptLanguage}`;
  // Hash the combination
  return hashData(data);
}
```

#### Track Device Sessions
- Store device_id with each session
- Allow users to view/manage devices
- Alert on new device login
- Force re-auth for suspicious devices

---

## Data Protection

### 1. Data in Transit

#### HTTPS/TLS
```
- Minimum: TLS 1.2
- Recommended: TLS 1.3
- Certificate: Valid, trusted CA
- HSTS Header: max-age=31536000
```

Configuration in wrangler.toml:
```toml
[env.production]
routes = [
  { pattern = "api.focusbro.io/*", zone_name = "focusbro.io" }
]
```

#### CORS Configuration
```javascript
const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://main.focusbro-7g0.pages.dev',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Max-Age': '86400'
};
```

### 2. Data at Rest

#### Database Encryption
- SQLite doesn't support native encryption
- Options:
  1. Use Cloudflare's encryption (automatic)
  2. Encrypt sensitive fields before storage
  3. Future: Migrate to encrypted database

#### KV Encryption
- Automatic encryption by Cloudflare
- Data encrypted in transit and at rest

#### Implementation
```javascript
async function encryptField(data, encryptionKey) {
  const encoder = new TextEncoder();
  const encodedData = encoder.encode(JSON.stringify(data));
  
  // Use Web Crypto API
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(encryptionKey),
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );
  
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encodedData
  );
  
  return {
    iv: Array.from(iv),
    data: Array.from(new Uint8Array(encrypted))
  };
}
```

### 3. Sensitive Data

#### Fields to Protect
- Passwords (hash only)
- API keys (hash, don't store plaintext)
- Session tokens (store as hash)
- Email addresses (encrypt if needed)
- Personal information (encrypt)

#### PII Handling
```javascript
// Encrypt before storing
const encryptedEmail = await encryptData(userEmail, env.ENCRYPTION_KEY);

// Decrypt only when needed
const decryptedEmail = await decryptData(encryptedEmail, env.ENCRYPTION_KEY);

// Log safely (no PII in logs)
await logEvent(userId, 'login', { device: 'iPhone', country: 'US' });
```

---

## API Security

### 1. Rate Limiting

#### Configuration
```javascript
async function checkRateLimit(env, userId, limit = 100, windowMs = 60000) {
  const key = `ratelimit:${userId}`;
  const count = await env.KV_CACHE.get(key);
  const currentCount = count ? parseInt(count) : 0;
  
  if (currentCount >= limit) {
    return { allowed: false };
  }
  
  await env.KV_CACHE.put(
    key,
    (currentCount + 1).toString(),
    { expirationTtl: Math.ceil(windowMs / 1000) }
  );
  
  return { allowed: true };
}
```

#### Limits by Endpoint
```
POST /auth/register         - 5 per hour per IP
POST /auth/login            - 10 per hour per email
POST /auth/request-password-reset - 3 per hour per email
POST /sync/data             - 100 per minute per user
GET  /sync/data             - 100 per minute per user
Other endpoints             - 100 per minute per user
```

### 2. Input Validation

#### Email Validation
```javascript
function validateEmail(email) {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email) && email.length <= 254;
}
```

#### Password Validation
```javascript
function validatePassword(password) {
  if (password.length < 8 || password.length > 128) return false;
  return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])/.test(password);
}
```

#### UUID Validation
```javascript
function validateUUID(uuid) {
  const regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return regex.test(uuid);
}
```

#### Data Validation
```javascript
function validateSyncData(data) {
  // Check size (max 10MB)
  const size = JSON.stringify(data).length;
  if (size > 10 * 1024 * 1024) {
    return { valid: false, error: 'Data too large' };
  }
  
  // Check depth (prevent complex objects)
  function checkDepth(obj, maxDepth = 10, current = 0) {
    if (current > maxDepth) return false;
    if (typeof obj !== 'object') return true;
    return Object.values(obj).every(v => checkDepth(v, maxDepth, current + 1));
  }
  
  if (!checkDepth(data)) {
    return { valid: false, error: 'Data structure too complex' };
  }
  
  return { valid: true };
}
```

### 3. SQL Injection Prevention

#### Use Prepared Statements
```javascript
// ✅ SAFE - Uses parameterized queries
const user = await env.DB.prepare(
  'SELECT * FROM users WHERE email = ?'
).bind(email).first();

// ❌ NEVER DO THIS
const user = await env.DB.prepare(
  `SELECT * FROM users WHERE email = '${email}'`
).first();
```

### 4. XSS Prevention

#### Sanitize Output
```javascript
function sanitizeOutput(data) {
  // Remove HTML tags
  if (typeof data === 'string') {
    return data.replace(/<[^>]*>/g, '');
  }
  
  if (typeof data === 'object') {
    const sanitized = {};
    for (const key in data) {
      sanitized[key] = sanitizeOutput(data[key]);
    }
    return sanitized;
  }
  
  return data;
}
```

### 5. CSRF Protection

#### Token Validation
```javascript
function validateCSRFToken(request, storedToken) {
  const requestToken = request.headers.get('X-CSRF-Token');
  const constTimeCompare = (a, b) => {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
  };
  
  return constTimeCompare(requestToken || '', storedToken);
}
```

---

## Database Security

### 1. Access Control

#### Database User Permissions
```sql
-- Create limited user for API (read/write only)
CREATE USER 'focusbro_api'@'%' IDENTIFIED BY 'strong_password';

-- Grant only necessary permissions
GRANT SELECT, INSERT, UPDATE ON focusbro.* TO 'focusbro_api'@'%';
GRANT DELETE ON focusbro.audit_logs TO 'focusbro_api'@'%';

-- No admin/drop/alter permissions
```

#### Row-Level Security
```sql
-- Ensure users only access their own data
CREATE VIEW user_own_data AS
SELECT * FROM user_data_snapshots
WHERE user_id = CURRENT_USER_ID();
```

### 2. Audit Logging

#### Log All Changes
```javascript
async function logAuditEvent(env, userId, action, details) {
  await env.DB.prepare(
    `INSERT INTO audit_logs 
     (user_id, action, ip_address, user_agent, details, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  ).bind(
    userId,
    action,
    extractIP(request),
    request.headers.get('User-Agent'),
    JSON.stringify(details)
  ).run();
}
```

#### Audit Log Events
- `user.login` - User login attempt
- `user.logout` - User logout
- `user.password_change` - Password changed
- `user.2fa_enable` - 2FA enabled
- `user.deletion` - Account deleted
- `admin.action` - Admin action taken
- `security.alert` - Security event

### 3. Data Retention

#### Automatic Cleanup
```javascript
async function cleanupOldData(env) {
  // Delete sessions older than 60 days
  await env.DB.prepare(
    `DELETE FROM sessions 
     WHERE created_at < datetime('now', '-60 days')`
  ).run();
  
  // Archive snapshots older than 1 year
  await env.DB.prepare(
    `DELETE FROM user_data_snapshots 
     WHERE created_at < datetime('now', '-1 year')
     AND user_id != (SELECT id FROM users WHERE is_active = 1)`
  ).run();
}

// Schedule cleanup (set up cron job)
// Every day at 2 AM UTC
```

---

## Infrastructure Security

### 1. Cloudflare Configuration

#### WAF Rules
```toml
# Block common attacks
[env.production]
rules = [
  {
    expression = "cf.bot_management.score < 30",
    action = "block",
    description = "Block suspected bots"
  },
  {
    expression = "(cf.threat_score > 50) and (ip.geoip.country in {\"CN\" \"RU\"})",
    action = "challenge",
    description = "Challenge high-threat IPs from certain regions"
  }
]
```

#### DDoS Protection
- Enabled by default on Cloudflare
- Automatic rate limiting
- IP reputation filtering
- Bot management

#### Content Security Policy
```javascript
function setSecurityHeaders(response) {
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  response.headers.set('Content-Security-Policy', "default-src 'self'");
  return response;
}
```

### 2. Secrets Management

#### Environment Variables
```bash
# Never commit these
JWT_SECRET=your-secret-key-32-chars-minimum
DATABASE_PASSWORD=secure-password
API_KEY=secret-key
ENCRYPTION_KEY=encryption-key
```

#### Cloudflare Secrets
```bash
# Store in Cloudflare
wrangler secret put JWT_SECRET
wrangler secret put DATABASE_PASSWORD
wrangler secret put ENCRYPTION_KEY

# Access in code
const secret = env.JWT_SECRET;
```

### 3. Monitoring & Alerts

#### Implement Monitoring
```javascript
// Prometheus-style metrics
async function recordMetric(env, name, value, tags = {}) {
  const timestamp = new Date().toISOString();
  const key = `metrics:${name}:${timestamp}`;
  await env.KV_CACHE.put(key, JSON.stringify({
    name,
    value,
    tags,
    timestamp
  }), { expirationTtl: 86400 });
}

// Usage
await recordMetric(env, 'auth.login.success', 1, { user_id });
await recordMetric(env, 'auth.login.failure', 1, { reason: 'invalid_password' });
```

---

## Incident Response

### 1. Security Breach Procedure

#### Immediate Actions
1. **Isolate** - Stop further compromise
2. **Alert** - Notify security team
3. **Contain** - Limit access to affected systems
4. **Investigate** - Determine scope and cause

#### Communication
```
1. Internal team notification (emergency channel)
2. Affected users email (within 1 hour)
3. Public statement (within 24 hours)
4. Timeline and mitigation (within 72 hours)
```

#### Investigation Steps
```javascript
// Query suspicious activities
const suspiciousActivities = await env.DB.prepare(
  `SELECT * FROM audit_logs 
   WHERE created_at > datetime('now', '-24 hours')
   AND (action LIKE '%delete%' OR action LIKE '%unauthorized%')`
).all();

// Analyze unusual patterns
const unusualLogins = await env.DB.prepare(
  `SELECT user_id, COUNT(*) as count, COUNT(DISTINCT device_id) as devices
   FROM sessions
   WHERE created_at > datetime('now', '-12 hours')
   GROUP BY user_id
   HAVING count > 10`
).all();
```

### 2. Password Reset Campaign

```javascript
// Force password reset for affected users
async function forcePasswordReset(env, userIds) {
  for (const userId of userIds) {
    // Invalidate all sessions
    await env.DB.prepare(
      'UPDATE sessions SET is_active = 0 WHERE user_id = ?'
    ).bind(userId).run();
    
    // Send reset email to user
    // sendEmail({ to: user.email, template: 'force-reset' });
    
    // Log event
    await logAuditEvent(env, userId, 'force_password_reset', {
      reason: 'security_incident'
    });
  }
}
```

### 3. Post-Incident Review

```
Checklist:
- [ ] Root cause identified
- [ ] All affected systems secured
- [ ] All users notified
- [ ] Security patches applied
- [ ] Tests for vulnerability added
- [ ] Documentation updated
- [ ] Team trained on incident
- [ ] Incident report completed
```

---

## Compliance

### 1. GDPR (EU)

#### Requirements
- User consent for data collection
- Right to access data (export)
- Right to deletion (erasure)
- Data portability
- Private by design

#### Implementation
```javascript
// Data Export (GDPR Right of Access)
async function exportUserData(env, userId) {
  const user = await env.DB.prepare(
    'SELECT * FROM users WHERE id = ?'
  ).bind(userId).first();
  
  const data = await env.DB.prepare(
    'SELECT * FROM user_data_snapshots WHERE user_id = ?'
  ).bind(userId).all();
  
  const export_data = {
    user_profile: user,
    sync_history: data,
    exported_at: new Date().toISOString()
  };
  
  return JSON.stringify(export_data);
}

// Data Deletion (GDPR Right to Erasure)
async function deleteUserData(env, userId) {
  // Mark user as deleted
  await env.DB.prepare(
    'UPDATE users SET is_active = 0 WHERE id = ?'
  ).bind(userId).run();
  
  // Delete all related data
  await env.DB.prepare(
    'DELETE FROM user_data_snapshots WHERE user_id = ?'
  ).bind(userId).run();
  
  await env.DB.prepare(
    'DELETE FROM sessions WHERE user_id = ?'
  ).bind(userId).run();
}
```

### 2. CCPA (California)

#### Key Rights
- Right to know
- Right to delete
- Right to opt-out
- Right to correct

### 3. Privacy Policy

#### Must Include
- What data is collected
- How it's used
- How it's protected
- User rights
- Contact for concerns
- Cookie policy
- Third-party sharing

### 4. Terms of Service

#### Must Specify
- API usage rights
- Data ownership
- Acceptable use
- Limitations of liability
- Dispute resolution
- Changes to service

---

## Security Checklist

### Before Deployment
- [ ] All secrets in environment variables
- [ ] SSL/TLS configured
- [ ] CORS properly set
- [ ] Rate limiting enabled
- [ ] Input validation in place
- [ ] SQL injection prevented
- [ ] CSRF protection added
- [ ] Security headers set
- [ ] Logging enabled
- [ ] Database backups configured
- [ ] Monitoring alerts set
- [ ] Documentation updated
- [ ] Security audit completed
- [ ] Penetration test done
- [ ] Compliance review passed

### Monthly
- [ ] Review audit logs
- [ ] Check for suspicious activities
- [ ] Rotate secrets
- [ ] Update dependencies
- [ ] Review access logs
- [ ] Test backup restoration
- [ ] Security patches applied

### Quarterly
- [ ] Penetration testing
- [ ] Code security audit
- [ ] Compliance review
- [ ] Disaster recovery drill
- [ ] Incident response drill

---

## Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Node.js Security Checklist](https://nodejs.org/en/docs/guides/security/)
- [Cloudflare Security](https://www.cloudflare.com/security/)
- [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)

