// Tiny static server for the smoke test: serves the built api/src/html.js (the
// exact string the Worker serves) so Playwright can exercise the CLIENT-side app
// without the Worker/D1 backend. Backend calls (/api/*) 404 and the app
// is expected to degrade gracefully — the smoke only asserts client behavior.
import http from 'node:http';
import fs from 'node:fs';
import pathMod from 'node:path';
import { fileURLToPath } from 'node:url';
import htmlContent from '../src/html.js';
import { renderMePage } from '../src/me.js';
import { guides, renderGuidePage } from '../src/guides/index.js';
import { GUIDE_VIEW_SCRIPT, CAFFEINE_SCRIPT, BREATH_SCRIPT } from '../src/guides/scripts.js';
import { NATIVE_BRIDGE_SCRIPT } from '../src/native-bridge.js';
import { renderFollowThroughPage, SAMPLE_FIGURES } from '../src/guides/follow-through.js';

const port = Number(process.env.PORT) || 4173;

// /audio/*: the real built files when they are on disk (audio/dist, after
// scripts/audio/build.py — what e2e/measure-sounds.mjs listens to), otherwise a
// small generated WAV with the requested name. The files live in R2, not git, so
// CI has only the fixture; decodeAudioData sniffs the bytes, not the extension.
const AUDIO_DIST = pathMod.resolve(pathMod.dirname(fileURLToPath(import.meta.url)), '..', '..', 'audio', 'dist');
let fixtureWav = null;
function audioFixture() {
  if (fixtureWav) return fixtureWav;
  const rate = 22050, seconds = 4, ch = 2, n = rate * seconds;
  const data = Buffer.alloc(n * ch * 2);
  let seed = 12345, b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const w = seed / 2 ** 31 - 1;
      b0 = 0.997 * b0 + w * 0.029591; b1 = 0.985 * b1 + w * 0.032534; b2 = 0.95 * b2 + w * 0.048056;
      const v = Math.max(-1, Math.min(1, (b0 + b1 + b2 + w * 0.05) * 1.2));
      data.writeInt16LE(Math.round(v * 32767 * 0.5), (i * ch + c) * 2);
    }
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(ch, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * ch * 2, 28); h.writeUInt16LE(ch * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fixtureWav = Buffer.concat([h, data]);
  return fixtureWav;
}
const receivedViews = [];

http
  .createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlContent);
    } else if (path === '/me/' || path === '/me') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(renderMePage());
    } else if (path === '/guides/view.js' || path === '/guides/caffeine.js' || path === '/guides/breath.js') {
      // The same bytes the Worker serves (guides/scripts.js) — a guide-page
      // smoke exercises real first-party scripts, not a stub.
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(path.endsWith('caffeine.js') ? CAFFEINE_SCRIPT : path.endsWith('breath.js') ? BREATH_SCRIPT : GUIDE_VIEW_SCRIPT);
    } else if (path === '/native-bridge.js') {
      // The same bytes the Worker serves; in a browser it returns on line one.
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(NATIVE_BRIDGE_SCRIPT);
    } else if (path === '/follow-through-index.html') {
      // No D1 here: the page renders its "unavailable" state, or the published
      // sample when the smoke asks for it (?fixture=published) — the same
      // renderer production uses, fed known figures.
      const fixture = (req.url || '').includes('fixture=published');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderFollowThroughPage(fixture ? SAMPLE_FIGURES : { available: false, generated_at: new Date().toISOString() }));
    } else if (/^\/guides\/[a-z0-9-]+\.html$/.test(path)) {
      const slug = path.slice('/guides/'.length, -'.html'.length);
      const guide = guides.find((g) => g.slug === slug);
      if (!guide) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderGuidePage(guide));
    } else if (path === '/api/content/view' && req.method === 'POST') {
      // Record what arrived so a smoke can assert on it. sendBeacon() bypasses
      // Playwright's request observation in Chromium, so the SERVER is the only
      // honest witness that a beacon was sent. In-memory, test-only.
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        try { receivedViews.push(JSON.parse(raw)); } catch { receivedViews.push({ raw }); }
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    } else if (/^\/audio\/[a-z0-9-]+\.[0-9a-f]{10}\.m4a$/.test(path)) {
      const name = path.slice('/audio/'.length);
      const file = pathMod.join(AUDIO_DIST, name);
      const real = fs.existsSync(file);
      const body = real ? fs.readFileSync(file) : audioFixture();
      res.writeHead(200, { 'Content-Type': real ? 'audio/mp4' : 'audio/wav', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
      res.end(body);
    } else if (path === '/__smoke/views') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(receivedViews));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  })
  .listen(port, () => console.log(`smoke server on http://localhost:${port}`));
