/**
 * FBQ-20 — the design LAW's two quiet clauses, made enforceable:
 *   1. no counter that resets to zero (a "current run" / "0 in a row" display), and
 *   2. no text dimmed with `opacity` (use a colour token that holds contrast).
 * Proof of rejection: each scanner is shown failing on the pre-fix strings/CSS.
 */
import { describe, it, expect } from 'vitest';
import { scanDesignLaw, findDimmedTextRules } from '../design-law.js';
import servedHtml from '../html.js';
import { pageShellStyle } from '../page-shell.js';
import { buildWeeklyReport, renderReportText } from '../report.js';
import { streakSummaryCopy } from '../accountability.js';

const SHELL_CSS = [...servedHtml.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
// Decorative glyphs / imagery / non-text affordances — not text, so dimming is not a legibility defect.
const DECORATIVE = [
  /icon|bubble|confetti|particle|breathing|ripple|task-empty-icon|spark-bar/i,
  /^body\.session-active/, // whole-card focus mode, restored on focus-within
];

describe('FBQ-20 scanner bites', () => {
  it('rejects a resetting run display', () => {
    expect(scanDesignLaw('Current kept-word run: 0 (best ever: 12)').length).toBeGreaterThan(0);
    expect(scanDesignLaw('0 in a row').length).toBeGreaterThan(0);
    expect(scanDesignLaw('0 kept words in a row').length).toBeGreaterThan(0);
    expect(scanDesignLaw('current run').length).toBeGreaterThan(0);
  });
  it('leaves the achievement and the total alone', () => {
    expect(scanDesignLaw('Best stretch so far: 12 kept words in a row')).toEqual([]);
    expect(scanDesignLaw('Words kept, all time: 40')).toEqual([]);
  });
  it('rejects text dimmed with opacity, proven on the pre-fix CSS', () => {
    expect(findDimmedTextRules('.pending { opacity: .7; }')).toEqual(['.pending => .7']);
    expect(findDimmedTextRules('.saved-mix .saved-mix-del { padding: 2px 8px; opacity: 0.7; }')).toHaveLength(1);
    expect(findDimmedTextRules('@keyframes x { 0% { opacity: .4; } }')).toEqual([]);
    expect(findDimmedTextRules('.a { opacity: 1; } .b { opacity: 0; }')).toEqual([]);
  });
});

describe('FBQ-20 the shipped CSS carries no dimmed text', () => {
  it('page-shell (every server-rendered page)', () => {
    expect(findDimmedTextRules(pageShellStyle(), { allow: DECORATIVE })).toEqual([]);
  });
  it('app shell (public/index.html)', () => {
    expect(findDimmedTextRules(SHELL_CSS, { allow: DECORATIVE })).toEqual([]);
  });
});

describe('FBQ-20 a person whose current run is 0 and best is 12', () => {
  const streak = { current_streak: 0, longest_streak: 12, total_kept: 30 };
  const report = buildWeeklyReport({ streak, nowISO: '2026-10-05T12:00:00Z' });
  const text = renderReportText(report);
  it('the report text (which goes to the coach) names no current run', () => {
    expect(text).not.toMatch(/current/i);
    expect(scanDesignLaw(text)).toEqual([]);
    expect(text).toContain('Words kept, all time: 30');
    expect(text).toContain('Best stretch so far: 12 kept words in a row');
  });
  it('no best-ever line at all when there is no stretch worth naming', () => {
    const t = renderReportText(buildWeeklyReport({ streak: { current_streak: 0, longest_streak: 1, total_kept: 1 } }));
    expect(t).not.toMatch(/stretch|best/i);
  });
  it('streakSummaryCopy narrates the climbing total, never the run', () => {
    const c = streakSummaryCopy({ streak: { ...streak, current_streak: 2, longest_streak: 9 } });
    expect(c).toContain('30 times so far');
    expect(c).not.toMatch(/in a row|best/i);
  });
});

describe('FBQ-20 the served pages', () => {
  async function page(path) {
    const worker = (await import('../index.js')).default;
    const r = await worker.fetch(new Request('https://focusbro.net' + path),
      { KV_CACHE: { get: async () => null, put: async () => {} } }, { waitUntil() {} });
    expect(r.status).toBe(200);
    return r.text();
  }
  it('/me/report has no current-run stat; best stretch only as an achievement', async () => {
    const html = await page('/me/report');
    expect(html).not.toContain('current run');
    expect(html).not.toMatch(/streak\.current_streak/);
    expect(html).toContain('best stretch');
    expect(html).toContain("classList.toggle('hidden', bestRun < 2)");
  });
  it('the coach card shows words kept, never in-a-row', async () => {
    const html = await page('/coach/');
    expect(html).not.toContain('<small>in a row</small>');
    expect(html).toContain("esc(c.streak.total_kept || 0) + '<small>words kept</small></div>'");
  });
});
