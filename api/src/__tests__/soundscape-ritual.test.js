/**
 * FocusBro — the soundscape ritual, Media Session, telemetry and arming gates.
 *
 * Before this, the timer and the sounds did not know each other existed:
 * startPomodoro() never touched a sound, pomoComplete() rang the bell and left
 * the mix running straight through the break, nothing worked from a locked
 * phone, and no event anywhere recorded which textures a person focused under.
 *
 * These are static gates on the served app (the same string the Worker sends).
 * The behavioural half — a real timer cycle in a real browser — lives in
 * e2e/smoke.spec.js. Every case below FAILS on the tree before this change.
 */

import { describe, it, expect } from 'vitest';
import servedHtml from '../html.js';

function fnBody(name) {
  const m = servedHtml.match(new RegExp(`function ${name}\\s*\\([^)]*\\)\\s*\\{`));
  if (!m) return null;
  // walk braces from the opening one
  let depth = 0, i = m.index + m[0].length - 1;
  for (; i < servedHtml.length; i++) {
    const c = servedHtml[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return servedHtml.slice(m.index, i + 1);
}

describe('the ritual — sound follows the focus block', () => {
  it('a focus block starting brings back the mix the bell stopped', () => {
    const body = fnBody('startPomodoro');
    expect(body, 'startPomodoro missing').toBeTruthy();
    expect(body).toContain('soundscapeOnFocusStart()');
    // …but only for a WORK block. A break starting must never start a sound.
    expect(body).toMatch(/if \(pomoState\.phase === 'work'\) soundscapeOnFocusStart\(\)/);
  });

  it('the bell fades the mix out and remembers it', () => {
    const body = fnBody('pomoComplete');
    expect(body).toContain('soundscapeOnBreak()');
    // Order matters: the session record must carry the mix, so the snapshot
    // is taken BEFORE the fade.
    const snap = body.indexOf('soundscapeSnapshot()');
    const fade = body.indexOf('soundscapeOnBreak()');
    expect(snap).toBeGreaterThan(-1);
    expect(snap).toBeLessThan(fade);
  });

  it('an abandoned block does not chase the person into the next one', () => {
    expect(fnBody('resetPomodoro')).toContain('soundscapeOnAbandon()');
    // and an explicit Stop all ends the ritual
    expect(fnBody('stopAllSounds')).toContain('soundscapeFollowTimer(false)');
  });

  it('never autoplays: resumption is gated on the bell having stopped it', () => {
    const body = fnBody('soundscapeOnFocusStart');
    expect(body).toContain("localStorage.getItem(SOUND_FOLLOW_KEY) === '1'");
    expect(body).toMatch(/if \(!follow\) return;/);
    // and only the bell sets that flag
    expect(fnBody('soundscapeOnBreak')).toContain('soundscapeFollowTimer(true)');
    expect(fnBody('soundscapeOnAbandon')).toContain('soundscapeFollowTimer(false)');
  });
});

describe('telemetry — which textures a person keeps their word under', () => {
  it('session_complete carries the soundscape snapshot', () => {
    expect(fnBody('recordSessionComplete')).toMatch(/function recordSessionComplete\(tool, durationSeconds, extra\)/);
    expect(fnBody('pomoComplete')).toContain("recordSessionComplete('pomodoro', POMO_WORK, soundscapeSnapshot())");
    const snap = fnBody('soundscapeSnapshot');
    expect(snap).toContain('sounds: Object.keys(activeSounds)');
    expect(snap).toContain('preset: activePresetKey');
  });

  it('sound events flow through the same signed-in spine as sessions', () => {
    const body = fnBody('recordSoundEvent');
    expect(body).toContain('if (!fbAuthenticated) return;');
    expect(body).toContain('fbTelemetryWrite(queue)');
    expect(body).toContain('fbFlushTelemetry()');
    for (const reason of ["'bell'", "'focus'", "'reset'", "'preset'", "'user'"]) {
      expect(servedHtml, `no sound event with reason ${reason}`).toMatch(new RegExp(`recordSoundEvent\\('sound_(start|stop)', ${reason}`));
    }
  });
});

describe('a phone — Media Session, background, lock screen', () => {
  it('routes the master bus through a media element with a direct fallback', () => {
    const body = fnBody('routeOutput');
    expect(body).toContain('createMediaStreamDestination');
    expect(body).toContain("getElementById('soundscapeOut')");
    expect(body).toContain('el.srcObject = dest.stream');
    // refusal must fall back to the destination, and must disconnect the
    // stream route first so the sound is never doubled
    expect(body).toContain('limiter.disconnect(dest)');
    expect(body).toContain('limiter.connect(ctx.destination)');
    expect(servedHtml).toContain('<audio id="soundscapeOut" playsinline');
  });

  it('installs pause / play / stop handlers and reports state', () => {
    const body = fnBody('installMediaSession');
    for (const a of ['pause', 'play', 'stop']) expect(body).toContain(`set('${a}'`);
    expect(fnBody('updateMediaSession')).toContain('new MediaMetadata(');
    expect(fnBody('updateMediaSession')).toContain("navigator.mediaSession.playbackState = userPaused ? 'paused' : 'playing'");
  });

  it('pause keeps the mix; resume brings it back without a rebuild', () => {
    expect(fnBody('pauseSoundscape')).toContain('.suspend()');
    expect(fnBody('resumeSoundscape')).toContain('.resume()');
    // a pause must not tear the graph down
    expect(fnBody('pauseSoundscape')).not.toContain('stopSound');
  });

  it('resumes a suspended context when the page becomes visible again', () => {
    const i = servedHtml.indexOf("if (document.visibilityState !== 'visible') return;");
    expect(i).toBeGreaterThan(-1);
    const block = servedHtml.slice(i, i + 500);
    expect(block).toContain("audioCtx.state === 'suspended'");
    expect(block).toContain('audioCtx.resume()');
    // …but honours an explicit pause
    expect(block).toContain('userPaused');
  });
});

describe('focus mode on a phone — dimmed is not disabled', () => {
  it('never sets pointer-events: none on the cards it dims', () => {
    // Found by the ritual smoke test on a Pixel 5 profile: session focus mode
    // dimmed every non-timer card AND set pointer-events: none, handing control
    // back only on :hover. A phone has no hover, so for the whole focus block
    // every card below — including "Stop all" — could not be tapped.
    const i = servedHtml.indexOf('POMODORO SESSION FOCUS MODE');
    expect(i).toBeGreaterThan(-1);
    // Judge the RULES, not the prose: the comment explaining this bug names
    // the very property the gate forbids. Strip comments before asserting.
    // The marker sits INSIDE the block's opening comment, so slice from that
    // comment's `/*` or the stripper never sees an opener.
    const from = servedHtml.lastIndexOf('/*', i);
    const block = servedHtml
      .slice(from, servedHtml.indexOf('TOOL TILES', i))
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(block).not.toContain('pointer-events: none');
    expect(block).not.toContain('pointer-events: auto');
    // keyboard users get the same courtesy as a mouse
    expect(block).toContain(':focus-within');
  });

  it('keeps the sounds card fully live during a session, like the wake lock', () => {
    expect(servedHtml).toContain('<div class="card" id="soundsCard">');
    const i = servedHtml.indexOf('POMODORO SESSION FOCUS MODE');
    const block = servedHtml.slice(i, servedHtml.indexOf('TOOL TILES', i));
    expect(block).toContain(':not(#soundsCard)');
    expect(block).toContain(':not(#keepAwakeCard)');
  });
});

describe('deep-links arm a mix — they never autoplay', () => {
  it('reads preset= and sound= alongside tool=', () => {
    expect(servedHtml).toContain("preset = q.get('preset'); sound = q.get('sound');");
    expect(servedHtml).toContain("if (!id && (preset || sound)) id = 'sounds';");
    expect(servedHtml).toContain('armSoundscape(preset, sound)');
  });

  it('arming validates against the real palette and only exposes one tap', () => {
    const body = fnBody('armSoundscape');
    expect(body).toContain('SOUND_PRESETS[key]');
    expect(body).toContain('SOUND_BUILDERS[n]');
    expect(body).toContain('btn.hidden = false');
    // nothing in arm may start audio
    expect(body).not.toContain('startSound(');
    expect(body).not.toContain('playPreset(');
  });
});
