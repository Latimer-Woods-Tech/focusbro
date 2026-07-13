# FocusBro Environment Configuration Guide

## Overview

FocusBro uses Cloudflare Workers with the following integrations:
- **Database**: Cloudflare D1 (SQLite)
- **Cache**: Cloudflare KV Store
- **Payments**: Stripe
- **Push Notifications**: Web Push API (VAPID keys)
- **Communication**: Slack Webhooks
- **Domain**: Cloudflare-managed DNS

## Environment Variables & Secrets

### Production Configuration (`wrangler.toml`)

```toml
[env.production]
# Domain routing
routes = [
  { pattern = "focusbro.net/*", zone_name = "focusbro.net" },
  { pattern = "*.focusbro.net/*", zone_name = "focusbro.net" }
]

# Database binding
d1_databases = [{ 
  binding = "DB", 
  database_id = "2ac20b08-66e3-4abd-92de-f0e6380bdad0", 
  database_name = "focusbro" 
}]

# KV Store binding
kv_namespaces = [{ 
  binding = "KV_CACHE", 
  id = "60c1852cd70f4999a380b9ea290fccb3", 
  preview_id = "60c1852cd70f4999a380b9ea290fccb3" 
}]

# Public variables (visible in code)
vars = { 
  ENV = "production", 
  API_ORIGIN = "https://focusbro.net", 
  JWT_SECRET = "focusbro-secret-key-prod-2024" 
}
```

### Secrets (Set via `wrangler secret put`)

```bash
# Authentication - REQUIRED
wrangler secret put JWT_SECRET
# Value: Generate random 32+ char string
# Example: $(openssl rand -base64 24)

# Stripe - REQUIRED for billing
wrangler secret put STRIPE_SECRET_KEY
# Value: sk_live_... from Stripe dashboard

wrangler secret put STRIPE_PRICE_PRO_MONTHLY
# Value: price_1Q... from Stripe product config

wrangler secret put STRIPE_PRICE_ENTERPRISE_MONTHLY
# Value: price_1Q... from Stripe product config

wrangler secret put STRIPE_WEBHOOK_SECRET
# Value: whsec_... from Stripe webhook endpoint

# Web Push - REQUIRED for notifications
wrangler secret put VAPID_PUBLIC_KEY
# Value: Base64-encoded public key from Web Push keygen

wrangler secret put VAPID_PRIVATE_KEY
# Value: Base64-encoded private key from Web Push keygen

wrangler secret put VAPID_SUBJECT
# Value: mailto:admin@focusbro.net (or your email)
```

## Step-by-Step Setup

### 1. Cloudflare Account Setup

**Create/Access Cloudflare Account**
```bash
# Login to Cloudflare dashboard
# https://dash.cloudflare.com
```

**Set Up Domain**
- Add focusbro.net to Cloudflare
- Update nameservers at domain registrar
- Wait for DNS propagation (5-30 min)

### 2. Cloudflare D1 Database

**Create Database**
```bash
wrangler d1 create focusbro
# Output will show database_id
```

**Update wrangler.toml**
```toml
[env.production]
d1_databases = [{
  binding = "DB",
  database_id = "<database_id_from_output>",
  database_name = "focusbro"
}]
```

**Verify Database Creation**
```bash
# Schema will auto-create on first API call
# Or manually initialize:
wrangler d1 execute focusbro --command "SELECT 1" --env production
```

### 3. Cloudflare KV Store

**Create KV Namespace**
- Go to Cloudflare Dashboard > KV
- Click "Create Namespace"
- Name: `focusbro-cache`
- Get namespace ID from settings

**Update wrangler.toml**
```toml
[[kv_namespaces]]
binding = "KV_CACHE"
id = "<namespace_id>"
preview_id = "<namespace_id>"
```

### 4. Stripe Configuration

**Create Stripe Account**
- Sign up at https://stripe.com
- Go to API Keys section

**Get API Key**
- Copy "Secret key" (starts with `sk_live_` in production)
```bash
wrangler secret put STRIPE_SECRET_KEY
# Paste: sk_live_...
```

**Create Products/Prices**
- Dashboard > Products
- Create "Pro Monthly" product
  - Price: $5/month
  - Billing period: monthly
  - Copy Price ID (e.g., `price_1Qo...`)
- Create "Enterprise Monthly" product
  - Price: Custom (e.g., $25/month)
  - Copy Price ID

```bash
wrangler secret put STRIPE_PRICE_PRO_MONTHLY
# Paste: price_1Qo...

wrangler secret put STRIPE_PRICE_ENTERPRISE_MONTHLY
# Paste: price_1Qe...
```

