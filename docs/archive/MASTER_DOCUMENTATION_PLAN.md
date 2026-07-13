# FocusBro Master Documentation Plan
**Version**: 1.0 | **Date**: March 25, 2026 | **Status**: Final Specification | **Classification**: Authoritative Planning Document

---

## Executive Summary

This document provides the **complete, detailed specification** for all documentation work needed to achieve maximum compliance, cohesion, and best-practice implementation across FocusBro. It includes:

1. **Documentation Inventory** — Current state + gaps
2. **Detailed Specifications** — What each doc contains, format, standards
3. **Validation Checklist** — Quality gates for each deliverable
4. **Implementation Sequence** — Dependency-aware ordering
5. **Best Practices Framework** — Standards applied throughout
6. **Compliance Matrix** — Alignment with architectural principles
7. **Testing & Verification** — How to validate completeness

**Key Principle**: First time right. Every document created passes validation before completion. No tech debt in documentation.

---

## 1. DOCUMENTATION INVENTORY & GAP ANALYSIS

### 1.1 Current Documentation (Complete)

✅ **Existing & Active Documents** (Authoritative):
- **API_DOCUMENTATION.md** — All endpoints, request/response structures
- **ARCHITECTURE_PLAN.md** — System design, phases, feature matrix
- **SECURITY_GUIDE.md** — Auth, encryption, CORS, rate limiting
- **DEPLOYMENT_GUIDE.md** — Cloudflare deployment checklist
- **ENV_CONFIG.md** — Environment variables reference
- **QUICK_REFERENCE.md** — Fast lookup for common tasks

✅ **Support Documents** (Reference):
- **RESILIENCE_AUDIT_FINDINGS.md** — Error boundary audit
- **CODE_AUDIT_COMPREHENSIVE.md** — Full codebase audit with 47 issues
- **PHASE4_COMPLETION_REPORT.md** — Improvement implementations
- **LESSONS_LEARNED.md** — Prior corrections and patterns
- **CONFIGURATION_GUIDE.md** — System configuration

### 1.2 Documentation Gaps (Missing)

#### **CRITICAL GAPS** (Production Risk)

| ID | Document | Purpose | Gap Type | Impact |
|----|----|---------|----------|--------|
| **DG-C1** | **CODE_STYLE_GUIDE.md** | Coding standards for consistency | Creating | HIGH |
| **DG-C2** | **JSDoc_STANDARDS.md** | Complete JSDoc specification | Creating | HIGH |
| **DG-C3** | **ERROR_HANDLING_GUIDE.md** | Standardized error patterns | Creating | HIGH |
| **DG-C4** | **FEATURE_FLAGS_GUIDE.md** | Feature flag architecture & usage | Creating | HIGH |
| **DG-C5** | **TESTING_STRATEGY.md** | Complete test coverage approach | Creating | HIGH |
| **DG-C6** | **API_INTEGRATION_PROTOCOL.md** | How to integrate external APIs safely | Creating | HIGH |

#### **IMPORTANT GAPS** (Maintainability)

| ID | Document | Purpose | Gap Type | Impact |
|----|----|---------|----------|--------|
| **DG-I1** | **FRONTEND_ARCHITECTURE.md** | SPA structure, module organization | Expanding | MEDIUM |
| **DG-I2** | **BACKEND_API_GUIDE.md** | Middleware, routing, DB patterns | Expanding | MEDIUM |
| **DG-I3** | **VALIDATION_PATTERNS.md** | Input validation standards | Creating | MEDIUM |
| **DG-I4** | **LOGGING_STANDARDS.md** | Logging format, levels, contexts | Creating | MEDIUM |
| **DG-I5** | **CACHE_STRATEGY.md** | Cache tiers, headers, invalidation | Creating | MEDIUM |
| **DG-I6** | **DATABASE_GUIDE.md** | Schema, queries, migrations | Creating | MEDIUM |

#### **NICE-TO-HAVE GAPS** (Completeness)

| ID | Document | Purpose | Gap Type | Impact |
|----|----|---------|----------|--------|
| **DG-N1** | **DEVELOPMENT_SETUP.md** | Local dev environment setup | Creating | LOW |
| **DG-N2** | **TROUBLESHOOTING_GUIDE.md** | Common issues and solutions | Creating | LOW |
| **DG-N3** | **PERFORMANCE_OPTIMIZATION.md** | Load time, memory, bandwidth | Creating | LOW |
| **DG-N4** | **ACCESSIBILITY_COMPLIANCE.md** | WCAG 2.1 Level AA standards | Creating | LOW |

---

## 2. DETAILED SPECIFICATIONS FOR EACH DOCUMENT

### 2.1 DG-C1: CODE_STYLE_GUIDE.md (CRITICAL)

**Purpose**: Single source of truth for code formatting, naming, and structure across entire codebase.

**Target Audience**: All developers, code reviewers, linters

**Sections to Include**:

```markdown
# FocusBro Code Style Guide

## 1. JavaScript Formatting
  1.1 Variable Naming
    - const/let preferences and patterns
    - camelCase for variables and functions
    - UPPER_SNAKE_CASE for constants
    - Examples: ✅ isFeatureEnabled, ❌ is_feature_enabled
  
  1.2 Function Declarations
    - Async vs synchronous patterns
    - Arrow functions vs function declarations
    - Parameter destructuring requirements
    - Return type expectations
    - Examples with "before/after" for common patterns
  
  1.3 Indentation & Spacing
    - 2-space indentation (confirmed by existing code)
    - Space rules around operators
    - Block spacing requirements
    - Import statement ordering
  
  1.4 String Usage
    - Single vs double quotes policy
    - Template literals requirements
    - String concatenation rules
    - Example: Use "double quotes" for all strings (consistent with codebase)

## 2. Frontend-Specific Patterns
  2.1 DOM Manipulation
    - getElementById safety (null checks required)
    - textContent vs innerHTML rules
    - Event listener patterns
    - Required error boundaries for DOM updates
  
  2.2 Async Patterns
    - Try-catch usage mandatory for async/await
    - Promise handling with .then()/.catch()
    - withRetry() wrapper usage points
    - apiCall() wrapper for all API requests
  
  2.3 State Management
    - localStorage usage patterns
    - Global variable naming (window.userFeatures, etc.)
    - State structure requirements
    - Initialization order guarantees
  
  2.4 Module Structure
    - Function organization in file
    - Event listener declaration order
    - Initialization sequence requirements
    - Export/import patterns (if using modules)

## 3. Backend-Specific Patterns
  3.1 Route Definitions
    - Method ordering (GET, POST, PUT, DELETE before specific routes)
    - Route parameter naming
    - Middleware attachment patterns
    - Error response consistency
  
  3.2 Database Access
    - Query construction with .bind()
    - .first() vs .all() vs .run() usage
    - Transaction patterns
    - Connection pooling practices
  
  3.3 Error Handling
    - Try-catch structure
    - errorResponse() helper usage
    - HTTP status code selection
    - Logging requirements

## 4. File Organization
  4.1 Frontend
    - Single file organization (public/index.html)
    - Section markers: // ── SECTION NAME ──
    - Function declaration order
    - Event listener placement
  
  4.2 Backend
    - api/src/index.js — Main routes
    - api/src/extended-routes.js — Extended endpoints  
    - api/src/middleware.js — Shared utilities
    - api/src/config.js — Configuration
  
  4.3 Tests
    - File naming: *.test.js
    - Test organization: describe > it blocks
    - Mock setup requirements
    - Assertion patterns

## 5. Comments & Documentation
  5.1 When to Comment
    - Complex algorithm explanations
    - Non-obvious design decisions
    - Workarounds for browser limitations
    - ✅ DO: Explain "why" not "what"
    - ❌ DON'T: Comment obviously readable code
  
  5.2 Section Markers
    - Format: // ── SECTION_NAME ──
    - Used for major logical sections
    - Improves code navigation
    - Example: // ── ERROR BOUNDARIES ──
  
  5.3 TODO Comments
    - Format: // TODO(date): Description with ticket
    - Include date and priority indicator
    - Actionable and specific
    - Example: // TODO(2026-04-01): Implement conflict resolution [M13]

## 6. Configuration & Environment
  6.1 Hardcoded Values
    - NEVER hardcode URLs, secrets, domains
    - Use config.js for all constants
    - Environment variables for deployment-specific values
    - Feature flags for rollout control
  
  6.2 Logging Output
    - Use consistent [ModuleName] prefix format
    - No sensitive data in logs
    - Appropriate log levels (console.debug vs .warn vs .error)
    - Structured for monitoring systems

## 7. Best Practices - ALWAYS
  7.1 Null/Undefined Safety
    - Check element existence: if (el !== null)
    - Optional chaining: obj?.property?.method?.()
    - Nullish coalescing: value ?? defaultValue
    - Array safety: Array.isArray(value) before .length
  
  7.2 Performance
    - No nested loops without bounds checking
    - Limit iterations to ~2 years of data (730 items)
    - Debounce high-frequency updates
    - Cache repeated calculations
  
  7.3 Error Boundaries
    - Every setInterval() callback wrapped in try-catch
    - Every DOM mutation in error boundary
    - Every fetch wrapped in error handler
    - Fallback behavior always defined
  
  7.4 Testing Requirements
    - Every util function has test
    - Every API endpoint has test
    - Happy path primary test
    - Error path secondary test

## 8. Linting & Formatting Rules
  - ESLint configuration (if used)
  - Prettier configuration (if used)
  - Pre-commit hooks (if enabled)
  - CI/CD format validation
```

