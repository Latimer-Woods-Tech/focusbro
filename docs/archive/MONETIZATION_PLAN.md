# FocusBro Monetization Plan

## Current State

| Channel | Status | Issue |
|---------|--------|-------|
| Google AdSense | ❌ Rejected | Placeholder slot IDs (`XXXXXXXXXX`), previously deceptive "keep PC awake" framing (now fixed), single-page tool app = "insufficient content" per Google |
| Stripe / Subscriptions | ⚠️ Built, not connected | Backend billing.js + checkout + webhooks exist in `api/`, but frontend has no upgrade flow |
| Affiliate | ❌ Not implemented | No affiliate links anywhere |

---

## Why AdSense Rejected (Root Causes)

1. **Placeholder ad slot IDs** — All 3 ad units use `data-ad-slot="XXXXXXXXXX"`. Google sees no valid ad unit.
2. **Policy violation language** — Original meta/title said "Keep your PC awake, stay active on Teams" which implies deceptive activity simulation. **FIXED** — now says "ADHD Focus & Productivity Toolkit."
3. **Insufficient content** — Google expects content-rich pages (articles, guides). A single-page tool app with no text content gets flagged.
4. **No privacy policy** — Required by AdSense. Missing entirely.
5. **No multi-page navigation** — Single HTML file. Google prefers sites with navigation, about pages, legal pages.

### To Get AdSense Approved
1. Replace `XXXXXXXXXX` with real ad slot IDs from AdSense dashboard
2. Add a Privacy Policy page (required)
3. Add an About page / contact info
4. Add 3-5 ADHD/productivity blog articles (500+ words each) for "sufficient content"
5. Ensure all ad placements follow AdSense density policies (max 3 per viewport)
6. Re-submit for review after above changes

---

## Revenue Streams (Ranked by Impact)

### 1. Freemium Subscription — FocusBro Pro ($3-5/month)

**Status:** Backend ready (Stripe checkout, webhooks, billing portal in `api/src/billing.js`)

**Free tier (current):**
- All tools (pomodoro, breathing, sounds, fidget, etc.)
- Local storage only
- Basic stats

**Pro tier ($3-5/month):**
- Cloud sync across devices (API already built in `api/src/sync.js`)
- Extended statistics (30-day history)
- Premium ambient sounds (forest, ocean waves, campfire — higher quality)
- Custom pomodoro intervals
- Export data (CSV/JSON)
- Priority support

**Implementation needed:**
- Add "Upgrade to Pro" button in sidebar
- Build checkout redirect flow using existing `createCheckoutSession()`
- Gate cloud sync features behind tier check
- Add subscription status indicator in UI

**Estimated revenue:** 2-5% conversion at $3/month. At 10K MAU = $600-1,500/month

### 2. Google AdSense (Display Ads)

**Status:** Script tag installed, placeholder slot IDs

**To activate:**
1. Create real ad units in AdSense dashboard
2. Replace placeholder IDs
3. Add privacy policy + content pages
4. Re-submit for approval

**Ad placement strategy:**
- Top leaderboard (728×90) — already positioned
- In-feed native ad between tool cards — already positioned
- Sidebar responsive ad — already positioned
- **Do NOT add interstitials** — ruins UX for a productivity tool

**Estimated revenue:** $2-5 RPM. At 50K monthly pageviews = $100-250/month

### 3. Affiliate Marketing

**Best-fit affiliate programs for ADHD/productivity audience:**

| Partner | Commission | Product |
|---------|-----------|---------|
| Amazon Associates | 4-8% | ADHD books, fidget tools, blue light glasses, standing desks |
| Headspace/Calm | $10-15/signup | Meditation subscription |
| Focusmate | 20% recurring | Virtual coworking |
| Notion/Todoist | Varies | Productivity tools |
| ADHD supplement brands | 15-30% | Focus supplements (vetted only) |

**Implementation:**
- Add "Recommended Tools" section in sidebar or dedicated page
- Add affiliate disclaimers (FTC compliance)
- Track clicks via UTM parameters

**Estimated revenue:** $200-800/month at scale with engaged audience

### 4. Donations / Buy Me a Coffee

**Lowest barrier to implement:**
- Add "Support FocusBro" button in footer
- Link to Buy Me a Coffee or Ko-fi page
- Optional: GitHub Sponsors

**Estimated revenue:** $50-200/month (varies widely)

---

## Implementation Priority

| Priority | Action | Effort | Revenue Impact |
|----------|--------|--------|---------------|
| 🔴 P0 | Add Privacy Policy page | 1 hour | Unlocks AdSense |
| 🔴 P0 | Replace AdSense placeholder IDs | 10 min | Unlocks ad revenue |
| 🟡 P1 | Add "Upgrade to Pro" flow in UI | 2-3 hours | Highest revenue potential |
| 🟡 P1 | Add 3 blog articles for AdSense content | 2-3 hours | Improves AdSense approval odds |
| 🟢 P2 | Add affiliate links section | 1 hour | Passive income |
| 🟢 P2 | Add donation button | 30 min | Quick wins |
| 🟢 P3 | Custom domain + SSL (if not done) | 1 hour | Professional credibility |

---

## Legal Requirements

- **Privacy Policy** — Required by AdSense, GDPR, CCPA. Must disclose data collection (localStorage, cookies, analytics).
- **Terms of Service** — Recommended. Limits liability.
- **Affiliate Disclosures** — FTC requires clear disclosure of affiliate relationships.
- **Cookie Consent** — Required for EU users if using AdSense/analytics.
- **GDPR Data Access** — Users must be able to export/delete their data (localStorage makes this simpler).

---

## Metrics to Track

- Monthly Active Users (MAU)
- Tool usage frequency (which tools are most popular)
- Session duration
- Pro conversion rate
- Ad revenue per 1K sessions (RPM)
- Affiliate click-through rate
- Churn rate (Pro subscribers)

---

## 90-Day Roadmap

**Month 1 — Foundation:**
- Add Privacy Policy + About page
- Activate real AdSense slots
- Add donation button
- Implement Pro upgrade flow

**Month 2 — Growth:**
- Add 5 blog articles (SEO play)
- Add affiliate recommendations
- Launch Pro tier marketing
- Add analytics tracking

**Month 3 — Optimize:**
- A/B test ad placements
- Analyze top-performing tools for premium gating
- Review affiliate performance
- Consider annual Pro pricing ($30/year = 2 months free)
