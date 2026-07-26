import { describe, expect, it, vi } from 'vitest';
import {
  calculateDataSize,
  checkFeatureFlag,
  checkRateLimit,
  cleanupExpiredSessions,
  decryptData,
  encryptData,
  errorResponse,
  extractRequestContext,
  generateDeviceFingerprint,
  generateUUID,
  logEvent,
  successResponse,
  validateDeviceId,
  validateEmail,
  validatePassword,
  verifyAuth,
} from '../middleware.js';

function bearer(payload) {
  return `Bearer x.${btoa(JSON.stringify(payload))}.z`;
}

describe('middleware primitives', () => {
  it('validates the lightweight bearer envelope without accepting malformed or expired tokens', async () => {
    await expect(verifyAuth(new Request('https://focusbro.net/'), {})).resolves.toMatchObject({ valid: false });
    await expect(verifyAuth(new Request('https://focusbro.net/', { headers: { Authorization: 'Bearer bad' } }), {}))
      .resolves.toMatchObject({ valid: false, error: 'Invalid token format (must be 3 parts)' });
    await expect(verifyAuth(new Request('https://focusbro.net/', { headers: { Authorization: 'Bearer x.not-json.z' } }), {}))
      .resolves.toMatchObject({ valid: false, error: 'Invalid token payload' });
    await expect(verifyAuth(new Request('https://focusbro.net/', { headers: { Authorization: bearer({ exp: 1 }) } }), {}))
      .resolves.toMatchObject({ valid: false, error: 'Token expired' });
    await expect(verifyAuth(new Request('https://focusbro.net/', { headers: { Authorization: bearer({ sub: 'u1', iat: 10, exp: 4102444800 }) } }), {}))
      .resolves.toMatchObject({ valid: true, userId: 'u1' });
  });

  it('enforces a KV-backed rate limit and feature flags', async () => {
    const values = new Map();
    const env = { KV_CACHE: {
      get: async key => values.get(key) || null,
      put: async (key, value) => values.set(key, value),
    } };
    await expect(checkRateLimit(env, 'u1', 2, 1000)).resolves.toMatchObject({ allowed: true, remaining: 1 });
    await expect(checkRateLimit(env, 'u1', 2, 1000)).resolves.toMatchObject({ allowed: true, remaining: 0 });
    await expect(checkRateLimit(env, 'u1', 2, 1000)).resolves.toMatchObject({ allowed: false });
    values.set('feature:sync:u1', 'enabled');
    await expect(checkFeatureFlag(env, 'u1', 'sync')).resolves.toBe(true);
  });

  it('validates basic inputs and generates stable-safe identifiers', () => {
    expect(validateEmail('person@example.com')).toBe(true);
    expect(validateEmail('not-an-email')).toBe(false);
    expect(validatePassword('12345678')).toBe(true);
    expect(validatePassword('short')).toBe(false);
    expect(validateDeviceId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(validateDeviceId('not-a-device')).toBe(false);
    expect(generateUUID()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(generateDeviceFingerprint('agent', 'en-US')).toBe(generateDeviceFingerprint('agent', 'en-US'));
  });

  it('builds structured response and request-context helpers', async () => {
    const error = errorResponse('Nope', 422, { field: 'email' });
    expect(error.status).toBe(422);
    await expect(error.json()).resolves.toMatchObject({ success: false, error: 'Nope', details: { field: 'email' } });
    await expect(successResponse({ ok: true }, 201).json()).resolves.toMatchObject({ success: true, data: { ok: true } });
    const request = new Request('https://focusbro.net/', { headers: {
      'User-Agent': 'test-agent', 'Accept-Language': 'en', Origin: 'https://focusbro.net',
      'CF-Connecting-IP': '203.0.113.1', 'CF-IPCountry': 'US',
    } });
    expect(extractRequestContext(request)).toMatchObject({ userAgent: 'test-agent', ip: '203.0.113.1', country: 'US' });
    expect(calculateDataSize({ hello: 'world' })).toBe(JSON.stringify({ hello: 'world' }).length);
  });

  it('round-trips the current serialization helpers and records best-effort audit events', async () => {
    await expect(decryptData(await encryptData({ a: 1 }), {})).resolves.toEqual({ a: 1 });
    const run = vi.fn(async () => ({ success: true }));
    const statement = { bind: vi.fn(function bind() { return statement; }), run };
    await logEvent({ DB: { prepare: vi.fn(() => statement) } }, 'u1', 'sync', { count: 1 });
    expect(run).toHaveBeenCalledOnce();
    expect(statement.bind).toHaveBeenCalledWith('u1', 'sync', JSON.stringify({ count: 1 }));
  });

  it('returns an error result when session cleanup fails', async () => {
    const success = await cleanupExpiredSessions({ DB: { prepare: () => ({ run: async () => ({ meta: { changes: 3 } }) }) } });
    expect(success).toEqual({ success: true, deletedRows: 3 });
    const failure = await cleanupExpiredSessions({ DB: { prepare: () => { throw new Error('unavailable'); } } });
    expect(failure).toMatchObject({ success: false, error: 'unavailable' });
  });
});
