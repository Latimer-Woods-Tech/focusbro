/**
 * /native-bridge.js — the web half of the FocusBro native app (mobile/).
 *
 * The app is a Capacitor shell in REMOTE-URL mode: it loads https://focusbro.net
 * itself, so the website IS the app's UI and every web deploy updates it. This
 * script is what lets that website use the phone:
 *
 *   1. Check-in reminders as LOCAL notifications, scheduled on the device for the
 *      exact moment the person chose (high-importance Android channel
 *      "Check-ins"; iOS `timeSensitive`). Source of truth stays the server:
 *      every sync reads GET /api/commitments and REPLACES the device schedule.
 *      Recurring words get their next occurrences pre-scheduled (a week ahead),
 *      so the nudge still arrives if the app is not opened.
 *   2. Background soundscape: when any <audio>/<video> on the page starts
 *      playing, an Android mediaPlayback foreground service (ongoing
 *      notification with a Stop button) keeps the process alive with the screen
 *      off; it stops when playback stops.
 *   3. Keep-awake: if the webview has no Screen Wake Lock API, navigator.wakeLock
 *      is provided by the KeepAwake plugin, so the page's existing
 *      "keep screen awake" code works unchanged.
 *
 * In a normal browser `window.Capacitor` does not exist and this script returns
 * on its first line — the website is unchanged.
 *
 * Shipped as a STRING, never Function.prototype.toString(): the Worker bundler
 * rewrites declarations with its own `__name` helper and reflected source then
 * throws in the browser (learned in production, see guides/scripts.js). Every
 * global is reached through `window` so the tests can run it against a stub.
 */

import { checkinActionLabels } from './me.js';

/** Notification id of the soundscape foreground service (outside the check-in id range). */
export const SOUNDSCAPE_NOTIFICATION_ID = 7001;

/** How many future occurrences of a recurring word are pre-scheduled on the device. */
export const RECURRING_LOOKAHEAD = 7;

/** iOS keeps at most 64 pending local notifications per app; stay under it. */
export const MAX_SCHEDULED = 60;

// The two answers on the notification — the same two the /me/ card leads with,
// in the same words (parity with the web push, #386). One source for the labels.
const LABELS = checkinActionLabels();

