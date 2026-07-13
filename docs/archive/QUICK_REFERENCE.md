# FocusBro API - Quick Reference Guide

A quick lookup for all API files, endpoints, and commands.

---

## 📂 File Locations & Purposes

| File | Purpose | Key Content |
|------|---------|-------------|
| `api/src/index.js` | Main API routes | Register, login, health check, sync endpoints |
| `api/src/middleware.js` | Auth & utilities | JWT verification, rate limiting, validation |
| `api/src/extended-routes.js` | Advanced features | Profile, password, device management |
| `api/schema.sql` | Database schema | 6 tables, 2 views, 10+ indexes |
| `api/package.json` | Dependencies | itty-router, wrangler, types |
| `api/wrangler.toml` | Cloudflare config | Worker, D1, KV bindings, environments |
| `api/README.md` | API quick start | Installation, usage, structure |
| `.env.template` | Environment template | 40+ configuration options |
| `API_DOCUMENTATION.md` | Complete API reference | All endpoints with examples |
| `DEPLOYMENT_GUIDE.md` | Deployment steps | Setup, config, monitoring |
| `SECURITY_GUIDE.md` | Security best practices | Implementation, compliance |
| `API_TESTING.md` | Testing guide | Test cases, tools, examples |
| `ENV_CONFIG.md` | Configuration details | All variables explained |
| `IMPLEMENTATION_SUMMARY.md` | What was created | Overview of all components |

---

## 🔧 Essential Commands

### Setup
```bash
# Install dependencies
cd focusbro/api && npm install

# Authenticate with Cloudflare
wrangler login

# Create database
wrangler d1 create focusbro-db

# Create KV namespace
wrangler kv:namespace create KV_CACHE
```

### Development
```bash
# Start local server
wrangler dev

# Run tests
npm test

# View logs
wrangler tail
```

### Database
```bash
# Initialize schema locally
wrangler d1 execute focusbro-db --file=schema.sql --local

# Initialize schema remotely
wrangler d1 execute focusbro-db --file=schema.sql --remote

# Query database
wrangler d1 query "SELECT * FROM users;" --remote
```

### Deployment
```bash
# Preview deployment
wrangler publish --env preview

# Production deployment
wrangler publish --env production

# Rollback
wrangler rollback
```

### Secrets
```bash
# Generate secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Set secret in Cloudflare
wrangler secret put JWT_SECRET

# List secrets
wrangler secret list
```

---

## 🌐 API Endpoints Reference

### Authentication (5 endpoints)
```
POST   /auth/register                    - Create user account
POST   /auth/login                       - Authenticate user
POST   /auth/request-password-reset      - Request password reset
POST   /auth/confirm-password-reset      - Confirm new password
POST   /auth/logout-all                  - Logout all devices
```

### User Profile (4 endpoints)
```
GET    /users/profile                    - Get user profile
PUT    /users/profile                    - Update profile
POST   /users/change-password            - Change password
POST   /users/delete-account             - Delete account
```

### Devices (2 endpoints)
```
GET    /devices                          - List devices
DELETE /devices/{deviceId}               - Remove device
```

### Data Sync (2 endpoints)
```
POST   /sync/data                        - Upload data
GET    /sync/data                        - Download data
```

### Utilities (1 endpoint)
```
GET    /health                           - Health check
```

---

## 🔐 Common Request/Response Patterns

### Authenticated Request
```bash
curl -X GET https://api.focusbro.io/users/profile \
  -H "Authorization: Bearer eyJhbGc..."
```

### Success Response (200)
```json
{
  "success": true,
  "data": { ... },
  "timestamp": "2024-01-20T14:22:00Z"
}
```

### Error Response (400+)
```json
{
  "success": false,
  "error": "Error message",
  "timestamp": "2024-01-20T14:22:00Z"
}
```

---

## 📝 Environment Variables Setup

### Create .env.local
```bash
# Copy template
cp .env.template .env.local

# Generate secrets
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# Update .env.local with values
# Set CORS_ORIGIN to your frontend URL
# Set FRONTEND_URL to your frontend
```

---

## 🗄️ Database Tables Quick Reference

| Table | Purpose | Key Fields |
|-------|---------|-----------|
| `users` | User accounts | id, email, password_hash |
| `sessions` | Device sessions | id, user_id, token, device_id |
| `user_data_snapshots` | Data backups | id, user_id, snapshot_data |
| `sync_logs` | Sync history | id, user_id, synced_at |
| `audit_logs` | Security logs | id, user_id, action |
| `api_keys` | API access | id, user_id, key_hash |

---

## 🧪 Quick Test Examples

### Register User
```bash
curl -X POST http://localhost:8787/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "TestPass123!"
  }'
```

### Login
```bash
curl -X POST http://localhost:8787/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "TestPass123!"
  }'
```

### Sync Data
```bash
curl -X POST http://localhost:8787/sync/data \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {"tasks": []},
    "device_id": "device-123"
  }'
```

---

## 🔒 Password Requirements

