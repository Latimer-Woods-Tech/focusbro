/**
 * The Play listing kit (mobile/store) — every local rule must be able to FAIL.
 *
 * push-listing.mjs --dry-run is the gate between this repo and a public Play
 * listing. A gate that never rejects is presumed broken, so each rule here is
 * shown rejecting a bad input, and the real kit is shown passing. The CLI case
 * runs the actual script against a copy of the kit with a 31-character title.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  checkListing, checkKit, checkImage, checkDataSafetyCsv, loadKit, pngSize, LISTING_LIMITS, DATA_SAFETY_HEADER,
} from '../../../mobile/store/lib/kit.mjs';
import { buildDataSafetyCsv } from '../../../mobile/store/build-data-safety.mjs';

const STORE = resolve(__dirname, '../../../mobile/store');
const PUSH = join(STORE, 'push-listing.mjs');
const good = () => ({
  title: 'FocusBro: Focus & Check-Ins',
  shortDescription: 'Give one thing and a time. I check in right then.',
  fullDescription: 'Tell me one thing and a time. I will check in right then.',
  releaseNotes: { '0.1.0': 'The first Android build.' },
});

/** A minimal PNG: signature + IHDR with the given size (enough for pngSize). */
function fakePng(width, height, colorType = 2) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12);
  b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
  b[24] = 8; b[25] = colorType;
  return b;
}

describe('the real kit', () => {
  it('passes every local rule', () => {
    expect(checkKit(loadKit(STORE))).toEqual([]);
  });

  it('data-safety.csv is exactly what build-data-safety.mjs produces', () => {
    const built = buildDataSafetyCsv(readFileSync(join(STORE, 'data-safety.template.csv'), 'utf8'));
    expect(readFileSync(join(STORE, 'data-safety.csv'), 'utf8')).toBe(built);
  });
});

describe('listing copy rules reject', () => {
  it('a title one character over the limit', () => {
    const l = { ...good(), title: 'x'.repeat(LISTING_LIMITS.title + 1) };
    expect(checkListing(l)).toContain(`title: ${LISTING_LIMITS.title + 1} characters, limit ${LISTING_LIMITS.title}`);
  });
  it('a short description over 80 and a full description over 4000', () => {
    const errs = checkListing({ ...good(), shortDescription: 'y'.repeat(81), fullDescription: 'z '.repeat(2001) });
    expect(errs.some((e) => e.startsWith('shortDescription: 81 characters'))).toBe(true);
    expect(errs.some((e) => e.startsWith('fullDescription: 4002 characters'))).toBe(true);
  });
  it('counts characters, not UTF-16 units (an emoji is one character)', () => {
    expect(checkListing({ ...good(), title: '🧠'.repeat(30) })).toEqual([]);
  });
  it('a price or a way to buy (Play billing: the app sells nothing)', () => {
    expect(checkListing({ ...good(), fullDescription: 'Unlock more for $9.99.' }).join()).toMatch(/price/);
    expect(checkListing({ ...good(), fullDescription: 'Upgrade on the website.' }).join()).toMatch(/how to buy/);
  });
  it('"AI", shame and treatment claims (the FocusBro design law)', () => {
    expect(checkListing({ ...good(), fullDescription: 'An AI coach.' }).join()).toMatch(/ai-branding/);
    expect(checkListing({ ...good(), fullDescription: 'Stop failing your goals.' }).join()).toMatch(/shame/);
    expect(checkListing({ ...good(), fullDescription: 'A treatment for focus.' }).join()).toMatch(/treatment/);
  });
  it('but allows ADHD for search', () => {
    expect(checkListing({ ...good(), shortDescription: 'Built for ADHD brains.' })).toEqual([]);
  });
  it('promo terms in the title', () => {
    expect(checkListing({ ...good(), title: 'FocusBro ADHD' }).join()).toMatch(/title: Play metadata policy/);
  });
  it('over-long release notes', () => {
    expect(checkListing({ ...good(), releaseNotes: { '0.1.0': 'n'.repeat(501) } }).join()).toMatch(/releaseNotes\[0.1.0\]: 501/);
  });
});

describe('image rules reject', () => {
  let dir;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'fb-kit-')); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name, buf) => { const f = join(dir, name); writeFileSync(f, buf); return f; };

  it('reads PNG dimensions', () => {
    expect(pngSize(fakePng(1080, 1920))).toMatchObject({ width: 1080, height: 1920 });
  });
  it('a phone screenshot at desktop width (wrong ratio) and one under 1080 wide', () => {
    expect(checkImage(write('a.png', fakePng(1920, 1080)), 'phoneScreenshots')).toHaveLength(1);
    expect(checkImage(write('b.png', fakePng(360, 640)), 'phoneScreenshots')).toHaveLength(1);
    expect(checkImage(write('c.png', fakePng(1080, 1920)), 'phoneScreenshots')).toEqual([]);
  });
  it('a feature graphic that is not 1024×500, or has alpha', () => {
    expect(checkImage(write('d.png', fakePng(1024, 512)), 'featureGraphic')).toHaveLength(1);
    expect(checkImage(write('e.png', fakePng(1024, 500, 6)), 'featureGraphic').join()).toMatch(/alpha/);
  });
  it('an icon that is not 512×512, and a file that is not a PNG', () => {
    expect(checkImage(write('f.png', fakePng(1024, 1024)), 'icon')).toHaveLength(1);
    expect(checkImage(write('g.png', Buffer.from('nope')), 'icon').join()).toMatch(/not a PNG/);
  });
});

describe('data-safety rules reject', () => {
  it('a trimmed header row (Play: 400 Invalid header row)', () => {
    const csv = readFileSync(join(STORE, 'data-safety.csv'), 'utf8').replace(DATA_SAFETY_HEADER, 'Question ID,Response ID,Response value,Answer requirement');
    expect(checkDataSafetyCsv(csv).join()).toMatch(/header/);
  });
  it('a missing account-creation block (Play: Response missing)', () => {
    const csv = readFileSync(join(STORE, 'data-safety.csv'), 'utf8')
      .split('\n').filter((l) => !l.startsWith('PSL_SUPPORTED_ACCOUNT_CREATION_METHODS')).join('\n');
    expect(checkDataSafetyCsv(csv).join()).toMatch(/ACCOUNT_CREATION_METHODS/);
  });
});

describe('push-listing.mjs --dry-run (the CLI)', () => {
  let copy;
  beforeAll(() => {
    copy = mkdtempSync(join(tmpdir(), 'fb-store-'));
    cpSync(STORE, copy, { recursive: true });
  });
  afterAll(() => rmSync(copy, { recursive: true, force: true }));
  const run = () => spawnSync(process.execPath, [PUSH, '--dry-run', '--store', copy], { encoding: 'utf8' });

  it('passes on the real kit', () => {
    const r = run();
    expect(r.stdout).toContain('every local rule passes');
    expect(r.status).toBe(0);
  });

  it('exits non-zero on a 31-character title, and names it', () => {
    writeFileSync(join(copy, 'listing/en-US/title.txt'), 'FocusBro: Focus and Check-Ins!!\n');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('title: 31 characters, limit 30');
  });
});
