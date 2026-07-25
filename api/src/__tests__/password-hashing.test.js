import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  passwordNeedsUpgrade,
  upgradePasswordHashIfNeeded,
  verifyPassword
} from '../index.js';

async function createLegacyHash(password) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(password)
  );
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

describe('password hashing', () => {
  it('creates unique, versioned PBKDF2 hashes', async () => {
    const firstHash = await hashPassword('correct horse battery staple');
    const secondHash = await hashPassword('correct horse battery staple');

    expect(firstHash).toMatch(/^pbkdf2-sha256\$600000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(secondHash).not.toBe(firstHash);
    expect(passwordNeedsUpgrade(firstHash)).toBe(false);
  });

  it('accepts the correct password and rejects an incorrect password', async () => {
    const storedHash = await hashPassword('a sufficiently long password');

    await expect(verifyPassword('a sufficiently long password', storedHash)).resolves.toBe(true);
    await expect(verifyPassword('wrong password', storedHash)).resolves.toBe(false);
  });

  it('rejects malformed or unsupported password hashes', async () => {
    await expect(verifyPassword('password', null)).resolves.toBe(false);
    await expect(verifyPassword('password', 'not-a-password-hash')).resolves.toBe(false);
    await expect(
      verifyPassword('password', 'pbkdf2-sha256$999999999$invalid$salt')
    ).resolves.toBe(false);
  });

  it('verifies legacy SHA-256 hashes and marks them for migration', async () => {
    const legacyHash = await createLegacyHash('legacy password');

    await expect(verifyPassword('legacy password', legacyHash)).resolves.toBe(true);
    await expect(verifyPassword('wrong password', legacyHash)).resolves.toBe(false);
    expect(passwordNeedsUpgrade(legacyHash)).toBe(true);
  });

  it('replaces a legacy hash with a compare-and-swap update', async () => {
    const legacyHash = await createLegacyHash('legacy password');
    let capturedSql;
    let capturedBindings;
    const env = {
      DB: {
        prepare(sql) {
          capturedSql = sql;
          return {
            bind(...bindings) {
              capturedBindings = bindings;
              return { run: async () => ({ success: true, meta: { changes: 1 } }) };
            }
          };
        }
      }
    };

    await expect(
      upgradePasswordHashIfNeeded(env, 'user-123', 'legacy password', legacyHash)
    ).resolves.toBe(true);

    expect(capturedSql).toContain('WHERE id = ? AND password_hash = ?');
    expect(capturedBindings[0]).toMatch(/^pbkdf2-sha256\$600000\$/);
    expect(capturedBindings.slice(1)).toEqual(['user-123', legacyHash]);
    await expect(verifyPassword('legacy password', capturedBindings[0])).resolves.toBe(true);
  });
});