**Validation Checklist**:
- [ ] All 8 sections complete with examples
- [ ] Frontend patterns include error safety
- [ ] Backend patterns match actual implementation  
- [ ] File organization reflects current structure
- [ ] Examples show before/after for common mistakes
- [ ] Configuration rules align with ARCHITECTURE_PLAN
- [ ] Linting section references actual tools in use
- [ ] No contradictions with existing RESILIENCE_AUDIT_FINDINGS

**Quality Gate**: Run through entire codebase, find 10 random functions, verify they follow all rules. 0 violations = PASS.

---

### 2.2 DG-C2: JSDoc_STANDARDS.md (CRITICAL)

**Purpose**: Complete specification for JSDoc comments on every function, ensuring developer understanding and IDE support.

**Target Audience**: Backend/frontend developers, code reviewers

**Sections**:

```markdown
# JSDoc Standards & Complete Reference

## 1. Why JSDoc Matters
  - IDE intellisense support (hover documentation)
  - Type safety without TypeScript
  - Parameter validation documentation
  - Return value contracts
  - Error condition documentation
  - Executable examples for developers
  - Searchable documentation
  - Enables API contract testing

## 2. Complete JSDoc Template with All Fields

```javascript
/**
 * Brief one-line description of what function does (max 80 chars)
 * Second line with additional context if description needs it
 * 
 * Longer explanation if the function is complex, including:
 * - What problem it solves
 * - When to use this function
 * - Key algorithm or approach if non-obvious
 * - Important side effects or dependencies
 * - Performance characteristics if relevant
 *
 * @function functionName
 * @param {type} paramName - Description of what param does, valid values/ranges
 * @param {type} [optionalParam=defaultValue] - Description, shown with default
 * @param {Object} objectParam - Object structure:
 *   @param {type} objectParam.property1 - Description
 *   @param {type} objectParam.property2 - Description
 * 
 * @returns {type} Description of return value. What does caller receive?
 * @returns {Promise<type>} If async, describe resolved value
 * @throws {ErrorType} Description of when/why this error is thrown
 * @throws {AnotherError} Another possible error condition
 * 
 * @async - If function is async/returns Promise
 * @deprecated {version} - If no longer recommended, suggest alternative
 * @see functionName - Related functions to understand context
 * @fires eventName - If function emits events
 * @example
 * // Basic usage example
 * const result = functionName(param1, param2);
 * console.log(result); // "expected output"
 * 
 * @example  
 * // Example with error handling
 * try {
 *   const result = await asyncFunction(param);
 * } catch (error) {
 *   console.error('Error:', error.message);
 * }
 */
function functionName(paramName, optionalParam = default) {
  // implementation
}
```

## 3. Type Annotation Standards

**Basic Types**:
```javascript
@param {string} name - User's full name
@param {number} count - Integer count, range 0-100
@param {boolean} isActive - True if currently active
@param {null} - Intentionally null value
@param {undefined} - May be undefined
@param {*} anything - Accepts any type
```

**Complex Types**:
```javascript
@param {string[]} tags - Array of string tags
@param {Object} config - Configuration object
@param {Object.<string, number>} map - Map of strings to numbers
@param {Promise<string>} promise - Promise resolving to string
@param {Array<{id: string, name: string}>} items - Array of objects with id and name
@param {(value: string) => boolean} predicate - Function taking string, returning boolean
```

**Type Unions**:
```javascript
@param {string|number} value - Either string or number
@param {boolean|null} flag - Boolean or null
```

## 4. Frontend-Specific JSDoc Examples

**Example 1: Event Handler**
```javascript
/**
 * Handle dark mode toggle from user interaction
 * Persists preference to localStorage and updates DOM
 * Re-renders UI with new color scheme
 *
 * @param {Event} event - Click event from toggle checkbox
 * @fires darkModeChanged - Emitted after mode changed
 * @example
 * document.getElementById('darkModeToggle').addEventListener('change', handleDarkModeToggle);
 */
function handleDarkModeToggle(event) { }
```

**Example 2: Async API Call**
```javascript
/**
 * Fetch feature flags for authenticated user
 * Returns availability based on subscription tier
 * Results cached in localStorage for 1 hour to reduce API load
 *
 * @returns {Promise<Object>} Object with feature names as keys, booleans as values
 * @throws {Error} If fetch fails or response invalid
 * @example
 * const features = await getFeatureFlags();
 * if (features.slackIntegration) {
 *   showSlackButton();
 * }
 */
async function getFeatureFlags() { }
```

**Example 3: Complex State Manager**
```javascript
/**
 * Organize local state updates with automatic sync
 * Atomically updates multiple localStorage keys
 * Triggers sync cycle after state change
 *
 * @param {Object} updates - Multiple key-value pairs to merge
 * @param {boolean} [skipSync=false] - If true, don't trigger server sync
 * @returns {Object} New complete state after merge
 * @throws {Error} If state can't serialize to JSON
 * @async - Calls sync operation if skipSync is false
 * @example
 * const newState = updateAppState({
 *   sessionCount: 5,
 *   lastSync: new Date().toISOString()
 * });
 */
