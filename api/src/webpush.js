// ════════════════════════════════════════════════════════════
// FOCUSBRO — WEB PUSH SENDER  (Contender track, issue #10, Phase A · R-205)
// ════════════════════════════════════════════════════════════
// Server-side Web Push delivery for the accountability check-in cron.
//
// Until now the app only STORED push subscriptions (extended-routes.js) and
// served the VAPID public key — there was no code that actually pushed a
// message to a subscription. This module is that missing send path: it
// encrypts a payload per RFC 8291 (aes128gcm, RFC 8188 content coding) and
// authorizes the request per RFC 8292 (VAPID, ES256 JWT), then POSTs it to
// the subscription endpoint.
//
// Workers-runtime clean: Web Crypto only (ECDH P-256, HKDF, AES-GCM, ECDSA) —
// no Node built-ins, no Buffer, every fetch error-handled by the caller.
//
// This is the Phase-A stand-in for the moat. The voice call (Phase B) rides
// the shared @latimer-woods-tech/voice-agent engine later and is gated; this
// keeps the check-in able to actually reach a phone in the meantime.
// ════════════════════════════════════════════════════════════

const ENC = new TextEncoder();

// ── base64 / base64url helpers (no Buffer) ───────────────────

/** Decode a base64 or base64url string into a Uint8Array. */
export function b64ToBytes(s) {
  if (typeof s !== 'string') throw new TypeError('base64 input must be a string');
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad === 2) b64 += '==';
  else if (pad === 3) b64 += '=';
  else if (pad === 1) throw new Error('invalid base64 length');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encode bytes as unpadded base64url. */
export function bytesToB64url(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Concatenate several Uint8Arrays into one. */
export function concatBytes(...arrays) {
  let len = 0;
  for (const a of arrays) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

// ── crypto primitives ────────────────────────────────────────

/** HKDF (extract+expand) via Web Crypto → Uint8Array of `length` bytes. */
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    length * 8
  );
  return new Uint8Array(bits);
}

/**
 * Split a raw 65-byte uncompressed P-256 point (0x04 || X32 || Y32) into a
 * JWK-usable {x, y} base64url pair.
 */
function pointToXY(raw) {
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error('expected 65-byte uncompressed P-256 point');
  return { x: bytesToB64url(raw.slice(1, 33)), y: bytesToB64url(raw.slice(33, 65)) };
}

/**
 * Encrypt a message for a push subscription per RFC 8291 (aes128gcm).
 * Exposed for the delivery layer and for a decrypt round-trip test.
 *
 * @param {object} args
 * @param {string} args.plaintext         message body (JSON string)
 * @param {Uint8Array} args.uaPublic      subscription public key (p256dh, 65 bytes)
 * @param {Uint8Array} args.authSecret    subscription auth secret (16 bytes)
 * @param {Uint8Array} [args.salt]        16-byte content salt (random if omitted)
 * @param {CryptoKeyPair} [args.asKeys]   ephemeral server ECDH keypair (generated if omitted)
 * @returns {Promise<Uint8Array>} the aes128gcm message body (header || ciphertext)
 */
export async function encryptPayload({ plaintext, uaPublic, authSecret, salt, asKeys }) {
  const contentSalt = salt || crypto.getRandomValues(new Uint8Array(16));

  // Ephemeral application-server (sender) ECDH keypair.
  const serverKeys = asKeys || await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  );
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeys.publicKey)); // 65

  // ECDH(server_private, ua_public) → 32-byte shared secret.
  const uaKey = await crypto.subtle.importKey(
    'raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  const ecdhBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaKey }, serverKeys.privateKey, 256
  );
  const ecdhSecret = new Uint8Array(ecdhBits);

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info\0"||ua_pub||as_pub, 32)
  const keyInfo = concatBytes(ENC.encode('WebPush: info\0'), uaPublic, asPublicRaw);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  // CEK / NONCE per RFC 8188, extracted with the content salt.
  const cek = await hkdf(contentSalt, ikm, ENC.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(contentSalt, ikm, ENC.encode('Content-Encoding: nonce\0'), 12);

  // Single record: plaintext || 0x02 (last-record delimiter).
  const padded = concatBytes(ENC.encode(plaintext), new Uint8Array([0x02]));

  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, padded);
  const ciphertext = new Uint8Array(ctBuf);

  // Header: salt(16) || rs(4, uint32 BE) || idlen(1) || keyid(as_public,65)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  const header = concatBytes(contentSalt, rs, new Uint8Array([asPublicRaw.length]), asPublicRaw);

  return concatBytes(header, ciphertext);
}

/**
 * Build a VAPID Authorization header value for a push endpoint (RFC 8292).
 * @returns {Promise<{authorization: string}>}
 */
export async function buildVapidHeaders({ endpoint, publicKey, privateKey, subject }) {
  const url = new URL(endpoint);
  const aud = `${url.protocol}//${url.host}`;
  const header = { typ: 'JWT', alg: 'ES256' };
  const now = Math.floor(Date.now() / 1000);
  const claims = { aud, exp: now + 12 * 60 * 60, sub: subject || 'mailto:support@focusbro.net' };

  const signingInput = `${bytesToB64url(ENC.encode(JSON.stringify(header)))}.${bytesToB64url(ENC.encode(JSON.stringify(claims)))}`;

  // Import the VAPID private key (raw 32-byte d + x,y from the public key) for ES256.
  const pubRaw = b64ToBytes(publicKey);
  const { x, y } = pointToXY(pubRaw);
  const d = bytesToB64url(b64ToBytes(privateKey));
  const signKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x, y, d, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, signKey, ENC.encode(signingInput)
  );
  const jwt = `${signingInput}.${bytesToB64url(new Uint8Array(sigBuf))}`;

  return { authorization: `vapid t=${jwt}, k=${bytesToB64url(pubRaw)}` };
}

/** True when VAPID keys are configured in the environment. */
export function vapidConfigured(env) {
  return !!(env && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

/**
 * Send a Web Push message to a single subscription.
 * @param {object} env  Worker env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT)
 * @param {object} sub  { endpoint, p256dh, auth }
 * @param {object|string} payload  JSON-serializable message (or a string)
 * @param {object} [opts] { ttl }
 * @returns {Promise<{ok: boolean, status: number, gone?: boolean, error?: string}>}
 */
export async function sendWebPush(env, sub, payload, opts = {}) {
  if (!vapidConfigured(env)) return { ok: false, status: 0, error: 'vapid_not_configured' };
  if (!sub || !sub.endpoint || !sub.p256dh || !sub.auth) {
    return { ok: false, status: 0, error: 'invalid_subscription' };
  }

  try {
    const plaintext = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const body = await encryptPayload({
      plaintext,
      uaPublic: b64ToBytes(sub.p256dh),
      authSecret: b64ToBytes(sub.auth),
    });
    const vapid = await buildVapidHeaders({
      endpoint: sub.endpoint,
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
      subject: env.VAPID_SUBJECT,
    });

    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': vapid.authorization,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'TTL': String(opts.ttl || 12 * 60 * 60),
      },
      body,
    }).catch((e) => ({ ok: false, status: 0, _netErr: e && e.message }));

    // 404/410 mean the subscription is gone and should be deactivated.
    const gone = res.status === 404 || res.status === 410;
    return {
      ok: !!res.ok,
      status: res.status || 0,
      gone,
      error: res.ok ? undefined : (res._netErr || `push_status_${res.status || 0}`),
    };
  } catch (err) {
    return { ok: false, status: 0, error: (err && err.message) || 'push_encrypt_error' };
  }
}