export const NATIVE_BRIDGE_SCRIPT = `(function () {
  'use strict';
  var w = window;
  var C = w.Capacitor;
  if (!C || typeof C.isNativePlatform !== 'function' || !C.isNativePlatform()) return;
  if (w.FocusBroNative) return;

  var d = w.document;
  var P = C.Plugins || {};
  var platform = typeof C.getPlatform === 'function' ? C.getPlatform() : 'native';
  var LN = P.LocalNotifications, FS = P.ForegroundService, KA = P.KeepAwake, AppP = P.App;
  var CHANNEL_ID = 'checkins';
  var ACTION_TYPE = 'checkin';
  var SOUND_CHANNEL_ID = 'soundscape';
  var SOUND_ID = ${SOUNDSCAPE_NOTIFICATION_ID};
  var LOOKAHEAD = ${RECURRING_LOOKAHEAD};
  var MAX = ${MAX_SCHEDULED};
  var EXACT_ASKED_KEY = 'focusbro_native_exact_asked';
  var PAUSE_GRACE_MS = 20 * 60 * 1000;

  try { d.documentElement.setAttribute('data-native-app', platform); } catch (e) {}

  function lsGet(k) { try { return w.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { w.localStorage.setItem(k, v); } catch (e) {} }
  function warn(msg, e) { try { w.console.warn('[native] ' + msg, e && e.message ? e.message : e); } catch (x) {} }

  // ── Check-in schedule (pure) ───────────────────────────────────────────────
  // Positive 31-bit id from a string; never collides with the soundscape id.
  function hashId(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    h = h & 0x7fffffff;
    if (h === 0 || h === SOUND_ID) h = h + 1;
    return h;
  }

  function parseHM(v) {
    var m = /^(\\d{1,2}):(\\d{2})$/.exec(String(v || ''));
    if (!m) return null;
    var hh = +m[1], mm = +m[2];
    if (hh > 23 || mm > 59) return null;
    return { h: hh, m: mm };
  }

  function clip(s, n) { s = String(s == null ? '' : s).trim(); return s.length > n ? s.slice(0, n - 1) + '\\u2026' : s; }

  // FBQ-02: each notification carries the occurrence it was scheduled for, so
  // its answer resolves THAT row, never a later day's. The server's next row is
  // bound by its id (checkinId); a later day pre-scheduled here has no row yet,
  // so it is bound by its own instant (occurrenceAt, matched to that local day).
  function notification(c, atMs, slot, checkinId) {
    var title = clip(c.title, 60) || 'Your check-in';
    var extra = { fb: 'checkin', commitmentId: String(c.id), url: '/me/?word=' + encodeURIComponent(String(c.id)), occurrenceAt: new Date(atMs).toISOString() };
    if (checkinId) extra.checkinId = String(checkinId);
    return {
      id: hashId(String(c.id) + ':' + slot),
      title: title,
      body: 'This is the moment you picked. Tap to tell me how it went.',
      channelId: CHANNEL_ID,
      smallIcon: 'ic_stat_focusbro',
      iconColor: '#14b8a6',
      interruptionLevel: 'timeSensitive',
      autoCancel: true,
      actionTypeId: ACTION_TYPE,
      schedule: { at: new Date(atMs), allowWhileIdle: true },
      // A tap lands on THIS word, never the toolkit (the web push does the same).
      extra: extra
    };
  }

  // commitments: rows from GET /api/commitments. Returns notification specs,
  // soonest first, capped at MAX. Only ACTIVE words with a FUTURE check-in are
  // scheduled — an already-past check-in is the page's "still here" door, never
  // a late buzz.
  function plan(commitments, nowMs, deviceTz) {
    var out = [];
    (commitments || []).forEach(function (c) {
      if (!c || c.status !== 'active' || !c.id) return;
      var next = c.next_checkin ? Date.parse(c.next_checkin) : NaN;
      if (isFinite(next) && next > nowMs) out.push(notification(c, next, 'next', c.next_checkin_id));
      var rec = c.recurrence;
      var hm = parseHM(c.local_time);
      // Pre-schedule the following occurrences of a recurring word, in local
      // wall-clock time (DST-correct via Date). Only when the word's timezone is
      // the phone's — otherwise the server's next_checkin is the only truth.
      if ((rec === 'daily' || rec === 'weekdays') && hm && (!c.timezone || c.timezone === deviceTz)) {
        // From the day AFTER the pending check-in (that one is scheduled above),
        // or from TODAY when there is no future pending one.
        var hasNext = isFinite(next) && next > nowMs;
        var base = new Date(hasNext ? next : nowMs);
        var added = 0;
        for (var i = hasNext ? 1 : 0; i <= LOOKAHEAD * 2 && added < LOOKAHEAD; i++) {
          var t = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, hm.h, hm.m, 0, 0);
          var dow = t.getDay();
          if (rec === 'weekdays' && (dow === 0 || dow === 6)) continue;
          if (t.getTime() <= nowMs) continue;
          out.push(notification(c, t.getTime(), 'r' + t.getFullYear() + '-' + (t.getMonth() + 1) + '-' + t.getDate()));
          added++;
        }
      }
    });
    out.sort(function (a, b) { return a.schedule.at.getTime() - b.schedule.at.getTime(); });
    var seen = {};
    return out.filter(function (n) { if (seen[n.id]) return false; seen[n.id] = 1; return true; }).slice(0, MAX);
  }

  // ── Check-in schedule (device) ─────────────────────────────────────────────
  var channelReady = null;
  function ensureChannel() {
    if (!LN || platform !== 'android' || typeof LN.createChannel !== 'function') return Promise.resolve();
    if (!channelReady) {
      channelReady = LN.createChannel({
        id: CHANNEL_ID, name: 'Check-ins',
        description: 'The nudge at the moment you said',
        importance: 5, visibility: 1, vibration: true, lights: true, lightColor: '#14b8a6'
      }).catch(function (e) { channelReady = null; warn('channel', e); });
    }
    return channelReady;
  }

  function cancelOurs() {
    if (!LN) return Promise.resolve();
    return LN.getPending().then(function (res) {
      var ours = ((res && res.notifications) || []).filter(function (n) {
        // Older Android builds of the plugin drop extra on pending reads; every
        // local notification this app schedules is a check-in, so no extra = ours.
        return !n.extra || n.extra.fb === 'checkin';
      }).map(function (n) { return { id: n.id }; });
      return ours.length ? LN.cancel({ notifications: ours }) : null;
    });
  }

  function ensurePermission() {
    return LN.checkPermissions().then(function (s) {
      if (s && s.display === 'granted') return true;
      if (s && s.display === 'denied') return false;
      return LN.requestPermissions().then(function (r) { return !!(r && r.display === 'granted'); });
    });
  }

  // Exact alarms (Android 12+): without one a check-in can land minutes late
  // inside a doze window. The plugin opens the "Alarms & reminders" screen when
  // asked to schedule an exact alarm it may not use — so ask ONCE, with a
  // reason, and after that schedule inexact rather than bounce the person into
  // Settings on every launch.
  function exactMode() {
    if (platform !== 'android' || typeof LN.checkExactNotificationSetting !== 'function') return Promise.resolve(true);
    return LN.checkExactNotificationSetting().then(function (s) {
      if (s && s.exact_alarm === 'granted') return true;
      if (lsGet(EXACT_ASKED_KEY)) return false;
      lsSet(EXACT_ASKED_KEY, '1');
      var ok = false;
      try { ok = w.confirm('To reach you at the exact minute you chose, FocusBro needs "Alarms & reminders". Turn it on in the next screen?'); } catch (e) { ok = false; }
      return ok;
    }).catch(function () { return false; });
  }

  var syncing = false, again = false;
  function sync() {
    if (!LN) return Promise.resolve({ skipped: 'no-plugin' });
    if (syncing) { again = true; return Promise.resolve({ skipped: 'in-flight' }); }
    syncing = true;
    var headers = { Accept: 'application/json' };
    var legacy = lsGet('focusbro_token');
    if (legacy) headers.Authorization = 'Bearer ' + legacy;
    var tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
    return w.fetch('/api/commitments', { credentials: 'same-origin', cache: 'no-store', headers: headers })
      .then(function (r) {
        // Signed out: nothing of theirs should still buzz on this phone.
        if (r.status === 401) return cancelOurs().then(function () { return { cleared: true }; });
        if (!r.ok) return { skipped: 'http-' + r.status };
        return r.json().then(function (data) {
          var list = plan((data && data.commitments) || [], Date.now(), tz);
          if (!list.length) return cancelOurs().then(function () { return { scheduled: 0 }; });
          return ensurePermission().then(function (granted) {
            if (!granted) return { skipped: 'permission' };
            return ensureChannel().then(exactMode).then(function (exact) {
              list.forEach(function (n) { n.isExactNotification = exact; });
              return cancelOurs().then(function () { return LN.schedule({ notifications: list }); })
                .then(function () { return { scheduled: list.length, exact: exact }; });
            });
          });
        });
      })
      .catch(function (e) { warn('sync', e); return { skipped: 'error' }; })
      .then(function (res) {
        syncing = false;
        if (again) { again = false; later(); }
        return res;
      });
  }

  var timer = null;
  function later() { if (timer) w.clearTimeout(timer); timer = w.setTimeout(function () { timer = null; sync(); }, 400); }

  // Re-sync after the page changes a commitment (create / check in / snooze /
  // pause / edit …) — observed at the fetch boundary so no page code changes.
  if (typeof w.fetch === 'function') {
    var origFetch = w.fetch;
    w.fetch = function (input, init) {
      var p = origFetch.apply(this, arguments);
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        if (method !== 'GET' && /\\/api\\/commitments(\\/|$|\\?)/.test(url)) {
          p.then(function () { later(); }, function () {});
        }
      } catch (e) {}
      return p;
    };
  }

  // Tapping a check-in opens the page where it is answered. Same-origin only:
  // resolve and compare the ORIGIN (a prefix test misses '/\\\\evil' spellings).
  function openSafe(url) {
    try {
      var u = new w.URL(String(url || '/me/'), w.location.origin);
      if (u.origin !== w.location.origin) return;
      w.location.assign(u.pathname + u.search + u.hash);
    } catch (e) {}
  }
  // The buttons on the check-in notification. Registered once per boot; an
  // older plugin without registerActionTypes simply shows a plain notification.
  if (LN && typeof LN.registerActionTypes === 'function') {
    LN.registerActionTypes({ types: [{ id: ACTION_TYPE, actions: [
      { id: 'kept', title: ${JSON.stringify(LABELS.kept)} },
      { id: 'not-yet', title: ${JSON.stringify(LABELS.missed)} }
    ] }] }).catch(function (e) { warn('action types', e); });
  }
  if (LN && typeof LN.addListener === 'function') {
    LN.addListener('localNotificationActionPerformed', function (ev) {
      var n = ev && ev.notification;
      if (!n || !n.extra || n.extra.fb !== 'checkin') return;
      var url = n.extra.url || '/me/';
      var id = n.extra.commitmentId;
      if (ev.actionId === 'kept' && id) {
        // "I did it" on the notification itself: the webview holds the session,
        // so the in-app route answers it — same path, same ledger, same copy as
        // the card's button — and the fetch wrapper above re-plans the schedule.
        // If it cannot be answered here (offline, signed out), or the server
        // wrote nothing (recorded:false — FBQ-01), land on the word.
        // The occurrence rides along (FBQ-02); a notification scheduled by an
        // older script carries neither and keeps the soonest-due behaviour.
        var answer = { outcome: 'kept' };
        if (n.extra.checkinId) answer.checkin_id = n.extra.checkinId;
        if (n.extra.occurrenceAt) answer.occurrence_at = n.extra.occurrenceAt;
        w.fetch('/api/commitments/' + encodeURIComponent(id) + '/checkin', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(answer)
        }).then(function (r) {
          if (!r || !r.ok) return openSafe(url);
          return r.json().then(function (j) { if (j && j.recorded === false) openSafe(url); }, function (e) { warn('checkin answer', e); });
        }, function () { openSafe(url); });
        return;
      }
      if (ev.actionId === 'not-yet') {
        // The person's answer, honored on /me/ exactly as the card's own "Not yet".
        openSafe(url + (url.indexOf('?') >= 0 ? '&' : '?') + 'answer=not-yet');
        return;
      }
      openSafe(url);
    });
  }

  // ── Background soundscape (Android foreground service) ─────────────────────
  var fgsOn = false, stopTimer = null, soundChannel = null;
  function mediaPlaying() {
    var els = d.querySelectorAll('audio, video');
    for (var i = 0; i < els.length; i++) { if (!els[i].paused && !els[i].ended) return true; }
    return false;
  }
  function fgsOptions(body) {
    return {
      id: SOUND_ID, title: 'Soundscape', body: body,
      smallIcon: 'ic_stat_focusbro', silent: true,
      notificationChannelId: SOUND_CHANNEL_ID,
      serviceType: 2, // ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
      buttons: [{ id: 1, title: 'Stop' }]
    };
  }
  function ensureSoundChannel() {
    if (!soundChannel) {
      soundChannel = FS.createNotificationChannel({
        id: SOUND_CHANNEL_ID, name: 'Soundscape',
        description: 'Shows while your soundscape plays with the screen off', importance: 2
      }).catch(function (e) { soundChannel = null; warn('sound channel', e); });
    }
    return soundChannel;
  }
  function fgsStart() {
    if (stopTimer) { w.clearTimeout(stopTimer); stopTimer = null; }
    var opts = fgsOptions('Playing — keeps going with the screen off.');
    return ensureSoundChannel().then(function () {
      var call = fgsOn && typeof FS.updateForegroundService === 'function' ? FS.updateForegroundService(opts) : FS.startForegroundService(opts);
      fgsOn = true;
      return call;
    }).catch(function (e) { warn('fgs start', e); });
  }
  function fgsStop() {
    if (stopTimer) { w.clearTimeout(stopTimer); stopTimer = null; }
    if (!fgsOn) return Promise.resolve();
    fgsOn = false;
    return FS.stopForegroundService().catch(function (e) { warn('fgs stop', e); });
  }
  function onMediaStop() {
    if (!fgsOn || mediaPlaying()) return;
    // Visible: the person stopped it themselves — clear the notification now.
    // Hidden: likely a Pomodoro break; the bell brings the mix back with the
    // next block, so keep the process alive for a grace period.
    if (d.visibilityState === 'visible') { fgsStop(); return; }
    if (typeof FS.updateForegroundService === 'function') {
      FS.updateForegroundService(fgsOptions('Paused — resumes with your next focus block.')).catch(function () {});
    }
    if (!stopTimer) stopTimer = w.setTimeout(function () { stopTimer = null; if (!mediaPlaying()) fgsStop(); }, PAUSE_GRACE_MS);
  }
  if (FS && platform === 'android') {
    d.addEventListener('playing', function () { fgsStart(); }, true);
    ['pause', 'ended', 'emptied'].forEach(function (t) { d.addEventListener(t, onMediaStop, true); });
    if (typeof FS.addListener === 'function') {
      FS.addListener('buttonClicked', function (ev) {
        if (!ev || ev.buttonId !== 1) return;
        try { if (typeof w.stopAllSounds === 'function') w.stopAllSounds(); } catch (e) {}
        var els = d.querySelectorAll('audio, video');
        for (var i = 0; i < els.length; i++) { try { els[i].pause(); } catch (e) {} }
        fgsStop();
      });
    }
  }

  // ── Keep-awake: Screen Wake Lock API backed by the KeepAwake plugin ────────
  var nav = w.navigator;
  if (KA && nav && !('wakeLock' in nav)) {
    try {
      Object.defineProperty(nav, 'wakeLock', {
        configurable: true,
        value: {
          request: function () {
            return KA.keepAwake().then(function () {
              var listeners = [];
              var sentinel = {
                type: 'screen', released: false, onrelease: null,
                addEventListener: function (t, fn) { if (t === 'release' && typeof fn === 'function') listeners.push(fn); },
                removeEventListener: function (t, fn) { listeners = listeners.filter(function (f) { return f !== fn; }); },
                release: function () {
                  if (sentinel.released) return Promise.resolve();
                  sentinel.released = true;
                  var ev = { type: 'release', target: sentinel };
                  listeners.concat(sentinel.onrelease ? [sentinel.onrelease] : []).forEach(function (fn) { try { fn(ev); } catch (e) {} });
                  return KA.allowSleep();
                }
              };
              return sentinel;
            });
          }
        }
      });
    } catch (e) { warn('wakeLock', e); }
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────
  if (AppP && typeof AppP.addListener === 'function') AppP.addListener('resume', function () { later(); });
  d.addEventListener('visibilitychange', function () { if (d.visibilityState === 'visible') later(); });

  w.FocusBroNative = { platform: platform, sync: sync, plan: plan, hashId: hashId };
  later();
})();
`;
