const RESET_PURPOSE = 'password_reset';
const VERIFICATION_PURPOSE = 'email_verification';
const RESET_TTL_SECONDS = 15 * 60;
const VERIFICATION_TTL_SECONDS = 24 * 60 * 60;
const ACCOUNT_REQUEST_LIMIT = 5;
const ACCOUNT_NETWORK_REQUEST_LIMIT = 3;
const RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
const RESET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function encodeBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function normalizeAccountEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function clientNetworkSignal(request) {
  const forwarded = request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')
    || 'unknown';
  return forwarded.split(',')[0].trim() || 'unknown';
}

async function incrementWithinLimit(kv, key, limit) {
  const current = Number.parseInt(await kv.get(key), 10) || 0;
  if (current >= limit) return false;
  await kv.put(key, String(current + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS });
  return true;
}

/**
 * Apply both account-wide and account+network limits. There is intentionally
 * no network-only lock: one noisy person must not lock out an office, school,
 * or household sharing a public IP.
 */
export async function allowRecoveryRequest(request, env, normalizedEmail, scope = 'recovery') {
  if (!env.KV_CACHE) return true;

  try {
    const accountHash = await sha256Hex(normalizedEmail);
    const networkHash = await sha256Hex(clientNetworkSignal(request));
    const accountAllowed = await incrementWithinLimit(
      env.KV_CACHE,
      `${scope}:account:${accountHash}`,
      ACCOUNT_REQUEST_LIMIT,
    );
    const accountNetworkAllowed = await incrementWithinLimit(
      env.KV_CACHE,
      `${scope}:account-network:${accountHash}:${networkHash}`,
      ACCOUNT_NETWORK_REQUEST_LIMIT,
    );
    return accountAllowed && accountNetworkAllowed;
  } catch (error) {
    console.warn('[AUTH] Recovery rate limit unavailable:', error.message);
    return true;
  }
}

export async function createAuthActionToken(env, userId, purpose, ttlSeconds) {
  const token = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await sha256Hex(token);
  const tokenId = crypto.randomUUID();

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE auth_action_tokens
       SET consumed_at = datetime('now')
       WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL`,
    ).bind(userId, purpose),
    env.DB.prepare(
      `INSERT INTO auth_action_tokens
         (id, user_id, purpose, token_hash, expires_at)
       VALUES (?, ?, ?, ?, datetime('now', ?))`,
    ).bind(tokenId, userId, purpose, tokenHash, `+${ttlSeconds} seconds`),
  ]);

  return token;
}

function emailPayload(from, to, resetUrl) {
  return {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: from, name: 'FocusBro' },
    subject: 'Reset your FocusBro password',
    content: [
      {
        type: 'text/plain',
        value: `Use this link within 15 minutes to reset your FocusBro password:\n\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
      },
    ],
  };
}

function verificationEmailPayload(from, to, verificationUrl) {
  return {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: from, name: 'FocusBro' },
    subject: 'Verify your FocusBro email',
    content: [
      {
        type: 'text/plain',
        value: `Use this link within 24 hours to verify your FocusBro email:\n\n${verificationUrl}\n\nIf you did not create this account, you can ignore this email.`,
      },
    ],
  };
}

export async function sendPasswordResetEmail(env, email, token, fetchImpl = fetch) {
  if (!env.SENDGRID_API_KEY || !env.AUTH_EMAIL_FROM) {
    return { delivered: false, reason: 'not_configured' };
  }

  const origin = (env.API_ORIGIN || 'https://focusbro.net').replace(/\/+$/, '');
  const resetUrl = `${origin}/reset-password#token=${encodeURIComponent(token)}`;
  const response = await fetchImpl('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(emailPayload(env.AUTH_EMAIL_FROM, email, resetUrl)),
  });
  return response.ok
    ? { delivered: true }
    : { delivered: false, reason: `provider_${response.status}` };
}

export async function sendEmailVerificationEmail(env, email, token, fetchImpl = fetch) {
  if (!env.SENDGRID_API_KEY || !env.AUTH_EMAIL_FROM) {
    return { delivered: false, reason: 'not_configured' };
  }

  const origin = (env.API_ORIGIN || 'https://focusbro.net').replace(/\/+$/, '');
  const verificationUrl = `${origin}/verify-email#token=${encodeURIComponent(token)}`;
  const response = await fetchImpl('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(verificationEmailPayload(
      env.AUTH_EMAIL_FROM,
      email,
      verificationUrl,
    )),
  });
  return response.ok
    ? { delivered: true }
    : { delivered: false, reason: `provider_${response.status}` };
}

