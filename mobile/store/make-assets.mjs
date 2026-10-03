#!/usr/bin/env node
/**
 * mobile/store/make-assets.mjs — the Play Store graphics, reproducibly.
 *
 *   node mobile/store/make-assets.mjs            # all graphics
 *   node mobile/store/make-assets.mjs --only feature
 *   node mobile/store/make-assets.mjs --only phone
 *
 * Needs: `npm ci` at the repo root (wrangler) and in api/ (Playwright + its
 * Chromium: `cd api && npx playwright install chromium`).
 *
 * WHY THE SCREENSHOTS ARE REAL, AND WHY THEY TOUCH NO PRODUCTION DATA
 * The Android app is a Capacitor webview of https://focusbro.net (remote-URL
 * mode), so a phone-viewport capture of the site with the app's user-agent
 * marker (`FocusBroApp/`) IS what the installed app renders — nothing is mocked
 * up. But /me/ and the weekly report need a person with words, and staging that
 * person in production would leave rows behind. So this script runs THIS
 * checkout's real Worker locally (`wrangler dev --local`) against a throwaway
 * D1 built from migrations/, creates a guest through the real API
 * (POST /auth/guest, POST /api/commitments, POST /api/commitments/:id/checkin),
 * back-dates a few kept words so the week has a shape, captures, then stops the
 * Worker and deletes the throwaway database. Production is never called — every
 * request is to localhost; anything else is aborted (see `context.route`).
 *
 * The one thing the local Worker lacks is the R2 sound files; /audio/* is
 * answered with a generated noise loop so the soundscape engine runs and the
 * page shows its real "playing" state. (It is a picture — nothing is heard.)
 *
 * Sizes (docs/runbooks/play-store-operations.md in Factory): phone 360×640 CSS
 * px @3× → 1080×1920 (9:16, accepted without a ratio warning); feature graphic
 * 1024×500. Every output's pixel size is checked before the script exits.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pngSize, IMAGE_SPECS } from './lib/kit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const GRAPHICS = join(HERE, 'graphics');
const PHONE_DIR = join(GRAPHICS, 'phone');
const requireFromApi = createRequire(join(REPO, 'api', 'package.json'));
const { chromium } = requireFromApi('@playwright/test');

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : 'all';
const PORT = Number(process.env.SHOTS_PORT) || 8799;
const ORIGIN = `http://localhost:${PORT}`;
// The exact UA shape a Capacitor Android webview sends, plus the marker the
// site keys on (capacitor.config.json → android.appendUserAgent).
const APP_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240905.003; wv) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36 FocusBroApp/0.1';
const TZ = 'America/New_York';

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// ── Feature graphic (1024×500) ──────────────────────────────────────────────
async function makeFeatureGraphic(browser) {
  const brain = readFileSync(join(REPO, 'mobile', 'assets', 'noto-brain.svg'), 'utf8')
    .replace(/<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '');
  const html = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@500;700&display=swap" rel="stylesheet">
<style>
  html,body{margin:0;width:1024px;height:500px;overflow:hidden}
  body{background:#0a0e27;font-family:'DM Sans',system-ui,sans-serif;color:#e8eefc;position:relative}
  .glow{position:absolute;inset:0;background:
    radial-gradient(520px 360px at 82% 50%, rgba(20,184,166,.28), transparent 70%),
    radial-gradient(420px 300px at 12% 10%, rgba(14,165,233,.22), transparent 70%)}
  .tile{position:absolute;right:96px;top:90px;width:320px;height:320px;border-radius:72px;
    background:linear-gradient(135deg,#0ea5e9,#14b8a6);box-shadow:0 30px 80px rgba(14,165,233,.35);
    display:flex;align-items:center;justify-content:center}
  .tile svg{width:220px;height:220px}
  .copy{position:absolute;left:84px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;width:520px}
  .name{font-size:76px;font-weight:700;letter-spacing:-1.5px;line-height:1}
  .name b{background:linear-gradient(135deg,#38bdf8,#14b8a6);-webkit-background-clip:text;color:transparent}
  .line{margin-top:22px;font-size:34px;font-weight:500;color:#b8c4e0;line-height:1.25}
</style></head><body><div class="glow"></div>
<div class="copy"><div class="name">Focus<b>Bro</b></div>
<div class="line">Give your word.<br>I’ll check in.</div></div>
<div class="tile">${brain}</div></body></html>`;
  const page = await browser.newPage({ viewport: { width: 1024, height: 500 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const out = join(GRAPHICS, 'feature-graphic.png');
  await page.screenshot({ path: out, omitBackground: false });
  await page.close();
  return out;
}

// ── A throwaway local Worker ────────────────────────────────────────────────
function run(cmd, cmdArgs, opts = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, cmdArgs, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => (code === 0 ? res(out) : rej(new Error(`${cmd} ${cmdArgs.join(' ')} → ${code}\n${out.slice(-2000)}`))));
  });
}

async function startLocalWorker(stateDir) {
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  // index.js has named exports (D1_SCHEMA_VERSION, …) that workerd rejects as
  // entrypoints under `wrangler dev`; a one-line shim re-exports only the handler.
  writeFileSync(join(stateDir, 'entry.mjs'), "import worker from '../../api/src/index.js';\nexport default worker;\n");
  await run('npx', ['wrangler', 'd1', 'migrations', 'apply', 'focusbro-db', '--local', '--persist-to', stateDir]);
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
  const dev = spawn('npx', ['wrangler', 'dev', join(stateDir, 'entry.mjs'), '--local', '--port', String(PORT),
    '--persist-to', stateDir, '--var', `JWT_SECRET:${secret}`, '--var', 'ENV:development',
    '--var', `API_ORIGIN:${ORIGIN}`, '--var', 'BUILD_SHA:store-shots'],
  { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  dev.stdout.on('data', (d) => { log += d; });
  dev.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${ORIGIN}/health`);
      if (r.ok) return dev;
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  try { process.kill(-dev.pid, 'SIGTERM'); } catch { /* already gone */ }
  throw new Error(`local Worker did not come up:\n${log.slice(-3000)}`);
}

