import { describe, expect, it, vi } from 'vitest';
import { Router } from 'itty-router';
import {
  allowRecoveryRequest,
  createAuthActionToken,
  normalizeAccountEmail,
  recoveryConstants,
  registerAccountRecoveryRoutes,
  sendPasswordResetEmail,
} from '../account-recovery.js';

function memoryKv() {
  const values = new Map();
  return {
    values,
    get: vi.fn(async (key) => values.get(key) ?? null),
    put: vi.fn(async (key, value) => values.set(key, value)),
  };
}

function preparedStatement(sql) {
  return {
    sql,
    values: [],
    bind(...values) {
      this.values = values;
      return this;
    },
    run: vi.fn(async () => ({ success: true })),
    first: vi.fn(async () => null),
  };
}

describe('account recovery foundation', () => {
  it('normalizes account identity without changing provider-specific aliases', () => {
    expect(normalizeAccountEmail('  Person+focus@Example.COM ')).toBe('person+focus@example.com');
    expect(normalizeAccountEmail(null)).toBe('');
  });

  it('limits an account+network pair without locking other accounts on that network', async () => {
    const KV_CACHE = memoryKv();
    const env = { KV_CACHE };
    const request = new Request('https://focusbro.net/auth/request-password-reset', {
      headers: { 'CF-Connecting-IP': '203.0.113.8' },
    });

    for (let attempt = 0; attempt < recoveryConstants.ACCOUNT_NETWORK_REQUEST_LIMIT; attempt += 1) {
      await expect(allowRecoveryRequest(request, env, 'one@example.com')).resolves.toBe(true);
    }
    await expect(allowRecoveryRequest(request, env, 'one@example.com')).resolves.toBe(false);
    await expect(allowRecoveryRequest(request, env, 'two@example.com')).resolves.toBe(true);
    expect([...KV_CACHE.values.keys()].every((key) => !key.includes('example.com'))).toBe(true);
  });

  it('stores only a token digest and invalidates older links of the same purpose', async () => {
    const statements = [];
    const env = {
      DB: {
        prepare(sql) {
          const statement = preparedStatement(sql);
          statements.push(statement);
          return statement;
        },
        batch: vi.fn(async () => []),
      },
    };

    const token = await createAuthActionToken(env, 'user-1', 'password_reset', 900);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(env.DB.batch).toHaveBeenCalledOnce();
    expect(statements[0].sql).toContain('consumed_at');
    expect(statements[0].values).toEqual(['user-1', 'password_reset']);
    expect(statements[1].values[3]).toMatch(/^[a-f0-9]{64}$/);
    expect(statements[1].values[3]).not.toBe(token);
  });

  it('sends through SendGrid without putting the token in a query string', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
    const result = await sendPasswordResetEmail({
      SENDGRID_API_KEY: 'secret',
      AUTH_EMAIL_FROM: 'help@focusbro.net',
      API_ORIGIN: 'https://focusbro.net/',
    }, 'person@example.com', 'one-time-token', fetchImpl);

    expect(result).toEqual({ delivered: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.sendgrid.com/v3/mail/send',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
      }),
    );
    const payload = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(payload.content[0].value).toContain('/reset-password#token=one-time-token');
    expect(payload.content[0].value).not.toContain('?token=');
  });

  it('returns the same generic response for unknown and malformed accounts', async () => {
    const router = Router();
    registerAccountRecoveryRoutes(router);
    const env = {
      KV_CACHE: memoryKv(),
      DB: {
        prepare() {
          return {
            bind() { return this; },
            first: vi.fn(async () => null),
          };
        },
      },
    };
    const unknown = await router.fetch(new Request(
      'https://focusbro.net/auth/request-password-reset',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@example.com' }),
      },
    ), env);
    const malformed = await router.fetch(new Request(
      'https://focusbro.net/auth/request-password-reset',
      { method: 'POST', body: '{' },
    ), env);

    expect(unknown.status).toBe(202);
    expect(malformed.status).toBe(202);
    expect(await unknown.text()).toBe(await malformed.text());
  });
});
