/**
 * FocusBro — soundscape distinctness tests.
 *
 * The founder's report was "they all sound the same", and it was literally
 * true. The old engine was one table:
 *
 *   rain:       { type: 'brown', filterFreq: 800  }
 *   fireplace:  { type: 'brown', filterFreq: 400  }
 *   ocean:      { type: 'brown', filterFreq: 600  }
 *   cafe:       { type: 'pink',  filterFreq: 2000 }
 *   forest:     { type: 'pink',  filterFreq: 1200 }
 *
 * — six labels over THREE signals, each a noise buffer through one lowpass at
 * a different cutoff. Rain, fireplace and ocean were the same sound. Nothing
 * in CI could see that, because nothing asserted the textures differed.
 *
 * These tests are the gate that was missing. Test 3 is the proof-of-rejection:
 * it FAILS on the old tree, because two sources that differ only in numbers
 * are the same source wearing two names.
 */

import { describe, it, expect } from 'vitest';
import servedHtml from '../html.js';

// Pull each builder body out of the SOUND_BUILDERS object literal.
function builderBodies() {
  const start = servedHtml.indexOf('const SOUND_BUILDERS = {');
  if (start === -1) return {};
  const bodies = {};
  const re = /\n  ([a-z]+):\s*function \(\) \{/g;
  re.lastIndex = start;
  let m;
  const marks = [];
  while ((m = re.exec(servedHtml)) !== null) {
    if (servedHtml.slice(start, m.index).includes('\n};')) break;
    marks.push({ name: m[1], from: m.index + m[0].length });
  }
  marks.forEach((mark, i) => {
    const to = i + 1 < marks.length ? marks[i + 1].from : servedHtml.indexOf('\n};', mark.from);
    bodies[mark.name] = servedHtml.slice(mark.from, to);
  });
  return bodies;
}

const BUILDERS = builderBodies();

// Every sound the UI offers.
const UI_SOUNDS = [...servedHtml.matchAll(/data-sound="([a-z]+)"/g)].map((m) => m[1]);

describe('the soundscape palette', () => {
  it('offers a broad palette, not a handful of filter settings', () => {
    expect(Object.keys(BUILDERS).length).toBeGreaterThanOrEqual(12);
    expect(new Set(UI_SOUNDS).size).toBeGreaterThanOrEqual(12);
  });

  it('has no dead buttons and no unreachable builders', () => {
    for (const name of UI_SOUNDS) {
      expect(BUILDERS[name], `UI offers "${name}" but no builder exists`).toBeTruthy();
    }
    // Every preset must reference sounds that actually exist.
    const presetBlock = servedHtml.slice(
      servedHtml.indexOf('const SOUND_PRESETS = {'),
      servedHtml.indexOf('// ── control ──')
    );
    const referenced = [...presetBlock.matchAll(/mix: \{([^}]*)\}/g)]
      .flatMap((m) => [...m[1].matchAll(/([a-z]+):/g)].map((x) => x[1]));
    expect(referenced.length).toBeGreaterThan(0);
    for (const name of referenced) {
      expect(BUILDERS[name], `preset references unknown sound "${name}"`).toBeTruthy();
    }
  });

  // ── PROOF OF REJECTION ──────────────────────────────────────────────
  // Strip every number and every string literal. What remains is the SHAPE of
  // the synthesis. Two sounds that reduce to the same shape are the same
  // sound with different knob settings — which is exactly the defect that
  // shipped. On the old tree rain/fireplace/ocean collapse to one shape and
  // this fails; a real palette gives each texture its own structure.
  it('no two sources are the same synthesis with different numbers', () => {
    const shape = (body) =>
      body
        .replace(/-?\d+(\.\d+)?/g, 'N')
        .replace(/'[^']*'/g, 'S')
        .replace(/\s+/g, ' ')
        .trim();

    const byShape = new Map();
    for (const [name, body] of Object.entries(BUILDERS)) {
      const s = shape(body);
      if (!byShape.has(s)) byShape.set(s, []);
      byShape.get(s).push(name);
    }

    const collisions = [...byShape.values()].filter((names) => names.length > 1);
    expect(
      collisions,
      `these sources are structurally identical and will sound the same: ${collisions
        .map((c) => c.join('/'))
        .join(', ')}`
    ).toEqual([]);
  });

  it('every source that should have events actually schedules them', () => {
    // A bed alone is a hush. Rain needs droplets, fire needs crackle, forest
    // needs birds — the events are what make it that place rather than noise.
    for (const name of ['rain', 'fire', 'cafe', 'forest', 'stream', 'night', 'keyboard', 'train', 'bowl']) {
      expect(BUILDERS[name], `missing builder ${name}`).toBeTruthy();
      expect(BUILDERS[name], `"${name}" is a bare bed with no events`).toContain('addJob(');
    }
    // And the slow-moving textures must actually modulate.
    for (const name of ['ocean', 'fan', 'drone']) {
      expect(BUILDERS[name], `"${name}" never modulates`).toContain('lfo(');
    }
  });

  it('does not reach for the audio files that were never generated', () => {
    // public/audio/ is gone. It could never have worked: wrangler.toml carries
    // no static-asset binding and the router has no audio/ routes, so the files
    // the deploy step generated were never uploaded and 404'd in production.
    expect(servedHtml).not.toContain('/audio/${type}.mp3');
    expect(servedHtml).not.toContain('ambientAudioPlayers');
  });

  it('protects the listener when layers stack', () => {
    // Layering six beds must not clip or hurt: a brick-wall limiter on the
    // master bus, and no layer starts or stops with a click.
    expect(servedHtml).toContain('createDynamicsCompressor');
    expect(servedHtml).toMatch(/limiter\.ratio\.value\s*=\s*\d+/);
    expect(servedHtml).toContain('linearRampToValueAtTime');
  });

  it('every source carries a normalised level, so layers stay balanced', () => {
    // Measured on production 2026-09-04, the palette spanned 25.7 dB: switching
    // from Deep hush to Keys dropped ~26 dB, which reads as "it stopped
    // working" rather than "that one is quieter". Per-source `level` values are
    // derived from integrated-loudness measurement (see docs/AUDIO_SETUP.md);
    // the band below is a coarse guard against a new source landing far off.
    const levels = [...servedHtml.matchAll(/level:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
    expect(levels.length).toBeGreaterThanOrEqual(12);
    for (const lv of levels) {
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
