/**
 * The Follow-Through Index — a public, dated measure of whether people who
 * give their word to a check-in actually start, and the methodology behind it.
 *
 * Why it exists: FocusBro's ledger records when people said they would start,
 * when they actually did, and how they reschedule. Nobody else has that
 * record. Published honestly — definitions stated, sample size shown, a floor
 * below which no rate appears — it is citable in a way no how-to article is.
 *
 * The rules that make it honest live HERE, as constants and pure functions,
 * and the page, the JSON endpoint and the tests all read the same ones:
 *   - the window is rolling (WINDOW_DAYS), and the figures are regenerated
 *     hourly, not hand-typed;
 *   - a rate is published only when the window holds at least
 *     `minimumResolved` resolved commitments — below that the page says
 *     "fewer than N" and nothing else, because a percentage of eleven is
 *     noise dressed as a finding;
 *   - the definitions are the ones computeLoopMetrics (events.js) computes —
 *     a reschedule is counted, never a miss; "I'm on it" moves nothing; the
 *     bro reaching out is never the person acting;
 *   - aggregates only. No per-person figure is ever produced by this module.
 */
import { computeLoopMetrics } from '../events.js';
import { SHELL_CSS, SITE_HEADER, SITE_FOOTER, withHeadingAnchors } from './index.js';
import { SOURCES, SOURCE_TYPES, AUTHOR, sourceUrl } from './sources.js';

export const FOLLOW_THROUGH = Object.freeze({
  path: '/follow-through-index.html',
  title: 'The Follow-Through Index',
  description: 'How FocusBro measures whether people who give their word actually start: the definitions, the publication floors, the limits, and the current figures with their sample size shown.',
  lastmod: '2026-09-04',
  lastmodLabel: 'September 2026',
  windowDays: 30,
  minimumResolved: 30,
  minimumCohort: 30,
  cacheSeconds: 3600,
  cacheKey: 'follow-through:v1',
  sources: Object.freeze(['gollwitzer1999', 'gollwitzer2006']),
  codeUrl: 'https://github.com/Latimer-Woods-Tech/focusbro/blob/main/api/src/events.js',
});

const pct = (num, den) => (den > 0 ? Math.round((100 * num) / den) : null);

/**
 * Reduce a computeLoopMetrics() result to what the Index publishes — and
 * nothing more. Below the floor, the exact count is withheld on purpose: the
 * only thing the page may say is "fewer than <floor>".
 * @param {object|null} metrics computeLoopMetrics output
 * @param {string} [nowISO]
 * @returns {object} figures
 */
export function summarizeFollowThrough(metrics, nowISO) {
  const generated_at = nowISO || new Date().toISOString();
  if (!metrics || !metrics.totals || !metrics.window) return { available: false, generated_at };
  const t = metrics.totals;
  const kept = Number(t.commitments_kept) || 0;
  const rescheduled = Number(t.commitments_reschedule) || 0;
  const missed = Number(t.commitments_missed) || 0;
  const resolved = kept + rescheduled + missed;
  const published = resolved >= FOLLOW_THROUGH.minimumResolved;
  const d7 = (metrics.retention && metrics.retention.d7) || { eligible: 0, returned: 0 };
  const eligible = Number(d7.eligible) || 0;
  const cohortPublished = eligible >= FOLLOW_THROUGH.minimumCohort;
  return {
    available: true,
    generated_at,
    window: { since: metrics.window.since, until: metrics.window.until, days: metrics.window.days },
    floors: { resolved: FOLLOW_THROUGH.minimumResolved, cohort: FOLLOW_THROUGH.minimumCohort },
    published,
    resolved: published ? resolved : null,
    resolved_band: published ? null : `fewer than ${FOLLOW_THROUGH.minimumResolved}`,
    kept_word_rate: published ? pct(kept, resolved) : null,
    reschedule_rate: published ? pct(rescheduled, resolved) : null,
    return_7d: {
      published: cohortPublished,
      eligible: cohortPublished ? eligible : null,
      rate: cohortPublished ? pct(Number(d7.returned) || 0, eligible) : null,
    },
  };
}

/**
 * The current figures: from KV when fresh, else computed from the ledger and
 * cached for an hour. Never throws — a page and an endpoint must render on a
 * bad day, saying "unavailable" rather than 500.
 * @param {object} env Worker env (DB, KV_CACHE)
 * @param {object} [opts] { compute?, now? } — injectable for tests
 * @returns {Promise<object>} figures
 */
