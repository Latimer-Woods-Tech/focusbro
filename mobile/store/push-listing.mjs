#!/usr/bin/env node
/**
 * mobile/store/push-listing.mjs — push the Play listing kit for net.focusbro.app.
 *
 *   node mobile/store/push-listing.mjs --dry-run
 *       Local checks only (lengths, copy law, image sizes, data-safety shape).
 *       No network. Exits 1 on any violation. Safe anywhere, any time.
 *
 *   node mobile/store/push-listing.mjs
 *       edits.insert → listings.update → images (replace each set) → edits.validate
 *       → edits.commit, then applications.dataSafety with data-safety.csv.
 *
 *   node mobile/store/push-listing.mjs --aab app-release.aab --track internal
 *       The same edit also uploads the bundle and puts it on the track with the
 *       release notes in listing/<lang>/release-notes/<versionName>.txt.
 *       `--status draft` is the default: Play refuses anything else while the
 *       app has never been published ("Only releases with status draft may be
 *       created on draft app"). Use `--status completed` once it has been.
 *
 * Also sets contact details (edits.details): support@focusbro.net, https://focusbro.net.
 *
 * Other flags: --package (default net.focusbro.app) · --lang (en-US) ·
 *   --skip-data-safety · --skip-images · --version-name 0.1.0 (release notes key).
 *
 * Auth (Factory docs/runbooks/play-store-operations.md §1): impersonate the
 * publisher SA with the androidpublisher scope — no key file. The caller needs
 * roles/iam.serviceAccountTokenCreator on it (the owner account has it).
 *   404 on edits.insert = the app does not exist in Play Console yet.
 *   403 = it exists but the SA was not granted on it (Users and permissions → Add app).
 *
 * The data-safety POST has no read-back: 204 means Play accepted and validated
 * the payload, nothing more. Only Play Console → App content → Data safety shows
 * the rendered state.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkKit, loadKit } from './lib/kit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SA = 'play-store-publisher@factory-495015.iam.gserviceaccount.com';
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const UPLOAD = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const PKG = opt('--package', 'net.focusbro.app');
const LANG = opt('--lang', 'en-US');
const STORE = opt('--store', HERE);

const kit = loadKit(STORE, LANG);
const problems = checkKit(kit);
const aab = opt('--aab', null);
const versionName = opt('--version-name', JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
if (aab && !kit.listing.releaseNotes[versionName]) problems.push(`release notes: listing/${LANG}/release-notes/${versionName}.txt is missing`);

console.log(`kit ${STORE} → ${PKG} (${LANG})`);
console.log(`  title             ${[...kit.listing.title].length}/30  ${kit.listing.title}`);
console.log(`  short description ${[...kit.listing.shortDescription].length}/80`);
console.log(`  full description  ${[...kit.listing.fullDescription].length}/4000`);
for (const [t, files] of Object.entries(kit.images)) console.log(`  ${t.padEnd(17)} ${files.map((f) => basename(f)).join(', ')}`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log('  ✓ every local rule passes');
if (flag('--dry-run')) process.exit(0);

// ── Live push ───────────────────────────────────────────────────────────────
const token = execFileSync('gcloud', ['auth', 'print-access-token', `--impersonate-service-account=${SA}`,
  '--scopes=https://www.googleapis.com/auth/androidpublisher'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
if (token.length < 100) throw new Error(`access token looks wrong (length ${token.length})`);

async function call(method, url, { json, body, contentType, ok = [200] } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(json ? { 'Content-Type': 'application/json' } : {}), ...(contentType ? { 'Content-Type': contentType } : {}) },
      body: json ? JSON.stringify(json) : body,
    });
  } catch (e) {
    throw new Error(`${method} ${url}: network error ${e.message}`);
  }
  const text = await res.text();
  if (!ok.includes(res.status)) {
    const hint = res.status === 404 && url.endsWith('/edits') ? ' — the app does not exist in Play Console yet'
      : res.status === 403 ? ` — ${SA} is not granted on ${PKG} (Console → Users and permissions → Add app)` : '';
    const err = new Error(`${method} ${url.replace(/\?.*/, '')} → ${res.status}${hint}\n${text.slice(0, 1500)}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

const edit = await call('POST', `${API}/${PKG}/edits`, { json: {} });
const E = `${API}/${PKG}/edits/${edit.id}`;
const EU = `${UPLOAD}/${PKG}/edits/${edit.id}`;
console.log(`edit ${edit.id}`);
try {
  await call('PUT', `${E}/listings/${LANG}`, { json: {
    language: LANG, title: kit.listing.title, shortDescription: kit.listing.shortDescription, fullDescription: kit.listing.fullDescription,
  } });
  console.log('  listing text');
  await call('PUT', `${E}/details`, { json: {
    defaultLanguage: LANG, contactEmail: 'support@focusbro.net', contactWebsite: 'https://focusbro.net',
  } });
  console.log('  contact details');
  if (!flag('--skip-images')) {
    for (const [type, files] of Object.entries(kit.images)) {
      await call('DELETE', `${E}/listings/${LANG}/${type}`, { ok: [200, 204] });
      for (const f of files) {
        await call('POST', `${EU}/listings/${LANG}/${type}?uploadType=media`, { body: readFileSync(f), contentType: 'image/png' });
      }
      console.log(`  ${type}: ${files.length}`);
    }
  }
  if (aab) {
    const track = opt('--track', 'internal');
    const status = opt('--status', 'draft');
    const bundle = await call('POST', `${EU}/bundles?uploadType=media`, { body: readFileSync(aab), contentType: 'application/octet-stream' });
    await call('PUT', `${E}/tracks/${track}`, { json: { track, releases: [{
      name: `${versionName} (${bundle.versionCode})`, versionCodes: [String(bundle.versionCode)], status,
      releaseNotes: [{ language: LANG, text: kit.listing.releaseNotes[versionName] }],
    }] } });
    console.log(`  bundle ${bundle.versionCode} → ${track} (${status})`);
  }
  await call('POST', `${E}:validate`, { json: {} });
  await call('POST', `${E}:commit`, { json: {} });
  console.log('  committed');
} catch (e) {
  await call('DELETE', E, { ok: [200, 204] }).catch(() => {});
  throw e;
}

if (!flag('--skip-data-safety')) {
  await call('POST', `${API}/${PKG}/dataSafety`, { json: { safetyLabels: readFileSync(kit.dataSafetyCsv, 'utf8') }, ok: [200, 204] });
  console.log('data safety: accepted (204). There is no read-back — confirm in Play Console → App content → Data safety.');
}