async function invalidateActionToken(env, token) {
  await env.DB.prepare(
    `UPDATE auth_action_tokens SET consumed_at = datetime('now')
     WHERE token_hash = ? AND consumed_at IS NULL`,
  ).bind(await sha256Hex(token)).run();
}

export async function deliverEmailVerification(env, userId, email) {
  const token = await createAuthActionToken(
    env,
    userId,
    VERIFICATION_PURPOSE,
    VERIFICATION_TTL_SECONDS,
  );
  const delivery = await sendEmailVerificationEmail(env, email, token);
  if (!delivery.delivered) {
    await invalidateActionToken(env, token);
  }
  return delivery;
}

function genericRecoveryResponse() {
  return new Response(JSON.stringify({
    success: true,
    message: 'If that account exists, a password reset link is on its way.',
  }), {
    status: 202,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, must-revalidate, max-age=0',
    },
  });
}

function resetPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Reset your password · FocusBro</title>
  <style>
    :root{color-scheme:dark;font-family:system-ui,sans-serif}body{margin:0;background:#0a0e27;color:#e2e8f0}
    main{max-width:440px;margin:10vh auto;padding:32px;border:1px solid #3d4f8a;border-radius:16px;background:#141d3f}
    h1{margin-top:0}p{color:#b6c3d4;line-height:1.5}label{display:block;margin:18px 0 6px;font-weight:700}
    input,button{box-sizing:border-box;width:100%;padding:12px;border-radius:8px;font:inherit}
    input{border:1px solid #6476a8;background:#0f1428;color:#fff}button{margin-top:20px;border:0;background:#38bdf8;color:#07111f;font-weight:800;cursor:pointer}
    button:disabled{opacity:.6;cursor:wait}#status{min-height:24px;margin-top:16px}.error{color:#fca5a5}.success{color:#86efac}
    a{color:#7dd3fc}
  </style>
</head>
<body>
  <main>
    <h1>Choose a new password</h1>
    <p>Your reset link works once and expires after 15 minutes. Resetting signs out every existing FocusBro session.</p>
    <form id="reset-form">
      <label for="password">New password</label>
      <input id="password" name="password" type="password" minlength="8" maxlength="1024" autocomplete="new-password" required>
      <label for="confirmation">Confirm new password</label>
      <input id="confirmation" name="confirmation" type="password" minlength="8" maxlength="1024" autocomplete="new-password" required>
      <button type="submit">Reset password</button>
    </form>
    <p id="status" role="status" aria-live="polite"></p>
    <p><a href="/">Back to FocusBro</a></p>
  </main>
  <script src="/auth/reset-page.js" defer></script>
</body>
</html>`;
}

const RESET_PAGE_SCRIPT = `(() => {
  const form = document.getElementById('reset-form');
  const status = document.getElementById('status');
  const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
  history.replaceState(null, '', location.pathname);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    form.hidden = true;
    status.className = 'error';
    status.textContent = 'This reset link is invalid or has expired. Request a new one.';
    return;
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = document.getElementById('password').value;
    const confirmation = document.getElementById('confirmation').value;
    if (password !== confirmation) {
      status.className = 'error';
      status.textContent = 'Those passwords do not match.';
      return;
    }
    const button = form.querySelector('button');
    button.disabled = true;
    status.className = '';
    status.textContent = 'Resetting…';
    try {
      const response = await fetch('/auth/confirm-password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Password reset failed');
      form.hidden = true;
      status.className = 'success';
      status.textContent = 'Password reset. You can sign in with your new password.';
    } catch (error) {
      status.className = 'error';
      status.textContent = error.message;
      button.disabled = false;
    }
  });
})();`;

function verificationPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Verify your email · FocusBro</title>
  <style>
    :root{color-scheme:dark;font-family:system-ui,sans-serif}body{margin:0;background:#0a0e27;color:#e2e8f0}
    main{max-width:440px;margin:10vh auto;padding:32px;border:1px solid #3d4f8a;border-radius:16px;background:#141d3f}
    h1{margin-top:0}p{color:#b6c3d4;line-height:1.5}button{box-sizing:border-box;width:100%;margin-top:14px;padding:12px;border:0;border-radius:8px;background:#38bdf8;color:#07111f;font:inherit;font-weight:800;cursor:pointer}
    button:disabled{opacity:.6;cursor:wait}#status{min-height:24px;margin-top:16px}.error{color:#fca5a5}.success{color:#86efac}a{color:#7dd3fc}
  </style>
</head>
<body>
  <main>
    <h1>Verify your email</h1>
    <p>Confirm that this email belongs to you. This link works once and expires after 24 hours.</p>
    <button id="verify-button" type="button">Verify my email</button>
    <p id="status" role="status" aria-live="polite"></p>
    <p><a href="/">Back to FocusBro</a></p>
  </main>
  <script src="/auth/verify-page.js" defer></script>
</body>
</html>`;
}

const VERIFY_PAGE_SCRIPT = `(() => {
  const button = document.getElementById('verify-button');
  const status = document.getElementById('status');
  const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
  history.replaceState(null, '', location.pathname);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    button.hidden = true;
    status.className = 'error';
    status.textContent = 'This verification link is invalid or has expired.';
    return;
  }
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.className = '';
    status.textContent = 'Verifying…';
    try {
      const response = await fetch('/auth/confirm-email-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Email verification failed');
      button.hidden = true;
      status.className = 'success';
      status.textContent = 'Email verified. You are all set.';
    } catch (error) {
      status.className = 'error';
      status.textContent = error.message;
      button.disabled = false;
    }
  });
})();`;

export async function confirmPasswordReset(env, token, newPassword, hashPassword) {
  if (!RESET_TOKEN_PATTERN.test(token || '')
    || typeof newPassword !== 'string'
    || newPassword.length < 8
    || newPassword.length > 1024) {
    return { ok: false, reason: 'invalid' };
  }

  // Do the expensive hash before the compare-and-swap. Once consumed, a link
  // can never be replayed, even if two confirmation requests arrive together.
  const passwordHash = await hashPassword(newPassword);
  const tokenHash = await sha256Hex(token);
  const consumed = await env.DB.prepare(
    `UPDATE auth_action_tokens
     SET consumed_at = datetime('now')
     WHERE token_hash = ?
       AND purpose = ?
       AND consumed_at IS NULL
       AND expires_at > datetime('now')
       AND user_id IN (SELECT id FROM users WHERE is_active = 1)
     RETURNING user_id`,
  ).bind(tokenHash, RESET_PURPOSE).first();
  if (!consumed?.user_id) return { ok: false, reason: 'invalid' };

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE users
       SET password_hash = ?, updated_at = datetime('now')
       WHERE id = ? AND is_active = 1`,
    ).bind(passwordHash, consumed.user_id),
    env.DB.prepare(
      `UPDATE sessions
       SET is_active = 0, revoked_at = datetime('now'), token = '', token_hash = NULL
       WHERE user_id = ? AND is_active = 1`,
    ).bind(consumed.user_id),
    env.DB.prepare(
      `INSERT INTO audit_logs (user_id, action, details, created_at)
       VALUES (?, 'password_reset', 'all_sessions_revoked', datetime('now'))`,
    ).bind(consumed.user_id),
  ]);
  return { ok: true, userId: consumed.user_id };
}

export function registerAccountRecoveryRoutes(router, dependencies = {}) {
  router.post('/auth/request-password-reset', async (request, env) => {
    let body;
    try {
      body = await request.json();
    } catch {
      return genericRecoveryResponse();
    }

    const email = normalizeAccountEmail(body?.email);
    if (!email || !(await allowRecoveryRequest(request, env, email))) {
      return genericRecoveryResponse();
    }

    try {
      const user = await env.DB.prepare(
        'SELECT id, email FROM users WHERE lower(email) = ? AND is_active = 1 LIMIT 1',
      ).bind(email).first();
      if (!user) return genericRecoveryResponse();

      const token = await createAuthActionToken(env, user.id, RESET_PURPOSE, RESET_TTL_SECONDS);
      const delivery = await sendPasswordResetEmail(env, user.email, token);
      if (!delivery.delivered) {
        await invalidateActionToken(env, token);
        console.warn(`[AUTH] Password reset email not delivered: ${delivery.reason}`);
      }
    } catch (error) {
      console.error('[AUTH] Password reset request failed:', error.message);
    }

    return genericRecoveryResponse();
  });

  router.get('/reset-password', () => new Response(resetPage(), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, must-revalidate, max-age=0',
    },
  }));

  router.get('/auth/reset-page.js', () => new Response(RESET_PAGE_SCRIPT, {
    status: 200,
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store, must-revalidate, max-age=0',
    },
  }));

  router.get('/verify-email', () => new Response(verificationPage(), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, must-revalidate, max-age=0',
    },
  }));

  router.get('/auth/verify-page.js', () => new Response(VERIFY_PAGE_SCRIPT, {
    status: 200,
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store, must-revalidate, max-age=0',
    },
  }));

  router.post('/auth/confirm-password-reset', async (request, env) => {
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid or expired reset link' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    try {
      const result = await confirmPasswordReset(
        env,
        body?.token,
        body?.password,
        dependencies.hashPassword,
      );
      if (!result.ok) {
        return new Response(JSON.stringify({ error: 'Invalid or expired reset link' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Set-Cookie': '__Host-focusbro_session=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax',
        },
      });
    } catch (error) {
      console.error('[AUTH] Password reset confirmation failed:', error.message);
      return new Response(JSON.stringify({ error: 'Password reset failed. Request a new link.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
  });

  router.post('/auth/request-email-verification', async (request, env) => {
    try {
      const auth = await dependencies.authenticatedSession(request, env);
      if (!auth) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }
      const user = await env.DB.prepare(
        'SELECT email, email_verified_at FROM users WHERE id = ? AND is_active = 1',
      ).bind(auth.payload.sub).first();
      if (!user) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }
      if (user.email_verified_at) {
        return new Response(JSON.stringify({ success: true, verified: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }
      const normalizedEmail = normalizeAccountEmail(user.email);
      if (await allowRecoveryRequest(request, env, normalizedEmail, 'verification')) {
        const delivery = await deliverEmailVerification(env, auth.payload.sub, user.email);
        if (!delivery.delivered) {
          console.warn(`[AUTH] Verification email not delivered: ${delivery.reason}`);
        }
      }
      return new Response(JSON.stringify({ success: true, verified: false }), {
        status: 202,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    } catch (error) {
      console.error('[AUTH] Verification request failed:', error.message);
      return new Response(JSON.stringify({ error: 'Verification request failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
  });

  router.post('/auth/confirm-email-verification', async (request, env) => {
    let body;
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const token = body?.token;
    if (!RESET_TOKEN_PATTERN.test(token || '')) {
      return new Response(JSON.stringify({ error: 'Invalid or expired verification link' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
    try {
      const tokenHash = await sha256Hex(token);
      const consumed = await env.DB.prepare(
        `UPDATE auth_action_tokens
         SET consumed_at = datetime('now')
         WHERE token_hash = ?
           AND purpose = ?
           AND consumed_at IS NULL
           AND expires_at > datetime('now')
           AND user_id IN (SELECT id FROM users WHERE is_active = 1)
         RETURNING user_id`,
      ).bind(tokenHash, VERIFICATION_PURPOSE).first();
      if (!consumed?.user_id) {
        return new Response(JSON.stringify({ error: 'Invalid or expired verification link' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE users SET email_verified_at = datetime('now'), updated_at = datetime('now')
           WHERE id = ? AND is_active = 1`,
        ).bind(consumed.user_id),
        env.DB.prepare(
          `INSERT INTO audit_logs (user_id, action, details, created_at)
           VALUES (?, 'email_verified', 'success', datetime('now'))`,
        ).bind(consumed.user_id),
      ]);
      return new Response(JSON.stringify({ success: true, verified: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    } catch (error) {
      console.error('[AUTH] Email verification failed:', error.message);
      return new Response(JSON.stringify({ error: 'Email verification failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
  });
}

export const recoveryConstants = {
  RESET_PURPOSE,
  VERIFICATION_PURPOSE,
  RESET_TTL_SECONDS,
  VERIFICATION_TTL_SECONDS,
  ACCOUNT_REQUEST_LIMIT,
  ACCOUNT_NETWORK_REQUEST_LIMIT,
  RATE_LIMIT_WINDOW_SECONDS,
};