function updateAppState(updates, skipSync = false) { }
```

## 5. Backend-Specific JSDoc Examples

**Example 1: Route Handler**
```javascript
/**
 * GET /features - Retrieve enabled features for user's subscription tier
 * Returns feature availability based on user's subscription level
 * Useful for frontend to conditionally show/hide premium features
 *
 * @route GET /features
 * @auth Optional Bearer token; uses 'free' tier if unauthenticated  
 * @returns {200} { success: true, features: {...}, tier: 'pro', message: '...' }
 * @returns {500} { success: false, error: 'message', code: 'ERROR_CODE' }
 * @example
 * GET /features
 * Authorization: Bearer eyJhbGc...
 * 
 * Response:
 * {
 *   "success": true,
 *   "features": {
 *     "slackIntegration": true,
 *     "advancedAnalytics": true
 *   },
 *   "tier": "pro"
 * }
 */
router.get('/features', async (request, env) => { })
```

**Example 2: Utility Function**
```javascript
/**
 * Check if feature is enabled for user's subscription tier
 * Features can be restricted to specific tiers (free, pro, enterprise)
 * Some features marked experimental for testing
 *
 * @param {string} featureName - Feature key from config.features
 * @param {string} userTier - User's subscription ('free'|'pro'|'enterprise')
 * @returns {boolean} True if feature enabled and tier has access
 * @example
 * if (isFeatureEnabled('slackIntegration', user.subscription_tier)) {
 *   // Safe to use Slack integration
 * }
 */
function isFeatureEnabled(featureName, userTier = 'free') { }
```

**Example 3: Database Operation**
```javascript
/**
 * Store authentication event in audit log
 * Updates database with login/logout/password-change events
 * Used for security monitoring and troubleshooting
 *
 * @param {Object} env - Cloudflare Workers environment
 * @param {string} userId - User ID from verified token
 * @param {string} eventType - Event name: 'login', 'logout', 'password_reset'
 * @param {Object} [metadata={}] - Additional event context (IP, device, error reason)
 * @returns {Promise<Object>} { success: true, event_id: "..." }
 * @throws {Error} If database insert fails or eventType invalid
 * @async
 * @example
 * await logEvent(env, userId, 'password_changed', { device: 'mobile' });
 */
async function logEvent(env, userId, eventType, metadata = {}) { }
```

## 6. Documentation Standards by Function Type

**Public API Functions**: Full JSDoc with all fields
**Helper Functions**: At minimum @param, @returns
**Internal Only Functions**: At minimum brief description
**Deprecated Functions**: Include @deprecated with migration path

## 7. JSDoc Validation Checklist

Every function must pass:
- [ ] Has one-line summary describing what it does
- [ ] Explains "why" if algorithm non-obvious
- [ ] Every parameter documented with type
- [ ] Every parameter has plain-English description
- [ ] Return value documented with type
- [ ] All thrown errors documented
- [ ] At least one @example provided
- [ ] Example is executable and correct
- [ ] No typographical errors in documentation
- [ ] Parameter descriptions include valid values/ranges if constrained

## 8. Tools & Verification

**IDE Support**:
- VSCode: JSDoc hovers work automatically
- Intellisense: Type hints appear in autocomplete
- Go to Definition: Works across files

**Verification Command**:
```bash
# Check for missing JSDoc
grep -n "function\|const.*=.*=>" public/index.html | grep -v "/**" | head -20
```

**Quality Gate**: 100% of public functions have JSDoc. 0 undocumented public APIs.
```

**Validation Checklist**:
- [ ] Template section shows all possible @tags
- [ ] Frontend examples are realistic and correct
- [ ] Backend examples match actual route handlers
- [ ] Type annotations cover all cases (arrays, objects, unions)
- [ ] 10 random functions in codebase checked, all follow template
- [ ] Examples are executable (copy-paste works)
- [ ] No contradictions with CODE_STYLE_GUIDE

**Quality Gate**: Run grep to find all `function` declarations, pick 10 at random, verify each has complete JSDoc. 10/10 = PASS.

---

### 2.3 DG-C3: ERROR_HANDLING_GUIDE.md (CRITICAL)

**Purpose**: Standardize all error handling patterns to ensure consistency, debugging ability, and graceful degradation.

**Key Sections**:

```markdown
# Error Handling Guide - Complete Standards

## 1. Error Logging Format Standard

**MANDATORY FORMAT**: Every error log must include:
1. Module context in brackets [ModuleName]  
2. Clear description of what failed
3. Error message from exception
4. Helpful context for debugging

```javascript
// ✅ CORRECT
console.error('[Features] GET /features failed:', error.message);
console.warn('[Sync] Data sync attempt 2 of 3 failed:', error.message);
console.debug('[Timer] Pomodoro update skipped, element missing:', error.message);

// ❌ WRONG - Missing context
console.error('Error:', error.message);
console.error(error);  // No context at all
console.warn('Error loading Slack config:', e.message);  // No module prefix
```

**Module Categories**:
- [Auth] — Authentication endpoints and token handling
- [Features] — Feature flag operations
- [Sync] — Data synchronization  
- [Timer] — Interval-based timer loops
- [Network] — Fetch and connectivity
- [Retry] — Retry logic execution
- [Storage] — localStorage operations
- [Event] — Event processing
- [DB] — Database operations
- [SlackIntegration] — Slack webhook operations
- [Validation] — Input validation failures
- [Cache] — Caching layer operations

## 2. Try-Catch Structure Requirements

**Rule**: Every async/await MUST be wrapped in try-catch

```javascript
// ✅ CORRECT - Async always wrapped
async function loadData() {
  try {
    const response = await fetch(url);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('[Network] Failed to load data:', error.message);
    throw error;  // Re-throw if caller needs to handle
    // OR return fallback; // If graceful degradation possible
  }
}

// ❌ WRONG - No try-catch on async
async function loadData() {
  const response = await fetch(url);  // If fails, uncaught error
  return response.json();
}
```

**Rule**: DOM access must be in error boundary

```javascript
// ✅ CORRECT - Safe DOM access
try {
  const element = document.getElementById('timer');
  if (!element) throw new Error('Element not found');
  element.textContent = newTime;
} catch (error) {
  console.error('[Timer] DOM update failed:', error.message);
  // Continue without updating display
}

// ❌ WRONG - Assumes element exists
document.getElementById('timer').textContent = newTime;  // Crashes if null
```

## 3. Promise Error Handling

**Rule**: Every .then() should have .catch()

```javascript
// ✅ CORRECT - Promise with error handler
fetch(url)
  .then(response => response.json())
  .then(data => processData(data))
  .catch(error => {
    console.error('[Network] Promise chain failed:', error.message);
    showToast('Failed to load data', 'error');
  });

// ❌ WRONG - Silent failure
fetch(url)
  .then(response => response.json())
  .catch(() => {});  // Silent failure, hard to debug