export async function followThroughFigures(env, { compute = computeLoopMetrics, now = () => new Date() } = {}) {
  const kv = env && env.KV_CACHE;
  if (kv && typeof kv.get === 'function') {
    try {
      const hit = await kv.get(FOLLOW_THROUGH.cacheKey, 'json');
      if (hit && hit.available) return hit;
    } catch { /* a cache miss is not an error */ }
  }
  if (!env || !env.DB) return { available: false, generated_at: now().toISOString() };
  let metrics;
  try {
    metrics = await compute(env, { sinceDays: FOLLOW_THROUGH.windowDays, nowISO: now().toISOString() });
  } catch {
    return { available: false, generated_at: now().toISOString() };
  }
  const figures = summarizeFollowThrough(metrics, now().toISOString());
  if (kv && figures.available && typeof kv.put === 'function') {
    try { await kv.put(FOLLOW_THROUGH.cacheKey, JSON.stringify(figures), { expirationTtl: FOLLOW_THROUGH.cacheSeconds }); } catch { /* cache is a convenience */ }
  }
  return figures;
}

/** Known figures for the smoke and for a visual check of the published state. */
export const SAMPLE_FIGURES = Object.freeze({
  available: true,
  generated_at: '2026-09-04T12:00:00.000Z',
  window: { since: '2026-08-05T12:00:00.000Z', until: '2026-09-04T12:00:00.000Z', days: 30 },
  floors: { resolved: 30, cohort: 30 },
  published: true,
  resolved: 47,
  resolved_band: null,
  kept_word_rate: 64,
  reschedule_rate: 23,
  return_7d: { published: false, eligible: null, rate: null },
});

const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const day = (iso) => esc(String(iso || '').slice(0, 10));
const stamp = (iso) => esc(String(iso || '').slice(0, 16).replace('T', ' ')) + ' UTC';

function figuresHtml(f) {
  if (!f || !f.available) {
    return `<section class="figures" id="current-figures"><h2>Current figures</h2>
<p class="figures-note">The figures are unavailable right now. The definitions above do not change; check back shortly.</p>
</section>`;
  }
  const win = `${day(f.window.since)} to ${day(f.window.until)}`;
  if (!f.published) {
    return `<section class="figures" id="current-figures"><h2>Current figures</h2>
<p><strong>Not enough yet.</strong> The ${f.window.days}-day window (${win}) holds ${esc(f.resolved_band)} resolved commitments, so no rate is published. The floor is the rule, not a mood: below it a percentage would be noise dressed as a finding.</p>
<p class="figures-stamp">Generated: ${stamp(f.generated_at)}</p>
</section>`;
  }
  const ret = f.return_7d && f.return_7d.published
    ? `<div><dt>7-day return</dt><dd>${f.return_7d.rate}% <span class="figures-n">of ${f.return_7d.eligible} eligible</span></dd></div>`
    : `<div><dt>7-day return</dt><dd><span class="figures-n">not yet published (fewer than ${f.floors.cohort} eligible)</span></dd></div>`;
  return `<section class="figures" id="current-figures"><h2>Current figures</h2>
<dl class="figures-list">
<div><dt>Kept-word rate</dt><dd>${f.kept_word_rate}%</dd></div>
<div><dt>Reschedule rate</dt><dd>${f.reschedule_rate}%</dd></div>
<div><dt>Resolved commitments (N)</dt><dd>${f.resolved}</dd></div>
${ret}
</dl>
<p class="figures-note">Window: ${win} (${f.window.days} days, rolling). Whole percentages. An early signal with its sample size shown, not a claim.</p>
<p class="figures-stamp">Generated: ${stamp(f.generated_at)}</p>
</section>`;
}

function sourcesHtml() {
  const items = FOLLOW_THROUGH.sources.map((k) => SOURCES[k]).filter(Boolean);
  return `<section class="sources" id="sources"><h2>Sources</h2>
<p class="sources-intro">The Index measures FocusBro's own ledger and cites no study for its numbers. The one research claim on this page — that naming when and where you will act makes acting more likely — rests on the sources below. The definitions themselves are in the open code, linked in the methodology.</p>
<ol class="sources-list">
${items.map((src) => {
    const link = sourceUrl(src);
    const title = link ? `<a href="${link}" rel="noopener">${esc(src.title)}</a>` : esc(src.title);
    const note = src.note ? ` <span class="source-note">${esc(src.note)}</span>` : '';
    return `<li><span class="source-type">${esc(SOURCE_TYPES[src.type] || src.type)}</span> ${esc(src.authors)} (${src.year}). ${title}. <em>${esc(src.venue)}</em>.${link ? ` <span class="source-doi">doi:${esc(src.doi)}</span>` : ''}${note}</li>`;
  }).join('\n')}
</ol>
</section>`;
}

