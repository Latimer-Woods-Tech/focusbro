# FocusBro Validation & Improvement Roadmap

**Created:** March 25, 2026  
**Status:** Active Remediation  
**Total Issues:** 47 (2 Critical, 6 High, 18 Medium, 21 Low)

---

## CRITICAL ISSUES (Must Fix Now)

### ✅ Issue 1: Unvalidated JSON Parsing
- **File(s):** `api/src/index.js`, `api/src/extended-routes.js`
- **Impact:** Endpoint crashes on malformed JSON
- **Status:** 🔄 IN PROGRESS
- **Fix:** Wrap all `request.json()` in try-catch with 400 response

### ✅ Issue 2: Database Schema Initialization Failure Handling
- **File(s):** `api/src/index.js`
- **Impact:** Schema creation fails silently, queries fail later
- **Status:** 🔄 IN PROGRESS
- **Fix:** Add migration tracking and verification

---

## HIGH-SEVERITY ISSUES

### 🔄 Issue 3: Missing Input Validation
- **File(s):** `api/src/extended-routes.js` (password endpoints)
- **Impact:** Type errors, security bypass
- **Status:** READY TO FIX
- **Fix:** Validate all inputs (type, length, format)

### 🔄 Issue 4: Unvalidated Billing Responses
- **File(s):** `public/index.html`
- **Impact:** Redirect to any URL, app crash
- **Status:** READY TO FIX
- **Fix:** Validate response structure and URL safety

### 🔄 Issue 5: Race Condition in Event Logging
- **File(s):** `public/index.html`
- **Impact:** Event loss under concurrent load
- **Status:** READY TO FIX
- **Fix:** Add event queue with locking mechanism

### 🔄 Issue 6: CORS Misconfiguration
- **File(s):** `api/src/index.js`
- **Impact:** Security vulnerability on untrusted origins
- **Status:** READY TO FIX
- **Fix:** Return null for untrusted origins instead of default

### 🔄 Issue 7: Unvalidated localStorage Parsing
- **File(s):** `public/index.html` (multiple locations)
- **Impact:** App crash on corrupted data
- **Status:** READY TO FIX
- **Fix:** Create `safeJSONParse()` utility function

### 🔄 Issue 8: Unsanitized PDF Exports
- **File(s):** `public/index.html`
- **Impact:** XSS if user data is compromised
- **Status:** READY TO FIX
- **Fix:** Add HTML sanitization function

---

## MEDIUM-SEVERITY ISSUES

### Issue 9: Unbounded Stream Logging
- **File(s):** `public/index.html`
- **Impact:** Performance degradation, log spam
- **Status:** READY TO FIX
- **Fix:** Use debug flag for console output

### Issue 10: Missing Null Checks on User Object
- **File(s):** `public/index.html`
- **Impact:** Runtime errors on null properties
- **Status:** READY TO FIX
- **Fix:** Validate user object structure

### Issue 11: Missing Pagination on Event Lists
- **File(s):** `public/index.html`
- **Impact:** Slow analytics with large datasets
- **Status:** READY TO FIX
- **Fix:** Limit query results and debounce renders

### Issue 12: Inconsistent Error Messages
- **File(s):** `api/src/index.js`, `api/src/extended-routes.js`
- **Impact:** User enumeration attacks
- **Status:** READY TO FIX
- **Fix:** Standardize error responses for auth failures

### Issue 13: No Timeout on Service Worker
- **File(s):** `public/index.html`
- **Impact:** Silent failure if SW missing
- **Status:** READY TO FIX
- **Fix:** Add 5-second timeout to registration

### Issue 14: Sessions Without Cleanup
- **File(s):** `api/src/index.js`
- **Impact:** Database bloat
- **Status:** READY TO FIX
- **Fix:** Add expiration cleanup on startup

### Issue 15: Missing Rate Limit on Password Reset
- **File(s):** `api/src/extended-routes.js`
- **Impact:** Email enumeration attacks
- **Status:** READY TO FIX
- **Fix:** Add global + per-email rate limiting

### Issue 16: No Webhook Signature Verification
- **File(s):** `api/src/extended-routes.js`
- **Impact:** Fake webhook processing
- **Status:** READY TO FIX
- **Fix:** Verify Stripe webhook signature

### Issue 17: Suboptimal Streak Calculation
- **File(s):** `public/index.html`
- **Impact:** Unnecessary iterations
- **Status:** READY TO FIX
- **Fix:** Stop iteration when limit reached

### Issue 18: Missing Timer Duration Validation
- **File(s):** `public/index.html`
- **Impact:** Invalid timer values
- **Status:** READY TO FIX
- **Fix:** Add min/max validation

### Issue 19: No Deduplication on Sync
- **File(s):** `public/index.html`
- **Impact:** Duplicate events in analytics
- **Status:** READY TO FIX
- **Fix:** Track sync attempts and deduplicate

### Issue 20: D1 Response Format Variance
- **File(s):** `api/src/middleware.js`
- **Impact:** Inconsistent query handling
- **Status:** READY TO FIX
- **Fix:** Normalize responses with helper