```

**Rule**: Use withRetry() wrapper for transient failures

```javascript
// ✅ CORRECT - Retry with backoff
try {
  const result = await withRetry(
    () => apiCall('/sync/data', { method: 'POST', body: JSON.stringify(data) }),
    3,     // max retries
    1000   // base delay ms (exponential: 1s, 2s, 4s)
  );
} catch (error) {
  console.error('[Sync] All retries exhausted:', error.message);
  // Store for later retry or show user error
}
```

## 4. Distinguish Retryable vs Non-Retryable Errors

**Retryable Errors** (temporary network issues):
- Network timeout
- 5xx server errors (500, 502, 503)
- Connection refused
- DNS resolution failure

**Non-Retryable Errors** (permanent failures):
- 400 Bad Request — Invalid format
- 401 Unauthorized — Auth failed
- 403 Forbidden — Access denied
- 404 Not Found — Resource doesn't exist
- 409 Conflict — State mismatch

```javascript
// ✅ CORRECT - conditional retry
try {
  const response = await apiCall(endpoint);
  if (!response.ok) {
    if (response.status >= 500) {
      // Retryable - might work next time
      throw new Error('Server error');
    } else if (response.status >= 400) {
      // Not retryable - don't waste attempts
      throw new Error(`Not retrying: ${response.status}`);
    }
  }
} catch (error) {
  if (error.message.includes('Not retrying')) {
    // Give up immediately
    showToast('Invalid request', 'error');
  } else {
    // Might retry
    attemptRetry();
  }
}
```

## 5. Error Boundaries in Timer Loops

**Rule**: setInterval callbacks MUST have try-catch

```javascript
// ✅ CORRECT - Timer with error boundary
pomodoroTimer = setInterval(() => {
  try {
    const remaining = calculateRemaining();
    const element = document.getElementById('display');
    if (!element) return;  // Exit gracefully if unmounted
    
    element.textContent = formatTime(remaining);
    
    if (remaining <= 0) {
      clearInterval(pomodoroTimer);
      stopPomodoro();
    }
  } catch (error) {
    console.error('[Timer] Pomodoro loop failed:', error.message);
    // Continue — don't stop interval
  }
}, 100);

// ❌ WRONG - No error boundary
pomodoroTimer = setInterval(() => {
  const remaining = calculateRemaining();
  document.getElementById('display').textContent = formatTime(remaining);
  // Crashes if element missing, interval dies
}, 100);
```

## 6. API Error Response Format

**Rule**: All errors must follow standard response structure

```javascript
// Request handler catch block
catch (error) {
  console.error('[Endpoint] Operation failed:', error.message);
  return errorResponse(
    'Human-readable error message',
    500,  // HTTP status
    'ERROR_CODE'  // Machine-readable code
  );
}

// Standard error response format:
{
  "success": false,
  "error": "Human readable message",
  "code": "VALIDATION_ERROR",  // or other code
  "timestamp": "2026-03-25T18:35:16Z"
}
```

**HTTP Status Mapping**:
- 400 → INVALID_INPUT (validation failed)
- 401 → UNAUTHORIZED (auth required or invalid token)
- 403 → FORBIDDEN (authenticated but denied access)  
- 404 → NOT_FOUND (resource doesn't exist)
- 409 → CONFLICT (state/version mismatch)
- 422 → UNPROCESSABLE (semantic validity failed)
- 429 → RATE_LIMIT_EXCEEDED (too many requests)
- 500 → INTERNAL_ERROR (unexpected server failure)

## 7. Frontend Error Recovery

**Pattern: Try → Log → Fallback → Continue**

```javascript
// ✅ CORRECT - Recovery strategy
async function loadUserData() {
  try {
    const response = await apiCall('/user/profile');
    if (!response?.ok) throw new Error('Response not ok');
    
    const data = await response.json();
    return data;
  } catch (error) {
    console.warn('[User] Profile load failed, using cache:', error.message);
    
    // Fallback: Try to use cached data
    const cached = localStorage.getItem('fbUserCache');
    if (cached) return JSON.parse(cached);
    
    // Last resort: Minimal defaults
    console.error('[User] No cache available, using defaults');
    return { email: 'guest', tier: 'free' };
  }
}
```

## 8. Testing Error Paths

Every catch block needs a test:

```javascript
// Test: Verify error handling works
describe('Feature flag loading', () => {
  it('should handle network error gracefully', async () => {
    // Setup: Mock fetch to fail
    global.fetch = () => Promise.reject(new Error('Network error'));
    
    // Execute: Call function
    const result = await getFeatureFlags();
    
    // Assert: Falls back to empty features
    expect(result).toEqual({});
  });
});
```

## 9. Common Error Anti-Patterns ❌ DON'T DO

```javascript
// ❌ Empty catch - Silent failure
try {
  await riskyOperation();
} catch (e) {
  // Silence, no logging
}

// ❌ Misleading success message after error
try {
  await operation();
} catch (e) {
  console.error(e);
}
return 'Success!';  // But it might have failed!

// ❌ Logging more than message
console.error('Error:', error);  // Loses stack trace
console.error(error);  // ✅ Better, includes stack

// ❌ No recovery strategy
try {
  const data = await fetchRemote();
  state.data = data;
} catch (e) {
  state.data = undefined;  // Lost all data!
}

// ❌ Retry without backoff
for (let i = 0; i < 3; i++) {
  try {
    return await fetch(url);  // Hammers server
  } catch (e) {
    // Try again immediately
  }
}
```

## 10. Validation Checklist for Error Handling

Every function must:
- [ ] Use try-catch for async/await
- [ ] Check null/undefined before DOM access
- [ ] Log with [ModuleName] prefix
- [ ] Distinguish retryable vs non-retryable errors
- [ ] Provide fallback or graceful degradation
- [ ] Include error recovery path (not just fail)
- [ ] Test error path with unit test
- [ ] Document thrown errors in JSDoc
- [ ] No silent failures (no empty catch blocks)
- [ ] User-facing errors have helpful message

**Quality Gate**: 0 empty catch blocks in codebase. Audit finds 10 random catch blocks, all have logging. 10/10 = PASS.
```

**Validation Checklist**:
- [ ] All 10 sections complete with examples
- [ ] Module categories match actual modules in code
- [ ] Error format matches actual errorResponse() implementation
- [ ] HTTP status mapping covers all endpoints
- [ ] Examples show before/after for anti-patterns
- [ ] Recovery patterns realistic and tested
- [ ] Logging format is consistent and clear
- [ ] No contradictions with existing error handling

**Quality Gate**: Find all `catch` blocks in codebase (should find 25+), sample 10 random ones, verify all follow format. 10/10 = PASS.

---

### 2.4 DG-C4: FEATURE_FLAGS_GUIDE.md (CRITICAL)

**Purpose**: Complete architecture and usage guide for feature flags system, ensuring proper tier-gating and feature control.

```markdown
# Feature Flags System - Complete Guide

## 1. Feature Flags Architecture

**System Overview**:
- Backend configuration: `api/src/config.js`
- Feature definitions: `config.features` object  
- Backend endpoint: `GET /features` 
- Frontend fetch: `getFeatureFlags()` function
- Frontend storage: localStorage cache (1-hour TTL)
- Global access: `window.userFeatures` object

**Data Flow**:
```
User Logs In (tier recorded)
        ↓
Frontend calls getFeatureFlags()
        ↓
GET /features endpoint queries user tier
        ↓
isFeatureEnabled() checks config for tier access
        ↓
Returns { featureName: true/false ... }
        ↓
Cached in localStorage for 1 hour
        ↓
Stored in window.userFeatures
        ↓
