# Analytics Instrumentation (Task 1/7)

## Overview
Successfully completed analytics instrumentation for ambient sound selection and checkout flow tracking. This enables data-driven decisions about retention, feature usage, and monetization effectiveness.

## Event Schema

All events follow a unified format:

```javascript
{
  id: string (UUID),
  type: string,           // Event category
  tool: string,           // Tool context (pomodoro, meditation, breathing, billing)
  duration_seconds: number,
  data: object,          // Custom event properties
  timestamp: ISO8601,
  synced: boolean
}
```

## Instrumented Events

### 1. Ambient Sound Selection (`ambient_selected`)
**Trigger**: User clicks an ambient option (None, Pink, White, Brown, Rain, Forest, etc.)
**Location**: `updateAmbientUI(inputId)` function (line 4649)
**Event Properties**:
```javascript
{
  type: 'ambient_selected',
  tool: 'pomodoro' | 'breathing' | 'meditation',
  duration_seconds: 0,
  data: { ambient_type: 'none' | 'pink-noise' | 'white-noise' | 'brown-noise' | 'rain' | ... }
}
```

**Usage**: Identifies which ambient sounds users prefer by tool, guiding product roadmap and bundling decisions.

### 2. Session Completion with Ambient Context
**Pomodoro** (`session_complete` - Pomodoro)
- Trigger: User completes a Pomodoro session and rates energy
- Location: `recordPomodoroSession()` function (line 4618)
- Event Properties:
  ```javascript
  {
    type: 'session_complete',
    tool: 'pomodoro',
    duration_seconds: 25*60 | 45*60 | 60*60,  // Actual duration
    data: { 
      type: 'focus',
      energy: 1-5,           // User energy rating
      ambient: 'none' | 'pink-noise' | ...
    }
  }
  ```

**Meditation** (`session_complete` - Meditation)
- Trigger: User stops meditation session
- Location: `stopMeditation()` function (line 4038)
- Event Properties:
  ```javascript
  {
    type: 'session_complete',
    tool: 'meditation',
    duration_seconds: actually_meditated_seconds,  // Calculated from startTime
    data: { 
      ambient: 'none' | 'pink-noise' | ...
    }
  }
  ```

**Breathing** (`session_complete` - Breathing)
- Trigger: User stops breathing exercise
- Location: `stopBreathing()` function (line 3858)
- Event Properties:
  ```javascript
  {
    type: 'session_complete',
    tool: 'breathing',
    duration_seconds: 0,  // Breathing is manual, no timer
    data: { 
      ambient: 'none' | 'pink-noise' | ...
    }
  }
  ```

### 3. Checkout Flow Funnel
**Funnel Events** (checkout_initiated → checkout_redirected)
- Location: `initiateCheckout(plan)` function (line 2230)
- Events:
  1. **checkout_initiated** - User clicks "Enable Cloud Sync" button
     ```javascript
     {
       type: 'checkout_initiated',
       tool: 'billing',
       duration_seconds: 0,
       data: { plan: 'pro' }
     }
     ```

  2. **checkout_failed** - Validation or API error (3 subtypes)
     ```javascript
     {
       type: 'checkout_failed',
       tool: 'billing',
       duration_seconds: 0,
       data: { 
         plan: 'pro',
         reason: 'api_error' | 'invalid_response' | 'invalid_url' | 'blocked_domain' | 'non_https' | 'error'
         // Additional fields if available
       }
     }
     ```

  3. **checkout_redirected** - Successfully redirected to Stripe
     ```javascript
     {
       type: 'checkout_redirected',
       tool: 'billing',
       duration_seconds: 0,
       data: { plan: 'pro' }
     }
     ```

**Funnel Analysis**:
- Conversion rate: `checkout_redirected / checkout_initiated`
- Failure rate by reason: Group by `data.reason`
- Churn detection: Long gap between `checkout_initiated` and `checkout_redirected` (user dropped off)

## Analytics Queries

### 1. Ambient Preference Distribution
```sql
SELECT data->>'ambient_type', COUNT(*) as count
FROM events
WHERE type = 'ambient_selected'
GROUP BY data->>'ambient_type'
ORDER BY count DESC;
```

