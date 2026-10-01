/**
 * FocusBro — the sound catalog, its files, their provenance and their measurements.
 *
 * The binaries live in R2, not git. What git holds is the chain that makes a
 * file shippable, and this test is the gate on that chain:
 *
 *   button in the app ─► SOUND_FILES (served HTML) ─► audio/manifest.json
 *        ─► a row in audio/SOURCES.md (where it came from, under what licence)
 *        ─► a PASS row in audio/MEASUREMENTS.md (seam, loudness, peaks, repetition,
 *           distinctness — measured, because nobody building this can listen)
 *
 * No file ships without a provenance row and a passing measurement. Every case
 * here fails on the tree before recordings existed: there was no SOUND_FILES,
 * no manifest, nothing to trace.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import servedHtml from '../html.js';
import { AUDIO_FILE_RE } from '../audio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

const HUSHES = ['brown', 'pink', 'white'];
const UI_SOUNDS = [...new Set([...servedHtml.matchAll(/data-sound="([a-z]+)"/g)].map((m) => m[1]))];

function servedFiles() {
  const m = servedHtml.match(/const SOUND_FILES = (\{.*?\});\n/);
  if (!m) throw new Error('served HTML has no SOUND_FILES manifest block');
  return JSON.parse(m[1]);
}

const manifest = exists('audio/manifest.json') ? JSON.parse(read('audio/manifest.json')) : { sounds: {} };
const recipe = exists('audio/recipe.json') ? JSON.parse(read('audio/recipe.json')) : { sources: {}, sounds: {} };
const sourcesMd = exists('audio/SOURCES.md') ? read('audio/SOURCES.md') : '';
const measurementsMd = exists('audio/MEASUREMENTS.md') ? read('audio/MEASUREMENTS.md') : '';

describe('every sound the app offers is a traced, measured file', () => {
  it('every non-hush button has a file in the served manifest', () => {
    const files = servedFiles();
    const recorded = UI_SOUNDS.filter((n) => !HUSHES.includes(n));
    expect(recorded.length).toBeGreaterThanOrEqual(12);
    for (const name of recorded) expect(files[name], `"${name}" has no file`).toBeTruthy();
  });

  it('the served manifest is exactly audio/manifest.json (build.py wrote both)', () => {
    const files = servedFiles();
    expect(Object.keys(files).sort()).toEqual(Object.keys(manifest.sounds).sort());
    for (const [name, e] of Object.entries(manifest.sounds)) {
      expect(files[name].file).toBe(e.file);
      expect(files[name].bytes).toBe(e.bytes);
      if (e.kind === 'loop') {
        expect(files[name].loopStart).toBe(e.loopStart);
        expect(files[name].loopEnd).toBe(e.loopEnd);
      } else {
        expect(files[name].strikes).toEqual(e.strikes);
      }
    }
  });

  it('file names are content-hashed and routable', () => {
    for (const [name, e] of Object.entries(manifest.sounds)) {
      expect(e.file, `${name}: not a routable name`).toMatch(AUDIO_FILE_RE);
      expect(e.file.startsWith(`${name}.`)).toBe(true);
      expect(e.file.split('.')[1]).toBe(e.sha256.slice(0, 10));
    }
  });

  it('every file has a provenance row naming its source, author and licence', () => {
    expect(sourcesMd).toContain('# Ambient audio — sources and provenance');
    for (const [name, e] of Object.entries(manifest.sounds)) {
      const row = sourcesMd.split('\n').find((l) => l.includes('`' + e.file + '`'));
      expect(row, `${e.file} has no row in audio/SOURCES.md`).toBeTruthy();
      expect(e.sources.length, `${name} names no source`).toBeGreaterThan(0);
      for (const key of e.sources) {
        const src = recipe.sources[key];
        expect(src, `${name}: source "${key}" is not in the recipe`).toBeTruthy();
        expect(src.author, `${key}: no author`).toBeTruthy();
        expect(src.license_url, `${key}: no licence URL`).toMatch(/^https?:\/\//);
        expect(row).toContain(src.license_url);
        if (src.kind === 'archive.org') {
          expect(src.md5).toMatch(/^[0-9a-f]{32}$/);
          expect(row).toContain(src.page);
        } else if (src.kind === 'elevenlabs') {
          expect(src.r2).toMatch(/^sources\/elevenlabs\//);
          expect(src.prompt.length).toBeGreaterThan(20);
          expect(row).toContain(src.r2);
        } else {
          expect(src.kind).toBe('synth');
        }
      }
    }
  });

  it('no source carries a licence we cannot ship', () => {
    // Non-commercial, personal-use-only, and libraries whose terms forbid
    // redistributing the sound as the product, are out.
    const banned = /\b(NC|non-?commercial|personal use|pixabay|bbc|remarc|sonniss|all rights reserved)\b/i;
    for (const [key, src] of Object.entries(recipe.sources)) {
      expect(`${src.license} ${src.license_url}`, `${key}`).not.toMatch(banned);
      expect(src.license_url).toMatch(/publicdomain\/(zero|mark)\/1\.0|elevenlabs\.io\/terms/);
    }
  });

  it('every file was measured and passed', () => {
    for (const [name, e] of Object.entries(manifest.sounds)) {
      const row = measurementsMd.split('\n').find((l) => l.startsWith(`| ${name} |`));
      expect(row, `${name} has no measurement row`).toBeTruthy();
      expect(row, `${name} did not pass measurement`).toMatch(/\| PASS \|$/);
      expect(row, `${name}: the measurement is of a different file than the one shipped`).toContain('`' + e.file + '`');
    }
    // and the measured target is the one the build used
    expect(manifest.target_lufs).toBe(recipe.target_lufs);
  });
});