UI components check flags before rendering
```

## 2. Backend Feature Configuration

**Location**: `api/src/config.js`, lines 87-119

**Feature Definition Structure**:
```javascript
features: {
  // Infrastructure features (always available)
  webhookRetries: { enabled: true, minTier: 'free' },
  compression: { enabled: true, minTier: 'free' },
  caching: { enabled: true, minTier: 'free' },
  
  // Pro-tier features
  slackIntegration: { enabled: true, minTier: 'pro' },
  advancedAnalytics: { enabled: true, minTier: 'pro' },
  customReports: { enabled: true, minTier: 'pro' },
  conflictResolution: { enabled: true, minTier: 'pro' },
  
  // Experimental features (A/B testing)
  darkModeApi: { enabled: true, minTier: 'free', experimental: true },
  offlineSyncV2: { enabled: false, minTier: 'pro', experimental: true },
  aiInsights: { enabled: false, minTier: 'enterprise', experimental: true }
}
```

**Fields**:
- `enabled` (boolean): Is feature turned on server-wide? If false, disabled for all users
- `minTier` (string): Minimum subscription tier required ('free', 'pro', 'enterprise')
- `experimental` (boolean, optional): Is this an experimental/beta feature?

## 3. Backend Helper Functions

**isFeatureEnabled(featureName, userTier)**
- File: `api/src/extended-routes.js`, lines 190-217
- Returns boolean: Can user access feature?
- Checks: feature exists, feature enabled, user tier >= minTier
- Usage: Before allowing pro features in routes

**checkTierAccess(userTier, requiredTier)**
- File: `api/src/extended-routes.js`, lines 161-177
- Returns boolean: User tier meets requirement?
- Hierarchy: free < pro < enterprise
- Usage: Tier validation for API endpoints

## 4. Backend GET /features Endpoint

**Route**: `GET /features`
**Authentication**: Optional Bearer token (uses free tier if not provided)
**Location**: `api/src/extended-routes.js`, lines 2050-2088

**Request**:
```
GET /features
Authorization: Bearer {token}  // Optional
```

**Response (200 OK)**:
```json
{
  "success": true,
  "features": {
    "webhookRetries": true,
    "slackIntegration": true,
    "advancedAnalytics": true,
    "darkModeApi": true,
    "offlineSyncV2": false,
    "aiInsights": false
  },
  "tier": "pro",
  "message": "Feature flags retrieved successfully"
}
```

**Implementation Details**:
1. Verify auth token (if provided)
2. Query user's subscription_tier from database
3. For each feature in config.features:
   - Call isFeatureEnabled(featureName, userTier)
   - Build response object
4. Return standardized response

## 5. Frontend Feature Fetching

**Function**: `getFeatureFlags()`
**Location**: `public/index.html`, lines 3254-3291
**Called**: On DOMContentLoaded (non-blocking)

**Logic**:
1. Check localStorage cache (`fbFeatureFlags`)
2. Check cache timestamp (1-hour TTL)
3. If valid cache exists, return cached flags
4. Otherwise, call `apiCall('/features')`
5. Validate response structure
6. Store response in localStorage (with timestamp)
7. Return feature object

**Error Handling**:
- Network error → Return empty object `{}`
- Invalid JSON → Return empty object `{}`
- Missing `features` field → Return empty object `{}`
- Graceful degradation: missing flags treated as `false`

**Example**:
```javascript
// Fetch fresh flags
const features = await getFeatureFlags();

// Cache hits after first call (1-hour TTL)
const cachedFeatures = await getFeatureFlags();  // Returns instantly from localStorage
```

## 6. Frontend Feature Flag Storage

**Global Variable**: `window.userFeatures`
**Initialization**: Set after `getFeatureFlags()` resolves
**Location**: Should be set in DOMContentLoaded

**Implementation**:
```javascript
// In DOMContentLoaded, after auth check:
let userFeatures = {};

// Later, asynchronously:
getFeatureFlags()
  .then(flags => {
    window.userFeatures = flags || {};
    console.debug('[Features] Loaded:', Object.keys(window.userFeatures).filter(k => window.userFeatures[k]).length, 'enabled');
  })
  .catch(error => {
    console.error('[Features] Failed to load flags:', error.message);
    window.userFeatures = {};  // Defaults to free tier features
  });
```

## 7. Frontend Feature Flag Usage

**Pattern 1: Show/Hide Premium Feature**
```javascript
// In settings modal:
const slackContainer = document.getElementById('slackIntegration');
if (user && window.userFeatures.slackIntegration) {
  slackContainer.style.display = 'block';
} else {
  slackContainer.style.display = 'none';
}
```

**Pattern 2: Enable/Disable Functionality**
```javascript
// In dark mode toggle:
if (window.userFeatures.darkModeApi) {
  document.getElementById('darkModeToggle').style.display = 'block';
  // Allow dark mode toggle
} else {
  // Light mode only for this tier
  document.getElementById('darkModeToggle').style.display = 'none';
}
```

**Pattern 3: Helper Function**
```javascript
function isFeatureAvailable(featureName) {
  return window.userFeatures?.[featureName] ?? false;
}

// Usage:
if (isFeatureAvailable('advancedAnalytics')) {
  showAnalyticsDashboard();
}
```

## 8. Adding a New Feature

**Step 1: Define in Configuration**
```javascript
// api/src/config.js
features: {
  newAwesomeFeature: {
    enabled: true,           // Start disabled for testing
    minTier: 'pro',          // Pro-only initially
    experimental: true       // Mark as experimental
  }
}
```

**Step 2: Implement Backend Logic**
```javascript
// api/src/extended-routes.js - Guard route with feature flag
router.post('/awesome/endpoint', async (request, env) => {
  const auth = await verifyAuth(request, env);
  const user = await getUserTierFromDb(env, auth.userId);
  
  if (!isFeatureEnabled('newAwesomeFeature', user.subscription_tier)) {
    return errorResponse('Feature not available for your tier', 403);
  }
  
  // Feature implementation here
});
```

**Step 3: Implement Frontend UI**
```javascript
// public/index.html
function initializeAwesomeFeature() {
  if (!isFeatureAvailable('newAwesomeFeature')) {
    document.getElementById('awesomeButton').style.display = 'none';
    return;
  }
  
  // Feature initialization here
}

// Call in modal open function
```

**Step 4: Test Feature Gating**
```javascript
describe('Feature flag protection', () => {
  it('should block feature for free tier', async () => {
    const response = await request('/awesome/endpoint')
      .send(data)
      .set('Authorization', `Bearer ${freeUserToken}`);
    
    expect(response.status).toBe(403);
    expect(response.body.error).toContain('not available');
  });
  
  it('should allow feature for pro tier', async () => {
    const response = await request('/awesome/endpoint')
      .send(data)
      .set('Authorization', `Bearer ${proUserToken}`);
    
    expect(response.status).toBe(200);
  });
});
```

## 9. Feature Flag Debugging

**Check Backend Configuration**:
```bash
# Read config features
grep -A 20 "features:" api/src/config.js
```

**Check Frontend Availability**:
```javascript
// In browser console:
console.log('User features:', window.userFeatures);
console.log('Feature enabled?', window.userFeatures.featureName);
```

**Check API Response**:
```bash
curl -H "Authorization: Bearer {token}" https://api.focusbro.io/features | jq .
```

**Expected Behavior**:
- Free user sees only free-tier features as true
- Pro user sees free + pro features as true
- Missing feature flag defaults to false (secure by default)
- Experimental features independent of tier access

## 10. Feature Flag Lifecycle

**Introducing Feature**:
1. Add to config with `enabled: false`
2. Implement backend logic
3. Implement frontend UI (hidden)
4. Write tests for feature gating
5. Run tests, verify all pass

**Rolling Out Feature**:
1. Enable for internal team first
2. Set `minTier: 'enterprise'` (most restrictive)
3. Gradually lower tier (enterprise → pro → free)
4. Monitor for bugs, error logs
5. Remove `experimental: true` when stable

**Disabling Feature**:
1. Set `enabled: false` (immediately disabled for all)
2. Backend returns 403 for protected endpoints
3. Frontend hides feature from UI
4. Remove code in future refactor

## 11. Testing Validation Checklist

For each new feature:
- [ ] Feature defined in config.js
- [ ] GET /features endpoint returns correct tier access
- [ ] Backend route checks isFeatureEnabled()
- [ ] Frontend checks window.userFeatures[featureName]
- [ ] Returns 403 error if tier denied
- [ ] Returns 200 success if tier allowed
- [ ] localStorage caching validates correctly
- [ ] Free user cannot bypass feature checks
- [ ] Pro user can access pro features
- [ ] Experimental flag doesn't affect tier gating

**Quality Gate**: Deploy feature flag for new feature, test with free/pro/enterprise accounts. Each tier shows correct features. 3/3 = PASS.

## 12. Best Practices

✅ **DO**:
- Check `window.userFeatures` before showing pro UI
- Disable features server-side if bugs found
- Use consistent naming (camelCase for flags)
- Document feature tier in code comments
- Test all tier levels before release

❌ **DON'T**:
- Trust client-side feature flags (always verify server-side)
- Allow bypassing tier checks based on localStorage
- Hide features but not disable server-side logic
- Keep experimental flag on forever (remove when stable)
- Hardcode tier checks (always use feature flags instead)
```

