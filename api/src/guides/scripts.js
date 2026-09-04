/**
 * First-party scripts served under /guides/*.js. Everything a guide page runs
 * lives here, never inline: the site's CSP is script-src 'self' (report-only
 * until the legacy inline scripts are extracted), and a guide must stay clean
 * under it. The Worker routes and the e2e smoke server both import from here so
 * a browser test exercises exactly the bytes production serves.
 */
import { remainingMg, hoursUntil, hoursBetween, HALF_LIFE_DEFAULT_H, HALF_LIFE_MIN_H, HALF_LIFE_MAX_H } from './caffeine-math.js';

export const GUIDE_VIEW_SCRIPT = `(function () {
  try {
    var el = document.currentScript || document.querySelector('script[data-slug]');
    var slug = el && el.getAttribute('data-slug');
    if (!slug) return;
    var key = 'focusbro_guide_view:' + slug;
    if (sessionStorage.getItem(key)) return;
    var body = JSON.stringify({ slug: slug });
    var sent = false;
    if (navigator.sendBeacon) {
      try { sent = navigator.sendBeacon('/api/content/view', new Blob([body], { type: 'application/json' })); } catch (e) { sent = false; }
    }
    if (!sent) {
      fetch('/api/content/view', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true })
        .catch(function () {});
    }
    sessionStorage.setItem(key, '1');
  } catch (e) {}
})();
`;

