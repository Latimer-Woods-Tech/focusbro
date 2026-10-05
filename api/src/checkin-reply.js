/**
 * One-tap reply tickets — the credential a notification action carries.
 *
 * A service worker has no session: when the person taps "I did it" on the
 * notification itself, nothing in that context can read the /me/ token or the
 * cookie jar. So the push payload carries a short-lived ticket bound to ONE
 * check-in occurrence, signed with the worker's JWT secret. It can do exactly
 * one thing — answer that check-in — and expires on its own (REPLY_TTL_MS),
 * so a leaked notification payload is worth one answer on one word, never a
 * session.
 *
 * Format: `<checkin_id>.<exp_ms>.<base64url(HMAC-SHA256(secret, "checkin-reply:" + id + ":" + exp))>`
 * Check-in ids are UUIDs (no dots). Web Crypto only — Worker-safe, no Buffer.
 */

/** A check-in older than three days is stale; /me/ reconciles it on return. */
export const REPLY_TTL_MS = 72 * 60 * 60 * 1000;

const enc = new TextEncoder();

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text))));
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Sign a ticket for one check-in occurrence.
 * @param {string} secret   the worker's JWT secret
 * @param {string} checkinId
 * @param {{ nowMs?: number, ttlMs?: number }} [opts]
 * @returns {Promise<string|null>} null when there is nothing to sign with
 */
export async function signReplyTicket(secret, checkinId, { nowMs = Date.now(), ttlMs = REPLY_TTL_MS } = {}) {
  if (!secret || !checkinId) return null;
  const exp = nowMs + ttlMs;
  const sig = await hmac(secret, `checkin-reply:${checkinId}:${exp}`);
  return `${checkinId}.${exp}.${sig}`;
}

/**
 * Verify a ticket. Returns the bound check-in id and expiry, or null for
 * anything malformed, tampered, signed with another secret, or expired.
 * @param {string} secret
 * @param {unknown} ticket
 * @param {{ nowMs?: number }} [opts]
 * @returns {Promise<{ checkinId: string, exp: number }|null>}
 */
export async function verifyReplyTicket(secret, ticket, { nowMs = Date.now() } = {}) {
  if (!secret || typeof ticket !== 'string') return null;
  const parts = ticket.split('.');
  if (parts.length !== 3) return null;
  const [checkinId, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!checkinId || !/^\d+$/.test(expStr) || !Number.isFinite(exp) || exp <= nowMs) return null;
  const expected = await hmac(secret, `checkin-reply:${checkinId}:${exp}`);
  if (!constantTimeEqual(sig, expected)) return null;
  return { checkinId, exp };
}