### Issue 21: Timers Not Cleared on Modal Close
- **File(s):** `public/index.html`
- **Impact:** Multiple timers running simultaneously
- **Status:** READY TO FIX
- **Fix:** Clear timers in modal close handler

---

## LOW-SEVERITY ISSUES (22-47)

### Issue 22: Missing 404 Handler on Static Files
- **Fix:** Handle missing index.html gracefully

### Issue 23: No Environment Variable Validation
- **Fix:** Verify required env vars on startup

### Issue 24: localStorage Size Not Monitored
- **Fix:** Log warnings when approaching 5MB limit

### Issue 25: Analytics Charts Without Error Boundaries
- **Fix:** Add try-catch around canvas rendering

### Issue 26: No User Feedback During Long Exports
- **Fix:** Add progress indicator to exports

### Issue 27: Slack Webhook Without Retry Logic
- **Fix:** Implement exponential backoff

### Issue 28: Missing Metrics on API Calls
- **Fix:** Log response times for monitoring

### Issue 29: No Versioning on Client-Server Contract
- **Fix:** Add API version header

### Issue 30: Energy Log Without Data Validation
- **Fix:** Validate energy level 1-10 range

### Issue 31: Multiple Global State Variables
- **Fix:** Consolidate into app state object

### Issue 32: No Session Activity Tracking
- **Fix:** Update last_activity on API calls

### Issue 33: Missing Timezone Handling
- **Fix:** Store all timestamps in UTC

### Issue 34: No Rollback on Failed Sync
- **Fix:** Implement transaction-like behavior

### Issue 35: Missing Cache Headers on Static Files
- **Fix:** Add Cache-Control headers

### Issue 36: No Compression on API Responses
- **Fix:** Enable gzip compression

### Issue 37: Analytics Without Timezone Offset
- **Fix:** Adjust dates by user's timezone

### Issue 38: Missing Documentation on Schema
- **Fix:** Add migration comments

### Issue 39: No Accessibility on Modal Dialogs
- **Fix:** Add ARIA attributes

### Issue 40: Missing Testing on Chart Edge Cases
- **Fix:** Test with 0, 1, 10k+ events

### Issue 41: Notification Without Fallback Sound
- **Fix:** Add silent audio fallback

### Issue 42: No Database Query Logging
- **Fix:** Log slow queries (>100ms)

### Issue 43: Missing User Consent for Analytics
- **Fix:** Add opt-in for event tracking

### Issue 44: No Graceful Degradation Without Service Worker
- **Fix:** Ensure app works without SW

### Issue 45: Missing Export Validation
- **Fix:** Verify exported files aren't corrupted

### Issue 46: No Backup Strategy for localStorage
- **Fix:** Auto-backup to IndexedDB

### Issue 47: Missing Heartbeat on Long-Lived Connections
- **Fix:** Implement keep-alive pings

---

## Fix Priority & Phasing

### **Phase 1 - Critical & Security (Today)**
- Fix JSON parsing validation
- Fix database schema initialization
- Fix CORS misconfiguration
- Fix input validation
- Fix localStorage parsing

**Estimated time:** 2-3 hours  
**Target:** Production-ready beta

### **Phase 2 - High-Impact (Tomorrow)**
- Fix event race condition
- Fix billing response validation
- Fix PDF HTML sanitization
- Fix webhook signature verification
- Fix rate limiting

**Estimated time:** 3-4 hours  
**Target:** Production-ready general

### **Phase 3 - Quality (Next 2 days)**
- Fix remaining medium issues (timers, pagination, etc.)
- Add logging improvements
- Fix error messages

**Estimated time:** 4-6 hours  
**Target:** Enterprise-ready

### **Phase 4 - Polish (Following days)**
- Fix low-severity issues
- Add monitoring and metrics
- Improve documentation

**Estimated time:** 6-8 hours  
**Target:** Market-ready

---

## Completed Fixes ✅

(To be updated as fixes are implemented)

---

## Testing Checklist

- [ ] All endpoints handle malformed JSON
- [ ] CORS only allows whitelisted origins
- [ ] Event sync doesn't lose data under concurrent load
- [ ] localStorage recovers from corruption
- [ ] Billing redirects only to HTTPS URLs
- [ ] PDF exports don't contain unescaped HTML
- [ ] Timers don't accumulate when modals reopen
- [ ] Rate limits enforce quotas correctly
- [ ] Webhook signatures verified
- [ ] Events deduplicated on retry

---

## Documentation Updates Needed

- [ ] Add input validation rules to API docs
- [ ] Document rate limit policies
- [ ] Add database schema migration guide
- [ ] Document CORS policy
- [ ] Add error code reference
- [ ] Document localStorage key structure
- [ ] Add security best practices guide

---

## Success Criteria

✅ All critical issues resolved  
✅ All high-severity issues fixed  
✅ 80%+ of medium issues addressed  
✅ Code passes security audit  
✅ No unhandled promise rejections  
✅ No memory leaks detected  
✅ All tests passing  
✅ Documentation updated