// The math is embedded from its module source, so the client can never drift
// from what the tests assert.
export const CAFFEINE_SCRIPT = `(function () {
  var HALF_LIFE_DEFAULT_H = ${HALF_LIFE_DEFAULT_H}, HALF_LIFE_MIN_H = ${HALF_LIFE_MIN_H}, HALF_LIFE_MAX_H = ${HALF_LIFE_MAX_H};
  ${remainingMg.toString()}
  ${hoursUntil.toString()}
  ${hoursBetween.toString()}
  function $(id) { return document.getElementById(id); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmtHours(h) { var m = Math.round(h * 60); var hh = Math.floor(m / 60), mm = m % 60; return hh + ' h' + (mm ? ' ' + pad(mm) + ' min' : ''); }
  function clockPlus(hhmm, hours) { var p = hhmm.split(':'); var mins = (Number(p[0]) * 60 + Number(p[1]) + Math.round(hours * 60)) % 1440; return pad(Math.floor(mins / 60)) + ':' + pad(mins % 60); }
  var used = false;
  function note(tool) {
    if (used) return; used = true;
    try {
      var slug = (document.querySelector('script[data-slug]') || {}).getAttribute ? document.querySelector('script[data-slug]').getAttribute('data-slug') : null;
      if (!slug) return;
      var key = 'focusbro_guide_tool:' + slug + ':' + tool;
      if (sessionStorage.getItem(key)) return;
      var body = JSON.stringify({ slug: slug, tool: tool });
      var sent = false;
      if (navigator.sendBeacon) { try { sent = navigator.sendBeacon('/api/content/view', new Blob([body], { type: 'application/json' })); } catch (e) { sent = false; } }
      if (!sent) fetch('/api/content/view', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }).catch(function () {});
      sessionStorage.setItem(key, '1');
    } catch (e) {}
  }
  function draw(svg, dose, halfLife, hoursToBed) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var W = 320, H = 120, padL = 8, padR = 8, padT = 8, padB = 18;
    var span = Math.max(hoursToBed + 8, 12);
    var x = function (h) { return padL + (h / span) * (W - padL - padR); };
    var y = function (mg) { return padT + (1 - mg / dose) * (H - padT - padB); };
    var ns = 'http://www.w3.org/2000/svg';
    var d = '';
    for (var h = 0; h <= span; h += span / 64) { d += (d ? ' L ' : 'M ') + x(h).toFixed(1) + ' ' + y(remainingMg(dose, h, halfLife)).toFixed(1); }
    var path = document.createElementNS(ns, 'path'); path.setAttribute('d', d); path.setAttribute('class', 'tool-curve'); svg.appendChild(path);
    var bx = x(hoursToBed);
    var line = document.createElementNS(ns, 'line'); line.setAttribute('x1', bx); line.setAttribute('x2', bx); line.setAttribute('y1', padT); line.setAttribute('y2', H - padB); line.setAttribute('class', 'tool-bedline'); svg.appendChild(line);
    var dot = document.createElementNS(ns, 'circle'); dot.setAttribute('cx', bx); dot.setAttribute('cy', y(remainingMg(dose, hoursToBed, halfLife))); dot.setAttribute('r', 4); dot.setAttribute('class', 'tool-beddot'); svg.appendChild(dot);
    var lbl = document.createElementNS(ns, 'text'); lbl.setAttribute('x', Math.min(bx + 4, W - 60)); lbl.setAttribute('y', H - 5); lbl.setAttribute('class', 'tool-label'); lbl.textContent = 'bedtime'; svg.appendChild(lbl);
    var half = document.createElementNS(ns, 'text'); half.setAttribute('x', padL); half.setAttribute('y', H - 5); half.setAttribute('class', 'tool-label'); half.textContent = '0 h'; svg.appendChild(half);
    var end = document.createElementNS(ns, 'text'); end.setAttribute('x', W - padR - 26); end.setAttribute('y', padT + 10); end.setAttribute('class', 'tool-label'); end.textContent = Math.round(span) + ' h'; svg.appendChild(end);
  }
  function run() {
    var dose = Number($('cafDose').value), taken = $('cafTaken').value, bed = $('cafBed').value, hl = Number($('cafHalf').value);
    var out = $('cafResult'); var svg = $('cafChart');
    $('cafHalfOut').textContent = hl.toFixed(1) + ' h';
    if (!(dose > 0) || !taken || !bed || !(hl >= HALF_LIFE_MIN_H && hl <= HALF_LIFE_MAX_H)) { out.textContent = 'Enter a dose, when you had it, and your bedtime.'; return; }
    var hours = hoursBetween(taken, bed); if (hours == null) return;
    var atBed = remainingMg(dose, hours, hl);
    var toHalf = hl, toQuarter = 2 * hl;
    out.innerHTML = '';
    var p1 = document.createElement('p'); p1.className = 'tool-headline';
    p1.appendChild(document.createTextNode('At ' + bed + ', about '));
    var b = document.createElement('strong'); b.textContent = Math.round(atBed) + ' mg'; p1.appendChild(b);
    p1.appendChild(document.createTextNode(' of the ' + Math.round(dose) + ' mg is still in your system (' + Math.round(100 * atBed / dose) + '%).'));
    out.appendChild(p1);
    var p2 = document.createElement('p'); p2.className = 'tool-detail';
    // Milestones only — pure arithmetic. No "safe" threshold is stated, because
    // none is cited; the guide's rule of thumb (stop 8–10 h before bed) rests on
    // Drake 2013 and lives in the prose, where its source is.
    p2.textContent = 'Half of it is gone by ' + clockPlus(taken, toHalf) + ' (' + fmtHours(toHalf) + ' later); a quarter is left by ' + clockPlus(taken, toQuarter) + ' (' + fmtHours(toQuarter) + ' later).';
    out.appendChild(p2);
    draw(svg, dose, hl, hours);
    note('caffeine-calculator');
  }
  function init() {
    var form = $('caffeineCalc'); if (!form) return;
    var now = new Date(); if (!$('cafTaken').value) $('cafTaken').value = pad(now.getHours()) + ':' + pad(now.getMinutes());
    $('cafPreset').addEventListener('change', function () { var v = this.value; if (v) $('cafDose').value = v; run(); });
    ['cafDose', 'cafTaken', 'cafBed', 'cafHalf'].forEach(function (id) { $(id).addEventListener('input', run); });
    form.addEventListener('submit', function (e) { e.preventDefault(); run(); });
    run();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
`;