/**
 * Render the methodology page with the given figures. Script-free by design.
 * @param {object} figures from followThroughFigures()
 * @param {object} [opts] { version? } — unused for scripts (there are none); kept for parity with guide pages
 * @returns {string} HTML
 */
export function renderFollowThroughPage(figures) {
  const F = FOLLOW_THROUGH;
  const url = `https://focusbro.net${F.path}`;
  const body = `
<p class="lede">The Follow-Through Index is FocusBro's own answer to a question the productivity world mostly guesses at: when someone says they will start something at a certain time, and something checks in with them at that time, how often do they actually start? It is computed from FocusBro's first-party ledger, published as an aggregate with its sample size shown, and regenerated hourly. This page is the methodology. The figures at the bottom are the Index as it stands right now.</p>

<h2>What is being measured</h2>
<p>Every number on this page comes from one record: the accountability loop. A person tells FocusBro what they will do and when. At that time FocusBro checks in. The person answers — they started, they moved it, or they did not — and the answer is written down. The Index is those answers, counted.</p>
<p>The one research claim behind the product is that naming <em>when and where</em> you will act makes acting more likely. That is Peter Gollwitzer's finding on implementation intentions, replicated across a large body of studies; the sources are listed below. The Index does not test that claim. It reports how the loop behaves for the people who use it.</p>

<h2>Definitions</h2>
<dl class="definitions">
<dt>Commitment</dt>
<dd>A person told FocusBro what they would do and when they would start. Timers on their own are not commitments; a Pomodoro with no word given is not counted anywhere here.</dd>
<dt>Check-in</dt>
<dd>FocusBro asking, at the committed time, whether they started. A check-in being <em>delivered</em> is FocusBro acting, not the person. It never counts as the person doing anything.</dd>
<dt>Kept</dt>
<dd>The person answered that they started.</dd>
<dt>Rescheduled</dt>
<dd>The person moved the commitment to a new time. This is a real, protected outcome. It counts in the denominator — the word was not kept <em>this</em> time — but it is never recorded or shown as a miss.</dd>
<dt>Missed</dt>
<dd>The person answered that they did not start, or the check-in ran out without an answer after every follow-up. Counted only so the rate is honest; never surfaced as a tally anywhere in the product.</dd>
<dt>"I'm on it"</dt>
<dd>The third answer: not yet started, not moving it, keep the word open a little longer. It is engagement, not a resolution. It is counted on its own and deliberately kept out of every rate on this page.</dd>
<dt>Released</dt>
<dd>The person withdrew the commitment. Not resolved, not counted.</dd>
<dt>Resolved</dt>
<dd>Kept + rescheduled + missed. The denominator, and the sample size (N) the page shows.</dd>
</dl>

<h2>The measures</h2>
<dl class="definitions">
<dt>Kept-word rate</dt>
<dd><strong>kept ÷ (kept + rescheduled + missed)</strong>, over the window. This is the Index's headline number.</dd>
<dt>Reschedule rate</dt>
<dd><strong>rescheduled ÷ (kept + rescheduled + missed)</strong>. Shown beside the headline so a high kept-word rate can never hide how much of the rest was moved rather than missed.</dd>
<dt>7-day return</dt>
<dd>Of the people whose first-ever activity fell in the window and who have had seven full days since, the share with activity <em>of their own</em> on a later day within those seven. A delivered check-in, a follow-up, or a "come back" nudge is FocusBro acting and does not count as returning. This measure has its own floor.</dd>
</dl>

<h2>Publication rules</h2>
<ul>
<li><strong>Window.</strong> The last ${F.windowDays} days, rolling. The window's dates are printed with the figures.</li>
<li><strong>Floor.</strong> A rate is published only when the window holds at least <strong>${F.minimumResolved} resolved commitments</strong>. Below that, the page says "fewer than ${F.minimumResolved}" and nothing else — not the count, not a percentage. The 7-day return needs at least ${F.minimumCohort} eligible people.</li>
<li><strong>Precision.</strong> Whole percentages. Nothing here supports a decimal.</li>
<li><strong>Freshness.</strong> Figures are computed from the ledger and cached for an hour; the "Generated" stamp is the computation time, in UTC. Nothing on this page is typed in by hand.</li>
<li><strong>Same data, one place.</strong> The figures and the JSON at <code>/api/public/follow-through</code> are produced by the same function from the same rows, so they cannot disagree.</li>
<li><strong>Definitions live in the open.</strong> The counting is done by <a href="${F.codeUrl}" rel="noopener">the code that records the events</a>, which anyone can read. If a definition on this page ever differs from the code, the code is wrong or this page is, and either is a bug.</li>
</ul>

<h2>Privacy</h2>
<p>The Index is an aggregate. No figure on this page or in the endpoint refers to a person; nothing here can be joined back to one. Below the floor even the count is withheld, so a small early cohort is never reduced to "three people, one of whom…". FocusBro does not record a per-person miss count anywhere, for the Index or for anything else.</p>

<h2>Limits — read these before citing</h2>
<ul>
<li><strong>Self-selected.</strong> These are people who chose an accountability tool and gave their word to it. They are not a sample of anyone else.</li>
<li><strong>One product.</strong> The loop's wording, timing, and follow-ups shape the answers. A different check-in would get different numbers.</li>
<li><strong>Survivorship.</strong> People who stop using FocusBro stop being counted. A window can look better because the people it was not working for left.</li>
<li><strong>A reschedule is not a failure.</strong> Reading the reschedule rate as "how often people flake" is a misreading; it is how often a word was moved rather than kept or missed.</li>
<li><strong>Not a clinical measure.</strong> The Index says nothing about ADHD prevalence, diagnosis, or treatment, and it must not be cited as if it did.</li>
<li><strong>Early.</strong> N is small in ${F.lastmodLabel}. Until the floor is met the page publishes no rate at all, and for a while after that the rate will move a lot from month to month. Cite the window and N with the number, always.</li>
</ul>

<h2>How to cite it</h2>
<p>FocusBro. <em>The Follow-Through Index</em>, window &lt;dates as printed&gt;, N = &lt;as printed&gt;. Retrieved &lt;date&gt; from <a href="${url}">${url}</a>. The JSON at <code>https://focusbro.net/api/public/follow-through</code> carries the same figures with the window, floors, and generation time as fields.</p>

${figuresHtml(figures)}

${sourcesHtml()}
`;
  const { body: processedBody, toc } = withHeadingAnchors(body);
  const f = figures && figures.available ? figures : null;
  const dataset = {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: F.title,
    description: F.description,
    url,
    isAccessibleForFree: true,
    inLanguage: 'en',
    dateModified: F.lastmod,
    creator: { '@type': 'Person', name: AUTHOR.name, jobTitle: AUTHOR.role, url: AUTHOR.url },
    publisher: { '@type': 'Organization', name: 'FocusBro', logo: { '@type': 'ImageObject', url: 'https://focusbro.net/icon-192.svg' } },
    temporalCoverage: f ? `${f.window.since}/${f.window.until}` : undefined,
    measurementTechnique: `First-party accountability ledger. Kept-word rate = kept ÷ (kept + rescheduled + missed) over a rolling ${F.windowDays}-day window; published only at or above ${F.minimumResolved} resolved commitments.`,
    variableMeasured: [
      { '@type': 'PropertyValue', name: 'Kept-word rate', unitText: 'percent', value: f && f.published ? f.kept_word_rate : undefined },
      { '@type': 'PropertyValue', name: 'Reschedule rate', unitText: 'percent', value: f && f.published ? f.reschedule_rate : undefined },
      { '@type': 'PropertyValue', name: 'Resolved commitments', value: f && f.published ? f.resolved : undefined },
    ],
    distribution: { '@type': 'DataDownload', encodingFormat: 'application/json', contentUrl: 'https://focusbro.net/api/public/follow-through' },
  };
  const datasetLd = JSON.stringify(dataset).replace(/</g, '\\u003c');
  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://focusbro.net/' },
      { '@type': 'ListItem', position: 2, name: F.title, item: url },
    ],
  }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(F.title)} — FocusBro</title>
<meta name="description" content="${esc(F.description)}" />
<link rel="canonical" href="${url}" />
<meta property="og:type" content="article" />
<meta property="og:site_name" content="FocusBro" />
<meta property="og:title" content="${esc(F.title)}" />
<meta property="og:description" content="${esc(F.description)}" />
<meta property="og:url" content="${url}" />
<meta property="og:image" content="https://focusbro.net/icon-192.svg" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="${esc(F.title)}" />
<meta name="twitter:description" content="${esc(F.description)}" />
<script type="application/ld+json">${datasetLd}</script>
<script type="application/ld+json">${breadcrumbLd}</script>
<style>${SHELL_CSS}</style>
</head><body>
${SITE_HEADER}
<main>
<article>
<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <span>${esc(F.title)}</span></nav>
<h1>${esc(F.title)}</h1>
<p class="meta">By <a href="${AUTHOR.url}" rel="author">${AUTHOR.name}</a>, ${AUTHOR.role} · methodology updated ${F.lastmodLabel}</p>
${toc}
${processedBody}
</article>
</main>
${SITE_FOOTER}
</body></html>`;
}
