import { describe, it, expect, beforeAll } from 'vitest';
import { config } from '../config.js';
import { isFeatureEnabled } from '../features.js';

describe('Feature flags', () => {
  it('should enable boolean feature flags', () => {
    // Add a temporary boolean feature
    config.features.__test_bool = true;
    expect(isFeatureEnabled('__test_bool', 'free')).toBe(true);
    delete config.features.__test_bool;
  });

  it('should respect minTier for object features', () => {
    config.features.__test_tier = { enabled: true, minTier: 'pro' };
    expect(isFeatureEnabled('__test_tier', 'free')).toBe(false);
    expect(isFeatureEnabled('__test_tier', 'pro')).toBe(true);
    expect(isFeatureEnabled('__test_tier', 'enterprise')).toBe(true);
    delete config.features.__test_tier;
  });

  it('should return false for missing features', () => {
    expect(isFeatureEnabled('nonexistent_feature', 'free')).toBe(false);
  });
});
