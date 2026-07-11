// Tiny static server for the smoke test: serves the built api/src/html.js (the
// exact string the Worker serves) so Playwright can exercise the CLIENT-side app
// without the Worker/D1 backend. Backend calls (/api/*, /audio/*) 404 and the app
// is expected to degrade gracefully — the smoke only asserts client behavior.
import http from 'node:http';
import htmlContent from '../src/html.js';

const port = Number(process.env.PORT) || 4173;

http
  .createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlContent);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  })
  .listen(port, () => console.log(`smoke server on http://localhost:${port}`));
