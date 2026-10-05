// FBQ-12 (focusbro#391): a number is usable for TEXTS only once a one-time code
// sent to it is confirmed, and a verified number belongs to ONE account.
//
//   POST /api/consent/phone/code   { phone }  → texts a 6-digit code (10 min, single use)
//   POST /api/consent/phone/verify { code }   → marks users.phone_verified_at
//
// The code is stored as an HMAC (keyed by JWT_SECRET, bound to user + number),
// never in the clear; one pending code per user (a new request replaces it);
// wrong guesses are capped per code and per user, requests per user and per
// number, via the atomic D1 limiter (rate-limit.js). Schema: migration 0015.
import { spendLimits, retryAfterSeconds } from './rate-limit.js';

export const CODE_TTL_SECONDS = 600;
export const MAX_CODE_GUESSES = 5;
const REQUEST_WINDOW_S = 3600;
const USER_REQUESTS_PER_WINDOW = 5;
const NUMBER_REQUESTS_PER_WINDOW = 3;
const CONFIRM_WINDOW_S = 900;
const CONFIRMS_PER_WINDOW = 15;

/** True when this user row (needs `phone`, `phone_verified_at`) may be texted. */
export function hasVerifiedTextChannel(user) {
  return !!(user && typeof user.phone === 'string' && user.phone.trim() && user.phone_verified_at);
}

/** Warm copy for the verify flow; every string is in the design-law scan surface. */
export function phoneVerifyCopy() {
  return {
    sent: 'Code sent. It works for 10 minutes — pop it in below.',
    verified: 'Your number is confirmed. Text follow-ups are good to go.',
    prompt: 'Confirm your number to keep text follow-ups. Until then your check-ins arrive as notifications.',
    sendButton: 'Text me a code',
    codeLabel: '6-digit code',
    confirmButton: 'Confirm number',
    needPhone: 'Add a mobile number and I can text you a code.',
    wrong: 'That code does not match. Check it and try again.',
    expired: 'That code has run out. Ask for a fresh one whenever you are ready.',
    taken: 'That number is already confirmed on another account, so I cannot text it here.',
    slowDown: 'Plenty of tries for now. Give it a little while, then ask for a fresh code.',
    sendFailed: 'I could not send a code just now. Try again in a moment.',
  };
}

/** The text of the code message itself (also in the design-law scan surface). */
export const verifyCodeSms = (code) =>
  `Your FocusBro code is ${code}. It works for 10 minutes. If this was not you, ignore it.`;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha = async (s) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

async function hashCode(secret, userId, phone, code) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`phone-verify:${userId}:${phone}:${code}`)));
}

function newCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(n).padStart(6, '0');
}

const nowS = () => Math.floor(Date.now() / 1000);

/**
 * Mount the two endpoints. `requireUser`, `normalizePhone` and the injectable
 * `sendSms` come from consent.js (tests and local runs inject a stub — nothing
 * here ever reaches the carrier on its own).
 */