async function d1(stateDir, sql) {
  return run('npx', ['wrangler', 'd1', 'execute', 'focusbro-db', '--local', '--persist-to', stateDir, '--command', sql]);
}

// A small stereo noise loop (same recipe as api/e2e/serve.mjs) for /audio/*.
function noiseWav() {
  const rate = 22050, seconds = 4, ch = 2, n = rate * seconds;
  const data = new Uint8Array(n * ch * 2);
  const dv = new DataView(data.buffer);
  let seed = 12345, b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i += 1) {
    for (let c = 0; c < ch; c += 1) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const w = seed / 2 ** 31 - 1;
      b0 = 0.997 * b0 + w * 0.029591; b1 = 0.985 * b1 + w * 0.032534; b2 = 0.95 * b2 + w * 0.048056;
      const v = Math.max(-1, Math.min(1, (b0 + b1 + b2 + w * 0.05) * 1.2));
      dv.setInt16((i * ch + c) * 2, Math.round(v * 32767 * 0.5), true);
    }
  }
  const h = new DataView(new ArrayBuffer(44));
  const str = (o, s) => { for (let i = 0; i < s.length; i += 1) h.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); h.setUint32(4, 36 + data.length, true); str(8, 'WAVE'); str(12, 'fmt ');
  h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, ch, true); h.setUint32(24, rate, true);
  h.setUint32(28, rate * ch * 2, true); h.setUint16(32, ch * 2, true); h.setUint16(34, 16, true);
  str(36, 'data'); h.setUint32(40, data.length, true);
  const out = new Uint8Array(44 + data.length);
  out.set(new Uint8Array(h.buffer), 0); out.set(data, 44);
  return out;
}

