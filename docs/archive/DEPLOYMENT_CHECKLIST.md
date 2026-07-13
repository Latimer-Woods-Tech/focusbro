# FocusBro Deployment Checklist

## Pre-Deployment Verification

### Code Quality ✅
- [x] No empty catch blocks (`catch(e) {}`)
- [x] No unbounded loops (`while(true)`)
- [x] All promises have error handling
- [x] No silent failures or misleading success messages
- [x] All timers properly cleaned up in `cleanupAllTimers()`
- [x] Service Worker properly registered and tested
- [x] CORS headers configured for production origins

### Error Handling ✅
- [x] All API endpoints return proper error responses (400/401/402/404/500)
- [x] Client-side functions use try-catch with user-friendly error messages
- [x] Database errors logged with context
- [x] Network failures handled gracefully
- [x] Unhandled promises logged (no silent rejections)

### Feature Completeness ✅

**Phase 0 - Data Infrastructure**
- [x] Event logging system (`logEvent()`)
- [x] Event sync to backend (`syncEventQueue()`)
- [x] Streak calculation with safe iteration (`getStreak()`)
- [x] Dashboard stats updated from events
- [x] Endpoints: `POST /events`, `GET /stats/summary`

**Phase 1 - Analytics Dashboard**
- [x] HTML structure with time range selector (7/30/90/All)
- [x] 4 Canvas charts: sessions, tools, energy, heatmap
- [x] Pro gating on 90+ day ranges
- [x] Analytics nav item integrated
- [x] Responsive design (mobile-first)

**Phase 2 - Data Export**
- [x] CSV export with localization and proper escaping
- [x] PDF export with styled HTML report (5 sections)
- [x] JSON export (Pro-only)
- [x] Tier-based limits (free: 30d, pro: 2yr)
- [x] Size caps (10MB) and row-level error handling
- [x] Endpoints: `GET /export/csv`, `GET /export/json`

**Phase 3 - Notifications & PWA**
- [x] Service Worker (270 lines) with offline support
- [x] Push subscription flow with VAPID keys
- [x] Notification preferences UI
- [x] PWA manifest with icons (72, 192, 512px, badge)
- [x] Endpoints: `GET /vapid/public-key`, `POST/DELETE /notifications/subscribe`, `GET/PUT /notifications/prefs`

**Phase 4a - Slack Webhooks**
- [x] Webhook URL management (save, test, disconnect)
- [x] Pro-only tier gating (402 response if free)
- [x] Settings UI section with upsell modal
- [x] Endpoints: `POST/GET/DELETE /integrations/slack`, `POST /integrations/slack/test`

**Phase 5 - Stripe Billing**
- [x] Stripe checkout flow (creates customer, session)
- [x] Subscription status tracking
- [x] Webhook handler for checkout.session.completed and subscription.deleted
- [x] Tier updates on payment events
- [x] Endpoints: `POST /billing/create-checkout`, `GET /billing/status`, `POST /billing/webhook`

### Tier Gating ✅
- [x] Pro checks on analytics (90d+ ranges, heatmap)
- [x] Pro checks on exports (JSON, PDF)
- [x] Pro checks on Slack integration
- [x] Free users see upgr ade modals
- [x] Backend returns 402 for Pro-only endpoints when user is free

