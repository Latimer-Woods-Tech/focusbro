# FocusBro — Architecture Plan & Deployment Backlog
**Version:** 1.0 | **Date:** 2026-03-25 | **Status:** Authoritative Planning Document

---

## Table of Contents
1. [System Overview](#1-system-overview)
2. [Current State Inventory](#2-current-state-inventory)
3. [Feature Matrix](#3-feature-matrix)
4. [Subscription Tier Model](#4-subscription-tier-model)
5. [Architecture Decisions](#5-architecture-decisions)
6. [Database Schema Additions](#6-database-schema-additions)
7. [API Endpoint Additions](#7-api-endpoint-additions)
8. [Implementation Backlog by Phase](#8-implementation-backlog-by-phase)
   - [Phase 0 — Data Infrastructure](#phase-0--data-infrastructure-foundation)
   - [Phase 1 — Analytics Dashboard](#phase-1--analytics-dashboard)
   - [Phase 2 — Data Export](#phase-2--data-export)
   - [Phase 3 — Notifications](#phase-3--notifications)
   - [Phase 4 — Slack Integration](#phase-4--slack-integration)
   - [Phase 5 — Monetization Layer](#phase-5--monetization-layer)
9. [Frontend Architecture Standards](#9-frontend-architecture-standards)
10. [Backend Architecture Standards](#10-backend-architecture-standards)
11. [Security Requirements by Phase](#11-security-requirements-by-phase)
12. [Testing Checklist by Phase](#12-testing-checklist-by-phase)

---

## 1. System Overview

### Tech Stack (Locked)
| Layer | Technology | Rationale |
|---|---|---|
| Frontend | Vanilla JS + HTML5 + CSS3 | No build step, instant deploy, no framework debt |
| Backend | Cloudflare Workers (itty-router) | Edge compute, $0 at current scale, global CDN |
| Database | Cloudflare D1 (SQLite) | Serverless SQL, built into Workers |
| Cache | Cloudflare KV (`KV_CACHE`) | Session tokens, rate limiting |
| Auth | HMAC-SHA256 JWT (30-day tokens) | No external auth dependency |
| Deployment | Wrangler CLI + Git | One-command deploys |
| Production URL | https://focusbro.net | |
| AdSense | ca-pub-1346297152611586 | Passive revenue while building (must match /ads.txt) |

### Guiding Principles
1. **Data ownership** — User data never leaves the stack without explicit export action
2. **Progressive enhancement** — Every feature works without login; cloud sync is the upgrade
3. **No external runtime dependencies** — If Cloudflare is up, FocusBro is up
4. **Gate features, not tools** — All focus/wellness tools remain free forever; analytics depth and export formats are the paid value
5. **Mobile-first** — All new UI built with mobile as the primary viewport

---

## 2. Current State Inventory

### Existing Frontend Views (all in `public/index.html`, 1941 lines)
| View ID | Tool | Data Stored | Auth Required |
|---|---|---|---|
| `dashboard` | Main dashboard + session count | `sessionCount` (localStorage) | No |
| `pomodoro` | 25-min focus timer | `sessionCount`, `settingsPomodoro` | No |
| `keep-alive` | Activity simulation (2-58s intervals) | None | No |
| `breathing` | Box / 4-7-8 / Tactical | None (stateless) | No |
| `grounding` | 5-4-3-2-1 grounding | None (stateless) | No |
| `body-scan` | Guided body scan | None (stateless) | No |
| `meditation` | Timed meditation | None (stateless) | No |
| `task-difficulty` | Task difficulty rating | None (stateless) | No |
| `movement` | Movement break guide | None (stateless) | No |
| `medication` | LSD timer / dose tracker | `medicationDose` (localStorage) | No |
| `energy` | Mood/energy 1-5 scale | `energyLogs` (localStorage JSON) | No |
| `dopamine-menu` | Custom activity list | `dopamineItems` (localStorage) | No |
| `fidget` | Spinner + particle canvas | None (stateless) | No |
| `settings` | Pomodoro duration, break length | `settingsPomodoro`, `settingsBreak` | No |

### Existing Backend Routes
| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/register` | None | Create account |
| POST | `/auth/login` | None | Get JWT token |
| POST | `/sync/data` | JWT | Upload localStorage snapshot |
| GET | `/sync/data` | JWT | Retrieve latest snapshot |
| GET | `/users/profile` | JWT | Get user profile |
| PUT | `/users/profile` | JWT | Update profile |
| POST | `/users/change-password` | JWT | Change password |
| GET | `/devices` | JWT | List active sessions |
| DELETE | `/devices/:deviceId` | JWT | Revoke session |
| POST | `/auth/logout-all` | JWT | Kill all sessions |
| POST | `/users/delete-account` | JWT | GDPR delete |
| GET | `/health` | None | Uptime check |

### Existing Database Tables
| Table | Purpose | State |
|---|---|---|
| `users` | Accounts, subscription tier | ✅ Active |
| `sessions` | JWT session tracking | ✅ Active |
| `user_data_snapshots` | Full localStorage JSON blobs | ✅ Active |
| `sync_logs` | Sync audit trail | ✅ Active |
| `audit_logs` | Security audit | ✅ Active |

### Key Frontend Variables
```javascript
// Global state (currently persisted to localStorage only)
let sessionCount = 0;         // Total pomodoro sessions completed
let energyLogs = [];          // [{ time: ISO, energy: 1-5, mood: string }]
let pomodoroTimer = null;     // setInterval reference
let medDisplayInterval = null;// setInterval for medication display
let syncInterval = null;      // setInterval for cloud sync
let user = null;              // { email, first_name, id, subscription_tier }
```

### Local Storage Keys (Current)
| Key | Type | Content |
|---|---|---|
| `fbToken` | string | JWT auth token |
| `fbUser` | JSON | User object |
| `fbSessionId` | string | Session ID |
| `sessionCount` | number | Total completed pomodoros |
| `energyLogs` | JSON array | Energy log entries |
| `dopamineItems` | JSON array | Custom dopamine menu items |
| `medicationDose` | JSON | `{ time, name }` |
| `settingsPomodoro` | number | Pomodoro duration in minutes |
| `settingsBreak` | number | Break duration in minutes |

---

## 3. Feature Matrix

### Complete Build Target Matrix

| Feature | Free Tier | Pro ($5/mo) | Enterprise ($15/mo/user) | Phase | Effort |
|---|:---:|:---:|:---:|:---:|:---:|
| **All 14 wellness tools** | ✅ | ✅ | ✅ | Done | — |
| **Basic session count (today)** | ✅ | ✅ | ✅ | Done | — |
| **Energy/mood logging** | ✅ | ✅ | ✅ | Done | — |
| **Medication timer** | ✅ | ✅ | ✅ | Done | — |
| **Cloud sync (multi-device)** | ✅ (5 snaps) | ✅ (unlimited) | ✅ | Done | — |
| **Session event logging** | — | — | — | **Phase 0** | S |
| **Streak calculation** | last 7 days | all time | all time | **Phase 0** | S |
| **Tool usage tracking** | — | — | — | **Phase 0** | S |
| **Analytics: session streaks** | 7 days | All time | All time | **Phase 1** | M |
| **Analytics: most-used tools** | top 3 | all | all + team | **Phase 1** | M |
| **Analytics: total focus time** | today | all time | all time | **Phase 1** | M |
| **Analytics: energy trends** | 7 days | 90 days | 90 days | **Phase 1** | M |
| **Analytics: heatmap calendar** | — | ✅ | ✅ | **Phase 1** | L |
| **Export: CSV (personal)** | last 30 days | Full history | Full history | **Phase 2** | S |
| **Export: PDF report** | — | ✅ | ✅ | **Phase 2** | M |
| **Export: JSON data dump** | — | ✅ | ✅ | **Phase 2** | S |
| **Notifications: morning motivation** | ✅ | ✅ | ✅ | **Phase 3** | M |
| **Notifications: break reminders** | ✅ | ✅ | ✅ | **Phase 3** | S |
| **Notifications: medication reminders** | ✅ | ✅ | ✅ | **Phase 3** | S |
| **Notifications: milestones** | ✅ | ✅ | ✅ | **Phase 3** | S |
| **Notifications: custom schedule** | — | ✅ | ✅ | **Phase 3** | M |
| **Slack: post session to channel** | — | ✅ | ✅ | **Phase 4** | M |
| **Slack: update presence status** | — | ✅ | ✅ | **Phase 4** | L |
| **Slack: accountability pings** | — | — | ✅ | **Phase 4** | L |
| **Slack: team dashboard** | — | — | ✅ | **Phase 4** | XL |
| **Billing: Stripe subscription** | — | Required | Required | **Phase 5** | L |
| **Billing: Pro upgrade flow** | — | Required | Required | **Phase 5** | M |
| **Billing: invoice history** | — | Required | Required | **Phase 5** | S |

**Effort sizing:** S = < 4hrs | M = 4-8hrs | L = 8-16hrs | XL = 16-40hrs

---

## 4. Subscription Tier Model

### Tiers
```
FREE
├── All wellness tools (no login required)
├── Basic session counter
├── Energy logging (unlimited, local)
├── Cloud sync (last 5 snapshots)
├── Analytics: last 7 days
├── CSV export: last 30 days
└── Notifications: break + medication reminders

PRO — $5/month or $49/year
├── Everything in Free
├── Analytics: full history, heatmap calendar
├── CSV export: full history
├── PDF report generation
├── JSON data dump
├── Notifications: custom schedule + milestones
├── Slack: post sessions + presence update
└── Priority support

ENTERPRISE — $15/user/month (minimum 5 users)
├── Everything in Pro
├── Team analytics dashboard
├── Slack: accountability pings + team view
├── Custom branding (logo, colors)
├── SSO (future)
└── Dedicated support
```

### Upgrade Trigger Points (in-app moments to prompt upgrade)
| Moment | Upgrade Pitch |
|---|---|
| User completes day 8 (beyond free 7-day window) | "Unlock your full streak history" |
| User tries to export PDF | "Generate PDF reports — upgrade to Pro" |
| User sets up 8th+ notification | "Custom notification schedules — Pro feature" |
| User asks about Slack in settings | "Connect Slack — Pro feature" |
| User hits 50 sessions milestone | Congrats + "Pro users see their full journey" |

---

## 5. Architecture Decisions

### Decision 1: Event Logging Architecture

**Problem:** Current data model stores only totals (`sessionCount`) and the last energy log array. There is no historical event record to power analytics.

**Decision:** Add a structured event log to localStorage that syncs to D1.

```javascript
// Event schema (stored in localStorage as 'fbEvents' JSON array)
{
  id: crypto.randomUUID(),         // Browser-generated UUID
  type: 'session_complete'         // See event types below
         | 'tool_use'
         | 'energy_log'
         | 'medication_dose'
         | 'break_complete'
         | 'streak_milestone',
  tool: 'pomodoro'                 // Which tool generated the event
         | 'breathing'
         | 'grounding'
         | 'meditation'
         | 'body-scan'
         | 'movement'
         | 'fidget'
         | 'medication',
  duration: 1500,                  // Seconds (for timed events)
  data: {},                        // Tool-specific metadata
  timestamp: '2026-03-25T14:30:00Z', // ISO 8601 UTC
  synced: false                    // Has this been pushed to D1?
}
```

**Event types and when they're emitted:**
| Event Type | Emitted When | Key Data Fields |
|---|---|---|
| `session_complete` | Pomodoro timer reaches 0 | `{ duration_min, type: 'focus'/'break' }` |
| `tool_use` | User opens any tool view | `{ tool, session_id }` |
| `energy_log` | User saves energy entry | `{ energy: 1-5, mood: string }` |
| `medication_dose` | User logs medication | `{ name, dose }` |
| `break_complete` | Break timer completes | `{ duration_min }` |
| `streak_milestone` | Streak hits threshold | `{ streak_days, total_sessions }` |

**Storage limits:** localStorage is ~5–10MB per origin. At 200 bytes/event average and 10 events/day, this is ~730KB/year — well within limits. Cap at 10,000 events locally; older events are pruned after D1 sync.

### Decision 2: Analytics Computed Client-Side

Analytics calculations (streaks, totals, averages) run in the browser against the event log. The API only stores/retrieves raw events. This removes server-side complexity and works offline.

**Exception:** Team analytics (Enterprise) requires server-side aggregation.

### Decision 3: PDF via Print-Optimized HTML

No external PDF libraries. PDF reports are generated by:
1. Building a styled HTML report in a new window
2. Triggering `window.print()` with print-specific CSS
3. User saves as PDF via browser native dialog

This works on all platforms, maintains styling, and requires zero server involvement.

### Decision 4: Notifications via Service Worker (No Vendor)

Push notifications using the Web Push API with VAPID keys generated and stored in Cloudflare Workers. No Firebase/OneSignal dependency. VAPID private key stored as a Workers secret.

### Decision 5: Slack via Incoming Webhooks First, User OAuth Second

Phase 4 ships in two sub-phases:
- **4a (Webhooks):** User pastes a Slack Incoming Webhook URL into settings. Simplest path, no Slack App approval needed.
- **4b (OAuth):** Full Slack App with OAuth for presence update and accountability pings. Requires Slack App approval.

### Decision 6: Stripe for Billing (Phase 5)

Cloudflare Workers handles Stripe webhook verification. Subscription status stored in `users.subscription_tier`. KV cache invalidated on tier change.

---

## 6. Database Schema Additions

New tables to add in sequence. Each phase depends on the tables from the previous phase.

### Phase 0 Tables

```sql
-- ── FOCUS EVENTS (granular activity log) ──
CREATE TABLE IF NOT EXISTS focus_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,          -- session_complete | tool_use | energy_log | etc.
  tool TEXT,                          -- pomodoro | breathing | grounding | meditation | etc.
  duration_seconds INTEGER DEFAULT 0,
  data TEXT DEFAULT '{}',             -- JSON: event-specific metadata
  client_timestamp DATETIME NOT NULL, -- Timestamp from client (UTC)
  server_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_events_user_time ON focus_events(user_id, client_timestamp);
CREATE INDEX IF NOT EXISTS idx_events_type ON focus_events(user_id, event_type);

-- ── USER STREAKS CACHE (computed + cached to avoid re-scan) ──
CREATE TABLE IF NOT EXISTS user_streaks (
  user_id TEXT PRIMARY KEY,
  current_streak INTEGER DEFAULT 0,
  longest_streak INTEGER DEFAULT 0,
  last_active_date TEXT,             -- ISO date string YYYY-MM-DD
  total_sessions INTEGER DEFAULT 0,
  total_focus_seconds INTEGER DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

### Phase 3 Tables

```sql
-- ── PUSH NOTIFICATION SUBSCRIPTIONS ──
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,            -- Push service URL
  p256dh TEXT NOT NULL,              -- Browser public key
  auth TEXT NOT NULL,                -- Auth secret
  device_label TEXT,                 -- User-set label e.g. "My iPhone"
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_active INTEGER DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);

-- ── NOTIFICATION PREFERENCES ──
CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id TEXT PRIMARY KEY,
  morning_motivation INTEGER DEFAULT 0,  -- 0 = off, 1 = on
  morning_time TEXT DEFAULT '08:00',     -- HH:MM local time
  break_reminders INTEGER DEFAULT 1,
  medication_reminders INTEGER DEFAULT 1,
  milestones INTEGER DEFAULT 1,
  custom_schedule TEXT DEFAULT '{}',     -- JSON (Pro only)
  timezone TEXT DEFAULT 'UTC',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

### Phase 4 Tables

```sql
-- ── SLACK INTEGRATIONS ──
CREATE TABLE IF NOT EXISTS slack_integrations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  webhook_url TEXT,                  -- Incoming webhook URL (Phase 4a)
  access_token TEXT,                 -- OAuth user token (Phase 4b)
  team_id TEXT,                      -- Slack workspace ID
  channel_id TEXT,                   -- Default channel
  post_sessions INTEGER DEFAULT 1,
  update_presence INTEGER DEFAULT 0, -- Requires OAuth (Phase 4b)
  accountability_pings INTEGER DEFAULT 0, -- Enterprise only
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_active INTEGER DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ── SLACK TEAM CONFIG (Enterprise) ──
CREATE TABLE IF NOT EXISTS slack_teams (
  id TEXT PRIMARY KEY,
  team_id TEXT UNIQUE NOT NULL,
  team_name TEXT,
  access_token TEXT,                 -- Bot token
  channel_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_active INTEGER DEFAULT 1
);
```

### Phase 5 Tables

```sql
-- ── BILLING / SUBSCRIPTIONS ──
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT,
  plan TEXT DEFAULT 'free',          -- free | pro | enterprise
  status TEXT DEFAULT 'active',      -- active | past_due | canceled | trialing
  current_period_end DATETIME,
  trial_end DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sub_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_sub_stripe ON subscriptions(stripe_customer_id);
```

---

## 7. API Endpoint Additions

### Phase 0 Endpoints

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| POST | `/events` | JWT | Batch upload focus events |
| GET | `/events` | JWT | Retrieve events (with date range) |
| GET | `/stats/summary` | JWT | Get computed stats summary |
| POST | `/stats/streaks/recalculate` | JWT | Force streak cache rebuild |

**POST `/events` request body:**
```json
{
  "events": [
    {
      "id": "uuid",
      "event_type": "session_complete",
      "tool": "pomodoro",
      "duration_seconds": 1500,
      "data": { "type": "focus" },
      "client_timestamp": "2026-03-25T14:30:00Z"
    }
  ]
}
```

**GET `/stats/summary` response:**
```json
{
  "current_streak": 7,
  "longest_streak": 14,
  "total_sessions": 142,
  "total_focus_hours": 59.2,
  "sessions_today": 3,
  "sessions_this_week": 18,
  "most_used_tool": "pomodoro",
  "avg_daily_energy": 3.4,
  "last_active_date": "2026-03-25"
}
```

### Phase 2 Endpoints

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| GET | `/export/csv` | JWT | Stream CSV of all events |
| GET | `/export/json` | JWT | Full data JSON dump (Pro) |

### Phase 3 Endpoints

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| POST | `/notifications/subscribe` | JWT | Register push subscription |
| DELETE | `/notifications/subscribe` | JWT | Remove push subscription |
| GET | `/notifications/prefs` | JWT | Get notification preferences |
| PUT | `/notifications/prefs` | JWT | Update preferences |
| GET | `/vapid/public-key` | None | Serve VAPID public key |

### Phase 4 Endpoints

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| POST | `/integrations/slack` | JWT | Save Slack webhook URL |
| DELETE | `/integrations/slack` | JWT | Remove Slack integration |
| GET | `/integrations/slack` | JWT | Get Slack config |
| POST | `/integrations/slack/test` | JWT | Send test message |
| GET | `/integrations/slack/oauth` | None | Slack OAuth callback |

### Phase 5 Endpoints

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| POST | `/billing/create-checkout` | JWT | Create Stripe Checkout session |
| POST | `/billing/portal` | JWT | Stripe billing portal URL |
| GET | `/billing/status` | JWT | Get subscription status |
| POST | `/billing/webhook` | Stripe Sig | Handle Stripe webhook events |

---

## 8. Implementation Backlog by Phase

> **This section is the deployment backlog. Do not skip phases. Each phase must be fully deployed and verified before starting the next.**

---

### Phase 0 — Data Infrastructure (Foundation)

**Goal:** Build the data layer that all future features depend on. No visible UI changes to users.

**Estimated effort: 6–8 hours**

---

#### P0-001 — Client: `logEvent()` function
**File:** `public/index.html`
**What:** Add a `logEvent(type, tool, duration, data)` function that writes structured events to localStorage (`fbEvents` key) and flags unsynced events.
**Rules:**
- Generate event `id` with `crypto.randomUUID()`
- Timestamp always in UTC ISO 8601 from `new Date().toISOString()`
- Read existing array, push new event, cap at 10,000 entries (prune oldest)
- Mark `synced: false` on creation
**Test:** Open console, run `logEvent('session_complete', 'pomodoro', 1500, {})`, verify `localStorage.getItem('fbEvents')` contains it.

---

#### P0-002 — Client: Instrument existing tools to call `logEvent()`
**File:** `public/index.html`
**What:** Add `logEvent()` calls to each tool at the right moment.
**Instrumentation points:**
| Tool | Function | Event type | When |
|---|---|---|---|
| Pomodoro | `startPomodoro()` completion callback | `session_complete` | Timer reaches 0, type=focus |
| Pomodoro | Break timer completion | `session_complete` | Break timer reaches 0, type=break |
| Breathing | `stopBreathing()` | `tool_use` | User completes or stops |
| Grounding | Submission handler | `tool_use` | User submits all 5 senses |
| Body Scan | `stopBodyScan()` | `tool_use` | Session ends |
| Meditation | `stopMeditation()` | `tool_use` | Session ends with duration |
| Energy | `saveEnergyLog()` | `energy_log` | User saves log |
| Medication | Dose log function | `medication_dose` | User logs dose |
| Movement | `showMovement()` | `tool_use` | User starts movement break |

---

#### P0-003 — Client: `getStreak()` calculation function
**File:** `public/index.html`
**What:** Calculate current streak from `fbEvents` array locally (without server).
**Algorithm:**
```
1. Filter events where event_type === 'session_complete' AND type === 'focus'
2. Extract unique dates (YYYY-MM-DD in user's local timezone)
3. Sort dates descending
4. Walk dates backward: if consecutive days, increment streak; else stop
5. Return { currentStreak, longestStreak, lastActiveDate, totalSessions }
```
**Safety:** Iterate max 730 entries (2 years). Return `0` streak if no events.

---

#### P0-004 — Client: Update dashboard stats cards
**File:** `public/index.html`
**What:** Dashboard currently shows only `sessionCount`. Update to show:
- Sessions today (from events today)
- Sessions this week
- Current streak (days)
- Total focus time (formatted as "Xh Ym")
**Note:** `sessionCount` global stays for backwards compatibility; stats cards pull from `getStreak()` + event filter.

---

#### P0-005 — Backend: `focus_events` and `user_streaks` table migration
**File:** `api/src/index.js` (initializeDatabase)
**What:** Add the two new tables to `createTableStatements` array.
**Also add** to `alterTableStatements` in case the DB already exists.

---

#### P0-006 — Backend: POST `/events` endpoint
**File:** `api/src/extended-routes.js`
**What:** Accepts batch array of events, deduplicates by `id`, inserts into `focus_events`.
**Rules:**
- Max 500 events per request (return 400 if exceeded)
- Validate `event_type` against allowed values list
- Validate `client_timestamp` is a parseable ISO date, not more than 7 days in future
- On success: update `user_streaks` cache record
- Mark synced events: return array of accepted event IDs

---

#### P0-007 — Backend: GET `/stats/summary` endpoint
**File:** `api/src/extended-routes.js`
**What:** Query `focus_events` for the authenticated user and return summary stats.
**Compute:**
- `current_streak` and `longest_streak` from `user_streaks` cache (or recompute if stale)
- `sessions_today` — count where `event_type='session_complete'` and `client_timestamp >= today`
- `sessions_this_week` — same, last 7 days
- `total_sessions` and `total_focus_seconds` from `user_streaks`
- `most_used_tool` — GROUP BY tool, ORDER BY count DESC, LIMIT 1

---

#### P0-008 — Client: Auto-sync event queue to backend
**File:** `public/index.html`
**What:** After every tool use (when user is logged in), call `syncEventQueue()` which:
1. Reads `fbEvents` where `synced === false`
2. POSTs in batches of 100 to `/events`
3. On success, marks those events `synced: true` in localStorage
4. Silently fails (logs warning, does not block UI)
**Sync timing:** Piggyback on existing `syncInterval` (every 5 min) or trigger immediately on page focus (`visibilitychange` event).

---

#### P0 Deployment Checklist
- [ ] `logEvent()` tested in browser console
- [ ] All 9 tool instrumentation points emit events
- [ ] `getStreak()` returns correct values for edge cases (no events, 1 event, 2-day gap)
- [ ] Dashboard stats cards update from event data
- [ ] `/events` endpoint rejects invalid payloads
- [ ] `/stats/summary` returns correct numbers
- [ ] Sync queue processes without blocking UI
- [ ] Deploy + verify no console errors in production

---

### Phase 1 — Analytics Dashboard

**Goal:** A dedicated `analytics-view` that visualizes the data collected in Phase 0. This is the primary Pro upsell.

**Estimated effort: 8–12 hours**

**Prerequisite:** Phase 0 complete and deployed.

---

#### P1-001 — Frontend: Create `analytics-view` HTML structure
**File:** `public/index.html`
**What:** Add a new view `<div id="analytics-view" class="view">`.
**Layout (top-to-bottom):**
```
[Page Title: "Analytics"]
[Time range selector: 7d | 30d | 90d | All Time] ← 90d/All Time = Pro only
[Row 1: 4 stat cards]
  - Current Streak (🔥 N days)
  - Total Sessions (N)
  - Total Focus Time (Nh Nm)
  - Avg Daily Energy (N.N / 5)
[Row 2: Charts]
  - Left (60%): "Sessions Per Day" bar chart (last N days)
  - Right (40%): "Tool Usage" horizontal bar chart
[Row 3: Charts]
  - Left (60%): "Energy Level Trend" line chart
  - Right (40%): "Focus Time by Hour" heat strip
[Row 4: Export buttons] (linked to Phase 2)
  - Export CSV
  - Export PDF (Pro badge)
```

---

#### P1-002 — Frontend: Implement `renderAnalyticsCharts()` with Canvas API
**File:** `public/index.html`
**What:** Pure Canvas 2D charts (no Chart.js or other libraries). Follows the same pattern as the existing energy chart.

**Three chart functions to build:**
1. `renderSessionsBarChart(canvas, data)` — sessions per day, bar per day, last 30 days
2. `renderToolUsageChart(canvas, data)` — horizontal bars per tool sorted by count
3. `renderEnergyTrendChart(canvas, data)` — line chart connecting energy log values

**Data source:** Build from `fbEvents` in localStorage. If user is logged in and Pro, hydrate from server events first.

**Design rules:**
- Use `--primary` (`#6366f1`) as bar color
- Use `--gradient-primary` for active/highlighted bars
- X-axis labels rotated 45° if more than 14 bars
- Tooltip on hover (mousemove canvas event → nearest bar → draw tooltip box)
- Animate on first render with `requestAnimationFrame` (bars grow up from bottom)

---

#### P1-003 — Frontend: Time range selector controls analytics data
**File:** `public/index.html`
**What:** Four buttons (7d, 30d, 90d, All Time). Clicking re-filters events and re-renders all charts.
- 90d and All Time: if `user.subscription_tier === 'free'`, show upgrade prompt instead
- Store selected range in a JS variable `analyticsRange` (not persisted, resets to 7d on load)

---

#### P1-004 — Frontend: Streak visualization (calendar dots)
**File:** `public/index.html`
**What:** A 13-column × 4-row mini-calendar (last 52 weeks) showing activity. Each cell is a colored dot.
- No activity = `var(--gray-200)`
- Light activity (1-2 sessions) = `#c7d2fe` (indigo-200)
- Medium (3-4 sessions) = `var(--primary-light)`
- High (5+ sessions) = `var(--primary)`
- This is a Pro-only feature. Free users see it blurred with "Upgrade to Pro" overlay.

---

#### P1-005 — Frontend: Pro gate enforcement
**File:** `public/index.html`
**What:** `isProUser()` helper function:
```javascript
function isProUser() {
  return user && ['pro', 'enterprise'].includes(user.subscription_tier);
}
```
Used in analytics view to:
- Show/hide 90d and All Time range buttons
- Show/hide streak calendar (or show blurred with overlay)
- Show/hide PDF export button

**Upgrade prompt component:** A reusable `showProGate(feature)` function that shows a card with:
- Feature name and benefit statement
- "Upgrade to Pro — $5/mo" button (links to `/billing/create-checkout` in Phase 5, for now links to a mailto or waitlist)
- "Remind me later" dismiss

---

#### P1-006 — Navigation: Add Analytics to sidebar
**File:** `public/index.html`
**What:** Add `<div class="nav-item" onclick="switchView('analytics')">📊 Analytics</div>` to sidebar nav.
**Position:** After Dashboard, before the tool groups.

---

#### P1-007 — Backend: GET `/events?start=DATE&end=DATE&limit=1000` endpoint
**File:** `api/src/extended-routes.js`
**What:** Return paginated events for the authenticated user filtered by date range.
**Rules:**
- Free tier: max 7-day lookback (enforce server-side regardless of what client sends)
- Pro/Enterprise: unrestricted
- Max `limit` is 1000 regardless of tier
- Return: `{ events: [...], total: N, has_more: bool }`

---

#### P1 Deployment Checklist
- [ ] Analytics view renders without errors on fresh account (no events)
- [ ] Analytics view renders with mocked event data
- [ ] All 3 charts draw correctly on desktop and mobile (responsive canvas)
- [ ] Time range selector re-renders charts correctly
- [ ] 90d / All Time blocked for free users with upgrade prompt
- [ ] Streak calendar renders (Pro) and shows blur (Free)
- [ ] `isProUser()` correctly reads subscription tier from `user` object
- [ ] Navigation item added and `switchView('analytics')` works
- [ ] Deploy + verify no console errors

---

### Phase 2 — Data Export

**Goal:** Enable users to export their data as CSV and PDF. CSV justifies free-tier value; PDF justifies Pro.

**Estimated effort: 6–8 hours**

**Prerequisite:** Phase 0 complete (events data exists).

---

#### P2-001 — Client: `exportCSV()` function
**File:** `public/index.html`
**What:** Build a CSV string from `fbEvents` + `energyLogs` and trigger a browser download.
**CSV columns:**
```
date, time, event_type, tool, duration_minutes, energy_level, mood, notes
```
**Implementation:**
```javascript
function exportCSV() {
  const events = JSON.parse(localStorage.getItem('fbEvents') || '[]');
  const header = 'date,time,event_type,tool,duration_minutes,energy_level,mood\n';
  const rows = events.map(e => {
    const d = new Date(e.timestamp);
    return [
      d.toLocaleDateString(),
      d.toLocaleTimeString(),
      e.type,
      e.tool || '',
      e.duration ? Math.round(e.duration / 60) : '',
      e.data?.energy || '',
      e.data?.mood || ''
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
  });
  const blob = new Blob([header + rows.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `focusbro-export-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
```
**Free tier:** All local events (no server call needed).

---

#### P2-002 — Backend: GET `/export/csv` endpoint (Pro)
**File:** `api/src/extended-routes.js`
**What:** Stream full event history as CSV for Pro users. Free users get client-side only.
**Rules:**
- Enforce `subscription_tier` check
- Response header: `Content-Type: text/csv`, `Content-Disposition: attachment; filename="focusbro-export-YYYY-MM-DD.csv"`
- No pagination: stream entire table in one response
- Max response size: 10MB (Cloudflare Workers limit is 100MB; enforce 10MB as a safety cap)

---

#### P2-003 — Client: `exportPDF()` function (Pro Only)
**File:** `public/index.html`
**What:** Generate a styled PDF report using the browser's print dialog.
**Implementation:**
1. `isProUser()` check — if false, call `showProGate('PDF Reports')`
2. Build an HTML document string with report content:
   - Header: FocusBro logo, user name, report date range
   - Section 1: Summary stats (streak, sessions, focus hours, avg energy)
   - Section 2: Sessions per day table (last 30 days)
   - Section 3: Tool usage breakdown
   - Section 4: Energy log table (last 30 entries)
3. Open in new window: `const win = window.open('', '_blank')`
4. Write HTML: `win.document.write(reportHtml)`
5. Add print-specific CSS (`@media print { ... }`)
6. Call `win.print()` after a 500ms delay (allow styles to load)
7. `win.close()` after print dialog closed via `win.onafterprint`

**Print CSS rules:**
```css
@media print {
  body { font-size: 10pt; color: #000; }
  .no-print { display: none; }
  table { page-break-inside: avoid; }
  h2 { page-break-before: always; }
  h2:first-of-type { page-break-before: avoid; }
}
```

---

#### P2-004 — Client: Export buttons in Analytics view
**File:** `public/index.html`
**What:** Add export action row at the bottom of `analytics-view`:
```html
<div class="export-row">
  <button class="btn btn-secondary" onclick="exportCSV()">
    ⬇ Export CSV
  </button>
  <button class="btn btn-primary" onclick="exportPDF()">
    📄 Export PDF Report
    <span class="pro-badge">PRO</span>
  </button>
</div>
```

---

#### P2-005 — Client: `exportJSON()` function (Pro Only)
**File:** `public/index.html`
**What:** Export complete FocusBro data as a JSON file.
**Content:**
```json
{
  "export_date": "2026-03-25T14:30:00Z",
  "user": { "email": "...", "created_at": "..." },
  "events": [...],
  "energy_logs": [...],
  "settings": { "pomodoro_duration": 25, "break_duration": 5 },
  "dopamine_items": [...],
  "medication": {...}
}
```

---

#### P2 Deployment Checklist
- [ ] CSV export generates and downloads in Chrome, Firefox, Safari
- [ ] CSV is valid (import to Google Sheets, verify columns)
- [ ] PDF opens in new window, renders correctly, prints to PDF
- [ ] PDF export blocked for free users with upgrade prompt
- [ ] JSON export produces valid parseable JSON
- [ ] Export buttons visible in analytics view
- [ ] Deploy + verify downloads work on mobile (iOS Safari, Android Chrome)

---

### Phase 3 — Notifications

**Goal:** Opt-in push notifications for reminders and milestones. Highest retention feature.

**Estimated effort: 12–16 hours**

**Prerequisite:** Phase 0 complete (events for milestone detection). Service Worker is new infrastructure.

---

#### P3-001 — Service Worker: `sw.js` file
**File:** `public/sw.js` (new file)
**What:** Minimal service worker that:
1. Listens for `push` events, shows notification with `self.registration.showNotification()`
2. Listens for `notificationclick`, focuses or opens the app
3. Handles `install` and `activate` lifecycle
4. Cache strategy: cache-first for app shell (index.html + fonts), network-first for API

**Notification payload schema:**
```json
{
  "title": "FocusBro",
  "body": "Time to take a break! You've been focused for 25 minutes.",
  "icon": "/icon-192.png",
  "badge": "/badge-72.png",
  "tag": "break-reminder",
  "data": { "action": "open", "view": "breathing" }
}
```

---

#### P3-002 — Client: Service Worker registration
**File:** `public/index.html`
**What:** Register service worker on app init:
```javascript
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    console.log('SW registered:', reg.scope);
  } catch(e) {
    console.warn('SW registration failed:', e.message);
  }
}
```
Call at end of `DOMContentLoaded`.

---

#### P3-003 — Backend: VAPID key management
**File:** `api/src/extended-routes.js`
**What:**
- `GET /vapid/public-key` — returns `env.VAPID_PUBLIC_KEY` (Workers env var)
- Worker secret `VAPID_PRIVATE_KEY` stored via `wrangler secret put`
- VAPID keys generated once with the web-push library (or manually using OpenSSL) and stored as secrets
- Never expose private key in any endpoint

**Workers secrets to add:**
```
VAPID_PUBLIC_KEY=BExample...
VAPID_PRIVATE_KEY=example...
VAPID_SUBJECT=mailto:support@focusbro.net
```

---

#### P3-004 — Backend: Push subscription endpoints
**File:** `api/src/extended-routes.js`
**What:**
- `POST /notifications/subscribe` — save push subscription to `push_subscriptions`
- `DELETE /notifications/subscribe` — deactivate subscription by endpoint
- `GET /notifications/prefs` — return `notification_prefs` record (create default if not exists)
- `PUT /notifications/prefs` — update preferences

---

#### P3-005 — Backend: Notification sender (Worker scheduled trigger)
**File:** `api/src/notifications.js` (new file)
**What:** Cloudflare Workers Cron Trigger `(0 * * * *)` (every hour) that:
1. Queries `notification_prefs` for users who have notifications enabled
2. For morning notifications: check if `morning_time` is in the current hour for user's `timezone`
3. For milestones: query `user_streaks` for new milestone thresholds (10, 25, 50, 100, 250 sessions)
4. Sends Web Push via fetch to each user's `push_subscriptions.endpoint`

**Milestone thresholds:**
```javascript
const MILESTONES = [10, 25, 50, 100, 250, 500, 1000];
```

---

#### P3-006 — Client: Notification opt-in UI in Settings view
**File:** `public/index.html`
**What:** Add a Notifications section to the settings view:
```
🔔 Notifications
[Toggle] Morning Motivation  [Time: 08:00]
[Toggle] Break Reminders (after each pomodoro)
[Toggle] Medication Reminders
[Toggle] Milestone Celebrations
[Button] Enable Notifications → requests browser permission
[Button] Send Test Notification
```
- "Enable Notifications" button calls `Notification.requestPermission()` then registers push
- If permission denied: show "Notifications are blocked. Enable in browser settings."
- Settings saved to `notification_prefs` endpoint

---

#### P3-007 — Client: In-app break reminder (no service worker required)
**File:** `public/index.html`
**What:** When pomodoro completes, if break reminder is enabled but service worker isn't active, fall back to `Notification` API directly (requires page to be open).
**Also:** Ring the existing session-complete sound + show a `showNotification()` popup inside the app UI.

---

#### P3-008 — App Icons for notification display
**Files:** `public/icon-192.png`, `public/icon-512.png`, `public/badge-72.png`, `public/manifest.json`
**What:** PWA icons required for push notifications to display properly.
- Icons: Brain emoji on indigo gradient background  
- `manifest.json`: App name, icons, theme color, display: standalone

---

#### P3 Deployment Checklist
- [ ] Service worker registers without errors
- [ ] Opt-in permission prompt fires on "Enable Notifications" click only
- [ ] Push subscription saved to database
- [ ] Morning notification arrives at configured time (test with 1-minute delay)
- [ ] Break reminder fires immediately after pomodoro completes
- [ ] Milestone notification fires at correct thresholds
- [ ] Notification taps open the app (or focus existing tab)
- [ ] Settings toggles persist across reload
- [ ] Graceful degradation if SW not supported (no errors, just silent skip)
- [ ] Deploy + test on: Chrome desktop, Safari iOS, Android Chrome

---

### Phase 4 — Slack Integration

**Goal:** Enable users to post focus sessions and updates to Slack. Phase 4a (webhooks) ships first; Phase 4b (OAuth/presence) follows.

**Estimated effort: 12–20 hours (Phase 4a: 6h, Phase 4b: 14h)**

**Prerequisite:** Phase 0 (events), Phase 3 (notification infrastructure pattern for async sends).

---

#### P4a-001 — Client: Slack settings UI in Settings view
**File:** `public/index.html`
**What:** Add Slack Integration section to settings:
```
🔗 Slack Integration [PRO]
[Input: Slack Webhook URL]  [Save]
[Toggle] Post completed focus sessions
[Toggle] Post energy check-ins
[Info] How to get a Webhook URL → link to Slack docs
[Button] Send Test Message
[Button] Disconnect
```
- Show `[PRO]` badge; `isProUser()` check before saving (show upgrade gate if free)
- Webhook URL validated: must start with `https://hooks.slack.com/services/`

---

#### P4a-002 — Backend: Slack integration CRUD endpoints
**File:** `api/src/extended-routes.js`
**What:** CRUD for `slack_integrations` table (see Phase 4 schema). All require JWT + Pro tier check.

---

#### P4a-003 — Backend: POST `/integrations/slack/test`
**File:** `api/src/extended-routes.js`
**What:** Fetches the stored webhook URL for the user and sends a test message:
```json
{
  "text": "✅ FocusBro connected to Slack! Your focus sessions will appear here."
}
```
Returns 200 if Slack accepts, 400 with error details if rejected.

---

#### P4a-004 — Client: `postToSlack(sessionData)` after pomodoro complete
**File:** `public/index.html`
**What:** After a pomodoro completes, if Slack is configured and `post_sessions` is on:
1. Build a Slack message payload (see below)
2. POST to `/integrations/slack/post` (server-side to hide webhook URL)

**Slack message format:**
```
🧠 *FocusBro — Focus Session Complete*
⏱ Duration: 25 minutes
📊 Session #47 today
🔥 Streak: 12 days
🎯 Sessions this week: 18
```

---

#### P4a-005 — Backend: POST `/integrations/slack/post`
**File:** `api/src/extended-routes.js`
**What:** Internal endpoint called by client. Retrieves user's webhook URL from DB and forwards the message to Slack. Rate limited: max 10 posts per hour per user.

**Important:** Never expose the raw webhook URL to the client. Store-and-forward only.

---

#### P4b-001 — Slack App: Create OAuth Application
**Not a code task.** Manual steps:
1. Go to https://api.slack.com/apps → Create App
2. Add OAuth scopes: `users.profile:write` (for status update)
3. Set redirect URL: `https://focusbro.net/api/integrations/slack/oauth`
4. Store `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` as Workers secrets

---

#### P4b-002 — Backend: GET `/integrations/slack/oauth` — OAuth callback
**File:** `api/src/extended-routes.js`
**What:** Handles Slack OAuth callback:
1. Receive `code` query param
2. Exchange for access token via `oauth.v2.access`
3. Store `access_token` in `slack_integrations.access_token`
4. Redirect to `https://focusbro.net/#settings` with success flag

---

#### P4b-003 — Backend: Slack status update on pomodoro start/end
**File:** `api/src/extended-routes.js`
**What:** New endpoint `POST /integrations/slack/status`:
- Called when user starts pomodoro: set Slack status to `🧠 In Focus Mode` with expiry = pomodoro duration
- Called when pomodoro ends: clear the status
- Uses `users.profile.set` Slack API method

---

#### P4 Deployment Checklist
**Phase 4a:**
- [ ] Webhook URL saves and validates correctly
- [ ] Test message appears in Slack channel
- [ ] Session completion triggers Slack post (when enabled)
- [ ] Webhook URL never exposed to client network calls
- [ ] Rate limiting enforced

**Phase 4b:**
- [ ] Slack OAuth flow completes and stores token
- [ ] Status sets to "In Focus Mode" when pomodoro starts
- [ ] Status clears when pomodoro ends
- [ ] Status clears if user closes tab during session (or times out naturally)
- [ ] Deploy + end-to-end test with real Slack workspace

---

### Phase 5 — Monetization Layer

**Goal:** Stripe billing, subscription management, enforcement of tier gates built in Phases 1-4.

**Estimated effort: 12–16 hours**

**Prerequisite:** Phases 1-4 complete (all gated features built). Do not build billing before the product has value to sell.

---

#### P5-001 — Stripe: Create products and prices
**Not a code task.** In Stripe dashboard:
- Product: `FocusBro Pro` — $5/month (price ID: `price_pro_monthly`)
- Product: `FocusBro Pro Annual` — $49/year (price ID: `price_pro_annual`)
- Product: `FocusBro Enterprise` — $15/user/month (price ID: `price_enterprise`)
- Set `subscription_tier` metadata values: `pro`, `enterprise`

---

#### P5-002 — Backend: Stripe billing endpoints
**File:** `api/src/billing.js` (new file)
**What:**
- `POST /billing/create-checkout` — Creates Stripe Checkout session, returns URL
- `POST /billing/portal` — Creates Stripe Customer Portal session, returns URL
- `GET /billing/status` — Returns current subscription status from `subscriptions` table
- `POST /billing/webhook` — Verifies Stripe signature, handles: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`

**On `checkout.session.completed`:** Set `users.subscription_tier` to the purchased tier. Invalidate KV cache for that user.

---

#### P5-003 — Backend: Tier enforcement middleware
**File:** `api/src/middleware.js`
**What:** Add `requireTier(tier)` higher-order function used to gate routes:
```javascript
function requireTier(tier) {
  return async (request, env) => {
    const auth = await verifyToken(request, env);
    if (!auth.valid) return errorResponse('Unauthorized', 401);
    const tierOrder = { free: 0, pro: 1, enterprise: 2 };
    if (tierOrder[auth.user.subscription_tier] < tierOrder[tier]) {
      return errorResponse('Pro subscription required', 402);
    }
    request.user = auth.user;
  };
}
```

---

#### P5-004 — Client: Upgrade flow UI
**File:** `public/index.html`
**What:**
- Upgrade modal triggered by `showProGate()` (built in P1-005)
- "Upgrade to Pro" button → POST `/billing/create-checkout` → redirect to Stripe Checkout URL
- After Stripe redirects back: detect `?upgraded=true` in URL, refresh user object, show success toast
- "Manage Subscription" link in settings → POST `/billing/portal` → redirect to Stripe Portal

---

#### P5-005 — Client: Reflect tier in UI
**File:** `public/index.html`
**What:**
- Add `🔑 Pro` badge to sidebar below user name (when `isProUser()`)
- Settings view: show current plan + "Manage" link
- Pro features that were previously blurred/blocked now fully unlock after upgrade

---

#### P5 Deployment Checklist
- [ ] Stripe test mode checkout completes successfully
- [ ] Subscription tier updates in DB on webhook receipt
- [ ] Pro features unlock immediately after checkout
- [ ] Billing portal opens and can cancel subscription
- [ ] On cancellation: tier reverts to free at period end
- [ ] `requireTier()` returns 402 for incorrect tier with clear error message
- [ ] No Stripe keys in client-side code (server-side only)
- [ ] Test with Stripe test card: 4242 4242 4242 4242
- [ ] Deploy + QA full upgrade → use Pro feature → downgrade → verify gate

---

## 9. Frontend Architecture Standards

These standards apply to all new code added to `public/index.html`.

### HTML Standards
- All user-facing text is escaped through `escapeHtml()` before insertion via `innerHTML`
- No `innerHTML` for structural changes — use `textContent` for text nodes
- New views follow the pattern: `<div id="{name}-view" class="view" style="display:none">`
- All interactive elements have ARIA labels if not self-descriptive
- Forms have `novalidate` and JavaScript validation using existing `validateEmail`/`validatePassword` patterns

### CSS Standards
- All new colors use CSS variables from `:root` — never hardcode hex values
- New component classes follow BEM-lite: `block`, `block-element`, `block--modifier`
- New `@media` breakpoints: mobile ≤ 768px only (no intermediate breakpoints)
- Animations use `transform` and `opacity` only (no layout-triggering properties)
- `-webkit-` prefix required alongside standard for `-background-clip`

### JavaScript Standards
- No `var` — use `const` for values that don't change, `let` for everything else
- No global state beyond the existing globals (`user`, `sessionCount`, `energyLogs`, `pomodoroTimer`, `medDisplayInterval`, `syncInterval`)
- New timers must be assigned to a variable and registered in `cleanupAllTimers()`
- All `fetch()` calls go through the existing `apiCall()` wrapper (handles auth headers + error formatting)
- `try/catch` required on all async functions; minimum requirement: `console.warn('Context:', e.message)`
- User-generated data entering `innerHTML` must pass through `escapeHtml()`
- `crypto.randomUUID()` for all ID generation

### State Management Pattern
```javascript
// ✅ CORRECT: Read from localStorage into memory variable at init, write-through on change
function loadUserData() {
  sessionCount = parseInt(localStorage.getItem('sessionCount') || '0');
  energyLogs = JSON.parse(localStorage.getItem('energyLogs') || '[]');
}
function saveUserData() {
  localStorage.setItem('sessionCount', sessionCount);
  localStorage.setItem('energyLogs', JSON.stringify(energyLogs));
}

// ❌ WRONG: Reading from localStorage inside render loops
function render() {
  const count = JSON.parse(localStorage.getItem('sessionCount')); // Don't do this
}
```

### Chart/Canvas Standards
- Every `<canvas>` element has `id`, explicit `width`/`height` attributes, and a `role="img"` + `aria-label`
- Canvas functions clear with `ctx.clearRect(0, 0, canvas.width, canvas.height)` before each render
- Mouse events on canvas use `getBoundingClientRect()` for accurate coordinates
- Canvas renders must be responsive: re-render on window resize via debounced `resize` event listener

---

## 10. Backend Architecture Standards

These standards apply to all new code in `api/src/`.

### Route Standards
- All new routes in `api/src/extended-routes.js` unless they touch core auth (those go in `index.js`)
- Every route uses `getCorsHeaders(request)` (the dynamic origin-checking version, not wildcard)
- Every authenticated route: validate JWT token as the first operation, before any DB or KV access
- Every POST route: validate Content-Type is `application/json` before parsing body

### Database Standards
- All queries use prepared statements (D1 `env.DB.prepare()`) — never concatenate user input into SQL
- Queries that modify data: use transactions where multiple tables are affected
- Pagination default: 100 records. Max: 1000 records. Always return `has_more: bool`.
- Date comparisons: always stored and compared as UTC ISO strings
- New tables always include `created_at DATETIME DEFAULT CURRENT_TIMESTAMP`

### Error Response Format
```javascript
// Standardized error response — use everywhere
function errorResponse(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
```

### Security Standards
- `subscription_tier` checks performed server-side — never trust client-sent tier
- Rate limiting: all mutating endpoints 60 req/min per IP (existing `KV_CACHE` pattern)
- External webhook calls (Slack): use server-side fetch, never expose raw URLs to client
- Stripe webhooks: verify signature with `crypto.subtle.verify` before processing
- VAPID private key: Workers secret only, never in source code

### Performance Standards  
- Any endpoint expected to run >50ms: add `Cache-Control: max-age=60` for GET endpoints
- `user_streaks` table is a computed cache — update it on event ingest, not on read
- Avoid `SELECT *` — always name the columns you need

---

## 11. Security Requirements by Phase

| Phase | Security Requirement | Implementation |
|---|---|---|
| 0 | Event IDs must be browser-generated UUIDs | `crypto.randomUUID()` — not sequential |
| 0 | Events cannot be submitted for other users | JWT `user_id` binds all inserts |
| 0 | Client timestamps validated | Reject timestamps >7 days in future, >2 years in past |
| 1 | Tier enforcement on analytics range | Server enforces free = 7-day max, regardless of client param |
| 2 | Export only user's own data | All export queries join on `user_id = JWT.user_id` |
| 2 | CSV values escaped | Wrap all values in quotes, escape inner quotes with `""` |
| 3 | VAPID private key never exposed | Workers secret, never in response body or logs |
| 3 | Push subscription endpoint validated | Must be a valid URL beginning with `https://` |
| 3 | Notification permission consent | Only request on explicit user action, never on page load |
| 4a | Slack webhook never exposed to client | Server fetches webhook from DB and posts server-side |
| 4a | Webhook URL validated on save | Must match `https://hooks.slack.com/services/` prefix |
| 4b | `SLACK_CLIENT_SECRET` in Workers secrets | Never in source code |
| 4b | OAuth state parameter validated | CSRF prevention on Slack OAuth callback |
| 5 | Stripe secret key in Workers secrets | Never in source code or client |
| 5 | Stripe webhook signature verified | Before processing any webhook payload |

---

## 12. Testing Checklist by Phase

Each phase must pass its checklist before the next phase begins.

### Pre-Phase Gate Questions
Before starting any phase, answer YES to all:
1. Is the previous phase fully deployed and verified in production? ✓
2. Are all previous phase deployment checklist items checked? ✓
3. Is `create-html-module.js` run to sync `api/src/html.js`? ✓
4. Is there a commit with message matching `feat(phase-N): ...`? ✓

### Universal Test Before Every Deploy
```bash
# Run before every wrangler deploy
node create-html-module.js          # Sync HTML to Workers module  
git add -A
git commit -m "feat(phaseN-taskID): description"
wrangler deploy --env production    # Deploy to production
# Then verify:
# 1. https://focusbro.net loads without errors
# 2. Browser console shows 0 errors
# 3. Network tab shows no 404s
# 4. Mobile viewport (375px) renders without horizontal scroll
```

---

## Appendix: Effort Summary

| Phase | Name | Estimated Hours | Revenue Impact | Priority |
|---|---|---|---|---|
| 0 | Data Infrastructure | 6–8h | 🔴 None direct, required for all | Immediate |
| 1 | Analytics Dashboard | 8–12h | 🟡 Pro upsell trigger | Next |
| 2 | Data Export | 6–8h | 🟡 Pro justification | Next (parallel to P1) |
| 3 | Notifications | 12–16h | 🟢 Retention / engagement | After P1+P2 |
| 4 | Slack Integration | 12–20h | 🔵 B2B / Enterprise revenue | After P3 |
| 5 | Monetization Layer | 12–16h | 🔵 Direct revenue activation | After P4 |
| **Total** | | **56–80h** | | |

### Recommended Sprint Plan

| Sprint | Duration | Work |
|---|---|---|
| **Sprint 1** | 1 week | Phase 0 (infrastructure) + Phase 2-P2-001 (CSV export client-side, standalone) |
| **Sprint 2** | 1 week | Phase 1 (Analytics Dashboard) + Phase 2 remainder (PDF, server CSV) |
| **Sprint 3** | 1 week | Phase 3 (Notifications) + PWA icons/manifest |
| **Sprint 4** | 2 weeks | Phase 4a (Slack webhooks) + Phase 4b (OAuth/presence) |
| **Sprint 5** | 1 week | Phase 5 (Billing/Stripe) + Launch marketing |

---

*This document is the single source of truth for the FocusBro build. All implementation decisions must be recorded here as amendments before code is written. The backlog tasks (PX-NNN) are the unit of work — each one is a deployable, verifiable increment.*
