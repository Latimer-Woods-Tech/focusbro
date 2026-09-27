// Measures the breathing pacer's swell with an AnalyserNode in headless
// Chromium — the same discipline as docs/AUDIO_SETUP.md's soundscape checks:
// never assume an envelope, sample it. Taps the page's own AudioContext by
// wrapping `destination`, starts one box round with sound on, and prints the
// output level every 250 ms with the phase the pacer is showing. The claim
// under test: the level RISES through an inhale, holds high, FALLS through
// an exhale, and holds low. Not a Playwright spec on purpose (it is a
// measurement, and it needs real time); run it with
//   node e2e/measure-swell.mjs
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';

const PORT = 4199;
const server = spawn(process.execPath, ['e2e/serve.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const proto = BaseAudioContext.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'destination');
    Object.defineProperty(proto, 'destination', {
      configurable: true,
      get() {
        if (!this.__tap) {
          const a = this.createAnalyser(); a.fftSize = 2048; a.connect(desc.get.call(this));
          this.__tap = a; (window.__taps = window.__taps || []).push(this);
        }
        return this.__tap;
      },
    });
  });
  await page.goto(`http://localhost:${PORT}/guides/box-breathing.html`, { waitUntil: 'domcontentloaded' });
  await page.selectOption('#pacerRounds', '1');
  await page.check('#pacerSound');
  await page.click('#pacerStart');
  const samples = await page.evaluate(() => new Promise((resolve) => {
    const out = []; const t0 = performance.now();
    const iv = setInterval(() => {
      const ctx = (window.__taps || [])[0];
      if (!ctx) return;
      const a = ctx.__tap; const buf = new Float32Array(a.fftSize); a.getFloatTimeDomainData(buf);
      let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
      const rms = Math.sqrt(s / buf.length);
      out.push({ t: +((performance.now() - t0) / 1000).toFixed(2), db: +(20 * Math.log10(rms + 1e-9)).toFixed(1), phase: document.getElementById('pacerPhase').textContent, state: ctx.state });
      if (performance.now() - t0 > 17800) { clearInterval(iv); resolve(out); }
    }, 250);
  }));
  const byPhase = {};
  for (const s of samples) (byPhase[s.phase] = byPhase[s.phase] || []).push(s);
  console.log('t(s)   dB     phase');
  for (const s of samples) console.log(String(s.t).padEnd(6), String(s.db).padStart(6), ' ', s.phase, s.state !== 'running' ? `(${s.state})` : '');
  const seg = (name, i) => (Object.entries(byPhase).filter(([k]) => k === name)[i] || [null, []])[1];
  const inhale = byPhase.Inhale || [], exhale = byPhase.Exhale || [];
  const holds = samples.filter((s) => s.phase === 'Hold');
  const holdFull = holds.filter((s) => s.t < 8.5), holdEmpty = holds.filter((s) => s.t >= 12);
  const mean = (a) => a.length ? a.reduce((x, y) => x + y.db, 0) / a.length : NaN;
  const rise = inhale.length > 2 ? inhale[inhale.length - 1].db - inhale[1].db : NaN;
  const fall = exhale.length > 2 ? exhale[0].db - exhale[exhale.length - 1].db : NaN;
  console.log('\nInhale rise (last − first sample):', rise.toFixed(1), 'dB');
  console.log('Hold-full mean:', mean(holdFull).toFixed(1), 'dB  · Hold-empty mean:', mean(holdEmpty).toFixed(1), 'dB');
  console.log('Exhale fall (first − last sample):', fall.toFixed(1), 'dB');
  console.log('Done phase seen:', samples.some((s) => s.phase === 'Done'), '· page errors:', errors.length ? errors : 'none');
  const ok = rise > 6 && fall > 6 && mean(holdFull) - mean(holdEmpty) > 8 && errors.length === 0;
  console.log(ok ? '\nPASS — the swell follows the breath' : '\nFAIL — the swell does not follow the breath');
  void seg;
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
  server.kill();
}
