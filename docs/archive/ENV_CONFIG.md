# FocusBro API Environment Configuration

## Local Development (.env.local)

```bash
# Environment
ENVIRONMENT=development
NODE_ENV=development
LOG_LEVEL=debug

# Database
DATABASE_URL=file:./db.sqlite
DATABASE_TIMEOUT=5000

# KV Cache
KV_CACHE_ENABLED=true
KV_CACHE_TTL=3600

# JWT
JWT_SECRET=your-dev-secret-key-change-in-production
JWT_EXPIRY=30d
JWT_REFRESH_EXPIRY=60d

# Password Security
PASSWORD_SALT_ROUNDS=10
PASSWORD_MIN_LENGTH=8

# CORS
CORS_ORIGIN=http://localhost:3000,http://localhost:5173
CORS_CREDENTIALS=true

# Rate Limiting
RATE_LIMIT_WINDOW=60000
RATE_LIMIT_MAX_REQUESTS=100
RATE_LIMIT_ENABLED=true

# API
API_PORT=8787
API_VERSION=1.0.0

# Logging
LOG_FORMAT=pretty
LOG_FILE=./logs/api.log

# Feature Flags
FEATURE_2FA=false
FEATURE_API_KEYS=true
FEATURE_WEBHOOKS=false

# Third Party
SEND_GRID_KEY=your-sendgrid-key
SENTRY_DSN=your-sentry-dsn
```

## Production Environment (Cloudflare Secrets)

Set via CLI:
```bash
wrangler secret put JWT_SECRET
wrangler secret put DATABASE_PASSWORD
wrangler secret put ENCRYPTION_KEY
wrangler secret put SENDGRID_API_KEY
wrangler secret put SENTRY_AUTH_TOKEN
```

### Variables

```bash
# Environment
ENVIRONMENT=production
NODE_ENV=production
LOG_LEVEL=error

# Database (Cloudflare D1)
DB_BINDING=DB

# KV Cache (Cloudflare KV)
KV_BINDING=KV_CACHE

# JWT (KEEP SECRET)
JWT_SECRET=your-secret-key-32-chars-minimum

# Encryption (KEEP SECRET)
ENCRYPTION_KEY=your-encryption-key-32-chars

# Frontend
FRONTEND_URL=https://main.focusbro-7g0.pages.dev

# Email Service
SENDGRID_API_KEY=your-sendgrid-api-key

# Monitoring
SENTRY_AUTH_TOKEN=your-sentry-token

# Rate Limiting (stricter in production)
RATE_LIMIT_WINDOW=60000
RATE_LIMIT_MAX_REQUESTS=100

# Security
ENABLE_HTTPS_ONLY=true
ENABLE_HSTS=true
ENABLE_CSP=true

# Features
FEATURE_2FA=true
FEATURE_API_KEYS=true
FEATURE_WEBHOOKS=true

# API
API_VERSION=1.0.0
API_TIMEOUT=30000

# Database
DB_POOL_SIZE=10
DB_CONNECTION_TIMEOUT=5000
```

## Testing Environment

```bash
ENVIRONMENT=test
NODE_ENV=test
LOG_LEVEL=warn

DATABASE_URL=:memory:
RATE_LIMIT_ENABLED=false
FEATURE_2FA=false

JWT_SECRET=test-secret-key
ENCRYPTION_KEY=test-encryption-key

FRONTEND_URL=http://localhost:3000
```

## Configuration Loading

