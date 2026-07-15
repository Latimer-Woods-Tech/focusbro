// Shared page shell for the accountability surfaces (/me/, /me/report, /coach/).
//
// One skin for the whole product: the home timer app wears the dark-indigo
// "Professional Enterprise" palette (public/index.html :root tokens); before
// this module the moat pages rendered as unstyled white wireframes (Resonance
// Council, 2026-07-13, #76). This ports the SAME tokens onto the moat so the
// commodity and the accountability spine read as one visual family — one
// product, one skin. It changes only presentation: every existing class name,
// copy string, and bit of markup is preserved, so the copy-law battery and the
// page tests are untouched.
//
// Pure, dependency-free, Worker-safe (a plain template-string builder).

/**
 * The shared brand stylesheet + design tokens, themed to the home app.
 * Covers the union of class names used across /me/, /me/report, and /coach/,
 * so a single sheet skins all three. Unused selectors on a given page are inert.
 * @param {{ maxWidth?: number }} [opts]
 * @returns {string} a `<style>…</style>` block
 */
export function pageShellStyle({ maxWidth = 720 } = {}) {
  return `<style>
  :root {
    color-scheme: dark;
    --bg: #0a0e27; --bg-secondary: #0f1428; --bg-card: #141d3f; --bg-card-hover: #1a2652;
    --border: #2a3a6f; --border-light: #3d4f8a;
    --text: #e2e8f0; --text-muted: #94a3b8; --text-dim: #64748b;
    --primary: #0ea5e9; --primary-light: #38bdf8; --primary-dim: rgba(14,165,233,0.12);
    --success: #10b981; --success-dim: rgba(16,185,129,0.12); --success-light: #6ee7b7;
    --warn: #f59e0b; --warn-dim: rgba(245,158,11,0.12); --warn-light: #fcd34d;
    --danger-light: #fca5a5;
    --blue: #3b82f6; --blue-dim: rgba(59,130,246,0.12); --blue-light: #93c5fd;
    --teal: #14b8a6; --purple: #a78bfa;
    --radius: 12px; --shadow: 0 4px 20px rgba(0,0,0,0.30);
    --font: 'DM Sans', -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  }
  * { box-sizing: border-box; }
  body { font-family: var(--font); max-width: ${maxWidth}px; margin: 0 auto; padding: 24px; line-height: 1.55; color: var(--text); background: linear-gradient(to bottom, var(--bg), var(--bg-secondary)); min-height: 100vh; }
  a { color: var(--primary-light); }
  h1 { margin-bottom: 4px; color: var(--text); }
  h2 { font-size: 18px; margin: 0 0 8px; color: var(--text); }
  .pagenav { font-size: 14px; color: var(--text-muted); margin-bottom: 10px; }
  .pagenav a { color: var(--primary-light); }
  .intro { color: var(--text-muted); margin-top: 0; }
  .card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; margin: 12px 0; box-shadow: var(--shadow); }
  .muted { color: var(--text-dim); font-size: 13px; }
  .footnote { margin-top: 28px; font-size: 13px; color: var(--text-dim); border-top: 1px solid var(--border); padding-top: 14px; }
  .hidden { display: none; }
  .err { color: var(--danger-light); font-size: 14px; }
  .ok { color: var(--success-light); font-size: 14px; }
  label { display: block; font-size: 13px; color: var(--text-muted); margin: 10px 0 4px; }
  input, select, button, textarea { font-size: 15px; padding: 9px 12px; border-radius: 8px; border: 1px solid var(--border); font-family: inherit; }
  input, select, textarea { width: 100%; box-sizing: border-box; background: var(--bg-secondary); color: var(--text); }
  input::placeholder, textarea::placeholder { color: var(--text-dim); }
  button { background: linear-gradient(135deg, var(--primary), var(--teal)); color: #fff; border: none; cursor: pointer; font-weight: 600; }
  button.secondary { background: var(--bg-card-hover); color: var(--text-muted); border: 1px solid var(--border); }
  button.small { padding: 6px 12px; font-size: 14px; }
  form { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  .row > div { flex: 1 1 220px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
  /* streak + status */
  .streakwrap { display: flex; align-items: center; gap: 18px; }
  .streak { font-size: 44px; font-weight: 700; color: var(--primary-light); line-height: 1; }
  .streak small { display: block; font-size: 12px; font-weight: 500; color: var(--text-dim); margin-top: 4px; }
  .streakmsg { color: var(--text-muted); font-size: 15px; }
  .streakbest { margin-top: 14px; padding: 10px 14px; border-radius: 10px; font-size: 15px; font-weight: 600; color: var(--primary-light); background: var(--primary-dim); border: 1px solid rgba(14, 165, 233, 0.30); }
  .name { font-weight: 600; color: var(--text); }
  .line { color: var(--text-muted); font-size: 14px; }
  .when { color: var(--text-dim); font-size: 13px; }
  .when.next { margin-top: 2px; color: var(--text-muted); }
  /* An open-but-past check-in is warm, never an alarm — a gentle accent, no red. */
  .when.next.waiting { color: var(--warn-light); }
  .roster-next { color: var(--text-muted); font-size: 13px; margin-top: 4px; }
  .roster-next.waiting { color: var(--warn-light); }
  .roster-reach { margin-top: 6px; padding: 6px 10px; border-radius: 8px; font-size: 13px; color: var(--primary-light); background: var(--primary-dim); border: 1px solid rgba(14, 165, 233, 0.22); }
  .pending { opacity: .7; }
  /* pills */
  .pill { display: inline-block; font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px; }
  .pill.active { background: var(--primary-dim); color: var(--primary-light); }
  .pill.kept   { background: var(--success-dim); color: var(--success-light); }
  .pill.moved  { background: var(--blue-dim); color: var(--blue-light); }
  .pill.open   { background: var(--warn-dim); color: var(--warn-light); }
  /* rows + commitments */
  .commit { display: flex; justify-content: space-between; gap: 14px; align-items: flex-start; flex-wrap: wrap; }
  .client { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; align-items: center; }
  .keptrow { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--border); }
  .keptrow:last-child { border-bottom: none; }
  .keptrow .tick { color: var(--success-light); font-weight: 700; margin-right: 8px; }
  .editform { margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--border); }
  .editform label { margin-top: 6px; }
  .detail { margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--border); }
  .detail .streakmsg { margin: 6px 0; }
  /* first-run / re-entry */
  .firstrun { background: var(--primary-dim); border-color: var(--border-light); }
  .firstrun h2 { margin-bottom: 6px; }
  .seedrow { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
  .seed { background: var(--bg-card-hover); color: var(--primary-light); border: 1px solid var(--border); border-radius: 999px; padding: 6px 12px; font-size: 14px; cursor: pointer; }
  /* momentum sparkline */
  .momentum-intro, .momentum-self-intro { color: var(--text-dim); font-size: 13px; margin: 0 0 8px; }
  .momentum { margin-bottom: 10px; }
  .spark { display: flex; align-items: flex-end; gap: 3px; height: 44px; margin: 6px 0; }
  .spark-bar { flex: 1 1 0; min-width: 4px; background: var(--primary); border-radius: 2px 2px 0 0; min-height: 3px; opacity: .85; }
  .spark-bar.zero { background: var(--border); }
  .momentum-summary { color: var(--text-muted); font-size: 13px; margin: 4px 0 2px; }
  .momentum-peak { color: var(--primary-light); font-size: 13px; font-weight: 600; margin: 2px 0 0; }
  /* weekly report */
  .headline { font-size: 18px; font-weight: 600; margin: 0 0 6px; color: var(--text); }
  .showed-up { color: var(--primary-light); font-size: 13px; margin: 8px 0 0; }
  .stats { display: flex; gap: 18px; flex-wrap: wrap; margin: 10px 0 2px; }
  .stat { text-align: center; }
  .stat b { display: block; font-size: 26px; font-weight: 700; color: var(--primary-light); line-height: 1.1; }
  .stat small { color: var(--text-dim); font-size: 12px; }
  .rhythm { margin-top: 12px; border-top: 1px dashed var(--border); padding-top: 10px; }
  .rhythm-intro { margin-bottom: 8px; }
  .rhythm-row { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; font-size: 14px; border-top: 1px dashed var(--border); }
  .rhythm-row:first-of-type { border-top: none; }
  .rhythm-title { color: var(--text); }
  .rhythm-cadence { color: var(--primary-light); white-space: nowrap; }
  .rhythm-next { color: var(--text-dim); font-size: 13px; margin: 0 0 6px; }
  .rhythm-toggle { font-size: 13px; }
  .next-step { background: var(--primary-dim); border: 1px solid var(--border-light); border-radius: 10px; padding: 12px 14px; color: var(--text); margin-top: 12px; }
</style>`;
}

/**
 * The full document head for an accountability page — shared so every moat page
 * carries the same brand fonts, tokens, and noindex directive.
 * @param {{ title: string, description: string, maxWidth?: number }} opts
 * @returns {string} everything from `<!doctype html>` through `</head>`
 */
export function pageHead({ title, description, maxWidth = 720 }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex, nofollow" />
<title>${title}</title>
<meta name="description" content="${description}" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap">
${pageShellStyle({ maxWidth })}</head>`;
}

/**
 * A branded top nav for the moat pages.
 * @param {Array<{ href: string, label: string }>} items
 * @returns {string} a `<nav class="pagenav">…</nav>` block
 */
export function pageNav(items) {
  return `<nav class="pagenav">${items
    .map((it) => `<a href="${it.href}">${it.label}</a>`)
    .join(' <span aria-hidden="true">·</span> ')}</nav>`;
}