// ── The guest the screenshots show, created through the real API ────────────
async function seedGuest(page, stateDir) {
  const ids = await page.evaluate(async (tz) => {
    const post = async (path, body) => {
      const r = await fetch(path, { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`${path} → ${r.status} ${JSON.stringify(j)}`);
      return j;
    };
    await post('/auth/guest');
    const word = (title, when, extra = {}) => post('/api/commitments',
      { title, when_text: when, timezone: tz, persona: 'ally', channel: 'push', ...extra });
    // Words already kept this week (back-dated below).
    const kept = [];
    for (const t of ['Reply to that one email', 'Ten-minute tidy of the desk', 'Book the dentist',
      'Go for a short walk', 'Send the invoice', 'Start the laundry']) {
      const c = await word(t, 'in 10 min');
      kept.push((c.commitment || c).id);
    }
    return kept;
  }, TZ);
  // Keep the six words through the real check-in route (streak, events, notes)…
  const notes = ['Felt lighter right after.', '', 'Done before lunch.', 'Twenty minutes outside.', '', 'Two loads.'];
  await page.evaluate(async ({ ids: list, notes: ns }) => {
    for (let i = 0; i < list.length; i += 1) {
      const r = await fetch(`/api/commitments/${encodeURIComponent(list[i])}/checkin`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome: 'kept', note: ns[i] }) });
      if (!r.ok) throw new Error(`checkin ${list[i]} → ${r.status} ${await r.text()}`);
    }
  }, { ids, notes });
  // …then spread them over the past six days so the week has a shape. The
  // Worker holds the database open; D1 local tolerates a second writer.
  const cases = ids.map((id, i) => `WHEN '${id}' THEN datetime('now', '-${5 - i} days', '-2 hours')`).join(' ');
  await d1(stateDir, `UPDATE commitment_checkins SET responded_at = CASE commitment_id ${cases} END,
    scheduled_for = CASE commitment_id ${cases} END WHERE commitment_id IN (${ids.map((id) => `'${id}'`).join(',')});
    UPDATE commitments SET created_at = datetime('now','-6 days'),
      start_at = CASE id ${ids.map((id, i) => `WHEN '${id}' THEN strftime('%Y-%m-%dT%H:%M:00.000Z', 'now', '-${5 - i} days', '-2 hours')`).join(' ')} END
      WHERE id IN (${ids.map((id) => `'${id}'`).join(',')});`);
  // The words on the go right now — created after the back-dating, through the API.
  await page.evaluate(async (tz) => {
    const word = async (title, when, extra = {}) => {
      const r = await fetch('/api/commitments', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, when_text: when, timezone: tz, persona: 'ally', channel: 'push', ...extra }) });
      if (!r.ok) throw new Error(`commitment → ${r.status} ${await r.text()}`);
    };
    await word('Start the taxes — just open the folder', 'in 30 min');
    await word('Ten-minute tidy', 'today 6pm', { recurrence: 'daily', local_time: '18:00' });
    await word('Call Mom back', 'tomorrow 9am');
    const list = await (await fetch('/api/commitments', { credentials: 'same-origin' })).json();
    const active = (list.commitments || []).filter((c) => c.status === 'active').length;
    if (active !== 3) throw new Error(`expected 3 active words after seeding, saw ${active}`);
  }, TZ);
}

// Close anything that is not the subject of the shot (first-run tips, toasts).
async function tidy(page) {
  await page.evaluate(() => {
    for (const sel of ['.toast', '#toast', '[role="dialog"][open]', '.onboarding-overlay', '.cmd-palette.open']) {
      document.querySelectorAll(sel).forEach((el) => { el.style.display = 'none'; });
    }
  });
}