**Validation Checklist**:
- [ ] Architecture diagram clear
- [ ] All 12 sections present with complete examples
- [ ] Backend flow matches actual implementation
- [ ] Frontend fetch logic matches getFeatureFlags() code
- [ ] Helper functions documented with locations
- [ ] Adding-feature checklist matches best practices
- [ ] Testing examples are realistic and comprehensive
- [ ] Debugging section includes actual commands
- [ ] No contradictions with existing code
- [ ] Examples show error cases and handling

**Quality Gate**: Deploy new feature flag, test with actual accounts at each tier. Feature available/unavailable as expected. 0 bypasses = PASS.

---

### 2.5 DG-C5: TESTING_STRATEGY.md (CRITICAL)

**Purpose**: Comprehensive testing strategy ensuring all code paths tested, including error scenarios.

**Key Content** (abbreviated for space):

```markdown
# Testing Strategy & Complete Coverage Guide

## 1. Testing Pyramid

```
         ╱╲
       ╱  ╲   E2E Tests (5-10%)
      ╱    ╲   Real browser, full workflows
     ╱──────╲
    ╱        ╲   Integration Tests (20-30%)
   ╱          ╲ API + Database together
  ╱────────────╲
 ╱              ╲ Unit Tests (60-70%)
╱────────────────╲ Individual functions, mocked deps
```

Current: 50 unit tests covering auth + validation
Missing: Feature flags, error responses, cache strategy

## 2. Test Coverage Gaps & Plan

| Area | Current | Target | Effort |
|------|---------|--------|--------|
| Authentication | 21 tests ✅ | Keep as-is | 0h |
| Validation | 29 tests ✅ | Keep as-is | 0h |
| Feature Flags | 0 tests ❌ | 10 tests | 1h |
| Error Responses | 0 tests ❌ | 8 tests | 45min |
| Cache Strategy | 0 tests ❌ | 6 tests | 45min |
| Tier Validation | 0 tests ❌ | 5 tests | 30min |
| Retry Logic | 0 tests ❌ | 4 tests | 30min |
| Frontend Features | 0 tests ❌ | 5 tests | 1h |

**Target**: 100+ tests covering all critical paths + error scenarios

## 3. Test File Organization

```
api/src/__tests__/
  ├── auth.test.js        (21 tests) ✅ Complete
  ├── validation.test.js   (29 tests) ✅ Complete
  ├── features.test.js     (10 tests) ⏳ NEW - Feature flags
  ├── errors.test.js       (8 tests)  ⏳ NEW - Error standardization
  ├── cache.test.js        (6 tests)  ⏳ NEW - Cache headers
  ├── tiers.test.js        (5 tests)  ⏳ NEW - Tier validation
  └── retry.test.js        (4 tests)  ⏳ NEW - Retry logic
```

## 4. Each Test File Structure

```javascript
import { describe, it, expect } from 'vitest';

describe('Feature Area', () => {
  describe('Specific Component', () => {
    it('should do happy path', () => {
      // Setup, execute, assert
    });
    
    it('should handle error case X', () => {
      // Setup with mock error
      // Execute
      // Assert error handling
    });
    
    it('should handle edge case Y', () => {
      // Setup with boundary condition
      // Execute
      // Assert correct behavior
    });
  });
});
```

## 5. Happy Path + Error Path Pattern

Every unit test needs at least 2 tests:
1. Happy path: Normal input → Expected output
2. Error path: Invalid input/error → Error handled

```javascript
describe('getFeatureFlags()', () => {
  // HAPPY PATH
  it('should fetch and cache feature flags', async () => {
    // Setup: Mock successful fetch
    global.fetch = () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        features: { slackIntegration: true }
      })
    });
    
    // Execute
    const flags = await getFeatureFlags();
    
    // Assert
    expect(flags.slackIntegration).toBe(true);
    expect(localStorage.getItem('fbFeatureFlags')).toBeTruthy();
  });
  
  // ERROR PATH
  it('should handle network errors gracefully', async () => {
    // Setup: Mock failed fetch
    global.fetch = () => Promise.reject(new Error('Network error'));
    
    // Execute
    const flags = await getFeatureFlags();
    
    // Assert: Returns empty object, doesn't throw
    expect(flags).toEqual({});
  });
});
```

## 6. Backend Endpoint Testing Template

Every endpoint needs tests for:
- Valid request → 200 with correct structure
- Invalid auth → 401
- Invalid input → 400/422
- Feature flagged → 403 if tier denied
- Server error → 500 with error code

## 7. Frontend Integration Testing

Test user workflows end-to-end:
- Login → Features load → Pro features show/hide based on tier
- Network offline → Data cached → Syncs when online
- Dark mode toggle → Preference saved → Persists on reload

## 8. Performance Testing

For performance-critical paths:
- Cache lookups < 1ms
- Feature flag checks < 5ms
- API responses < 500ms (with retries)
- Initial page load < 3s

## 9. Security Testing

Test that security is enforced:
- Can't access pro feature with free token
- Can't bypass rate limiting
- Can't modify other user's data
- Can't refresh token after logout

## 10. Test Quality Checklist

Every test must have:
- [ ] Clear test name describing what's tested
- [ ] Arrange-Act-Assert structure
- [ ] Mock all external dependencies
- [ ] Test one thing per test
- [ ] No hardcoded test data (use constants or fixtures)
- [ ] Cleanup after test (clear mocks, localStorage, etc.)
- [ ] Pass locally before committing
- [ ] Pass in CI/CD pipeline
- [ ] At least one happy path test
- [ ] At least one error path test
```

**Validation Checklist**:
- [ ] All 10 sections complete
- [ ] Testing pyramid matches industry standards
- [ ] Coverage gaps identified with estimates
- [ ] File organization clear and organized
- [ ] Happy path + error path pattern shown
- [ ] Backend template covers all scenarios
- [ ] Frontend E2E examples realistic
- [ ] Security testing includes privilege checks
- [ ] Test quality checklist comprehensive
- [ ] Examples are copy-pasteable and correct

**Quality Gate**: Create one new test file following this template. All 10 tests pass. Structure follows template exactly. 10/10 = PASS.

---

### 2.6 DG-C6: API_INTEGRATION_PROTOCOL.md (CRITICAL)

**Purpose**: Safe patterns for integrating external APIs (Slack, Stripe, etc.) without compromising security or reliability.

**Abbreviated Content**:

```markdown
# External API Integration Protocol

## 1. Integration Checklist

Every external API integration must:

- [ ] Have timeout configured (default 5s)
- [ ] Have retry logic with exponential backoff
- [ ] Have error logging with [ModuleName] prefix
- [ ] Validate response structure before using
- [ ] Check API key/secret not hardcoded
- [ ] Rate limit awareness (quota tracking)
- [ ] Fallback behavior if service unavailable
- [ ] Webhook signature verification (if accepting webhooks)
- [ ] Test with mock responses matching API docs
- [ ] Document in API_INTEGRATIONS.md

## 2. Request Wrapping Pattern

All external requests must use this pattern:

```javascript
async function callExternalAPI(endpoint, data, options = {}) {
  const timeout = options.timeout ?? 5000;
  const maxRetries = options.retries ?? 3;
  
  return await withRetry(
    async () => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        
        const response = await fetch(`${API_HOST}${endpoint}`, {
          method: options.method || 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
            ...options.headers,
          },
          body: data ? JSON.stringify(data) : undefined,
          signal: controller.signal,
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
          const error = await response.text().catch(() => '');
          throw new Error(`API returned ${response.status}: ${error}`);
        }
        
        return response.json();
      } catch (error) {
        console.error('[ExternalAPI] Request failed:', error.message);
        throw error;
      }
    },
    maxRetries,
    1000  // base delay
  );
}
```

## 3. Response Validation Pattern

Never trust external API responses:

```javascript
// ✅ CORRECT - Validate structure
async function processSlackEvent(body) {
  // Verify required fields
  if (!body?.event?.type || !body?.event?.user) {
    throw new Error('Invalid event structure');
  }
  
  // Validate types
  if (typeof body.event.type !== 'string') {
    throw new Error('Event type must be string');
  }
  
  // Range check if applicable
  if (body.event.timestamp && body.event.timestamp > Date.now() + 60000) {
    throw new Error('Event timestamp too far in future');
  }
  
  return {
    eventType: body.event.type,
    userId: body.event.user,
    timestamp: new Date(body.event.timestamp * 1000)
  };
}
```

## 4. API Key Management

Never hardcode API keys:

```javascript
// ✅ CORRECT - From environment
const slackApiKey = env.SLACK_API_KEY;  // From wrangler.toml secrets
if (!slackApiKey) {
  console.error('[Slack] API key not configured');
  return errorResponse('Slack not configured', 503);
}
```

## 5. Rate Limiting Awareness

Track quota to avoid lockouts:

```javascript
// Check remaining quota before making request
const remaining = await env.KV_CACHE.get(`usage:slack:${date}`);
if (!remaining || parseInt(remaining) > quota) {
  return errorResponse('API quota exceeded, retry tomorrow', 429);
}
```

## 6. Webhook Signature Verification

Always verify webhooks from external services:

```javascript
// ✅ CORRECT - Verify Slack signature
function verifySlackSignature(request, secret) {
  const timestamp = request.headers.get('X-Slack-Request-Timestamp');
  const signature = request.headers.get('X-Slack-Signature');
  
  // Check timestamp not too old (5 min tolerance)
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) {
    return false;
  }
  
  // Verify HMAC signature matches
  const baseString = `v0:${timestamp}:${body}`;
  const computed = new HmacSHA256(baseString, secret).toString();
  
  return `v0=${computed}` === signature;
}
```

## 7. Error Recovery Strategies

```javascript
// Strategy 1: Queue for async retry
if (error.retryable) {
  await queueForRetry(data);  // Process later
  return successResponse({ queued: true });
}

// Strategy 2: Degrade gracefully  
if (service.unavailable) {
  return cachedResult || defaultResult;
}