```javascript
import { config } from 'dotenv';

config();

const env = {
  // Environment
  NODE_ENV: process.env.NODE_ENV || 'development',
  ENVIRONMENT: process.env.ENVIRONMENT || 'development',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  
  // API
  API_PORT: parseInt(process.env.API_PORT || '8787'),
  API_VERSION: process.env.API_VERSION || '1.0.0',
  API_TIMEOUT: parseInt(process.env.API_TIMEOUT || '30000'),
  
  // Database
  DB_BINDING: process.env.DB_BINDING || 'DB',
  DATABASE_URL: process.env.DATABASE_URL,
  DB_POOL_SIZE: parseInt(process.env.DB_POOL_SIZE || '10'),
  DB_CONNECTION_TIMEOUT: parseInt(process.env.DB_CONNECTION_TIMEOUT || '5000'),
  
  // KV Cache
  KV_CACHE_ENABLED: process.env.KV_CACHE_ENABLED !== 'false',
  KV_CACHE_TTL: parseInt(process.env.KV_CACHE_TTL || '3600'),
  KV_BINDING: process.env.KV_BINDING || 'KV_CACHE',
  
  // JWT
  JWT_SECRET: process.env.JWT_SECRET,
  JWT_EXPIRY: process.env.JWT_EXPIRY || '30d',
  JWT_REFRESH_EXPIRY: process.env.JWT_REFRESH_EXPIRY || '60d',
  
  // Password Security
  PASSWORD_SALT_ROUNDS: parseInt(process.env.PASSWORD_SALT_ROUNDS || '10'),
  PASSWORD_MIN_LENGTH: parseInt(process.env.PASSWORD_MIN_LENGTH || '8'),
  
  // CORS
  CORS_ORIGIN: (process.env.CORS_ORIGIN || '*').split(','),
  CORS_CREDENTIALS: process.env.CORS_CREDENTIALS === 'true',
  
  // Rate Limiting
  RATE_LIMIT_ENABLED: process.env.RATE_LIMIT_ENABLED !== 'false',
  RATE_LIMIT_WINDOW: parseInt(process.env.RATE_LIMIT_WINDOW || '60000'),
  RATE_LIMIT_MAX_REQUESTS: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'),
  
  // Frontend
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:3000',
  
  // Email
  SENDGRID_API_KEY: process.env.SENDGRID_API_KEY,
  
  // Monitoring
  SENTRY_AUTH_TOKEN: process.env.SENTRY_AUTH_TOKEN,
  
  // Security
  ENABLE_HTTPS_ONLY: process.env.ENABLE_HTTPS_ONLY === 'true',
  ENABLE_HSTS: process.env.ENABLE_HSTS !== 'false',
  ENABLE_CSP: process.env.ENABLE_CSP !== 'false',
  
  // Features
  FEATURE_2FA: process.env.FEATURE_2FA === 'true',
  FEATURE_API_KEYS: process.env.FEATURE_API_KEYS === 'true',
  FEATURE_WEBHOOKS: process.env.FEATURE_WEBHOOKS === 'true',
  
  // Encryption
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
};

// Validate required secrets in production
if (env.ENVIRONMENT === 'production') {
  const required = ['JWT_SECRET', 'ENCRYPTION_KEY'];
  for (const key of required) {
    if (!env[key]) {
      throw new Error(`Missing required secret: ${key}`);
    }
  }
}

export default env;
```

## Wrangler Configuration Template

```toml
# wrangler.toml
name = "focusbro-api"
type = "javascript"
main = "src/index.js"
compatibility_date = "2024-03-24"
account_id = "YOUR_ACCOUNT_ID"
workers_dev = true

# ── DATABASE ──
[[d1_databases]]
binding = "DB"
database_name = "focusbro-db"
database_id = "YOUR_DATABASE_ID"

# ── CACHE ──
[[kv_namespaces]]
binding = "KV_CACHE"
id = "YOUR_KV_NAMESPACE_ID"
preview_id = "YOUR_PREVIEW_NAMESPACE_ID"

# ── DEVELOPMENT ──
[env.development]
vars = { ENVIRONMENT = "development" }

# ── PREVIEW ──
[env.preview]
routes = [
  { pattern = "api-preview.focusbro.io/*", zone_name = "focusbro.io" }
]
vars = { ENVIRONMENT = "preview" }

# ── STAGING ──
[env.staging]
routes = [
  { pattern = "api-staging.focusbro.io/*", zone_name = "focusbro.io" }
]
vars = { ENVIRONMENT = "staging" }

# ── PRODUCTION ──
[env.production]
routes = [
  { pattern = "api.focusbro.io/*", zone_name = "focusbro.io" }
]

[env.production.vars]
ENVIRONMENT = "production"
FRONTEND_URL = "https://main.focusbro-7g0.pages.dev"
API_VERSION = "1.0.0"

# [env.production.build]
# command = "npm run build"
# cwd = "./api"
```

## Generating Secrets

```bash
# Generate JWT_SECRET (256-bit)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Generate ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Generate random API key
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Security Checklist

- [ ] All secrets are 32+ characters
- [ ] Secrets are never committed to git
- [ ] Environment variables use strong values
- [ ] Development keys differ from production
- [ ] Secrets are rotated monthly
- [ ] Access logs reviewed regularly
- [ ] Unused secrets removed
- [ ] Backup of current secrets stored securely

