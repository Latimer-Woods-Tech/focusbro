/**
 * First-party scripts served under /guides/*.js. Everything a guide page runs
 * lives here, never inline: the site's CSP is script-src 'self' (report-only
 * until the legacy inline scripts are extracted), and a guide must stay clean
 * under it. The Worker routes and the e2e smoke server both import from here so
 * a browser test exercises exactly the bytes production serves.
 */
import { CAFFEINE_MATH_SRC, HALF_LIFE_DEFAULT_H, HALF_LIFE_MIN_H, HALF_LIFE_MAX_H } from './caffeine-math.js';
import { BREATH_MATH_SRC, BREATH_PATTERNS_JSON } from './breath-patterns.js';

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

// The math is embedded as the SAME STRING the module builds its own exports
// from — data, which survives the Worker bundler. Never Function.toString():
// the bundler rewrites declarations with its own `__name` helper and the
// reflected source stops working in a browser (learned in production).
export const CAFFEINE_SCRIPT = `(function () {
  var HALF_LIFE_DEFAULT_H = ${HALF_LIFE_DEFAULT_H}, HALF_LIFE_MIN_H = ${HALF_LIFE_MIN_H}, HALF_LIFE_MAX_H = ${HALF_LIFE_MAX_H};
  ${CAFFEINE_MATH_SRC}
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

// The breathing pacer. Patterns and math are embedded as DATA (a JSON literal
// and the same source string the module tests are built from); the visual
// follows performance.now(), and when the reader opts into sound, the whole
// session's swell is laid on the audio clock up front — so the ocean rises
// through every inhale and falls through every exhale, whether or not the tab
// keeps painting. Never autoplays: sound starts only from Start or the
// checkbox, both gestures.
export const BREATH_SCRIPT = `(function () {
  var PATTERNS = ${BREATH_PATTERNS_JSON};
  ${BREATH_MATH_SRC}
  function $(id) { return document.getElementById(id); }
  var used = false;
  function note(tool) {
    if (used) return; used = true;
    try {
      var el = document.querySelector('script[data-slug]');
      var slug = el ? el.getAttribute('data-slug') : null;
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
  var reduceMotion = false;
  try { reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { reduceMotion = false; }

  // ── the swell: brown noise under a low-pass, its gain and cutoff ramped
  //    phase by phase; a thread of high-passed white noise is the foam that
  //    rides the crest. Built per session and closed after it, so a page never
  //    holds an idle AudioContext. ──
  var audio = null;
  function noiseBuffer(ctx, colour, seconds) {
    var len = Math.floor(seconds * ctx.sampleRate);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0), last = 0;
    for (var i = 0; i < len; i++) {
      var w = Math.random() * 2 - 1;
      if (colour === 'white') { d[i] = w * 0.5; } else { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
    }
    return buf;
  }
  function gainFor(level) { return 0.1 + 0.9 * level; }
  function cutoffFor(level) { return 300 + 600 * level; }
  function buildAudio() {
    var Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return null;
    var ctx = new Ctx();
    var master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
    var swell = ctx.createGain(); swell.gain.value = gainFor(0); swell.connect(master);
    var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = cutoffFor(0); lp.connect(swell);
    var bed = ctx.createBufferSource(); bed.buffer = noiseBuffer(ctx, 'brown', 8); bed.loop = true; bed.connect(lp); bed.start();
    var hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2400;
    var foam = ctx.createGain(); foam.gain.value = 0; hp.connect(foam); foam.connect(swell);
    var spray = ctx.createBufferSource(); spray.buffer = noiseBuffer(ctx, 'white', 8); spray.loop = true; spray.connect(hp); spray.start();
    return { ctx: ctx, master: master, swell: swell, lp: lp, foam: foam, srcs: [bed, spray], closeTimer: null };
  }
  function scheduleSwell(a, phases, rounds, elapsed) {
    var ctx = a.ctx, now = ctx.currentTime, cycle = cycleSeconds(phases), t0 = now - elapsed;
    var g = a.swell.gain, f = a.lp.frequency, fo = a.foam.gain, m = a.master.gain;
    g.cancelScheduledValues(now); f.cancelScheduledValues(now); fo.cancelScheduledValues(now); m.cancelScheduledValues(now);
    var level = breathLevel(phases, elapsed);
    g.setValueAtTime(gainFor(level), now); f.setValueAtTime(cutoffFor(level), now); fo.setValueAtTime(0.05 * gainFor(level), now);
    m.setValueAtTime(0, now); m.linearRampToValueAtTime(0.45, now + 1.2);
    for (var r = 0; r < rounds; r++) {
      var off = 0;
      for (var i = 0; i < phases.length; i++) {
        var end = t0 + r * cycle + off + phases[i].seconds; off += phases[i].seconds;
        if (end <= now) continue;
        var tgt = swellTarget(phases, i);
        g.linearRampToValueAtTime(tgt.gain, end);
        f.exponentialRampToValueAtTime(tgt.cutoff, end);
        fo.linearRampToValueAtTime(0.05 * tgt.gain, end);
      }
    }
    var E = t0 + cycle * rounds;
    m.setValueAtTime(0.45, Math.max(E, now)); m.linearRampToValueAtTime(0, Math.max(E, now) + 2);
    return Math.max(E, now) + 2.3 - now;
  }
  function closeAudio(a) {
    try { for (var i = 0; i < a.srcs.length; i++) { try { a.srcs[i].stop(); } catch (e) {} } } catch (e) {}
    try { if (a.ctx.state !== 'closed') a.ctx.close().catch(function () {}); } catch (e) {}
  }
  function startAudio(elapsed) {
    stopAudio(0.05);
    var a = buildAudio(); if (!a) return;
    audio = a;
    try { if (a.ctx.state === 'suspended') a.ctx.resume().catch(function () {}); } catch (e) {}
    var untilClose = scheduleSwell(a, run.phases, run.rounds, elapsed);
    a.closeTimer = setTimeout(function () { if (audio === a) audio = null; closeAudio(a); }, Math.ceil(untilClose * 1000));
  }
  function stopAudio(fade) {
    var a = audio; if (!a) return; audio = null;
    if (a.closeTimer) clearTimeout(a.closeTimer);
    try {
      var now = a.ctx.currentTime, m = a.master.gain;
      m.cancelScheduledValues(now); m.setValueAtTime(m.value, now); m.linearRampToValueAtTime(0, now + fade);
    } catch (e) {}
    setTimeout(function () { closeAudio(a); }, Math.ceil(fade * 1000) + 100);
  }

  // ── keep the screen on for the length of a session (phones dim mid-round) ──
  var lock = null;
  function holdScreen() { try { if (navigator.wakeLock && navigator.wakeLock.request) navigator.wakeLock.request('screen').then(function (l) { lock = l; }).catch(function () {}); } catch (e) {} }
  function releaseScreen() { try { if (lock) { lock.release().catch(function () {}); lock = null; } } catch (e) {} }

  // ── the session ──
  var run = null, RING = 2 * Math.PI * 92;
  function setOrb(level) { if (!reduceMotion) $('pacerOrb').style.transform = 'scale(' + (0.55 + 0.45 * level).toFixed(3) + ')'; }
  function tick() {
    if (!run) return;
    var t = (performance.now() - run.startedAt) / 1000;
    var round = Math.floor(t / run.cycle);
    if (round >= run.rounds) { finish(); return; }
    var local = t - round * run.cycle, p = phaseAt(run.phases, local);
    var count = Math.max(1, Math.ceil(p.remaining - 1e-6));
    if (round !== run.lastRound) { $('pacerRound').textContent = 'Round ' + (round + 1) + ' of ' + run.rounds; run.lastRound = round; run.lastPhase = null; }
    if (p.index !== run.lastPhase) { $('pacerPhase').textContent = p.name; run.lastPhase = p.index; }
    if (count !== run.lastCount) { $('pacerCount').textContent = String(count); run.lastCount = count; }
    setOrb(breathLevel(run.phases, local));
    $('pacerRing').style.strokeDashoffset = (RING * (1 - t / (run.cycle * run.rounds))).toFixed(1);
    run.raf = requestAnimationFrame(tick);
  }
  function controls(running) {
    $('pacerStart').hidden = running; $('pacerStop').hidden = !running;
    $('pacerPattern').disabled = running; $('pacerRounds').disabled = running;
  }
  function currentPattern() {
    var root = $('breathing-pacer');
    return PATTERNS[$('pacerPattern').value] || PATTERNS[root.getAttribute('data-default')];
  }
  function start() {
    if (run) return;
    var pattern = currentPattern();
    var rounds = Math.max(1, Math.min(pattern.maxRounds, Math.round(Number($('pacerRounds').value)) || pattern.defaultRounds));
    run = { phases: pattern.phases, rounds: rounds, cycle: cycleSeconds(pattern.phases), startedAt: performance.now(), lastPhase: null, lastRound: -1, lastCount: null, raf: 0 };
    $('pacerRing').setAttribute('stroke-dasharray', RING.toFixed(1));
    $('pacerRing').style.strokeDashoffset = RING.toFixed(1);
    controls(true);
    if ($('pacerSound').checked) startAudio(0);
    holdScreen();
    note('breathing-pacer');
    run.raf = requestAnimationFrame(tick);
  }
  function finish() {
    var rounds = run.rounds; cancelAnimationFrame(run.raf); run = null;
    $('pacerPhase').textContent = 'Done';
    $('pacerRound').textContent = rounds + (rounds === 1 ? ' round' : ' rounds') + ' — that is plenty. Notice how you feel.';
    $('pacerCount').textContent = ''; setOrb(0); $('pacerRing').style.strokeDashoffset = '0';
    controls(false); releaseScreen();
    // the swell's own fade-out is already on the audio clock; the context closes after it
  }
  function stop() {
    if (!run) return;
    cancelAnimationFrame(run.raf); run = null;
    $('pacerPhase').textContent = 'Stopped'; $('pacerRound').textContent = ''; $('pacerCount').textContent = ''; setOrb(0);
    controls(false); releaseScreen(); stopAudio(0.4);
  }
  function rebuildRounds(pattern) {
    var sel = $('pacerRounds'); while (sel.firstChild) sel.removeChild(sel.firstChild);
    for (var n = 1; n <= pattern.maxRounds; n++) { var o = document.createElement('option'); o.value = String(n); o.textContent = String(n); if (n === pattern.defaultRounds) o.selected = true; sel.appendChild(o); }
  }
  function init() {
    var root = $('breathing-pacer'); if (!root) return;
    $('pacerForm').addEventListener('submit', function (e) { e.preventDefault(); start(); });
    $('pacerStop').addEventListener('click', stop);
    $('pacerPattern').addEventListener('change', function () { var p = currentPattern(); $('pacerNote').textContent = p.note; rebuildRounds(p); });
    $('pacerSound').addEventListener('change', function () {
      if (!run) return;
      if (this.checked) startAudio((performance.now() - run.startedAt) / 1000); else stopAudio(0.4);
    });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && run) holdScreen(); });
    window.addEventListener('pagehide', function () { if (run) stop(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
`;
