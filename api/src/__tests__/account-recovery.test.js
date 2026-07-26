import { describe, expect, it, vi } from 'vitest';
import { Router } from 'itty-router';
import {
  allowRecoveryRequest,
  confirmPasswordReset,
  createAuthActionToken,
  deliverEmailVerification,
  normalizeAccountEmail,
  recoveryConstants,
  registerAccountRecoveryRoutes,
  sendEmailVerificationEmail,
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

    expect(result).toEqual({ delivered: true, provider: 'sendgrid' });
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

  it('sends verification links in fragments and invalidates undelivered links', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
    const sent = await sendEmailVerificationEmail({
      SENDGRID_API_KEY: 'secret',
      AUTH_EMAIL_FROM: 'help@focusbro.net',
      API_ORIGIN: 'https://focusbro.net',
    }, 'person@example.com', 'verification-token', fetchImpl);
    const payload = JSON.parse(fetchImpl.mock.calls[0][1].body);

    expect(sent).toEqual({ delivered: true, provider: 'sendgrid' });
    expect(payload.content[0].value).toContain('/verify-email#token=verification-token');

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
    const delivery = await deliverEmailVerification(env, 'user-1', 'person@example.com');
    expect(delivery).toEqual({ delivered: false, reason: 'not_configured' });
    expect(statements.some((statement) => statement.sql.includes('consumed_at'))).toBe(true);
  });

  it('uses the existing Resend credential when SendGrid is not configured', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ id: 'email-1' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const result = await sendPasswordResetEmail({
      RESEND_API_KEY: 'resend-secret',
      AUTH_EMAIL_FROM: 'support@latwoodtech.com',
      API_ORIGIN: 'https://focusbro.net',
    }, 'person@example.com', 'one-time-token', fetchImpl);

    expect(result).toEqual({ delivered: true, provider: 'resend' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer resend-secret',
          'User-Agent': 'FocusBro-Worker/1.0',
        }),
      }),
    );
    const payload = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(payload.from).toBe('FocusBro <support@latwoodtech.com>');
    expect(payload.to).toEqual(['person@example.com']);
    expect(payload.text).toContain('/reset-password#token=one-time-token');
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

  it('consumes a reset link once, updates the password, and revokes every session', async () => {
    const statements = [];
    let available = true;
    const env = {
      DB: {
        prepare(sql) {
          const statement = preparedStatement(sql);
          if (sql.includes('RETURNING user_id')) {
            statement.first = vi.fn(async () => {
              if (!available) return null;
              available = false;
              return { user_id: 'user-1' };
            });
          }
          statements.push(statement);
          return statement;
        },
        batch: vi.fn(async () => []),
      },
    };
    const hashPassword = vi.fn(async () => 'pbkdf2-sha256$600000$salt$hash');
    const token = 'A'.repeat(43);

    await expect(confirmPasswordReset(env, token, 'new-password', hashPassword))
      .resolves.toEqual({ ok: true, userId: 'user-1' });
    await expect(confirmPasswordReset(env, token, 'new-password', hashPassword))
      .resolves.toEqual({ ok: false, reason: 'invalid' });

    expect(env.DB.batch).toHaveBeenCalledOnce();
    const mutationSql = env.DB.batch.mock.calls[0][0].map((statement) => statement.sql);
    expect(mutationSql.some((sql) => sql.includes('SET password_hash'))).toBe(true);
    expect(mutationSql.some((sql) => sql.includes('SET is_active = 0'))).toBe(true);
    expect(mutationSql.some((sql) => sql.includes("'password_reset'"))).toBe(true);
    expect(statements.find((statement) => statement.sql.includes('RETURNING user_id')).sql)
      .toContain("expires_at > datetime('now')");
  });

  it('rejects malformed credentials before hashing or touching D1', async () => {
    const hashPassword = vi.fn();
    const env = { DB: { prepare: vi.fn() } };

    await expect(confirmPasswordReset(env, 'short', 'new-password', hashPassword))
      .resolves.toEqual({ ok: false, reason: 'invalid' });
    await expect(confirmPasswordReset(env, 'A'.repeat(43), 'short', hashPassword))
      .resolves.toEqual({ ok: false, reason: 'invalid' });
    expect(hashPassword).not.toHaveBeenCalled();
    expect(env.DB.prepare).not.toHaveBeenCalled();
  });

  it('serves a no-store reset page whose script immediately clears the fragment', async () => {
    const router = Router();
    registerAccountRecoveryRoutes(router, { hashPassword: vi.fn() });

    const page = await router.fetch(new Request('https://focusbro.net/reset-password'), {});
    const script = await router.fetch(new Request('https://focusbro.net/auth/reset-page.js'), {});

    expect(page.status).toBe(200);
    expect(page.headers.get('Cache-Control')).toContain('no-store');
    expect(await page.text()).toContain('src=\"/auth/reset-page.js\"');
    expect(script.headers.get('Cache-Control')).toContain('no-store');
    expect(await script.text()).toContain("history.replaceState(null, '', location.pathname)");
  });

  it('consumes an email verification link once and exposes a scanner-safe page', async () => {
    const router = Router();
    registerAccountRecoveryRoutes(router, {
      hashPassword: vi.fn(),
      authenticatedSession: vi.fn(),
    });
    let available = true;
    const env = {
      DB: {
        prepare(sql) {
          const statement = preparedStatement(sql);
          if (sql.includes('RETURNING user_id')) {
            statement.first = vi.fn(async () => {
              if (!available) return null;
              available = false;
              return { user_id: 'user-1' };
            });
          }
          return statement;
        },
        batch: vi.fn(async () => []),
      },
    };
    const token = 'V'.repeat(43);
    const confirm = () => router.fetch(new Request(
      'https://focusbro.net/auth/confirm-email-verification',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      },
    ), env);

    expect((await confirm()).status).toBe(200);
    expect((await confirm()).status).toBe(400);
    expect(env.DB.batch).toHaveBeenCalledOnce();
    const page = await router.fetch(new Request('https://focusbro.net/verify-email'), env);
    const script = await router.fetch(new Request('https://focusbro.net/auth/verify-page.js'), env);
    expect(page.headers.get('Cache-Control')).toContain('no-store');
    expect(await page.text()).toContain('Verify my email');
    const scriptText = await script.text();
    expect(scriptText).toContain("history.replaceState(null, '', location.pathname)");
    expect(scriptText).toContain("button.addEventListener('click'");
  });
});
