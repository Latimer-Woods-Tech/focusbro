// Measures the recorded soundscapes IN A BROWSER, through the app's own engine —
// the half of the audio checks that scripts/audio/measure.py (ffmpeg) cannot do.
// Not a Playwright spec on purpose: it needs the real files (audio/dist, built
// by scripts/audio/build.py; they live in R2, not git) and it takes real time.
//   node e2e/measure-sounds.mjs            (from api/)
//
// 1. Decode: Chromium's own decodeAudioData on every file. The loop must fit in
//    what the browser decoded, and the seam must be an ordinary sample step in
//    the BROWSER's PCM — this is where an AAC decoder that mishandles encoder
//    priming would show up as a click.
// 2. Engine sanity: each sound alone, through startSound() at the default volume,
//    an AnalyserNode on the master bus, unweighted power above 100 Hz over 8 s.
//    This is NOT the loudness reference — that is EBU R128 in
//    audio/MEASUREMENTS.md, where every file and every hush is -23 LUFS. Unweighted
//    power over a short random window reads dense low-frequency noise (the hushes)
//    several dB "louder" than LUFS does, and swings with a gust or a wave. It is
//    here to catch the engine applying a level wrongly: no layer may land more
//    than 10 dB from the median.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '..', '..', 'audio', 'dist');
const manifest = JSON.parse(fs.readFileSync(path.resolve(here, '..', '..', 'audio', 'manifest.json'), 'utf8'));
const missing = Object.values(manifest.sounds).filter((e) => !fs.existsSync(path.join(dist, e.file)));
if (missing.length) {
  console.error(`audio/dist is missing ${missing.map((e) => e.file).join(', ')} — run scripts/audio/build.py first`);
  process.exit(2);
}

const PORT = 4198;
const server = spawn(process.execPath, [path.join(here, 'serve.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 900));
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let failed = false;
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/?tool=sounds`, { waitUntil: 'domcontentloaded' });

  // ── 1. decode in the browser ────────────────────────────────────────────
  const decoded = await page.evaluate(async () => {
    const ctx = new OfflineAudioContext(2, 48000, 48000);
    const out = {};
    for (const [name, meta] of Object.entries(SOUND_FILES)) {
      const bytes = await (await fetch('/audio/' + meta.file)).arrayBuffer();
      const buf = await ctx.decodeAudioData(bytes);
      const r = { rate: buf.sampleRate, seconds: buf.duration };
      if (!meta.strikes) {
        const a = Math.round(meta.loopStart * buf.sampleRate);
        const b = Math.round(meta.loopEnd * buf.sampleRate);
        const ch = buf.getChannelData(0);
        let steps = [];
        for (let i = a + 1; i < b; i += 7) steps.push(Math.abs(ch[i] - ch[i - 1]));
        steps.sort((x, y) => x - y);
        const p999 = steps[Math.floor(steps.length * 0.999)];
        r.fits = b <= buf.length;
        r.seamStep = Math.abs(ch[a] - ch[b - 1]);
        r.p999 = p999;
        r.expected = meta.loopEnd + meta.loopStart;
      } else {
        const last = meta.strikes[meta.strikes.length - 1];
        r.fits = last.at + last.dur <= buf.duration + 0.05;
        r.expected = last.at + last.dur;
      }
      out[name] = r;
    }
    return out;
  });
  console.log('\nBrowser decode (Chromium decodeAudioData):');
  console.log('sound      decoded   expected  Δms   loop fits  seam step / p99.9');
  for (const [name, r] of Object.entries(decoded)) {
    const seam = r.seamStep == null ? '—' : `${r.seamStep.toFixed(4)} / ${r.p999.toFixed(4)} ${r.seamStep <= r.p999 ? 'ok' : 'CLICK'}`;
    console.log(`${name.padEnd(10)} ${r.seconds.toFixed(3).padStart(8)}  ${r.expected.toFixed(3).padStart(8)}  ${((r.seconds - r.expected) * 1000).toFixed(0).padStart(4)}  ${String(r.fits).padEnd(9)}  ${seam}`);
    if (!r.fits || (r.seamStep != null && r.seamStep > r.p999)) failed = true;
  }

  // ── 2. balance through the engine ──────────────────────────────────────
  const names = Object.keys(await page.evaluate(() => SOUND_BUILDERS));
  const levels = {};
  for (const name of names) {
    levels[name] = await page.evaluate(async (n) => {
      startSound(n);
      const built = activeSounds[n].built;
      if (built.ready) await built.ready;
      await new Promise((r) => setTimeout(r, n === 'bowl' ? 300 : 900));
      const ctx = getAudioCtx();
      const a = ctx.createAnalyser();
      a.fftSize = 4096;
      masterBus.connect(a);
      const bins = new Float32Array(a.frequencyBinCount);
      const lo = Math.ceil(100 / (ctx.sampleRate / a.fftSize));
      let acc = 0, frames = 0;
      await new Promise((resolve) => {
        const t = setInterval(() => {
          a.getFloatFrequencyData(bins);
          let p = 0;
          for (let i = lo; i < bins.length; i++) p += Math.pow(10, bins[i] / 10);
          acc += p; frames++;
        }, 50);
        setTimeout(() => { clearInterval(t); resolve(); }, n === 'bowl' ? 12000 : 8000);
      });
      masterBus.disconnect(a);
      stopSound(n);
      await new Promise((r) => setTimeout(r, 700));
      return 10 * Math.log10(acc / frames);
    }, name);
  }
  const vals = Object.values(levels);
  const median = vals.slice().sort((x, y) => x - y)[Math.floor(vals.length / 2)];
  console.log('\nEngine sanity (default volume, unweighted power above 100 Hz over 8 s, dB re median; loudness reference is LUFS in audio/MEASUREMENTS.md):');
  for (const [n, v] of Object.entries(levels).sort((x, y) => y[1] - x[1])) console.log(`${n.padEnd(10)} ${v.toFixed(1).padStart(7)}  ${(v - median >= 0 ? '+' : '') + (v - median).toFixed(1)}`);
  console.log(`spread ${(Math.max(...vals) - Math.min(...vals)).toFixed(1)} dB`);
  const hush = ['brown', 'pink', 'white'].map((n) => levels[n]);
  const rec = names.filter((n) => !['brown', 'pink', 'white', 'bowl'].includes(n)).map((n) => levels[n]).sort((x, y) => x - y);
  const recMedian = rec[Math.floor(rec.length / 2)];
  const hushMean = hush.reduce((s, v) => s + v, 0) / hush.length;
  console.log(`recordings median ${recMedian.toFixed(1)} dB, hushes mean ${hushMean.toFixed(1)} dB → difference ${(recMedian - hushMean).toFixed(1)} dB`);
  const off = Object.entries(levels).filter(([, v]) => Math.abs(v - median) > 10);
  if (off.length) { console.log('ENGINE LEVEL FAULT:', off.map(([n, v]) => `${n} ${(v - median).toFixed(1)} dB`).join(', ')); failed = true; }
  if (errors.length) { console.log('page errors:', errors); failed = true; }
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