**Set Up Webhook Endpoint**
- Dashboard > Webhooks
- Create endpoint:
  - URL: `https://focusbro.net/api/billing/webhook`
  - Events: `checkout.session.completed`, `customer.subscription.deleted`
  - Get "Signing secret" (whsec_...)

```bash
wrangler secret put STRIPE_WEBHOOK_SECRET
# Paste: whsec_...
```

### 5. Web Push (VAPID Keys)

**Generate VAPID Keys**
```bash
# Using openssl
openssl rand -base64 24 | head -c 32  # Public key
openssl rand -base64 32 | head -c 43  # Private key

# Or use web push generator:
# https://tool.yopp.me/vapid
```

**Store in Secrets**
```bash
wrangler secret put VAPID_PUBLIC_KEY
# Paste: <Base64-encoded public key>

wrangler secret put VAPID_PRIVATE_KEY
# Paste: <Base64-encoded private key>

wrangler secret put VAPID_SUBJECT
# Paste: mailto:admin@focusbro.net
```

### 6. Authentication Secret

**Generate JWT_SECRET**
```bash
# Generate secure random string
openssl rand -base64 32

wrangler secret put JWT_SECRET
# Paste the generated string
```

## Verification

### Test Configuration
```bash
# List all configured secrets (without values)
wrangler secret list --env production

# Test API connectivity
curl -X GET https://focusbro.net/api/vapid/public-key
```

### Test Database
```bash
# Create test user
wrangler d1 execute focusbro \
  --command "INSERT INTO users (id, email, password_hash, subscription_tier) VALUES ('test-1', 'test@example.com', 'hash', 'free')" \
  --env production
```

### Test Notifications
```bash
# Manually test push
# Or use: https://web-push-codelab.appspot.com/
```

## Troubleshooting

### Database Connection Failed
```
Error: Database binding not found
```
**Solution**: Verify `database_id` matches actual database in Cloudflare

### Stripe API Error (401)
```
Error: Invalid API Key provided
```
**Solution**: Confirm `STRIPE_SECRET_KEY` is correct (not publishable key)

### VAPID Key Error
```
Error: Failed to decode VAPID key
```
**Solution**: VAPID keys must be base64-encoded; use generator tool

### Webhook Not Triggering
```
No 'checkout.session.completed' events received
```
**Solution**: 
1. Verify webhook URL is publicly accessible: `curl https://focusbro.net/api/billing/webhook`
2. Check Stripe webhook endpoint status in dashboard
3. Confirm signing secret matches `STRIPE_WEBHOOK_SECRET`

## Environment-Specific Variables

### Development (`wrangler dev`)
```bash
# Use same format in wrangler.toml [env.development]
API_ORIGIN = "http://localhost:8787"
JWT_SECRET = "dev-secret-key"
# Note: D1/KV in dev point to preview namespaces
```

### Production (`wrangler deploy --env production`)
```bash
# Already configured in [env.production]
API_ORIGIN = "https://focusbro.net"
# Secrets fetched from Cloudflare secret manager
```

## Monitoring & Alerts

### CLI Commands
```bash
# Check deployment status
wrangler deployments list --env production

# Monitor logs (real-time)
wrangler tail --env production

# View D1 metrics
wrangler d1 info focusbro --env production
```

### Cloudflare Dashboard
- Workers Analytics: Real-time requests, errors, latency
- D1: Database size, query performance
- KV: Namespaces, key count, bandwidth

## Security Best Practices

1. **Rotate JWT_SECRET quarterly**
   ```bash
   openssl rand -base64 32
   wrangler secret put JWT_SECRET  # New value
   # Old tokens remain valid until expiry (30 days)
   ```

2. **Restrict CORS Origins**
   - Only `https://focusbro.net` and `https://www.focusbro.net`
   - Dev origins (localhost) for development only

3. **Stripe API Keys**
   - Never commit to git
   - Rotate if compromised
   - Use webhook signing for validation

4. **VAPID Keys**
   - Generate new pair if compromised
   - Prevent exposure in client code (only public key sent)

5. **Database Access**
   - D1 queries parameterized (no SQL injection)
   - Connection limited to Cloudflare Workers only
   - Backups recommended (manual export)

## Deployment Flow

```
Local Development
    ↓
git commit
    ↓
wrangler deploy --env production
    ↓
Cloudflare Workers (Updated)
    ↓
D1 Database (Schema auto-created)
    ↓
Webhook receives Stripe events
    ↓
KV Cache stores session data
```

## Support

For configuration issues:
1. Check Cloudflare Workers documentation: https://developers.cloudflare.com/workers
2. Review Stripe API docs: https://stripe.com/docs/api
3. Check FocusBro error logs: `wrangler tail --env production`
