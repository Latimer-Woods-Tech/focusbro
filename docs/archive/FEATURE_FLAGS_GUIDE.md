# Feature Flags Guide

## Purpose
Describe the feature flag system architecture, usage patterns, and testing steps.

## Backend
- Place flags in `api/src/config.js` under `features`.
- Use `isFeatureEnabled(featureName, userTier)` helper to gate behavior server-side.
- Provide `GET /features` to expose per-user availability.

## Frontend
- Use `getFeatureFlags()` to fetch flags and cache in `localStorage` with TTL (1 hour).
- Store flags globally: `window.userFeatures = {}`.
- Use helper `isFeatureAvailable(name)` to check availability before rendering or enabling functionality.

## Adding a Feature
1. Add to `config.features` with `enabled`, `minTier`, `experimental`.
2. Guard backend routes with `isFeatureEnabled()`.
3. Use `isFeatureAvailable()` in frontend UI.
4. Add tests for tier gating and caching.

## Validation
- Test free/pro/enterprise accounts see correct flags.
- Missing flags default to `false`.

(End of FEATURE_FLAGS_GUIDE.md)