export function registerPhoneVerifyRoutes(router, { jsonResponse, requireUser, normalizePhone, sendSms }) {
  const copy = phoneVerifyCopy();
  const secretOf = (env) => (env && (env.JWT_SECRET || env.JWT_SECRET_NEXT)) || '';
  const limited = (resetAts) => new Response(JSON.stringify({ error: copy.slowDown, code: 'rate_limited' }), {
    status: 429,
    headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfterSeconds(resetAts)) },
  });

  router.post('/api/consent/phone/code', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;
      if (!secretOf(env)) return jsonResponse({ error: copy.sendFailed }, 503);
      let body; try { body = await request.json(); } catch { body = null; }
      const phone = normalizePhone(body && body.phone);
      if (!phone) return jsonResponse({ error: copy.needPhone }, 400);

      const me = await env.DB.prepare(`SELECT phone, phone_verified_at FROM users WHERE id = ?`).bind(auth.userId).first();
      if (me && me.phone === phone && me.phone_verified_at) {
        return jsonResponse({ ok: true, already_verified: true, message: copy.verified }, 200);
      }
      const holder = await env.DB.prepare(
        `SELECT id FROM users WHERE phone = ? AND phone_verified_at IS NOT NULL AND id != ?`,
      ).bind(phone, auth.userId).first();
      if (holder) return jsonResponse({ error: copy.taken, code: 'phone_taken' }, 409);

      const uKey = `phv:u:${await sha(auth.userId)}`;
      const nKey = `phv:n:${await sha(phone)}`;
      const hits = await spendLimits(env, [uKey, nKey], REQUEST_WINDOW_S);
      if (hits[uKey].count > USER_REQUESTS_PER_WINDOW || hits[nKey].count > NUMBER_REQUESTS_PER_WINDOW) {
        return limited([hits[uKey].resetAt, hits[nKey].resetAt]);
      }

      const code = newCode();
      await env.DB.prepare(
        `INSERT INTO phone_verifications (user_id, phone, code_hash, expires_at, attempts)
         VALUES (?, ?, ?, ?, 0)
         ON CONFLICT(user_id) DO UPDATE SET phone = excluded.phone, code_hash = excluded.code_hash,
           expires_at = excluded.expires_at, attempts = 0, created_at = CURRENT_TIMESTAMP`,
      ).bind(auth.userId, phone, await hashCode(secretOf(env), auth.userId, phone, code), nowS() + CODE_TTL_SECONDS).run();

      const sent = await sendSms(env, phone, verifyCodeSms(code));
      if (!sent) {
        await env.DB.prepare(`DELETE FROM phone_verifications WHERE user_id = ?`).bind(auth.userId).run();
        return jsonResponse({ error: copy.sendFailed }, 503);
      }
      return jsonResponse({ ok: true, expires_in: CODE_TTL_SECONDS, message: copy.sent }, 200);
    } catch (err) {
      console.error('[phone-verify] code error:', err && err.message);
      return jsonResponse({ error: copy.sendFailed }, 500);
    }
  });

  router.post('/api/consent/phone/verify', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;
      if (!secretOf(env)) return jsonResponse({ error: copy.sendFailed }, 503);
      let body; try { body = await request.json(); } catch { body = null; }
      const code = body && typeof body.code === 'string' ? body.code.trim() : '';
      if (!/^\d{6}$/.test(code)) return jsonResponse({ error: copy.wrong, code: 'wrong_code' }, 400);

      const cKey = `phv:c:${await sha(auth.userId)}`;
      const hit = (await spendLimits(env, [cKey], CONFIRM_WINDOW_S))[cKey];
      if (hit.count > CONFIRMS_PER_WINDOW) return limited([hit.resetAt]);

      const row = await env.DB.prepare(
        `SELECT phone, code_hash, expires_at, attempts FROM phone_verifications WHERE user_id = ?`,
      ).bind(auth.userId).first();
      if (!row) return jsonResponse({ error: copy.expired, code: 'expired' }, 400);
      if (Number(row.expires_at) <= nowS() || Number(row.attempts) >= MAX_CODE_GUESSES) {
        await env.DB.prepare(`DELETE FROM phone_verifications WHERE user_id = ?`).bind(auth.userId).run();
        return jsonResponse({ error: copy.expired, code: 'expired' }, 400);
      }
      if (row.code_hash !== await hashCode(secretOf(env), auth.userId, row.phone, code)) {
        await env.DB.prepare(`UPDATE phone_verifications SET attempts = attempts + 1 WHERE user_id = ?`).bind(auth.userId).run();
        return jsonResponse({ error: copy.wrong, code: 'wrong_code' }, 400);
      }
      // Single use: only the request that actually deletes the code may proceed.
      const used = await env.DB.prepare(`DELETE FROM phone_verifications WHERE user_id = ? AND code_hash = ?`)
        .bind(auth.userId, row.code_hash).run();
      if (!(used && used.meta && used.meta.changes)) return jsonResponse({ error: copy.expired, code: 'expired' }, 400);
      try {
        await env.DB.prepare(
          `UPDATE users SET phone = ?, phone_verified_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
        ).bind(row.phone, auth.userId).run();
      } catch (err) {
        if (/UNIQUE/i.test((err && err.message) || '')) return jsonResponse({ error: copy.taken, code: 'phone_taken' }, 409);
        throw err;
      }
      await env.DB.prepare(`UPDATE contact_consent SET phone = ? WHERE user_id = ? AND channel = 'text'`)
        .bind(row.phone, auth.userId).run();
      return jsonResponse({ ok: true, phone_verified: true, message: copy.verified }, 200);
    } catch (err) {
      console.error('[phone-verify] verify error:', err && err.message);
      return jsonResponse({ error: copy.sendFailed }, 500);
    }
  });
}
