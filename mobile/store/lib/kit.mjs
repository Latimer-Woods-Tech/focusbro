/**
 * mobile/store/lib/kit.mjs — the Play listing kit's local rules, in one place.
 *
 * Pure functions (no network, no Play API) used by:
 *   - push-listing.mjs --dry-run   (refuses to push anything that breaks a rule)
 *   - make-assets.mjs              (checks every image it writes)
 *   - api/src/__tests__/play-listing-kit.test.js (proves each rule can FAIL)
 *
 * Limits are Google Play's published ones (Play Console Help → "Add preview
 * assets" and "Create and set up your app"), cross-checked against
 * Factory docs/runbooks/play-store-operations.md §2.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { scanDesignLaw } from '../../../api/src/design-law.js';

/** Listing text limits (characters, as Play counts them — Unicode code points). */
export const LISTING_LIMITS = Object.freeze({
  title: 30,
  shortDescription: 80,
  fullDescription: 4000,
  releaseNotes: 500,
});

const MB = 1024 * 1024;

/**
 * Image rules per Play imageType. `check(w, h)` answers "will Play accept this
 * size", `maxBytes` the file-size ceiling.
 */
export const IMAGE_SPECS = Object.freeze({
  icon: { maxBytes: 1 * MB, check: (w, h) => w === 512 && h === 512, rule: 'exactly 512×512' },
  featureGraphic: { maxBytes: 15 * MB, check: (w, h) => w === 1024 && h === 500, rule: 'exactly 1024×500', noAlpha: true },
  phoneScreenshots: {
    maxBytes: 8 * MB,
    // 320..3840 px per side, long side ≤ 2× short side. We additionally hold the
    // kit to 9:16 at ≥1080 wide — the size the runbook records Play accepting
    // without a ratio warning, and the floor for promotional placement.
    check: (w, h) => w >= 1080 && h >= 1080 && w <= 3840 && h <= 3840
      && Math.max(w, h) <= 2 * Math.min(w, h) && w * 16 === h * 9,
    rule: '9:16, ≥1080 px wide, each side 320–3840, long ≤ 2× short',
    min: 2,
    max: 8,
  },
});

/** Words the listing must never carry (Play policy + FocusBro copy law). */
const LISTING_BANNED = Object.freeze([
  { re: /\$\s?\d|\bUSD\b|\d+(\.\d+)?\s?(dollars|bucks)\b/i, why: 'a price (the app sells nothing; Play billing policy)' },
  { re: /\b(buy|purchase|upgrade|subscribe|subscription|checkout|pay(ment)?)\b/i, why: 'how to buy (Play billing policy — Pro is website-only)' },
  { re: /\bpro\b/i, why: 'naming the paid tier (the listing describes only what the app itself does)' },
  { re: /\b(best|#1|number one|ultimate|revolutionary|world.?class|amazing|game.?changer|life.?changing|powerful)\b/i, why: 'a superlative / marketing fluff' },
  { re: /\b(clinically|proven|doctor|therapist|medical|heal(s|ing)?\b|prescri)/i, why: 'a medical claim' },
]);

/** Count characters the way Play does (code points, not UTF-16 units). */
export const charCount = (s) => Array.from(String(s)).length;

/**
 * Check listing copy. Returns a list of human-readable violations (empty = ok).
 * @param {{title?: string, shortDescription?: string, fullDescription?: string, releaseNotes?: Record<string,string>}} listing
 */
export function checkListing(listing) {
  const errors = [];
  const fields = [
    ['title', listing.title, LISTING_LIMITS.title],
    ['shortDescription', listing.shortDescription, LISTING_LIMITS.shortDescription],
    ['fullDescription', listing.fullDescription, LISTING_LIMITS.fullDescription],
  ];
  for (const [name, notes] of Object.entries(listing.releaseNotes || {})) {
    fields.push([`releaseNotes[${name}]`, notes, LISTING_LIMITS.releaseNotes]);
  }
  for (const [name, value, limit] of fields) {
    if (typeof value !== 'string' || !value.trim()) { errors.push(`${name}: empty`); continue; }
    const n = charCount(value);
    if (n > limit) errors.push(`${name}: ${n} characters, limit ${limit}`);
    // ADHD may appear for search (SEO surface); shame / treatment / "AI" may not.
    for (const v of scanDesignLaw(value, { allowAdhd: true })) {
      errors.push(`${name}: design-law ${v.kind} (${v.pattern})`);
    }
    for (const { re, why } of LISTING_BANNED) {
      const m = value.match(re);
      if (m) errors.push(`${name}: "${m[0]}" — ${why}`);
    }
  }
  if (typeof listing.title === 'string' && /\b(ADHD|free|no ads)\b/i.test(listing.title)) {
    errors.push('title: Play metadata policy forbids keywords / promo terms in the title');
  }
  return errors;
}

/** Read width/height/colour type from a PNG's IHDR (throws on non-PNG). */
export function pngSize(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 26 || !sig.every((b, i) => buf[i] === b)) throw new Error('not a PNG');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20), colorType: buf[25] };
}

/**
 * Check one image file against its Play imageType.
 * @returns {string[]} violations
 */