### Security ✅
- [x] JWT authentication on all protected endpoints
- [x] CORS headers whitelist production domain
- [x] Database queries parameterized (no SQL injection)
- [x] Slack webhook URL validation (must be https://hooks.slack.com/)
- [x] Stripe API key in secrets (not in wrangler.toml)
- [x] VAPID keys in secrets
- [x] JWT_SECRET in environment variables (should be rotated)

## Environment Setup

### Secrets to Configure

```bash
# Stripe
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_PRICE_PRO_MONTHLY
wrangler secret put STRIPE_PRICE_ENTERPRISE_MONTHLY
wrangler secret put STRIPE_WEBHOOK_SECRET

# Web Push
wrangler secret put VAPID_PUBLIC_KEY
wrangler secret put VAPID_PRIVATE_KEY
wrangler secret put VAPID_SUBJECT

# Authentication
wrangler secret put JWT_SECRET
```

### Database Initialization

1. D1 database "focusbro" must be created:
   ```bash
   wrangler d1 create focusbro
   ```

2. Schema automatically runs on first request (see `api/src/index.js`)
3. Verify tables created:
   ```sql
   .tables  -- Should show: users, sessions, focus_events, user_streaks, push_subscriptions, notification_prefs, slack_integrations, subscriptions
   ```

### KV Store Setup

- Binding: `KV_CACHE`
- Used for: Session caching, rate limiting (optional)
- Must be created in Cloudflare dashboard

## Deployment Steps

### 1. Local Testing
```bash
cd /workspaces/focusbro

# Build HTML module
node create-html-module.js

# Run local dev server (optional)
wrangler dev --env production
```

### 2. Commit Changes
```bash
git add -A
git commit -m "chore: polish & optimization pass"
```

### 3. Deploy to Production
```bash
wrangler deploy --env production
```

### 4. Verify Deployment
```bash
# Check deployed version
wrangler deployments list --env production

# Test endpoints (with auth token)
curl -H "Authorization: Bearer <token>" https://focusbro.net/api/users/profile
```

## Post-Deployment Testing

### Authentication Flow
- [ ] Register new account
- [ ] Login with credentials
- [ ] Verify JWT token in localStorage
- [ ] Logout and verify cleanup

### Analytics Pipeline
- [ ] Create pomodoro session
- [ ] Verify event synced to backend (check `/api/stats/summary`)
- [ ] View analytics dashboard
- [ ] Export CSV (should have last 30 days for free user)
- [ ] Try 90-day range (should prompt upgrade)

### Pro Features
- [ ] Pro user sees all time ranges
- [ ] Free user sees Pro gate on 90+ days
- [ ] Pro user can upgrade from billing section
- [ ] Stripe checkout redirects properly
- [ ] Webhook updates tier on successful payment

### Slack Integration
- [ ] Free user sees upsell modal
- [ ] Pro user can save webhook
- [ ] Test button sends message to Slack
- [ ] Backend returns 402 for free users

### Notifications
- [ ] Service Worker registers successfully
- [ ] Browser prompts for notification permission
- [ ] Push subscription saves to backend
- [ ] Preferences persist
- [ ] Test notification displays

### Data Export
- [ ] CSV exports with proper formatting
- [ ] PDF exports with styled sections
- [ ] JSON export Pro-gated
- [ ] Size limits enforced

## Rollback Procedure

If deployment fails:

```bash
# Get previous version ID
wrangler deployments list --env production

# Rollback to previous version
wrangler rollback --name <previous-version-id> --env production
```

## Monitoring

### Health Checks
- [ ] API responding to `/api/users/profile` (requires auth)
- [ ] /api/stats/summary returning data
- [ ] Database connections healthy
- [ ] KV store accessible

### Error Tracking
- Monitor logs via Cloudflare dashboard
- Check for 5xx errors in analytics
- Alert on 402 errors (Pro gating)

### Performance Metrics
- Database query times (Analytics queries should be <500ms)
- Canvas chart render time (should be <100ms)
- Service Worker cache hit rate

## Maintenance

### Weekly
- [ ] Check error logs for patterns
- [ ] Verify Stripe webhook processing

### Monthly
- [ ] Review database size growth (D1 backup if needed)
- [ ] Audit push subscription list (cleanup inactive)
- [ ] Check KV store usage

### Quarterly
- [ ] Rotate JWT_SECRET
- [ ] Review and update CORS whitelist
- [ ] Security audit of endpoints

## Known Limitations

### Phase 4b (Deferred)
- Slack OAuth integration deferred - webhooks sufficient for MVP
- No team/workspace features yet

### Future Improvements
- [ ] Caching strategy optimization
- [ ] Database connection pooling
- [ ] Background job processing for heavy operations
- [ ] Email notifications
- [ ] Desktop app support
