// Tiny static server for the smoke test: serves the built api/src/html.js (the
// exact string the Worker serves) so Playwright can exercise the CLIENT-side app
// without the Worker/D1 backend. Backend calls (/api/*, /audio/*) 404 and the app
// is expected to degrade gracefully — the smoke only asserts client behavior.
import http from 'node:http';
import htmlContent from '../src/html.js';
import { renderMePage } from '../src/me.js';
import { guides, renderGuidePage } from '../src/guides/index.js';
import { GUIDE_VIEW_SCRIPT, CAFFEINE_SCRIPT, BREATH_SCRIPT } from '../src/guides/scripts.js';

const port = Number(process.env.PORT) || 4173;
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
    } else if (path === '/__smoke/views') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(receivedViews));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  })
  .listen(port, () => console.log(`smoke server on http://localhost:${port}`));
