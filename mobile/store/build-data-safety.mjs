#!/usr/bin/env node
/**
 * mobile/store/build-data-safety.mjs — writes data-safety.csv, the body of
 * Play's `applications.dataSafety` (and the console's "Import from CSV" file).
 *
 *   node mobile/store/build-data-safety.mjs          # write data-safety.csv
 *   node mobile/store/build-data-safety.mjs --check  # exit 1 if it is stale
 *
 * data-safety.template.csv is the question set Play ACCEPTED (204) for
 * com.selfprime.app on 2026-09-22, with every answer blanked. It carries the
 * account-creation block that Google's published sample omits (Factory
 * docs/runbooks/play-store-operations.md §3). Nothing in it is FocusBro's;
 * every FocusBro answer is in DECLARED below, with the code it was read from.
 *
 * Play's definitions that decide these answers:
 *  - "Collected" = sent off the device. Data that stays on the phone (the
 *    check-in alarms the app schedules, the med-time logger and notes in local
 *    storage) is not collected.
 *  - "Shared" = transferred to a third party. Transfers to a SERVICE PROVIDER
 *    processing on our behalf (Cloudflare hosting, Telnyx SMS, Resend email,
 *    Stripe checkout) are NOT sharing, so nothing here is declared shared.
 *  - "Optional" = the person can use the app without providing it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ACCOUNT_DELETE_URL = 'https://focusbro.net/account/delete';

/**
 * Each declared data type. `required` = the person cannot use the app without it
 * being collected; purposes are Play's response IDs without the PSL_ prefix.
 */
const DECLARED = {
  // Email: only when a guest claims an account (POST /auth/claim, /auth/register;
  // users.email). Used to sign in, and for verification / password-reset mail
  // sent through Resend (api/src/account-recovery.js). Guests never give one.
  PSL_EMAIL: { required: false, purposes: ['APP_FUNCTIONALITY', 'ACCOUNT_MANAGEMENT'] },
  // User IDs: every person, guest or claimed, gets a users.id and a session
  // (POST /auth/guest). It is how their words are theirs.
  PSL_USER_ACCOUNT: { required: true, purposes: ['APP_FUNCTIONALITY', 'ACCOUNT_MANAGEMENT'] },
  // Phone number: only when the person turns on text check-ins (POST /api/consent;
  // users.phone, contact_consent.phone). Sent to Telnyx to deliver the text.
  PSL_PHONE: { required: false, purposes: ['APP_FUNCTIONALITY'] },
  // Purchase history: whether this account bought Pro (pro_purchases, keyed to a
  // Stripe Checkout session). The purchase happens on the website, never in the
  // app, but the app reads the status (GET /api/pro/status). See UNSURE.
  PSL_PURCHASE_HISTORY: { required: false, purposes: ['APP_FUNCTIONALITY'] },
  // App interactions: focus sessions and the accountability loop's events —
  // word given / kept / moved / set down, check-in delivered
  // (analytics_events, focus_events; api/src/events.js). First-party only.
  PSL_USER_INTERACTION: { required: true, purposes: ['APP_FUNCTIONALITY', 'ANALYTICS'] },
  // User-generated content: the words themselves (commitments.title/details)
  // and the notes on kept words (commitment_checkins.note). The timer, sounds
  // and breathing work without giving a word, so this is optional.
  PSL_USER_GENERATED_CONTENT: { required: false, purposes: ['APP_FUNCTIONALITY'] },
  // Device or other IDs: focus sprints send a random client id (localStorage,
  // rotating, no account link) with each heartbeat while a timer runs
  // (POST /api/room/heartbeat; pruned after 10 minutes). See UNSURE.
  PSL_DEVICE_ID: { required: true, purposes: ['APP_FUNCTIONALITY'] },
};

