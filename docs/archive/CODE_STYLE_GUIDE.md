# FocusBro Code Style Guide

## Purpose
Single source of truth for code formatting, naming, and structure across FocusBro. Use this to keep the codebase consistent and easily reviewable.

## 1. JavaScript Formatting
- Indentation: 2 spaces
- Line length: 100 characters max where practical
- Trailing semicolons: optional but be consistent (current codebase uses semicolons in many places — prefer semicolons)

### 1.1 Naming
- Functions and variables: camelCase (e.g. `isFeatureEnabled`, `getFeatureFlags`)
- Constants: UPPER_SNAKE_CASE for global constants (e.g. `DEFAULT_TIMEOUT`)
- Files: kebab-case or lowerCamelCase consistent with existing repo

### 1.2 Function Declarations
- Prefer named function declarations for exported/important functions.
- Use `async function` for async code and always use try/catch when `await` is used.
- Small helpers can be `const helper = () => {}` but include JSDoc above.

### 1.3 Strings
- Prefer double quotes for strings to match current codebase style.
- Use template literals for interpolation.

### 1.4 Imports & Ordering
- Group imports: external packages → internal modules → styles/assets.

## 2. Frontend Patterns
- Always null-check DOM elements before using them. Example:

```javascript
try {
  const el = document.getElementById('pomodoroDisplay');
  if (!el) return;
  el.textContent = text;
} catch (err) {
  console.error('[Timer] DOM update failed:', err.message);
}
```

- All `setInterval` and `setTimeout` callbacks must wrap body in try/catch.
- Use `apiCall()` for network requests; wrap other fetches with `withRetry()` where appropriate.

## 3. Backend Patterns
- Use `errorResponse()` and `successResponse()` helpers consistently in routes.
- Always validate input and return 4xx errors for client issues, 5xx for server failures.
- Use prepared statements with `.bind()` for D1 queries.

## 4. Comments & Section Markers
- Use section markers: `// ── SECTION NAME ──` to separate logical parts of long files.
- Use `// TODO(YYYY-MM-DD):` with ticket or context.

## 5. Tests
- Test files named `*.test.js` located under `api/src/__tests__/`.
- Unit tests: target small functions and error paths.
- Integration tests: test routes with mocked env.

## 6. Linting
- Add or update ESLint/Prettier configs to reflect these rules. Run linters in CI.

## Validation
- Randomly sample 10 functions across frontend and backend; they should:
  - Follow naming rules
  - Be null-safe for DOM access
  - Use `try/catch` for async operations
  - Include JSDoc if public


---

(End of CODE_STYLE_GUIDE.md)