async function makePhoneScreenshots(browser) {
  const stateDir = join(REPO, '.wrangler', 'store-shots');
  const dev = await startLocalWorker(stateDir);
  const shots = [];
  try {
    const context = await browser.newContext({
      viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
      colorScheme: 'dark', reducedMotion: 'no-preference', userAgent: APP_UA, timezoneId: TZ, locale: 'en-US',
    });
    const wav = noiseWav();
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === ORIGIN && url.pathname.startsWith('/audio/')) {
        return route.fulfill({ status: 200, contentType: 'audio/wav', body: Buffer.from(wav) });
      }
      // Fonts are read-only GETs; everything else that is not this local Worker is refused,
      // so a capture can never write to production.
      if (url.origin === ORIGIN) return route.continue();
      if (route.request().method() === 'GET' && /(^|\.)(fonts\.googleapis|fonts\.gstatic)\.com$/.test(url.hostname)) return route.continue();
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error(`  page error: ${e.message}`));
    const shot = async (name) => {
      await tidy(page);
      await page.waitForTimeout(500);
      const file = join(PHONE_DIR, name);
      await page.screenshot({ path: file, fullPage: false });
      shots.push(file);
      console.log(`  ${name}`);
    };

    // 1 — the door: give your word.
    await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    const hero = page.getByPlaceholder('What are you avoiding?');
    if (await hero.count()) await hero.first().fill('start the taxes');
    await shot('01-give-your-word.png');

    // /me/ and the report need a person with words: seed one through the API.
    await page.goto(`${ORIGIN}/me/`, { waitUntil: 'load' });
    await seedGuest(page, stateDir);

    // 2 — /me/: the words on the go, each with its next check-in.
    const listed = page.waitForResponse((r) => r.url() === `${ORIGIN}/api/commitments` && r.request().method() === 'GET');
    await page.goto(`${ORIGIN}/me/`, { waitUntil: 'load' });
    await listed;
    await page.waitForTimeout(1500);
    // /me/ swallows a render error and shows an empty list (focusbro#380) — refuse to
    // capture that instead of publishing a blank screen.
    if (!(await page.locator('#list [data-id]').count())) throw new Error('/me/ rendered no words (see focusbro#380)');
    await page.evaluate(() => {
      const el = document.getElementById('list');
      window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 24);
    });
    await shot('02-your-words.png');

    // 3 — /me/: the kept words, day by day (wins only, never a tally of the rest).
    await page.evaluate(() => {
      const el = document.getElementById('momentumCard') || document.getElementById('list');
      window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 24);
    });
    await shot('03-momentum.png');

    // 4 — the focus timer running with the soundscape following it.
    await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
    await page.evaluate(() => { window.setView && window.setView('focus'); });
    await page.waitForTimeout(500);
    await page.evaluate(() => { window.playPreset && window.playPreset('rainycafe', document.querySelector('[onclick*="rainycafe"]')); });
    await page.locator('#pomoStartBtn').click();
    await page.waitForTimeout(4200);
    await page.locator('#pomoCard').scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, -70));
    await shot('04-focus-timer.png');

    // 5 — the sounds: presets and the layers they are made of.
    await page.evaluate(() => { window.setView && window.setView('rest'); });
    await page.waitForTimeout(600);
    await page.locator('#soundsCard').scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      const el = document.getElementById('soundsCard');
      window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 64);
    });
    await shot('05-sounds.png');

    // 6 — the weekly report.
    await page.goto(`${ORIGIN}/me/report`, { waitUntil: 'load' });
    await page.waitForTimeout(1200);
    await shot('06-weekly-report.png');

    // 7 — breathing pacer.
    await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
    await page.waitForTimeout(800);
    await page.evaluate(() => { window.openBreathingGuide(); });
    await page.waitForTimeout(2500); // mid-inhale, so the circle is part-way out
    if (!(await page.locator('#breathingModal.show').isVisible())) throw new Error('breathing pacer did not open');
    await shot('07-breathing.png');

    await context.close();
  } finally {
    try { process.kill(-dev.pid, 'SIGTERM'); } catch { /* already gone */ }
    await sleep(1500);
    rmSync(stateDir, { recursive: true, force: true });
  }
  return shots;
}

// ── main ────────────────────────────────────────────────────────────────────
mkdirSync(PHONE_DIR, { recursive: true });
const browser = await chromium.launch();
const made = [];
try {
  if (only === 'all' || only === 'feature') made.push(await makeFeatureGraphic(browser));
  if (only === 'all' || only === 'phone') made.push(...await makePhoneScreenshots(browser));
} finally {
  await browser.close();
}

const icon = join(HERE, 'icon-512.png');
if (existsSync(icon)) made.push(icon);
let bad = 0;
for (const file of made) {
  const { width, height } = pngSize(readFileSync(file));
  const spec = file.endsWith('feature-graphic.png') ? IMAGE_SPECS.featureGraphic
    : file.endsWith('icon-512.png') ? IMAGE_SPECS.icon : IMAGE_SPECS.phoneScreenshots;
  const ok = spec.check(width, height);
  if (!ok) bad += 1;
  console.log(`${ok ? 'ok ' : 'BAD'} ${width}×${height}  ${file.slice(REPO.length + 1)}`);
}
if (bad) { console.error(`${bad} image(s) violate Play's size rules`); process.exit(1); }
