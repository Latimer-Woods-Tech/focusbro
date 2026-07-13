# FocusBro API Deployment Guide

## Prerequisites

- Cloudflare account (free or paid)
- Node.js 18+ installed
- Wrangler CLI installed
- Git repository for version control

---

## Installation

### 1. Install Wrangler CLI

```bash
npm install -g wrangler
```

Verify installation:
```bash
wrangler --version
```

### 2. Authenticate with Cloudflare

```bash
wrangler login
```

This opens a browser to authenticate. Follow the prompts.

### 3. Install Dependencies

Navigate to the api directory:
```bash
cd focusbro/api
npm install
```

---

## Configuration

### 1. Update wrangler.toml

Edit `/focusbro/api/wrangler.toml` and add your Cloudflare details:

```toml
name = "focusbro-api"
type = "javascript"
main = "src/index.js"
compatibility_date = "2024-03-24"
account_id = "YOUR_ACCOUNT_ID"

# Get from Cloudflare Dashboard
[[d1_databases]]
binding = "DB"
database_name = "focusbro-db"
database_id = "YOUR_DATABASE_ID"

[[kv_namespaces]]
binding = "KV_CACHE"
id = "YOUR_KV_NAMESPACE_ID"
preview_id = "YOUR_PREVIEW_NAMESPACE_ID"

[env.production]
routes = [
  { pattern = "api.focusbro.io/*", zone_name = "focusbro.io" }
]

[env.production.vars]
FRONTEND_URL = "https://main.focusbro-7g0.pages.dev"
JWT_SECRET = "YOUR_SECURE_SECRET_KEY"
PASSWORD_SALT_ROUNDS = "10"
```

---

## Creating Resources on Cloudflare

### 1. Create D1 Database

From command line:
```bash
wrangler d1 create focusbro-db
```

This returns:
```
✓ Successfully created DB 'focusbro-db'
Account ID: a1c8a33cbe8a3c9e260480433a0dbb06
Database ID: xxxxx-xxxxx-xxxxx
```

Copy the Database ID to `wrangler.toml`.

### 2. Create KV Namespace

```bash
wrangler kv:namespace create KV_CACHE
wrangler kv:namespace create KV_CACHE --preview
```

Returns:
```
✓ Created namespace with ID xxxxx
Preview ID: yyyyy
```

Copy both IDs to `wrangler.toml`.

### 3. Initialize Database Schema

Apply schema to production:
```bash
wrangler d1 execute focusbro-db --file=schema.sql --remote
```

For local development:
```bash
wrangler d1 execute focusbro-db --file=schema.sql --local
```

Verify tables:
```bash
wrangler d1 query "SELECT name FROM sqlite_master WHERE type='table';" --remote
```

---

## Environment Setup

### 1. Production Environment Variables

Set in Cloudflare Dashboard (Workers > Settings):

```
FRONTEND_URL=https://main.focusbro-7g0.pages.dev
JWT_SECRET=your-secret-key-32-chars-minimum
PASSWORD_SALT_ROUNDS=10
ENVIRONMENT=production
LOG_LEVEL=info
```

### 2. Local Development Environment

Create `.env.local`:
```
ENVIRONMENT=development
DATABASE_URL=d1
KV_CACHE=local
JWT_SECRET=dev-secret-key-change-in-prod
```

---

## Development

### Run Local Dev Server

```bash
wrangler dev
```

API available at `http://localhost:8787`

### Test the API

```bash
# Health check
curl http://localhost:8787/health

# Register
curl -X POST http://localhost:8787/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "TestPass123!"
  }'
```

### Debug Logs

View logs with:
```bash
wrangler tail
```

---

## Deployment

### 1. Preview Deployment

Test before production:
```bash
wrangler publish --env preview
```

### 2. Production Deployment

Deploy to production:
```bash
wrangler publish --env production
```

Or specific file:
```bash
wrangler publish api/src/index.js --env production
```

### 3. Check Deployment Status

```bash
wrangler deployments list
```

---

## Database Migrations

### Create Migration

```bash
# Add new table/modify schema in schema.sql
# Then apply:
wrangler d1 execute focusbro-db --file=schema.sql --remote
```

### Backup Database

```bash
wrangler d1 backup create focusbro-db
```

List backups:
```bash
wrangler d1 backup list focusbro-db
```

Restore from backup:
```bash
wrangler d1 backup restore focusbro-db BACKUP_ID
```

---

## Monitoring & Debugging

### View Analytics

In Cloudflare Dashboard:
- Workers > focusbro-api > Analytics & Logs
- View requests, errors, performance metrics

### Query Database in Production