export function checkImage(file, imageType) {
  const spec = IMAGE_SPECS[imageType];
  if (!spec) return [`${file}: unknown imageType ${imageType}`];
  const buf = readFileSync(file);
  let size;
  try { size = pngSize(buf); } catch (e) { return [`${file}: ${e.message}`]; }
  const errors = [];
  if (!spec.check(size.width, size.height)) errors.push(`${file}: ${size.width}×${size.height}, needs ${spec.rule}`);
  if (buf.length > spec.maxBytes) errors.push(`${file}: ${buf.length} bytes, limit ${spec.maxBytes}`);
  // Play wants a 24-bit PNG (no alpha) for the feature graphic.
  if (spec.noAlpha && (size.colorType === 4 || size.colorType === 6)) errors.push(`${file}: has an alpha channel; Play wants 24-bit`);
  return errors;
}

/** The header Play's "Import from CSV" insists on (runbook §3 — line 1 must name all five). */
export const DATA_SAFETY_HEADER = 'Question ID (machine readable),Response ID (machine readable),Response value,Answer requirement,Human-friendly question label';

/**
 * Structural check of the data-safety CSV (the body of applications.dataSafety).
 * It cannot prove Play will accept it — only Play's validator can — but it
 * catches the failures that have actually happened in the estate.
 */
export function checkDataSafetyCsv(text) {
  const errors = [];
  const lines = String(text).replace(/\r\n/g, '\n').split('\n').filter((l) => l.length);
  if (lines[0] !== DATA_SAFETY_HEADER) errors.push('data-safety: line 1 is not the five-column header (Play returns 400 Invalid header row)');
  const answered = new Map();
  lines.slice(1).forEach((line, i) => {
    const cols = line.split(',');
    if (cols.length < 4) { errors.push(`data-safety line ${i + 2}: fewer than 4 columns`); return; }
    const [q, r, v] = cols;
    if (!/^[A-Z_:]+$/.test(q)) errors.push(`data-safety line ${i + 2}: odd question id ${q}`);
    if (v && v !== 'TRUE' && v !== 'FALSE' && !/^https:\/\//.test(v)) errors.push(`data-safety line ${i + 2}: value must be TRUE, FALSE, blank or an https URL`);
    if (v) answered.set(`${q}|${r}`, v);
  });
  const must = [
    'PSL_DATA_COLLECTION_COLLECTS_PERSONAL_DATA|',
    'PSL_DATA_COLLECTION_ENCRYPTED_IN_TRANSIT|',
    'PSL_SUPPORT_DATA_DELETION_BY_USER|DATA_DELETION_YES',
  ];
  for (const key of must) if (!answered.has(key)) errors.push(`data-safety: no answer for ${key.replace('|', ' ')}`);
  if (![...answered.keys()].some((k) => k.startsWith('PSL_SUPPORTED_ACCOUNT_CREATION_METHODS|'))) {
    errors.push('data-safety: PSL_SUPPORTED_ACCOUNT_CREATION_METHODS unanswered (Play: "Response missing")');
  }
  return errors;
}

/**
 * Load the whole kit from disk (mobile/store) into the shape push-listing uses.
 * @param {string} storeDir
 */
export function loadKit(storeDir, lang = 'en-US') {
  const L = join(storeDir, 'listing', lang);
  const read = (f) => (existsSync(join(L, f)) ? readFileSync(join(L, f), 'utf8').replace(/\n+$/, '') : '');
  const notesDir = join(L, 'release-notes');
  const releaseNotes = {};
  if (existsSync(notesDir)) {
    for (const f of readdirSync(notesDir).filter((n) => n.endsWith('.txt')).sort()) {
      releaseNotes[f.replace(/\.txt$/, '')] = readFileSync(join(notesDir, f), 'utf8').replace(/\n+$/, '');
    }
  }
  const phoneDir = join(storeDir, 'graphics', 'phone');
  const phone = existsSync(phoneDir)
    ? readdirSync(phoneDir).filter((f) => f.endsWith('.png')).sort().map((f) => join(phoneDir, f)) : [];
  return {
    lang,
    listing: {
      title: read('title.txt'),
      shortDescription: read('short_description.txt'),
      fullDescription: read('full_description.txt'),
      releaseNotes,
    },
    images: {
      icon: [join(storeDir, 'icon-512.png')],
      featureGraphic: [join(storeDir, 'graphics', 'feature-graphic.png')],
      phoneScreenshots: phone,
    },
    dataSafetyCsv: join(storeDir, 'data-safety.csv'),
  };
}

/** Every local rule over a loaded kit. Returns violations (empty = pushable). */
export function checkKit(kit) {
  const errors = [...checkListing(kit.listing)];
  for (const [type, files] of Object.entries(kit.images)) {
    const spec = IMAGE_SPECS[type];
    if (spec.min && files.length < spec.min) errors.push(`${type}: ${files.length} images, Play needs at least ${spec.min}`);
    if (spec.max && files.length > spec.max) errors.push(`${type}: ${files.length} images, Play allows at most ${spec.max}`);
    for (const f of files) {
      if (!existsSync(f) || !statSync(f).isFile()) { errors.push(`${type}: missing ${f}`); continue; }
      errors.push(...checkImage(f, type));
    }
  }
  if (!existsSync(kit.dataSafetyCsv)) errors.push('data-safety.csv missing');
  else errors.push(...checkDataSafetyCsv(readFileSync(kit.dataSafetyCsv, 'utf8')));
  return errors;
}
