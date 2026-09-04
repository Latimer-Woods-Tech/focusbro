/**
 * The breathing pacer's markup — server-rendered from the same pattern data
 * the served script embeds, so a page lists its patterns and their counts
 * without JavaScript, and the rounds select is honest to the guide's cap
 * before the script ever runs. Only the patterns a guide DESCRIBES are
 * offered on it: the pacer is the guide's counts made followable, not a
 * catalogue.
 */
import { BREATH_PATTERNS, cycleSeconds } from './breath-patterns.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const counts = (p) => p.phases.map((ph) => ph.seconds).join('-');

export function renderBreathPacer(patternIds, defaultId) {
  const def = BREATH_PATTERNS[defaultId];
  if (!def || !patternIds.every((id) => BREATH_PATTERNS[id])) throw new Error(`renderBreathPacer: unknown pattern in ${patternIds.join(',')} / ${defaultId}`);
  const options = patternIds.map((id) => {
    const p = BREATH_PATTERNS[id];
    return `<option value="${esc(id)}"${id === defaultId ? ' selected' : ''}>${esc(p.label)} · ${cycleSeconds(p.phases)} s a round</option>`;
  }).join('\n');
  const rounds = Array.from({ length: def.maxRounds }, (_, i) => i + 1)
    .map((n) => `<option value="${n}"${n === def.defaultRounds ? ' selected' : ''}>${n}</option>`).join('');
  const phaseList = patternIds.map((id) => {
    const p = BREATH_PATTERNS[id];
    return `<li><strong>${esc(p.label)}:</strong> ${p.phases.map((ph) => `${esc(ph.name.toLowerCase())} ${ph.seconds}`).join(', ')} — ${counts(p)}, ${cycleSeconds(p.phases)} s a round, up to ${p.maxRounds} rounds.</li>`;
  }).join('\n');
  return `<section class="tool pacer" id="breathing-pacer" aria-labelledby="pacerTitle" data-patterns="${esc(patternIds.join(','))}" data-default="${esc(defaultId)}">
<h3 id="pacerTitle">Breathe along with a pacer</h3>
<form id="pacerForm" class="tool-form" novalidate>
<div class="tool-row tool-row-3">
<div><label for="pacerPattern">Pattern</label><select id="pacerPattern" name="pattern">
${options}
</select></div>
<div><label for="pacerRounds">Rounds</label><select id="pacerRounds" name="rounds">${rounds}</select></div>
<div class="pacer-check"><label for="pacerSound"><input type="checkbox" id="pacerSound" name="sound" /> Ocean swell that rises and falls with your breath</label></div>
</div>
<p class="tool-help" id="pacerNote">${esc(def.note)}</p>
<div class="pacer-stage" aria-hidden="true">
<svg class="pacer-svg" viewBox="0 0 200 200" focusable="false"><circle class="pacer-ring-bg" cx="100" cy="100" r="92"></circle><circle class="pacer-ring" id="pacerRing" cx="100" cy="100" r="92"></circle><circle class="pacer-orb" id="pacerOrb" cx="100" cy="100" r="70"></circle></svg>
<div class="pacer-count" id="pacerCount"></div>
</div>
<p class="pacer-phase" id="pacerPhase" role="status" aria-live="polite">Press start, then breathe with the circle.</p>
<p class="pacer-round" id="pacerRound"></p>
<div class="pacer-actions"><button type="submit" class="tool-btn" id="pacerStart">Start</button><button type="button" class="tool-btn tool-btn-secondary" id="pacerStop" hidden>Stop</button></div>
</form>
<ul class="pacer-patterns">
${phaseList}
</ul>
<p class="tool-note">The counts are the ones this guide describes, at one count a second. The swell is generated on your device as you breathe, not a recording. Nothing you do here leaves this page. This is a relaxation aid, not a medical treatment — stop if you feel light-headed.</p>
<noscript><p class="tool-help">The pacer needs JavaScript. Without it, count the pattern above at one count a second, or breathe along with a slow clock.</p></noscript>
</section>`;
}
