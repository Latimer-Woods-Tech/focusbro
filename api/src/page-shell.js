// Shared page shell for the accountability surfaces (/me/, /me/report, /coach/).
//
// One skin for the whole product: the home timer app wears the ink + amber
// palette (public/index.html :root tokens); before
// this module the moat pages rendered as unstyled white wireframes (Resonance
// Council, 2026-07-13, #76). This ports the SAME tokens onto the moat so the
// commodity and the accountability spine read as one visual family — one
// product, one skin. It changes only presentation: every existing class name,
// copy string, and bit of markup is preserved, so the copy-law battery and the
// page tests are untouched.
//
// Pure, dependency-free, Worker-safe (a plain template-string builder).

/**
 * Google Play policy (FocusBro Pro is sold on the website only): inside the
 * native app — `html[data-native-app]`, set by /native-bridge.js — every buy /
 * upgrade control (`.pro-buy`) is hidden. Pro bought on the web still unlocks
 * in the app; only the way to buy is absent.
 */
export const PRO_BUY_HIDE_CSS = 'html[data-native-app] .pro-buy{display:none !important}';

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
    --bg: #0d0f12; --bg-secondary: #0f1215; --bg-card: #15181d; --bg-card-hover: #1b1f25;
    --border: rgba(255,255,255,0.075); --border-light: rgba(255,255,255,0.12);
    --text: #eceae6; --text-muted: #a4a19b; --text-dim: #8c8982;
    --primary: #f2b45a; --primary-light: #f6c47c; --primary-dim: rgba(242,180,90,0.12);
    --on-accent: #1b1305;
    --success: #6cc79a; --success-dim: rgba(108,199,154,0.12); --success-light: #8fd6b1;
    --warn: #e8935a; --warn-dim: rgba(232,147,90,0.12); --warn-light: #f0b088;
    --danger-light: #f0958b;
    --blue: #8fb0dd; --blue-dim: rgba(143,176,221,0.12); --blue-light: #a9c3e6;
    --teal: #6bbfae; --purple: #a99be6;
    --radius: 12px; --shadow: none;
    --font: 'DM Sans', -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  }
  * { box-sizing: border-box; }
  body { font-family: var(--font); max-width: ${maxWidth}px; margin: 0 auto; padding: 24px; line-height: 1.55; color: var(--text); background: var(--bg); -webkit-font-smoothing: antialiased; min-height: 100vh; }
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
  button { background: var(--primary); color: var(--on-accent); border: none; cursor: pointer; font-weight: 600; }
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
  .streakbest { margin-top: 14px; padding: 10px 14px; border-radius: 10px; font-size: 15px; font-weight: 600; color: var(--primary-light); background: var(--primary-dim); border: 1px solid rgba(242, 180, 90, 0.30); }
  /* Milestone badge — a discrete "you reached it" win, so a warm success accent (distinct from the blue personal-best line; the two can show together). */
  .streakmilestone { margin-top: 10px; padding: 10px 14px; border-radius: 10px; font-size: 15px; font-weight: 600; color: var(--success-light); background: var(--success-dim); border: 1px solid rgba(108, 199, 154, 0.30); }
  /* Lifetime landmark — the cumulative total (never resets), so a gold/trophy accent distinct from both the blue best line and the green milestone; all three can show together. */
  .streaklandmark { margin-top: 10px; padding: 10px 14px; border-radius: 10px; font-size: 15px; font-weight: 600; color: var(--warn-light); background: var(--warn-dim); border: 1px solid rgba(232, 147, 90, 0.30); }
  /* Standing all-time record — the strongest run held as a permanent record, shown only at a fresh start; a purple accent distinct from the blue best, green milestone, and gold landmark. */
  .streakrecord { margin-top: 10px; padding: 10px 14px; border-radius: 10px; font-size: 15px; font-weight: 600; color: var(--purple); background: rgba(169, 155, 230, 0.12); border: 1px solid rgba(169, 155, 230, 0.30); }
  /* Power hours — the warm "you're strongest around N" read; a teal accent, distinct from the streak badges, matching its own insight card. */
  .powerhours { margin-top: 6px; padding: 10px 14px; border-radius: 10px; font-size: 15px; font-weight: 600; color: var(--teal); background: rgba(107, 191, 174, 0.12); border: 1px solid rgba(107, 191, 174, 0.30); }
  .name { font-weight: 600; color: var(--text); }
  .line { color: var(--text-muted); font-size: 14px; }
  .when { color: var(--text-dim); font-size: 13px; }
  .when.next { margin-top: 2px; color: var(--text-muted); }
  /* An open-but-past check-in is warm, never an alarm — a gentle accent, no red. */
  .when.next.waiting { color: var(--warn-light); }
  .roster-next { color: var(--text-muted); font-size: 13px; margin-top: 4px; }
  .roster-next.waiting { color: var(--warn-light); }
  .roster-reach { margin-top: 6px; padding: 6px 10px; border-radius: 8px; font-size: 13px; color: var(--primary-light); background: var(--primary-dim); border: 1px solid rgba(242, 180, 90, 0.22); }
  /* The joyful twin of the reach-out cue — a celebration, so a warm success accent, never the worried blue. */
  .roster-back { margin-top: 6px; padding: 6px 10px; border-radius: 8px; font-size: 13px; color: var(--success-light); background: var(--success-dim); border: 1px solid rgba(108, 199, 154, 0.22); }
  .roster-milestone { margin-top: 6px; padding: 6px 10px; border-radius: 8px; font-size: 13px; font-weight: 600; color: var(--success-light); background: var(--success-dim); border: 1px solid rgba(108, 199, 154, 0.30); }
  /* The weekly homecoming digest — the batched twin of the per-client cues; a
     celebration of returns, so the same warm success accent, never a worried tone. */
  .digest .digest-summary { margin: 6px 0 0; font-size: 14px; color: var(--success-light); }
  .digest { border-left: 3px solid var(--success-light); }
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
  /* the person's own words, read back beneath the sparkline — a warm memory, never a tally */
  .latest-note { color: var(--text); font-size: 14px; font-style: italic; margin: 8px 0 0; padding-top: 8px; border-top: 1px dashed var(--border); }
  .latest-note-label { color: var(--text-dim); font-style: normal; font-size: 12px; display: block; margin-bottom: 2px; }
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
  ${PRO_BUY_HIDE_CSS}
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
