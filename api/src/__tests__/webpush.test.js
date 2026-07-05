/**
 * FocusBro — Web Push sender tests (Contender #10, Phase A · R-205).
 *
 * The value here is a real cryptographic round-trip: we encrypt a payload with
 * the module exactly as it would for a browser, then decrypt it as a browser
 * would — using spec strings typed INDEPENDENTLY of the module. If the module's
 * RFC 8291 info strings or key schedule were wrong, this decrypt would fail. We
 * also verify the VAPID JWT (RFC 8292) parses and its ES256 signature validates
 * against the advertised public key.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  b64ToBytes,
  bytesToB64url,
  concatBytes,
  encryptPayload,
  buildVapidHeaders,
  vapidConfigured,
  sendWebPush,
} from '../webpush.js';

const ENC = new TextEncoder();
const DEC = new TextDecoder();

// Independent HKDF (not imported from the module) so the round-trip is a true cross-check.
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8);
  return new Uint8Array(bits);
}

/** Decrypt an aes128gcm web-push body as the user agent (subscription) would. */
async function decryptAsUA(body, uaKeys, uaPublicRaw, authSecret) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublicRaw = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);

  const asKey = await crypto.subtle.importKey('raw', asPublicRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, uaKeys.privateKey, 256));

  const keyInfo = concatBytes(ENC.encode('WebPush: info\0'), uaPublicRaw, asPublicRaw);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, ENC.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, ENC.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']);
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, ciphertext);
  const plain = new Uint8Array(plainBuf);
  // Strip the RFC 8188 last-record delimiter (0x02).
  expect(plain[plain.length - 1]).toBe(0x02);
  return DEC.decode(plain.slice(0, plain.length - 1));
}

async function makeSubscriptionKeys() {
  const uaKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', uaKeys.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  return { uaKeys, uaPublicRaw, authSecret };
}

describe('base64 helpers', () => {
  it('round-trips base64url without padding', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128, 64]);
    const s = bytesToB64url(bytes);
    expect(s).not.toMatch(/[+/=]/);
    expect(Array.from(b64ToBytes(s))).toEqual(Array.from(bytes));
  });

  it('accepts standard base64 input too', () => {
    expect(Array.from(b64ToBytes('AAEC+/8='))).toEqual([0, 1, 2, 251, 255]);
  });
});

describe('encryptPayload (RFC 8291 aes128gcm)', () => {
  it('produces a body a browser can decrypt back to the exact plaintext', async () => {
    const { uaKeys, uaPublicRaw, authSecret } = await makeSubscriptionKeys();
    const plaintext = JSON.stringify({ title: 'FocusBro', body: 'You said you’d start the taxes. I’m here.' });

    const body = await encryptPayload({ plaintext, uaPublic: uaPublicRaw, authSecret });

    // Header shape: salt(16) + rs(4) + idlen(1)=65 + keyid(65) then ciphertext.
    expect(body[20]).toBe(65);
    expect(body.length).toBeGreaterThan(16 + 4 + 1 + 65 + 16);

    const decrypted = await decryptAsUA(body, uaKeys, uaPublicRaw, authSecret);
    expect(decrypted).toBe(plaintext);
  });

  it('uses a fresh salt/keypair each call (different ciphertext for same input)', async () => {
    const { uaPublicRaw, authSecret } = await makeSubscriptionKeys();
    const a = await encryptPayload({ plaintext: 'hi', uaPublic: uaPublicRaw, authSecret });
    const b = await encryptPayload({ plaintext: 'hi', uaPublic: uaPublicRaw, authSecret });
    expect(bytesToB64url(a)).not.toBe(bytesToB64url(b));
  });
});

describe('buildVapidHeaders (RFC 8292 ES256)', () => {
  async function makeVapidKeys() {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    return {
      publicKey: bytesToB64url(pubRaw),
      privateKey: bytesToB64url(b64ToBytes(jwk.d)),
      verifyKey: kp.publicKey,
      pubRaw,
    };
  }

  it('emits a well-formed vapid header whose JWT signature verifies', async () => {
    const keys = await makeVapidKeys();
    const { authorization } = await buildVapidHeaders({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      subject: 'mailto:support@focusbro.net',
    });

    const m = authorization.match(/^vapid t=([^,]+), k=(.+)$/);
    expect(m).toBeTruthy();
    const [, jwt, k] = m;
    expect(k).toBe(keys.publicKey);

    const [h64, p64, sig64] = jwt.split('.');
    const header = JSON.parse(DEC.decode(b64ToBytes(h64)));
    const claims = JSON.parse(DEC.decode(b64ToBytes(p64)));
    expect(header).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(claims.aud).toBe('https://fcm.googleapis.com');
    expect(claims.sub).toBe('mailto:support@focusbro.net');
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      keys.verifyKey,
      b64ToBytes(sig64),
      ENC.encode(`${h64}.${p64}`)
    );
    expect(ok).toBe(true);
  });

  it('derives aud from the endpoint host', async () => {
    const keys = await makeVapidKeys();
    const { authorization } = await buildVapidHeaders({
      endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/xyz',
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
    });
    const jwt = authorization.match(/t=([^,]+),/)[1];
    const claims = JSON.parse(DEC.decode(b64ToBytes(jwt.split('.')[1])));
    expect(claims.aud).toBe('https://updates.push.services.mozilla.com');
    expect(claims.sub).toBe('mailto:support@focusbro.net'); // default subject
  });
});

describe('vapidConfigured / sendWebPush guards', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports configuration from env', () => {
    expect(vapidConfigured({})).toBe(false);
    expect(vapidConfigured({ VAPID_PUBLIC_KEY: 'x' })).toBe(false);
    expect(vapidConfigured({ VAPID_PUBLIC_KEY: 'x', VAPID_PRIVATE_KEY: 'y' })).toBe(true);
  });

  it('refuses to send (no network) when VAPID is unconfigured', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = await sendWebPush({}, { endpoint: 'https://x', p256dh: 'a', auth: 'b' }, { body: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('vapid_not_configured');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('flags gone subscriptions on 410 so the caller can deactivate them', async () => {
    const { uaPublicRaw, authSecret } = await makeSubscriptionKeys();
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    const env = {
      VAPID_PUBLIC_KEY: bytesToB64url(pubRaw),
      VAPID_PRIVATE_KEY: bytesToB64url(b64ToBytes(jwk.d)),
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 410 })));
    const r = await sendWebPush(env, {
      endpoint: 'https://fcm.googleapis.com/fcm/send/gone',
      p256dh: bytesToB64url(uaPublicRaw),
      auth: bytesToB64url(authSecret),
    }, { body: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.gone).toBe(true);
  });
});
