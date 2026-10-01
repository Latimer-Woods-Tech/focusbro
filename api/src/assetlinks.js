/**
 * Digital Asset Links for the FocusBro Android app (net.focusbro.app).
 * Served at https://focusbro.net/.well-known/assetlinks.json so the app's
 * `autoVerify` App Link filter (mobile/android/app/src/main/AndroidManifest.xml,
 * /me and /me/*) verifies and those links open in the app.
 *
 * Fingerprints are the SHA-256 of the signing CERTIFICATES:
 *   - UPLOAD key: the keystore in GCP Secret Manager `focusbro-android-keystore-b64`
 *     (alias focusbro-upload). Signs every CI build — the APKs sideloaded or sent
 *     through Firebase App Distribution are signed with it.
 *   - PLAY APP SIGNING key: does not exist until the first AAB reaches Play.
 *     After that, read it by API — GET /androidpublisher/v3/applications/
 *     net.focusbro.app/generatedApks/{versionCode} → certificateSha256Hash — and
 *     append it here. Until then, Play-installed builds will not verify (they are
 *     re-signed by Google); sideloaded/App Distribution builds will.
 *
 * Never ship this list empty: `sha256_cert_fingerprints: []` verifies nothing and
 * fails silently (the link just opens the browser). A test pins that.
 */
export const ANDROID_PACKAGE = 'net.focusbro.app';

export const ANDROID_CERT_FINGERPRINTS = [
  // Upload key, generated 2026-10-01 (RSA 4096, valid to 2054).
  '74:D3:5D:4A:79:4D:4B:A9:20:2C:14:63:0E:8D:28:76:97:85:4A:03:80:D3:0D:37:F4:70:F2:0D:1C:37:A6:E5',
];

export const ASSET_LINKS = [
  {
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: ANDROID_PACKAGE,
      sha256_cert_fingerprints: ANDROID_CERT_FINGERPRINTS,
    },
  },
];

/** The /.well-known/assetlinks.json response. Must be 200, application/json, no redirect. */
export function assetLinksResponse() {
  return new Response(JSON.stringify(ASSET_LINKS), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
