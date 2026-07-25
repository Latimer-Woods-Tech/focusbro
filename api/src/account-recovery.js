const RESET_PURPOSE = 'password_reset';
const RESET_TTL_SECONDS = 15 * 60;
const ACCOUNT_REQUEST_LIMIT = 5;
const ACCOUNT_NETWORK_REQUEST_LIMIT = 3;
const RATE_LIMIT_WINDOW_SECONDS = 15 * 60;

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
export async function allowRecoveryRequest(request, env, normalizedEmail) {
  if (!env.KV_CACHE) return true;

  try {
    const accountHash = await sha256Hex(normalizedEmail);
    const networkHash = await sha256Hex(clientNetworkSignal(request));
    const accountAllowed = await incrementWithinLimit(
      env.KV_CACHE,
      `recovery:account:${accountHash}`,
      ACCOUNT_REQUEST_LIMIT,
    );
    const accountNetworkAllowed = await incrementWithinLimit(
      env.KV_CACHE,
      `recovery:account-network:${accountHash}:${networkHash}`,
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

export function registerAccountRecoveryRoutes(router) {
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
        await env.DB.prepare(
          `UPDATE auth_action_tokens SET consumed_at = datetime('now')
           WHERE token_hash = ? AND consumed_at IS NULL`,
        ).bind(await sha256Hex(token)).run();
        console.warn(`[AUTH] Password reset email not delivered: ${delivery.reason}`);
      }
    } catch (error) {
      console.error('[AUTH] Password reset request failed:', error.message);
    }

    return genericRecoveryResponse();
  });
}

export const recoveryConstants = {
  RESET_PURPOSE,
  RESET_TTL_SECONDS,
  ACCOUNT_REQUEST_LIMIT,
  ACCOUNT_NETWORK_REQUEST_LIMIT,
  RATE_LIMIT_WINDOW_SECONDS,
};
