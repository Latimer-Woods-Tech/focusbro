// Feature-flag helpers, extracted verbatim from the retired extended-routes.js
// monolith (issue #44) — the only part of that module live code and tests used.
import config from './config.js';

// ── SUBSCRIPTION TIER VALIDATION HELPER ──
/**
 * Validate that user has required subscription tier for feature access.
 * Prevents free users from accessing pro/enterprise features.
 * @param {string} userTier - User's subscription tier ('free', 'pro', 'enterprise')
 * @param {string|array} requiredTier - Required tier(s) ('free', 'pro', 'enterprise')
 * @returns {boolean} True if user has access
 */
function checkTierAccess(userTier, requiredTier) {
  // tier hierarchy: free < pro < enterprise
  const tierHierarchy = { 'free': 0, 'pro': 1, 'enterprise': 2 };
  const userLevel = tierHierarchy[userTier] ?? 0;

  // Handle array of allowed tiers
  if (Array.isArray(requiredTier)) {
    return requiredTier.some(tier =>
      (tierHierarchy[tier] ?? 0) <= userLevel
    );
  }

  // Handle single tier requirement
  const requiredLevel = tierHierarchy[requiredTier] ?? 0;
  return userLevel >= requiredLevel;
}

// ── FEATURE FLAGS HELPER ──
/**
 * Check if a feature is enabled for a user's subscription tier
 * Features can be restricted to specific tiers and marked as experimental
 * @param {string} featureName - Feature key from config.features (e.g. 'slackIntegration', 'advancedAnalytics')
 * @param {string} userTier - User's subscription tier ('free', 'pro', 'enterprise')
 * @returns {boolean} True if feature enabled and user has access, false otherwise
 * @example
 * if (isFeatureEnabled('slackIntegration', user.subscription_tier)) {
 *   // Feature is available for this user
 * }
 */
export function isFeatureEnabled(featureName, userTier = 'free') {
  const feature = config.features[featureName];

  // Feature doesn't exist in config
  if (!feature) return false;

  // Simple boolean flags
  if (typeof feature === 'boolean') return feature;

  // Object-based feature with tier requirements
  if (feature && typeof feature === 'object') {
    // Check if feature is enabled
    if (!feature.enabled) return false;

    // Check tier access if minTier is specified
    if (feature.minTier) {
      return checkTierAccess(userTier, feature.minTier);
    }

    return true;
  }

  return false;
}
