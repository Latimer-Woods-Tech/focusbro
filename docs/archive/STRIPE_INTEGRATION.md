# Stripe Billing Integration (Task 3/7)

## Overview
Implemented full Stripe integration for FocusBro Pro subscription ($3/month cloud sync).
- Secure checkout with Stripe Checkout
- Automated webhook processing for subscription lifecycle
- Database tier management tied to Stripe subscription
- Billing portal for customer self-service

## Environment Setup Required

Add to `wrangler.toml`:
```toml
[env.production]
vars = { 
  STRIPE_SECRET_KEY = "sk_live_...",
  STRIPE_PRICE_ID_PRO = "price_...",
  APP_URL = "https://focusbro.app"
}

[env.development]
vars = {
  STRIPE_SECRET_KEY = "sk_test_...",
  STRIPE_PRICE_ID_PRO = "price_...",
  APP_URL = "http://localhost:8787"
}
```

## Endpoints

### 1. Start Subscription Checkout
**POST** `/api/billing/create-checkout`

**Request**:
```javascript
{
  "plan": "pro"  // Currently only 'pro' supported
}
```

**Success Response** (200):
```javascript
{
  "url": "https://checkout.stripe.com/pay/cs_...",
  "sessionId": "cs_..."
}
```

**Error Responses**:
- 400: Already subscribed
- 401: Unauthorized (invalid token)
- 500: Stripe API error

**Flow**:
1. User clicks "Enable Cloud Sync - $3/month" button
2. Frontend calls POST /api/billing/create-checkout
3. Backend creates Stripe Checkout session
4. Frontend redirects to Stripe's hosted checkout
5. User enters card details and confirms
6. Stripe redirects to `success_url` when complete
7. Webhook updates user tier to "pro"

### 2. Billing Portal (Manage Subscription)
**GET** `/api/billing/portal`

**Success Response** (200):
```javascript
{
  "url": "https://billing.stripe.com/..."
}
```

**User Actions in Portal**:
- View invoice history
- Update payment method
- Cancel subscription
- Download invoices

### 3. Check Current Subscription
**GET** `/api/billing/tier`

**Response** (200):
```javascript
{
  "tier": "pro" | "free",
  "status": "active" | "trialing" | "past_due" | "cancelled" | "error",
  "subscriptionId": "sub_...",
  "periodEnd": "2026-04-15T10:30:00Z"  // When current period ends
}
```

### 4. Webhook Handler
**POST** `/api/billing/webhook`

**Stripe webhooks processed**:
- `checkout.session.completed` → Create subscription, set tier to "pro"
- `customer.subscription.updated` → Update tier based on status
- `customer.subscription.deleted` → Downgrade to "free"
- `invoice.payment_succeeded` → Renew subscription period
- `invoice.payment_failed` → Log failure, schedule retry

**Webhook Signature Verification**:
- Validates `stripe-signature` header using HMAC-SHA256
- Checks timestamp (must be within 5 minutes)
- Prevents replay attacks

## Database Integration

### users table
```sql
subscription_tier TEXT DEFAULT 'free'  -- 'free' | 'pro' | 'premium'
```

### stripe_subscriptions table (NEW)
Stores Stripe subscription mapping:
```sql
CREATE TABLE stripe_subscriptions (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  stripe_product_id TEXT,
  tier TEXT,           -- Matches users.subscription_tier
  status TEXT,         -- active | trialing | cancelled | past_due
  current_period_start DATETIME,
  current_period_end DATETIME,
  created_at DATETIME,
  updated_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

## Subscription Lifecycle

```
FREE TIER
   ↓
[User clicks "Enable Cloud Sync"]
   ↓
Stripe Checkout Session Created
   ↓
User enters card details
   ↓
Payment succeeds
   ↓
[Webhook] checkout.session.completed
   ↓
   → users.subscription_tier = 'pro'
   → stripe_subscriptions record created
   → Cloud sync endpoints now accept requests
   ↓
PRO TIER (30 days)
   ↓ [Monthly renewal]
[Webhook] invoice.payment_succeeded
   ↓
   → current_period_start = +30 days
   → current_period_end = +30 days
   ↓
PRO TIER (next 30 days)
   
OR if user cancels:
   ↓
[Webhook] customer.subscription.deleted
   ↓
   → users.subscription_tier = 'free'
   → stripe_subscriptions.status = 'cancelled'
   ↓
