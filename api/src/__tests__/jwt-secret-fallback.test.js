import { describe, expect, it } from 'vitest';
import { withJwtSecretFallback } from '../index.js';

describe('withJwtSecretFallback', () => {
  it('hydrates JWT_SECRET from JWT_SECRET_NEXT when only the new secret is present', () => {
    const env = { JWT_SECRET_NEXT: 'next-secret', OTHER: 'value' };
    expect(withJwtSecretFallback(env)).toEqual({
      JWT_SECRET_NEXT: 'next-secret',
      JWT_SECRET: 'next-secret',
      OTHER: 'value'
    });
  });

  it('leaves env unchanged when JWT_SECRET already exists', () => {
    const env = { JWT_SECRET: 'current-secret', JWT_SECRET_NEXT: 'next-secret' };
    expect(withJwtSecretFallback(env)).toBe(env);
  });
});