// Strategy 3: Fail explicitly
if (error.notRetryable) {
  return errorResponse('Operation failed', 400);
}
```

## 8. Monitoring & Alerting

Log integration health:

```javascript
// Track success/failure ratio
await logIntegrationEvent(env, {
  service: 'slack',
  status: response.ok ? 'success' : 'failure',
  statusCode: response.status,
  duration: Date.now() - startTime,
  timestamp: new Date().toISOString(),
});
```

---

**Validation Checklist**:
- [ ] All 8 sections present with code examples
- [ ] Wrapping pattern includes timeout
- [ ] Response validation catches all failure modes  
- [ ] API key management never hardcodes secrets
- [ ] Webhook signature verification shown
- [ ] Error recovery strategies realistic
- [ ] Monitoring/logging patterns complete
- [ ] Examples follow ERROR_HANDLING_GUIDE standards
- [ ] No contradictions with SECURITY_GUIDE

**Quality Gate**: Review one external API integration (Slack), verify it follows all 8 practices. 8/8 = PASS.

---

## 3. IMPORTANT (NOT CRITICAL BUT HIGH VALUE) DOCUMENTATION

### 3.1 DG-I1: LOGGING_STANDARDS.md

**Purpose**: Standardize all logging across frontend/backend for consistent monitoring.

**Key Sections**:
- Log level guidance (debug, info, warn, error)
- [ModuleName] prefix requirements
- Performance logging patterns
- Structured logging for monitoring systems
- Sensitive data redaction rules
- Log aggregation setup
- Debugging with logs

**Estimated Size**: 40 lines

---

### 3.2 DG-I2: VALIDATION_PATTERNS.md

**Purpose**: Input validation standards for API endpoints and frontend forms.

**Key Sections**:
- Email validation patterns
- Password strength rules
- Number range validation
- String length constraints
- Array/object validation
- Cross-field validation
- Custom validation functions
- Error messages guidelines

**Estimated Size**: 60 lines

---

### 3.3 DG-I3: CACHE_STRATEGY.md

**Purpose**: Document cache tiers, headers, and invalidation logic.

**Key Sections**:
- 4 cache strategies (nocache, short, medium, static)
- Cache-Control header generation
- TTL calculations per endpoint
- Cache invalidation triggers
- Stale-while-revalidate pattern
- Cache debugging
- Performance impact measurements

**Estimated Size**: 50 lines

---

### 3.4 DG-I4: DATABASE_GUIDE.md

**Purpose**: D1 database usage patterns and schema documentation.

**Key Sections**:
- Current schema (tables, columns, types)
- Query patterns best practices
- Transaction usage
- SQLite-specific gotchas
- Migration strategy
- Backups and recovery
- Performance optimization
- Common queries with examples

**Estimated Size**: 80 lines

---

## 4. IMPLEMENTATION SEQUENCE (DEPENDENCY-ORDERED)

**This sequence respects dependencies and maximizes value per hour**:

### Phase 1: Foundation (Critical Standards) — 6 hours
1. **DG-C1: CODE_STYLE_GUIDE.md** (1.5h)
   - All examples verified against codebase
   - Linting rules documented
   - Validation: grep 10 functions, all follow style
   
2. **DG-C2: JSDoc_STANDARDS.md** (1.5h)
   - All @tags documented with examples
   - Frontend + backend examples separate
   - Validation: 10 functions checked, all have JSDoc
   
3. **DG-C3: ERROR_HANDLING_GUIDE.md** (2h)
   - Module categories defined
   - Anti-patterns shown
   - Recovery strategies documented
   - Validation: 10 catch blocks audited, all follow format
   
4. **DG-C4: FEATURE_FLAGS_GUIDE.md** (1h)
   - Architecture diagram clear
   - Config examples match actual code
   - Usage patterns for pro features
   - Validation: Deploy flag, test all tiers

### Phase 2: Validation & Safety (Critical Systems) — 5 hours
5. **DG-C5: TESTING_STRATEGY.md** (2h)
   - Cover gaps mapped with estimates
   - Test file organization finalized
   - Happy/error path pattern defined
   - Validation: Create 1 test file, 10 tests pass

6. **DG-C6: API_INTEGRATION_PROTOCOL.md** (1.5h)
   - Checklist covers all risk areas
   - Code patterns for timeouts, retries, validation
   - Webhook signature verification shown
   - Validation: Review existing Slack integration

7. **DG-I1: LOGGING_STANDARDS.md** (0.5h)
   - Builds on ERROR_HANDLING_GUIDE
   - Log level guidelines clear
   - Performance logging patterns
   - Validation: All new logging follows pattern

8. **DG-I2: VALIDATION_PATTERNS.md** (0.5h)
   - Email/password patterns
   - Number/string constraints
   - Custom validators
   - Validation: Applied in 3 new validators

### Phase 3: Architecture & Completeness (High-Value Documentation) — 5 hours
9. **DG-I3: CACHE_STRATEGY.md** (1h)
   - 4 tiers documented
   - Cache-Control generation
   - Invalidation logic
   - Validation: Verify all endpoints have cache headers

10. **DG-I4: DATABASE_GUIDE.md** (1h)
    - Full D1 schema documented
    - Query patterns with examples
    - Migration strategy
    - Validation: Compare guide vs schema.sql

11. **DG-I5: FRONTEND_ARCHITECTURE.md** (1.5h)
    - SPA structure documented
    - Module organization explained
    - State management patterns
    - Validation: Architecture diagram matches code

12. **DG-I6: BACKEND_API_GUIDE.md** (1.5h)
    - Middleware patterns
    - Routing structure
    - Error handling flow
    - Validation: New developer can add endpoint without help

### Phase 4: Development Experience (Nice-to-Have) — 3 hours
13. **DG-N1: DEVELOPMENT_SETUP.md** (1h)
    - Local environment setup
    - Wrangler configuration
    - Database seeding
    - Debugging setup

14. **DG-N2: TROUBLESHOOTING_GUIDE.md** (1h)
    - Common errors and solutions
    - Debug techniques
    - Performance troubleshooting
    - Network debugging

15. **DG-N3: ACCESSIBILITY_COMPLIANCE.md** (1h)
    - WCAG 2.1 Level AA standards
    - Current compliance status
    - Remediation checklist
    - Testing with assistive tech

---

## 5. VALIDATION CHECKLIST FOR EACH DOCUMENT

**Before marking document complete, verify**:

### Template Validation
- [ ] Document uses consistent Markdown formatting
- [ ] All code examples are syntactically correct
- [ ] All file paths reference actual files in repo
- [ ] All line numbers are accurate
- [ ] No broken internal links
- [ ] Table of contents links work

### Content Validation
- [ ] All sections present and outlined in TOC
- [ ] Examples are realistic and tested
- [ ] Before/after patterns shown for common mistakes
- [ ] Edge cases documented
- [ ] No contradictions with other docs
- [ ] Aligns with ARCHITECTURE_PLAN and SECURITY_GUIDE
- [ ] References actual functions/endpoints in codebase

### Practical Validation
- [ ] Document applied to codebase (test with 5 examples)
- [ ] All recommendations are actionable
- [ ] No blocking dependencies
- [ ] New developer can follow guidance independently
- [ ] Code examples can be copy-pasted successfully

### Quality Gate
**Each document must pass 3 judges**:
1. **Technical accuracy**: Compare against actual codebase
2. **Completeness**: Checklist ensures nothing omitted
3. **Usability**: New dev uses guide, completes task without help

---

## 6. IMPLEMENTATION STANDARDS (APPLY TO ALL DOCUMENTS)

### Writing Standards
- **Clarity**: Average sentence length < 20 words
- **Examples**: Every concept needs at least one code example
- **Structure**: Use lists, tables, code blocks for scannability
- **Tone**: Professional, consistent, non-condescending
- **Terminology**: Consistent with rest of codebase

### Code Example Standards
- **Syntactically correct**: Examples run without modification
- **Realistic**: Match patterns used in actual codebase
- **Before/after**: Show wrong way, then right way
- **Annotated**: Comments explain non-obvious parts
- **Complete**: Not pseudo-code, actual working examples

### Validation Standards
- **Checklist format**: Always include validation checklist
- **Quality gates**: Define pass/fail criteria
- **Objective**: No subjective judgments (numerical if possible)
- **Measurable**: "10/10 code examples correct" not "good"
- **Auditable**: Can verify without author present

---

## 7. SUCCESS METRICS

**Completion Definition**: 
- All 12 critical documents created ✅
- All 15 documents pass validation checks ✅
- No contradictions between documents ✅
- Codebase fully compliant with all standards ✅
- New developer can build feature 50% faster using docs ✅

**Quality Metrics**:
- Code style compliance: 100% (0 deviations)
- JSDoc coverage: 100% (all public functions documented)
- Error handling compliance: 100% (all catch blocks have logging)
- Feature flag implementation: 100% (all pro features gated)
- Test coverage: 100+ tests, 85%+ code coverage

**Time Investment**:
- Total documentation creation: 19 hours
- Total validation/corrections: 5 hours
- Total effort: 24 hours (3 full work days)

---

## 8. MASTER CHECKLIST (COMPLETION VERIFICATION)

### Critical Documents (C1-C6)
- [ ] DG-C1: CODE_STYLE_GUIDE.md — 8 sections, all with examples
- [ ] DG-C2: JSDoc_STANDARDS.md — Template + frontend + backend examples  
- [ ] DG-C3: ERROR_HANDLING_GUIDE.md — 10 sections, 0 empty catch blocks
- [ ] DG-C4: FEATURE_FLAGS_GUIDE.md — 12 sections, tested deployment
- [ ] DG-C5: TESTING_STRATEGY.md — Gap analysis + structure + patterns
- [ ] DG-C6: API_INTEGRATION_PROTOCOL.md — Checklist + patterns + security

### Important Documents (I1-I6)
- [ ] DG-I1: LOGGING_STANDARDS.md — Complete
- [ ] DG-I2: VALIDATION_PATTERNS.md — Complete
- [ ] DG-I3: CACHE_STRATEGY.md — Complete
- [ ] DG-I4: DATABASE_GUIDE.md — Complete
- [ ] DG-I5: FRONTEND_ARCHITECTURE.md — Complete
- [ ] DG-I6: BACKEND_API_GUIDE.md — Complete

### Supporting Documents
- [ ] DG-N1: DEVELOPMENT_SETUP.md
- [ ] DG-N2: TROUBLESHOOTING_GUIDE.md
- [ ] DG-N3: ACCESSIBILITY_COMPLIANCE.md

### Compliance & Quality
- [ ] All docs linked in README
- [ ] No contradictions between documents
- [ ] Codebase 100% compliant with all standards
- [ ] Test suite 100+ tests passing
- [ ] Code coverage 85%+
- [ ] All team members trained on standards

---

## NEXT IMMEDIATE ACTION

**Start Phase 1 immediately**: CODE_STYLE_GUIDE.md

1. Create file `/workspaces/focusbro/CODE_STYLE_GUIDE.md`
2. Write 8 sections with examples verified against codebase
3. Validate with grep (10 random functions)
4. Get sign-off (all examples verified)
5. Move to DG-C2

**Estimated time**: 1.5 hours for DG-C1

---

**Document Status**: FINAL SPECIFICATION  
**Last Updated**: March 25, 2026  
**Prepared For**: FocusBro core team  
**Classification**: Authoritative Planning Document