/** Flat questions: [questionId, responseId, value]. */
const FLAT = [
  ['PSL_DATA_COLLECTION_COLLECTS_PERSONAL_DATA', '', 'TRUE'],
  ['PSL_DATA_COLLECTION_ENCRYPTED_IN_TRANSIT', '', 'TRUE'], // HTTPS only (HSTS); the shell allows no cleartext
  ['PSL_DATA_COLLECTION_USER_REQUEST_DELETE', '', 'TRUE'],
  ['PSL_SUPPORTED_ACCOUNT_CREATION_METHODS', 'PSL_ACM_USER_ID_PASSWORD', 'TRUE'], // email + password (claim / register)
  ['PSL_ACCOUNT_DELETION_URL', '', ACCOUNT_DELETE_URL],
  ['PSL_SUPPORT_DATA_DELETION_BY_USER', 'DATA_DELETION_YES', 'TRUE'],
  ['PSL_DATA_DELETION_URL', '', ACCOUNT_DELETE_URL],
  // PSL_HAS_OUTSIDE_APP_ACCOUNTS must be left blank: Play 400s "You cannot answer" it
  // when the app has no outside-app accounts (verified against the live API 2026-10-03).
  ['PSL_HAS_OUTSIDE_APP_ACCOUNTS', '', ''],
];

/** The data-type category each declared type is answered under. */
function categoryOf(templateRows, type) {
  const row = templateRows.find((r) => r[0].startsWith('PSL_DATA_TYPES_') && r[1] === type);
  if (!row) throw new Error(`template has no data type ${type}`);
  return row[0];
}

export function buildDataSafetyCsv(template) {
  const lines = template.replace(/\r\n/g, '\n').split('\n').filter((l) => l.length);
  const header = lines[0];
  const rows = lines.slice(1).map((l) => l.split(','));
  const answers = new Map();
  const set = (q, r, v) => answers.set(`${q}|${r}`, v);
  for (const [q, r, v] of FLAT) set(q, r, v);
  for (const [type, d] of Object.entries(DECLARED)) {
    set(categoryOf(rows, type), type, 'TRUE');
    const p = `PSL_DATA_USAGE_RESPONSES:${type}`;
    set(`${p}:PSL_DATA_USAGE_COLLECTION_AND_SHARING`, 'PSL_DATA_USAGE_ONLY_COLLECTED', 'TRUE');
    set(`${p}:PSL_DATA_USAGE_EPHEMERAL`, '', 'FALSE');
    set(`${p}:DATA_USAGE_USER_CONTROL`, d.required ? 'PSL_DATA_USAGE_USER_CONTROL_REQUIRED' : 'PSL_DATA_USAGE_USER_CONTROL_OPTIONAL', 'TRUE');
    for (const purpose of d.purposes) set(`${p}:DATA_USAGE_COLLECTION_PURPOSE`, `PSL_${purpose}`, 'TRUE');
  }
  const used = new Set();
  const out = rows.map((cols) => {
    const key = `${cols[0]}|${cols[1]}`;
    const c = [...cols];
    while (c.length < 5) c.push('');
    if (answers.has(key)) { c[2] = answers.get(key); used.add(key); } else c[2] = '';
    return c.join(',');
  });
  const missing = [...answers.keys()].filter((k) => !used.has(k));
  if (missing.length) throw new Error(`answers with no row in the template: ${missing.join(', ')}`);
  return [header, ...out].join('\n') + '\n';
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const csv = buildDataSafetyCsv(readFileSync(join(HERE, 'data-safety.template.csv'), 'utf8'));
  const target = join(HERE, 'data-safety.csv');
  if (process.argv.includes('--check')) {
    let current = '';
    try { current = readFileSync(target, 'utf8'); } catch { /* missing */ }
    if (current !== csv) { console.error('data-safety.csv is stale: run node mobile/store/build-data-safety.mjs'); process.exit(1); }
    console.log('data-safety.csv is current');
  } else {
    writeFileSync(target, csv);
    console.log(`wrote ${target} (${csv.split('\n').filter((l) => /,(TRUE|FALSE|https:[^,]*),/.test(l)).length} answered rows)`);
  }
}
