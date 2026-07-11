// ════════════════════════════════════════════════════════════
// FOCUSBRO — WEB PUSH SUBSCRIPTION INTAKE  (Contender #10, Phase A)
// ════════════════════════════════════════════════════════════
// The delivery half of the push channel already exists: checkins-cron.js reads
// `push_subscriptions` and webpush.js sends an RFC 8291 payload. But nothing
// reachable ever WROTE a `push_subscriptions` row — the intake routes lived in
// extended-routes.js, which is imported but never mounted. Result: the cron
// always found `no_subscription` and every push check-in silently no-op'd.
//
// This module mounts the two routes that make the push channel real, using the
// same ctx-injection pattern as registerAccountabilityRoutes so the module-
// private helpers (getAuthToken, verifyToken, jsonResponse, generateUUID) stay
// the single source of auth truth:
//
//   GET  /vapid/public-key      — hands the browser the VAPID public key so it
//                                 can build a PushSubscription.
//   POST /notifications/subscribe   — stores that subscription (upsert on the
//                                 unique endpoint) so the cron can deliver to it.
//   DELETE /notifications/subscribe — a user-initiated unsubscribe (soft).
//
// Follow-up (P1): swap webpush.js + this intake for @latimer-woods-tech/push
// so FocusBro stops re-implementing the shared Web Push + FCM surface.
// ════════════════════════════════════════════════════════════

/**
 * Register the Web Push subscription intake routes on the shared router.
 *
 * @param {import('itty-router').RouterType} router  The mounted main router.
 * @param {object} ctx  Injected module-private helpers from index.js.
 * @param {(request: Request) => string|null} ctx.getAuthToken
 * @param {(token: string, jwtSecret: string) => Promise<{sub:string}|null>} ctx.verifyToken
 * @param {(data: unknown, status?: number) => Response} ctx.jsonResponse
 * @param {() => string} ctx.generateUUID
 */
export function registerPushRoutes(router, ctx) {
  const { getAuthToken, verifyToken, jsonResponse, generateUUID } = ctx;

  async function requireUser(request, env) {
    const token = getAuthToken(request);
    if (!token) return { error: jsonResponse({ error: 'Unauthorized' }, 401) };
    const payload = await verifyToken(token, env.JWT_SECRET);
    if (!payload) return { error: jsonResponse({ error: 'Invalid token' }, 401) };
    return { userId: payload.sub };
  }

  // ── GET /vapid/public-key — the browser needs this to build a subscription ──
  router.get('/vapid/public-key', async (request, env) => {
    const publicKey = env && env.VAPID_PUBLIC_KEY;
    if (!publicKey) return jsonResponse({ error: 'Push notifications not configured' }, 503);
    return jsonResponse({ public_key: publicKey }, 200);
  });

  // ── POST /notifications/subscribe — store (or refresh) a push subscription ──
  // Upsert keyed on the unique endpoint: a returning device re-activates its row
  // and re-points it at the current user rather than creating a duplicate.
  router.post('/notifications/subscribe', async (request, env) => {
    const auth = await requireUser(request, env);
    if (auth.error) return auth.error;

    let body;
    try { body = await request.json(); } catch { body = null; }
    const subscription = body && body.subscription;
    const keys = subscription && subscription.keys;
    if (!subscription || !subscription.endpoint || !keys || !keys.p256dh || !keys.auth) {
      return jsonResponse({ error: 'Invalid subscription data' }, 400);
    }

    const id = generateUUID();
    try {
      await env.DB.prepare(
        `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, device_label, is_active)
         VALUES (?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(endpoint) DO UPDATE SET
           user_id    = excluded.user_id,
           p256dh     = excluded.p256dh,
           auth       = excluded.auth,
           is_active  = 1,
           created_at = CURRENT_TIMESTAMP`
      ).bind(
        id,
        auth.userId,
        subscription.endpoint,
        keys.p256dh,
        keys.auth,
        (body && body.device_label) || 'Unknown Device'
      ).run();
    } catch {
      return jsonResponse({ error: 'Failed to save subscription' }, 500);
    }

    return jsonResponse({ success: true, subscription_id: id }, 200);
  });

  // ── DELETE /notifications/subscribe — user-initiated unsubscribe (soft) ──
  router.delete('/notifications/subscribe', async (request, env) => {
    const auth = await requireUser(request, env);
    if (auth.error) return auth.error;

    let body;
    try { body = await request.json(); } catch { body = null; }
    const endpoint = body && body.endpoint;
    if (!endpoint) return jsonResponse({ error: 'Endpoint required' }, 400);

    try {
      await env.DB.prepare(
        `UPDATE push_subscriptions SET is_active = 0 WHERE user_id = ? AND endpoint = ?`
      ).bind(auth.userId, endpoint).run();
    } catch {
      return jsonResponse({ error: 'Failed to unsubscribe' }, 500);
    }

    return jsonResponse({ success: true }, 200);
  });
}