```bash
wrangler d1 query "SELECT * FROM users LIMIT 10;" --remote
```

### View KV Store

```bash
wrangler kv:key list --binding KV_CACHE
```

### Check Purge Events

```bash
wrangler kv:namespace delete-key --binding KV_CACHE key_name
```

---

## Security Best Practices

### 1. API Keys for Services

Generate and rotate API keys:
```bash
# Generate new secret
openssl rand -hex 32
```

Update in Cloudflare dashboard.

### 2. Rate Limiting

Already configured in code:
- 100 requests/minute (most endpoints)
- 3 requests/hour (password reset)

### 3. CORS Configuration

Update in `index.js`:
```javascript
const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://main.focusbro-7g0.pages.dev',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
```

### 4. HTTPS Enforcement

Route only HTTPS:
```toml
[env.production]
routes = [
  { pattern = "api.focusbro.io/*", zone_name = "focusbro.io" }
]
```

### 5. Secret Management

Never commit secrets. Use Cloudflare Secrets:
```bash
wrangler secret put JWT_SECRET
wrangler secret put DATABASE_PASSWORD
```

---

## Troubleshooting

### 401 Unauthorized on All Requests

**Solution:** Verify JWT_SECRET is set in environment:
```bash
wrangler secret list
```

### Database Connection Errors

**Solution:** Verify database binding in wrangler.toml:
```bash
wrangler d1 info focusbro-db --remote
```

### KV Cache Not Working

**Solution:** Clear KV cache:
```bash
wrangler kv:namespace delete-key --binding KV_CACHE "*"
```

### Rate Limiting Issues

**Solution:** Reset rate limit counters:
```bash
wrangler kv:key list --binding KV_CACHE | grep ratelimit | xargs wrangler kv:key delete --binding KV_CACHE
```

### CORS Errors

**Solution:** Add origin to CORS headers in code:
```javascript
corsHeaders['Access-Control-Allow-Origin'] = request.headers.get('Origin');
```

---

## Performance Optimization

### 1. Database Optimization

Check slow queries:
```bash
# Enable query logging (add to code)
console.time('query');
const result = await env.DB.prepare(...).first();
console.timeEnd('query');
```

### 2. KV Caching Strategy

Cache frequently accessed data:
```javascript
// Try cache first, then DB
const cached = await env.KV_CACHE.get(key);
if (cached) return JSON.parse(cached);

const data = await env.DB.prepare(...).first();
await env.KV_CACHE.put(key, JSON.stringify(data), { expirationTtl: 3600 });
return data;
```

### 3. Connection Pooling

Wrangler handles pooling automatically for D1.

### 4. Compression

Enable gzip compression for responses:
```javascript
const response = new Response(JSON.stringify(data));
response.headers.set('Content-Encoding', 'gzip');
```

---

## Scaling Considerations

### Current Limits
- D1: Up to 5GB storage
- KV: Up to 1GB per namespace  
- Workers: 100k requests/day (Hobby), unlimited (Paid)

### Upgrade Path

**When you hit limits:**

1. **Database:** Migrate to Cloudflare Durable Objects or external DB
2. **KV:** Separate namespaces for different data types
3. **Workers:** Upgrade to Paid plan for unlimited requests

### Optimization for Scale

```javascript
// Use batch operations
const batch = [
  env.DB.prepare('INSERT INTO logs...').bind(...),
  env.DB.prepare('UPDATE users...').bind(...),
];
const results = await env.DB.batch(batch);
```

---

## Rollback Procedure

### Quick Rollback

If deployment has issues:
```bash
wrangler rollback
```

Lists available versions to rollback to.

### Manual Rollback

Redeploy previous version:
```bash
git checkout previous-commit
wrangler publish
```

---

## Maintenance

### Daily
- Monitor error logs in dashboard
- Check rate limit metrics

### Weekly
- Review analytics
- Check database queries
- Backup database

### Monthly
- Update dependencies: `npm update`
- Rotate secrets
- Review security logs
- Performance review

---

## Support & Resources

- **Cloudflare Docs:** https://developers.cloudflare.com/workers/
- **D1 Documentation:** https://developers.cloudflare.com/d1/
- **KV Documentation:** https://developers.cloudflare.com/kv/
- **API Issues:** https://github.com/focusbro/api/issues

---

## Checklist: Production Deployment

- [ ] All tests passing
- [ ] Environment variables set
- [ ] Database migrations applied
- [ ] CORS properly configured
- [ ] SSL/TLS enabled
- [ ] Rate limiting tested
- [ ] Backup created
- [ ] Monitoring enabled
- [ ] Error alerting configured
- [ ] Documentation updated