### 2. Ambient Correlation with Completion
```sql
-- Do sessions with ambient sound have higher completion rates?
SELECT 
  ambient_type,
  COUNT(*) as total_sessions,
  SUM(CASE WHEN type = 'session_complete' THEN 1 ELSE 0 END) as completions,
  100.0 * SUM(CASE WHEN type = 'session_complete' THEN 1 ELSE 0 END) / COUNT(*) as completion_rate
FROM (
  SELECT 
    data->>'ambient_type' as ambient_type,
    type
  FROM events
  WHERE tool IN ('pomodoro', 'meditation', 'breathing')
) t
GROUP BY ambient_type
ORDER BY completion_rate DESC;
```

### 3. Checkout Conversion Funnel
```sql
SELECT 
  type,
  COUNT(*) as count,
  ROUND(100.0 * COUNT(*) / MAX(COUNT(*)) OVER(), 2) as pct_of_initiation
FROM events
WHERE tool = 'billing'
GROUP BY type
ORDER BY count DESC;
```

### 4. Energy Rating by Ambient Type
```sql
SELECT 
  data->>'ambient' as ambient,
  ROUND(AVG((data->>'energy')::int), 2) as avg_energy,
  COUNT(*) as sessions
FROM events
WHERE tool = 'pomodoro' AND type = 'session_complete'
GROUP BY data->>'ambient'
ORDER BY avg_energy DESC;
```

## Retention Metrics

### Ambient Sound Engagement
Track sessions with ambient enabled (vs. none):
```javascript
const with_ambient = events.filter(e => e.tool.includes('session') && e.data.ambient !== 'none').length;
const total_sessions = events.filter(e => e.type === 'session_complete').length;
const ambient_adoption = 100 * with_ambient / total_sessions;
```

**Hypothesis**: Users who select ambient sounds have:
- Longer session duration
- Higher energy ratings
- More consistent daily usage streaks
- Higher likelihood to convert to cloud sync

### Monetization Funnel
Track checkout flow through completion:
- **Top of funnel**: `checkout_initiated` (awareness, product interest)
- **Middle**: `checkout_redirected` (intent to convert)
- **Bottom**: Stripe webhook `charge.succeeded` (actual payment)

**Current Gap**: No webhook tracking yet; stripe-side metrics not connected.

## Future Enhancements

1. **Cohort Analysis**: Compare retention metrics for users who adopted ambient sounds early vs. late
2. **Attribution**: Track which tool drives most cloud-sync conversions
3. **Churn Analysis**: Identify drop-off points in checkout flow
4. **A/B Testing**: 
   - Price sensitivity: $3/mo vs $4/mo
   - Copy testing: "Enable Cloud Sync" vs "Save & Sync Everywhere"
   - Ambient bundling: Default with meditation vs. opt-in
5. **Session Quality**: Correlate energy ratings with ambient type to find winning combos
6. **Stripe Webhook Integration**: Connect payment events to user profiles for paid tier tracking

## Event Processing

Events are queued in `eventQueue` and processed via `processEventQueue()` which:
1. Batches events (default: send when queue reaches 10 events or 30s elapsed)
2. POSTs to `/api/events` endpoint (not yet implemented)
3. Marks events as `synced: true` on success
4. Retries failed batches with exponential backoff

**Current Status**: Event logging is local-only. Backend `/api/events` endpoint needs implementation.

## Files Modified
- `public/index.html`:
  - Line 2230: `initiateCheckout()` — Added 6 event logs (checkout_initiated, checkout_failed variants, checkout_redirected, checkout_error)
  - Line 3858: `stopBreathing()` — Changed from `tool_use` to `session_complete` with ambient context
  - Line 4038: `stopMeditation()` — Added duration calculation and `session_complete` with ambient context
  - Line 4618: `recordPomodoroSession()` — Added ambient type to session_complete event
  - Line 4649: `updateAmbientUI()` — Added `ambient_selected` event logging with tool context

## Next Steps
1. Implement `/api/events` POST endpoint in Cloudflare Workers API
2. Add Stripe webhook handler for payment confirmation
3. Create analytics dashboard to visualize funnel metrics
4. Set up alerts for abnormal conversion rate changes
5. Plan cohort analysis for feature adoption vs. retention