FREE TIER (cloud sync disabled)
```

## Frontend Integration

### 1. Show Conditional UI Based on Tier
```javascript
async function updateBillingUI() {
  const response = await fetch('/api/billing/tier', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const subscription = await response.json();
  
  if (subscription.tier === 'pro') {
    document.getElementById('billingBtn').textContent = 'Manage Subscription';
    document.getElementById('billingBtn').onclick = openBillingPortal;
  } else {
    document.getElementById('billingBtn').textContent = 'Enable Cloud Sync - $3/month';
    document.getElementById('billingBtn').onclick = () => initiateCheckout('pro');
  }
}
```

### 2. Redirect After Successful Checkout
```javascript
// Check for Stripe session in URL after redirect from checkout
const params = new URLSearchParams(window.location.search);
if (params.get('success') === 'true') {
  showToast('Cloud Sync enabled! Your data is now syncing.', 'success');
  syncDataToServer(); // Immediately sync
  updateBillingUI(); // Update button
}
```

### 3. Gate Cloud Sync Behind Tier Check
```javascript
function recordPomodoroSession() {
  // ... existing code ...
  
  // Only auto-sync if Pro
  const subscription = await fetch('/api/billing/tier', {
    headers: { 'Authorization': `Bearer ${token}` }
  }).then(r => r.json());
  
  if (subscription.tier === 'pro') {
    syncDataToServer();
  }
}
```

## Stripe Configuration Checklist

- [ ] Create Stripe account (https://dashboard.stripe.com)
- [ ] Add product "Cloud Sync Pro"
- [ ] Add monthly price ($3.00 = 300 cents)
- [ ] Copy API keys to wrangler.toml
- [ ] Set webhook URL: `https://api.focusbro.app/api/billing/webhook`
- [ ] Add webhook signing secret to wrangler.toml
- [ ] Test in Stripe's test dashboard
- [ ] Switch to live keys for production
- [ ] Configure failed payment recovery (Stripe does this automatically)

## Error Handling

### Card Declined
- Stripe handles automatically on checkout page
- User is notified immediately
- Can retry with different card

### Subscription Expiration
```sql
-- Check if period_end has passed
SELECT * FROM stripe_subscriptions 
WHERE current_period_end < datetime('now')
AND status = 'active'
```

### Webhook Timeout/Retry
- Stripe retries failed webhooks for 3 days
- Each webhook includes unique ID to prevent duplicates
- Backend should be idempotent (ON CONFLICT DO UPDATE)

## Testing Workflow

### 1. Test Checkout Flow
```bash
# In Stripe test dashboard, use these card numbers:
4242 4242 4242 4242  # Success
4000 0000 0000 0002  # Decline
4000 0025 0000 3155  # Requires 3D Secure
```

### 2. Verify Webhook Processing
```bash
# Using Stripe CLI (https://stripe.com/docs/stripe-cli)
stripe listen --forward-to http://localhost:8787/api/billing/webhook
# Copy signing secret to .env

# In another terminal, trigger test events:
stripe trigger checkout.session.completed
stripe trigger customer.subscription.updated
```

### 3. Verify Database Updates
```sql
SELECT * FROM users WHERE subscription_tier = 'pro';
SELECT * FROM stripe_subscriptions;
SELECT * FROM analytics_events WHERE event_type LIKE 'billing:%';
```

## Security Considerations

- ✅ Webhook signature verification (prevents spoofing)
- ✅ HTTPS only for checkout redirect
- ✅ No API keys in frontend (all server-side)
- ✅ Subscription tier checked before cloud sync (gating)
- ✅ Rate limiting not yet implemented (TODO)

## Monitoring

### Key Metrics to Track
```sql
-- Checkout success rate
SELECT 
  COUNT(*) as total_checkouts,
  SUM(CASE WHEN "success" THEN 1 ELSE 0 END) as successes,
  100.0 * SUM(CASE WHEN "success" THEN 1 ELSE 0 END) / COUNT(*) as success_rate
FROM analytics_events 
WHERE event_type = 'billing:checkout_session_created';

-- Revenue (successful payments)
SELECT 
  DATE(created_at) as day,
  COUNT(*) as payments,
  SUM(amount/100) as revenue_dollars
FROM analytics_events
WHERE event_type = 'billing:payment_succeeded'
GROUP BY day;

-- Churn (cancellations)
SELECT 
  COUNT(*) as cancellations,
  COUNT(*) FILTER(WHERE created_at > datetime('now', '-7 days')) as last_7_days
FROM analytics_events
WHERE event_type = 'billing:subscription_cancelled';
```

## Future Enhancements

1. **Annual Plan** ($30/year, 17% discount)
   - Add STRIPE_PRICE_ID_PRO_ANNUAL to env
   - Update checkout to support plan selection

2. **Promo Codes**
   - Create coupon in Stripe dashboard
   - Pass `coupon` param to checkout session

3. **Usage-Based Billing** (overages)
   - Track API calls in sync_logs
   - Calculate overage charges monthly

4. **Dunning (Failed Payment Recovery)**
   - Stripe handles emails automatically
   - Backend listens for `invoice.payment_failed`
   - Can offer coupon to retry payment

5. **Family Plans**
   - Support multiple users on one subscription
   - Share cloud sync storage (e.g., shared team workspace)

## Troubleshooting

**"Invalid signature" on webhook**
- Check webhook signing secret matches Stripe dashboard
- Verify timestamp is recent (within 5 minutes)
- Make sure you're using test key for test webhook

**"Subscription not found" after checkout**
- Webhook may not have processed yet (takes 1-3 seconds)
- Check analytics_events table for `billing:checkout_completed`
- If missing, webhook didn't fire - check Stripe dashboard logs

**"Already subscribed" error**
- User already has active/trialing subscription
- Direct them to billing portal to manage (not new checkout)
- Allow "upgrade" if annual plan exists

**User charged but tier still "free"**
- Webhook processed late
- Manual fix: `UPDATE users SET subscription_tier = 'pro' WHERE id = 'user_id'`
- Investigate webhook logs in Stripe dashboard
