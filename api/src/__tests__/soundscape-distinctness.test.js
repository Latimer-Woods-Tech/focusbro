/**
 * FocusBro — soundscape palette tests.
 *
 * History: the first engine was six labels over THREE signals (rain, fireplace
 * and ocean were one brown-noise buffer at three filter cutoffs). The second
 * engine gave every sound its own synthesis — distinct, and still not rain, not a
 * café, not a fire; the founder's verdict was that other apps sound better. Every
 * place-sound is now a recording (audio/SOURCES.md), mastered and measured by
 * scripts/audio/ (audio/MEASUREMENTS.md). Only the three hushes stay synthesised.
 *
 * These gates are static, on the served HTML. sound-catalog.test.js ties the
 * catalog to the files, their provenance and their measurements.
 */

import { describe, it, expect } from 'vitest';
import servedHtml from '../html.js';

// Pull each builder body out of the SOUND_BUILDERS object literal.
function builderBodies() {
  const start = servedHtml.indexOf('const SOUND_BUILDERS = {');
  if (start === -1) return {};
  const end = servedHtml.indexOf('\n};', start);
  const bodies = {};
  const re = /\n {2}([a-z]+):\s*function \(\) \{/g;
  re.lastIndex = start;
  let m;
  const marks = [];
  while ((m = re.exec(servedHtml)) !== null && m.index < end) {
    marks.push({ name: m[1], from: m.index + m[0].length });
  }
  marks.forEach((mark, i) => {
    const to = i + 1 < marks.length ? marks[i + 1].from : end;
    bodies[mark.name] = servedHtml.slice(mark.from, to);
  });
  return bodies;
}

function soundFiles() {
  const m = servedHtml.match(/const SOUND_FILES = (\{.*?\});\n/);
  return m ? JSON.parse(m[1]) : {};
}

const SYNTH = builderBodies();
const FILES = soundFiles();
const UI_SOUNDS = [...servedHtml.matchAll(/data-sound="([a-z]+)"/g)].map((m) => m[1]);

describe('the soundscape palette', () => {
  it('offers a broad palette', () => {
    const catalog = new Set([...Object.keys(SYNTH), ...Object.keys(FILES)]);
    expect(catalog.size).toBeGreaterThanOrEqual(12);
    expect(new Set(UI_SOUNDS).size).toBeGreaterThanOrEqual(12);
  });

  it('has no dead buttons and no unreachable sounds', () => {
    for (const name of UI_SOUNDS) {
      expect(SYNTH[name] || FILES[name], `UI offers "${name}" but nothing plays it`).toBeTruthy();
    }
    for (const name of [...Object.keys(SYNTH), ...Object.keys(FILES)]) {
      expect(UI_SOUNDS, `"${name}" can be played but has no button`).toContain(name);
    }
    const presetBlock = servedHtml.slice(
      servedHtml.indexOf('const SOUND_PRESETS = {'),
      servedHtml.indexOf('// ── control ──')
    );
    const referenced = [...presetBlock.matchAll(/mix: \{([^}]*)\}/g)]
      .flatMap((m) => [...m[1].matchAll(/([a-z]+):/g)].map((x) => x[1]));
    expect(referenced.length).toBeGreaterThan(0);
    for (const name of referenced) {
      expect(SYNTH[name] || FILES[name], `preset references unknown sound "${name}"`).toBeTruthy();
    }
  });

  // Only the hushes are synthesised now — noise is noise. Everything that names
  // a PLACE must be a recording: a synthesised "rain" is the thing being replaced.
  it('synthesises only the hushes; every place is a recording', () => {
    expect(Object.keys(SYNTH).sort()).toEqual(['brown', 'pink', 'white']);
    for (const place of ['rain', 'ocean', 'forest', 'stream', 'night', 'wind', 'cafe', 'fire', 'keyboard', 'fan', 'train', 'drone', 'bowl']) {
      expect(FILES[place], `"${place}" has no recording`).toBeTruthy();
    }
  });

  // The old defect, generalised: two names over one signal. For recordings that
  // means two sounds pointing at the same file.
  it('no two sounds share a recording, and the hushes are not one synthesis', () => {
    const files = Object.values(FILES).map((f) => f.file);
    expect(new Set(files).size).toBe(files.length);
    // the hushes legitimately share a structure (noise colour -> lowpass); what
    // must differ is the colour itself, or two hushes are one sound
    const colours = Object.values(SYNTH).map((b) => (b.match(/noiseSource\('([a-z]+)'\)/) || [])[1]);
    expect(new Set(colours).size).toBe(3);
  });

  it('every loop plays inside its padding, never at the file edges', () => {
    for (const [name, f] of Object.entries(FILES)) {
      if (f.strikes) {
        expect(f.strikes.length, `${name} needs more than one strike`).toBeGreaterThan(1);
        continue;
      }
      expect(f.loopStart, `${name} loopStart`).toBeGreaterThan(0);
      expect(f.loopEnd - f.loopStart, `${name} loop is too short to hide its repeat`).toBeGreaterThanOrEqual(55);
    }
    expect(servedHtml).toContain('src.loopStart = meta.loopStart;');
    expect(servedHtml).toMatch(/src\.loopEnd = Math\.min\(meta\.loopEnd, buf\.duration\);/);
  });

  it('does not reach for the audio files that were never generated', () => {
    expect(servedHtml).not.toContain('/audio/${type}.mp3');
    expect(servedHtml).not.toContain('ambientAudioPlayers');
  });

  it('protects the listener when layers stack, and fades every layer', () => {
    expect(servedHtml).toContain('createDynamicsCompressor');
    expect(servedHtml).toMatch(/limiter\.ratio\.value\s*=\s*\d+/);
    expect(servedHtml).toContain('linearRampToValueAtTime');
    // a recording fades in when it arrives — it never starts at full level mid-waveform
    expect(servedHtml).toMatch(/bus\.gain\.value = 0;[\s\S]*bus\.gain\.linearRampToValueAtTime\(1, now \+ FADE\)/);
  });

  it('every source carries a level inside the normalised band', () => {
    const synthLevels = Object.values(SYNTH).map((b) => Number((b.match(/level:\s*([0-9.]+)/) || [])[1]));
    const recorded = Number((servedHtml.match(/const RECORDED_LEVEL = ([0-9.]+);/) || [])[1]);
    for (const lv of [...synthLevels, recorded]) {
      expect(lv, `level ${lv} is outside the normalised band`).toBeGreaterThan(0.2);
      expect(lv, `level ${lv} is outside the normalised band`).toBeLessThanOrEqual(3.0);
    }
  });

  it('keeps the deep-link and volume contract the guides depend on', () => {
    expect(servedHtml).toContain('id="soundVolume"');
    expect(servedHtml).toMatch(/function toggleSound\(name, btn\)/);
    expect(servedHtml).toMatch(/function updateVolume\(val\)/);
  });
});
