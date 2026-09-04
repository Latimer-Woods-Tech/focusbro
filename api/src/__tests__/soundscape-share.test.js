/**
 * FocusBro — shareable sound mixes.
 *
 * A mix someone built is worth passing on: "this is what I work under". The
 * link is the same `?sound=` / `?preset=` deep-link the guides already use,
 * now carrying each layer's level, and it ARMS on arrival like every sound
 * link — one tap, never autoplay. These run the real functions extracted from
 * the served app (the same string the Worker sends), with the app's own
 * palette and presets stubbed at the boundary. Every case FAILS on the tree
 * before this change.
 */

import { describe, it, expect } from 'vitest';
import servedHtml from '../html.js';

function fnBody(name) {
  const m = servedHtml.match(new RegExp(`function ${name}\\s*\\([^)]*\\)\\s*\\{`));
  if (!m) return null;
  let depth = 0, i = m.index + m[0].length - 1;
  for (; i < servedHtml.length; i++) {
    const c = servedHtml[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return servedHtml.slice(m.index, i + 1);
}

const PALETTE = { rain: 1, cafe: 1, wind: 1, brown: 1, ocean: 1, drone: 1 };
const PRESETS = { winddown: { mix: { ocean: 0.9, drone: 0.3 } } };

const parseMixParam = new Function('SOUND_BUILDERS', `${fnBody('parseMixParam')}; return parseMixParam;`)(PALETTE);
const shareMixUrlWith = (activeSounds, activePresetKey) =>
  new Function('activeSounds', 'activePresetKey', 'SOUND_PRESETS', `const SHARE_ORIGIN = 'https://focusbro.net'; ${fnBody('shareMixUrl')}; return shareMixUrl();`)(activeSounds, activePresetKey, PRESETS);

describe('parseMixParam — the link format', () => {
  it('reads layers with optional levels, and drops what the palette does not have', () => {
    expect(parseMixParam('rain:0.7,cafe:0.5,wind')).toEqual({ rain: 0.7, cafe: 0.5, wind: 1 });
    expect(parseMixParam('rain, CAFE ,notasound')).toEqual({ rain: 1, cafe: 1 });
    expect(parseMixParam('')).toEqual({});
    expect(parseMixParam(null)).toEqual({});
    expect(parseMixParam('notasound:0.5')).toEqual({});
  });

  it('never guesses a level: bad numbers fall back to 1, and levels are clamped to 0.05–1', () => {
    expect(parseMixParam('rain:abc')).toEqual({ rain: 1 });
    expect(parseMixParam('rain:-3')).toEqual({ rain: 1 });
    expect(parseMixParam('rain:0')).toEqual({ rain: 1 });
    expect(parseMixParam('rain:Infinity')).toEqual({ rain: 1 });
    expect(parseMixParam('rain:9')).toEqual({ rain: 1 });
    expect(parseMixParam('rain:0.001')).toEqual({ rain: 0.05 });
    expect(parseMixParam('rain:0.333333')).toEqual({ rain: 0.33 });
  });
});

describe('shareMixUrl — what gets shared', () => {
  it('shares a preset as the preset, and anything else as layers with levels, sorted, omitting 1', () => {
    expect(shareMixUrlWith({}, null)).toBeNull();
    expect(shareMixUrlWith({ ocean: { mix: 0.9 }, drone: { mix: 0.3 } }, 'winddown')).toBe('https://focusbro.net/?tool=sounds&preset=winddown');
    expect(shareMixUrlWith({ wind: { mix: 1 }, rain: { mix: 0.7 }, cafe: { mix: 0.5 } }, null)).toBe('https://focusbro.net/?tool=sounds&sound=cafe:0.5,rain:0.7,wind');
    // a preset key the app no longer knows is not trusted
    expect(shareMixUrlWith({ rain: { mix: 1 } }, 'gone')).toBe('https://focusbro.net/?tool=sounds&sound=rain');
  });

  it('round-trips: what is shared is what arrives', () => {
    const mix = { cafe: { mix: 0.5 }, rain: { mix: 0.7 }, wind: { mix: 1 } };
    const url = new URL(shareMixUrlWith(mix, null));
    expect(url.searchParams.get('tool')).toBe('sounds');
    const back = parseMixParam(url.searchParams.get('sound'));
    expect(back).toEqual({ cafe: 0.5, rain: 0.7, wind: 1 });
  });

  it('always uses the branded origin, never a workers.dev host', () => {
    expect(servedHtml).toContain("const SHARE_ORIGIN = 'https://focusbro.net';");
    expect(fnBody('shareMixUrl')).not.toMatch(/location\.(origin|host)/);
    expect(fnBody('shareMixUrl')).not.toContain('workers.dev');
  });
});

describe('the app wiring', () => {
  it('a link with levels arms exactly those levels (the old code forced every layer to 1)', () => {
    const body = fnBody('armSoundscape');
    expect(body).toContain('const mix = parseMixParam(soundList);');
    expect(body).not.toContain('mix[n] = 1');
  });

  it('the share button exists, starts disabled, and follows whether anything is playing', () => {
    expect(servedHtml).toMatch(/<button class="btn btn-sm sound-share" id="soundShare" onclick="shareMix\(\)" disabled/);
    expect(fnBody('paintSoundButton')).toContain("share.disabled = Object.keys(activeSounds).length === 0");
  });

  it('shares through the native sheet, then the clipboard, then by hand — and records it only on success', () => {
    const body = fnBody('shareMix');
    expect(body).toContain('navigator.share');
    expect(body).toContain('navigator.clipboard.writeText(url)');
    expect(body).toContain("'Copy this link: ' + url");
    expect(body).toContain("recordSoundEvent('sound_share', how)");
    // closing the share sheet is a choice, not a failure — no fallback, no event
    expect(body).toContain("e.name === 'AbortError'");
    // nothing leaves the page: no fetch, no beacon
    expect(body).not.toMatch(/fetch\(|sendBeacon/);
  });
});