- Minimum 8 characters
- 1 uppercase letter (A-Z)
- 1 lowercase letter (a-z)
- 1 number (0-9)
- 1 special character (!@#$%^&*)

**Valid**: `MyPassword123!`  
**Invalid**: `mypassword` (no uppercase, no number, no special)

---

## ⚡ Rate Limits

| Endpoint | Limit |
|----------|-------|
| Register | 5/hour per IP |
| Login | 10/hour per email |
| Password reset request | 3/hour per email |
| Most endpoints | 100/minute per user |
| Sync endpoints | 100/minute per user |

---

## 🚀 Deployment Checklist

Before deploying to production:

```
SETUP
  ☐ Register Cloudflare account
  ☐ Create D1 database
  ☐ Create KV namespace
  ☐ Get account ID and resource IDs

CONFIGURATION
  ☐ Update wrangler.toml with IDs
  ☐ Generate JWT_SECRET (32+ chars)
  ☐ Generate ENCRYPTION_KEY (32+ chars)
  ☐ Set FRONTEND_URL
  ☐ Configure CORS_ORIGIN

DATABASE
  ☐ Apply schema to database
  ☐ Verify tables created
  ☐ Create backup

SECURITY
  ☐ Set all secrets in Cloudflare
  ☐ Enable HTTPS
  ☐ Configure security headers
  ☐ Enable rate limiting
  ☐ Setup monitoring

TESTING
  ☐ Run local tests
  ☐ Load test API
  ☐ Security audit
  ☐ Penetration test

DEPLOYMENT
  ☐ Deploy to staging first
  ☐ Run integration tests
  ☐ Deploy to production
  ☐ Verify endpoints working
  ☐ Monitor error logs
```

---

## 🐛 Troubleshooting Quick Links

### Problem: "Database not found"
→ See [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md#creating-resources-on-cloudflare)

### Problem: "401 Unauthorized"
→ Check [SECURITY_GUIDE.md](SECURITY_GUIDE.md#authentication-security) auth section

### Problem: "Rate limit exceeded"
→ See [API_DOCUMENTATION.md](API_DOCUMENTATION.md#rate-limiting)

### Problem: Slow responses
→ Check [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md#performance-optimization)

### Problem: Can't login
→ Review [API_TESTING.md](API_TESTING.md#test-2-login) test examples

---

## 📊 Monitoring & Analytics

### View Recent Logs
```bash
wrangler tail
```

### Query Users
```bash
wrangler d1 query "SELECT email, created_at FROM users LIMIT 10;" --remote
```

### Check Activity
```bash
wrangler d1 query "SELECT * FROM audit_logs WHERE created_at > datetime('now', '-24 hours');" --remote
```

---

## 🔑 Key Concepts

### JWT Tokens
- Generated on login/register
- Valid for 30 days
- Contains user ID
- Invalidated on password change
- Use in `Authorization: Bearer {token}` header

### Rate Limiting
- Per user/IP basis
- Rolling time window
- Response includes remaining count
- KV cache-based tracking

### Device Sessions
- One session per device
- Tracked with device_id
- Can logout individual device
- Can logout all devices

### Data Sync
- Upload with device_id
- Download latest snapshot
- Stored in KV (fast) and D1 (persistent)
- Size tracking included

---

## 📞 Get Help

1. **Check Documentation**
   - Start with [api/README.md](api/README.md)
   - See [API_DOCUMENTATION.md](API_DOCUMENTATION.md) for endpoints
   - Review [API_TESTING.md](API_TESTING.md) for examples

2. **Debug Issues**
   - Check logs: `wrangler tail`
   - Query database: `wrangler d1 query "..."`
   - Test endpoint: `curl http://localhost:8787/health`

3. **Security Questions**
   - Review [SECURITY_GUIDE.md](SECURITY_GUIDE.md)
   - Check implementation code
   - Verify configuration

4. **Deployment Help**
   - Follow [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)
   - Check troubleshooting section
   - Review checklist

---

## 📚 Documentation Priority

If you only have time for one file:
→ Read **[api/README.md](api/README.md)** for quick start

If you have 30 minutes:
→ Read:
1. [api/README.md](api/README.md)
2. [API_DOCUMENTATION.md](API_DOCUMENTATION.md)
3. [API_TESTING.md](API_TESTING.md#quick-start)

If deploying to production:
→ Read ALL:
1. [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)
2. [SECURITY_GUIDE.md](SECURITY_GUIDE.md)
3. [ENV_CONFIG.md](ENV_CONFIG.md)

---

## ✅ Success Indicators

You're ready when:

1. ✅ All dependencies installed
2. ✅ Local server starts (`wrangler dev`)
3. ✅ Health check works (`GET /health`)
4. ✅ Can register user (`POST /auth/register`)
5. ✅ Can login user (`POST /auth/login`)
6. ✅ Can get profile (`GET /users/profile`)
7. ✅ Can sync data (`POST/GET /sync/data`)
8. ✅ Rate limiting works
9. ✅ Logs are recorded

---

## 🎓 Learning Path

```
1. Setup (30 min)
   ↓
2. Local Testing (30 min)
   ↓
3. Read Docs (1-2 hours)
   ↓
4. Staging Deployment (1 hour)
   ↓
5. Security Audit (1-2 hours)
   ↓
6. Production Deployment (30 min)
   ↓
7. Monitoring Setup (1 hour)
```

---

## 🎉 You're All Set!

The FocusBro API is:
- ✅ Implemented
- ✅ Documented
- ✅ Tested
- ✅ Secured
- ✅ Ready to deploy

**Next Step**: Follow the [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)

---

**Last Updated**: January 20, 2024  
**Quick Reference Version**: 1.0.0

