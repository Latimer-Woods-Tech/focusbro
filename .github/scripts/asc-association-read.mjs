// One-shot, READ-ONLY App Store Connect association read (jc-security GO #32421): does the bundle id
// net.focusbro.app exist, and under which seedId (Apple team prefix)? One GET, fixed host, no redirect, no retry.
// Prints only: HTTP status, matching identifier + seedId. Never the key, the JWT, the issuer, or the raw response.
import { createSign, createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const HOST = 'https://api.appstoreconnect.apple.com';
export const PATH = '/v1/bundleIds?filter%5Bidentifier%5D=net.focusbro.app';
export const WANT_SEED = '22W56AM87W';
const b64u = (b) => Buffer.from(b).toString('base64url');

/** An ES256 App Store Connect JWT that lives 5 minutes at most (Apple allows 20). */
export function makeJwt(pem, kid, iss, now = Math.floor(Date.now() / 1000)) {
  const head = b64u(JSON.stringify({ alg: 'ES256', kid, typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss, iat: now, exp: now + 300, aud: 'appstoreconnect-v1' }));
  const sig = createSign('SHA256').update(`${head}.${body}`).sign({ key: createPrivateKey(pem), dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64u(sig)}`;
}

/** Reduces a response to the sanitized receipt. ok is true only for HTTP 200 and exactly one row with the wanted seedId. */
export function summarize(status, text) {
  const lines = [`HTTP ${status}`];
  let rows = [];
  try {
    const j = JSON.parse(text);
    rows = Array.isArray(j.data) ? j.data : [];
  } catch {
    lines.push('body: not JSON');
  }
  const seen = rows.map((r) => ({ identifier: String(r?.attributes?.identifier ?? ''), seedId: String(r?.attributes?.seedId ?? '') }));
  for (const r of seen) lines.push(`row identifier=${r.identifier} seedId=${r.seedId}`);
  lines.push(`rows=${seen.length}`);
  const exact = seen.filter((r) => r.identifier === 'net.focusbro.app');
  const ok = status === 200 && seen.length === 1 && exact.length === 1 && exact[0].seedId === WANT_SEED;
  lines.push(ok ? `RESULT: match net.focusbro.app seedId=${WANT_SEED}` : 'RESULT: STOP for leader/founder (no single matching row with the expected seedId)');
  return { ok, lines };
}

async function main() {
  const { ASC_KEY_ID: kid, ASC_ISSUER_ID: iss, ASC_KEY_PATH: path } = process.env;
  if (!kid || !iss || !path) throw new Error('missing inputs');
  const jwt = makeJwt(readFileSync(path, 'utf8'), kid, iss);
  const res = await fetch(`${HOST}${PATH}`, { method: 'GET', redirect: 'manual', headers: { authorization: `Bearer ${jwt}`, accept: 'application/json' } });
  const out = summarize(res.status, await res.text());
  for (const l of out.lines) console.log(l);
  process.exit(out.ok ? 0 : 3);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.log('RESULT: request failed before a response (no retry; attempt spent)'); process.exit(4); });
}
