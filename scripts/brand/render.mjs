// Renders the FocusBro mark to the raster assets embedded in api/src/brand-assets.js.
//   npx -y -p playwright node scripts/brand/render.mjs <out-dir>
// then base64 the PNGs into PNG_B64. The geometry here must match GLYPH there.
import { chromium } from 'playwright';
const dir = process.argv[2] || '.';
const glyph = (stroke) => `<path d="M25 16.5A9 9 0 1 1 19.8 7.8" fill="none" stroke="${stroke}" stroke-width="2.6" stroke-linecap="round"/><path d="M11.4 15.6l3.9 3.9 8.6-9.3" fill="none" stroke="${stroke}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`;
// app icon: full-bleed amber (maskable-safe: glyph sits well inside the 80% circle)
const icon = (n) => `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 32 32"><rect width="32" height="32" fill="#f2b45a"/><g transform="translate(16 16) scale(0.78) translate(-16 -16)">${glyph('#1b1305')}</g></svg>`;
const og = `<!doctype html><html><head><link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@500;700&display=block" rel="stylesheet"><style>
html,body{margin:0;width:1200px;height:630px;background:#0d0f12;font-family:'DM Sans',sans-serif;color:#eceae6;overflow:hidden}
.wrap{position:absolute;inset:0;padding:84px 96px;box-sizing:border-box;display:flex;flex-direction:column;justify-content:space-between;
background:radial-gradient(90% 120% at 100% 0%,rgba(242,180,90,.16),transparent 55%)}
.brand{display:flex;align-items:center;gap:22px;font-size:40px;font-weight:700;letter-spacing:-.02em}
.brand span{color:#a4a19b;font-weight:500}
h1{font-size:92px;line-height:1.02;letter-spacing:-.035em;margin:0;font-weight:700;max-width:900px}
p{font-size:30px;color:#a4a19b;margin:0}
.rule{width:72px;height:4px;border-radius:2px;background:#f2b45a;margin-bottom:28px}
</style></head><body><div class="wrap">
<div class="brand"><svg width="64" height="64" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#f2b45a"/>${glyph('#1b1305')}</svg><div>Focus<span>Bro</span></div></div>
<div><div class="rule"></div><h1>The check-in that follows up.</h1></div>
<p>Give your word. Your bro shows up when it's time to start.</p>
</div></body></html>`;
const b = await chromium.launch();
for (const n of [192, 512]) {
  const p = await b.newPage({ viewport: { width: n, height: n } });
  await p.setContent(`<html><body style="margin:0">${icon(n)}</body></html>`);
  await p.screenshot({ path: `${dir}/icon-${n}.png`, omitBackground: true });
  await p.close();
}
const p = await b.newPage({ viewport: { width: 1200, height: 630 } });
await p.setContent(og, { waitUntil: 'networkidle' });
await p.evaluate(() => document.fonts.ready);
await p.screenshot({ path: `${dir}/og.png` });
await b.close();
