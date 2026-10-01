/**
 * The native app bridge (/native-bridge.js) and Android App Links.
 *
 * The bridge is a STRING the Worker serves; these tests execute those exact
 * bytes against a stub `window` — once as a plain browser (must do nothing) and
 * once as the Capacitor shell with fake plugins (must schedule check-ins, keep
 * the soundscape alive, and refuse to navigate off-origin).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import worker from '../index.js';
import { NATIVE_BRIDGE_SCRIPT, MAX_SCHEDULED, RECURRING_LOOKAHEAD, SOUNDSCAPE_NOTIFICATION_ID } from '../native-bridge.js';
import { ASSET_LINKS, ANDROID_PACKAGE, ANDROID_CERT_FINGERPRINTS } from '../assetlinks.js';
import { renderMePage } from '../me.js';

const repo = (p) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const env = { BUILD_SHA: 'abc1234', DB: undefined };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const get = (path) => worker.fetch(new Request(`https://focusbro.net${path}`), env, ctx);
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function makeDoc() {
  const listeners = {};
  const media = [];
  return {
    visibilityState: 'visible',
    media,
    documentElement: { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    dispatch(t) { (listeners[t] || []).forEach((fn) => fn({ type: t })); },
    querySelectorAll() { return media; },
  };
}

/** Run the served bytes against a stub window. `native` = fake Capacitor shell. */
function boot({ native = true, commitments = [], status = 200, display = 'granted', exact = 'granted', hasWakeLock = false, confirm = true } = {}) {
  const doc = makeDoc();
  const listeners = {};
  const on = (plugin) => (name, fn) => { listeners[`${plugin}:${name}`] = fn; return Promise.resolve({ remove() {} }); };
  const LN = {
    pending: [],
    scheduled: null,
    createChannel: vi.fn(() => Promise.resolve()),
    checkPermissions: vi.fn(() => Promise.resolve({ display })),
    requestPermissions: vi.fn(() => Promise.resolve({ display })),
    checkExactNotificationSetting: vi.fn(() => Promise.resolve({ exact_alarm: exact })),
    getPending() { return Promise.resolve({ notifications: this.pending }); },
    cancel: vi.fn(function (o) { const ids = o.notifications.map((n) => n.id); this.pending = this.pending.filter((n) => !ids.includes(n.id)); return Promise.resolve(); }),
    schedule: vi.fn(function (o) { this.scheduled = o.notifications; this.pending = o.notifications.map((n) => ({ id: n.id, extra: n.extra })); return Promise.resolve({ notifications: [] }); }),
    addListener: on('LN'),
  };
  const FS = {
    createNotificationChannel: vi.fn(() => Promise.resolve()),
    startForegroundService: vi.fn(() => Promise.resolve()),
    updateForegroundService: vi.fn(() => Promise.resolve()),
    stopForegroundService: vi.fn(() => Promise.resolve()),
    addListener: on('FS'),
  };
  const KA = { keepAwake: vi.fn(() => Promise.resolve()), allowSleep: vi.fn(() => Promise.resolve()) };
  const App = { addListener: on('App') };
  const fetch = vi.fn(() => Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve({ commitments }) }));
  const navigator = hasWakeLock ? { wakeLock: { request: 'native' } } : {};
  const assigned = [];
  const timers = [];
  const win = {
    document: doc,
    navigator,
    fetch,
    console: { warn() {} },
    localStorage: { s: {}, getItem(k) { return this.s[k] ?? null; }, setItem(k, v) { this.s[k] = String(v); } },
    location: { origin: 'https://focusbro.net', assign: (u) => assigned.push(u) },
    URL,
    confirm: vi.fn(() => confirm),
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    Capacitor: native ? {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: { LocalNotifications: LN, ForegroundService: FS, KeepAwake: KA, App },
    } : undefined,
  };
  new Function('window', NATIVE_BRIDGE_SCRIPT)(win);
  return { win, doc, LN, FS, KA, fetch, listeners, assigned, timers };
}

const inHours = (h) => new Date(Date.now() + h * 3600e3).toISOString();

describe('the bridge as served', () => {
  it('is served by the Worker as JavaScript and parses without bundler helpers', async () => {
    const res = await get('/native-bridge.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/javascript/);
    const body = await res.text();
    expect(body).toBe(NATIVE_BRIDGE_SCRIPT);
    expect(body).not.toMatch(/__name\(|__publicField|__esm\(/);
    expect(() => new Function(body)).not.toThrow();
  });

  it('is loaded by the app shell and by /me/ (one isolated tag each)', () => {
    const html = readFileSync(repo('public/index.html'), 'utf8');
    expect(html.match(/<script src="\/native-bridge\.js" defer><\/script>/g)).toHaveLength(1);
    expect(renderMePage()).toContain('<script src="/native-bridge.js" defer></script>');
  });

  it('does nothing at all in a normal browser', () => {
    const { win, fetch, doc } = boot({ native: false });
    expect(win.FocusBroNative).toBeUndefined();
    expect(win.fetch).toBe(fetch); // not wrapped
    expect(doc.documentElement.attrs).toEqual({});
    expect(win.navigator.wakeLock).toBeUndefined();
  });
});

describe('check-in schedule (plan)', () => {
  const { win } = boot();
  const plan = (cs) => win.FocusBroNative.plan(cs, Date.now(), TZ);

  it('schedules an active word at its next check-in on the high-importance channel', () => {
    const at = inHours(2);
    const [n, ...rest] = plan([{ id: 'c1', title: 'Write the intro', status: 'active', next_checkin: at, recurrence: 'none' }]);
    expect(rest).toEqual([]);
    expect(n.channelId).toBe('checkins');
    expect(n.interruptionLevel).toBe('timeSensitive');
    expect(n.title).toBe('Write the intro');
    expect(n.schedule.at.toISOString()).toBe(at);
    expect(n.schedule.allowWhileIdle).toBe(true);
    expect(n.extra).toEqual({ fb: 'checkin', commitmentId: 'c1', url: '/me/' });
    expect(n.id).toBeGreaterThan(0);
    expect(n.id).not.toBe(SOUNDSCAPE_NOTIFICATION_ID);
  });

  it('never schedules a paused / kept word, or a check-in already in the past', () => {
    expect(plan([
      { id: 'a', title: 'x', status: 'paused', next_checkin: inHours(1) },
      { id: 'b', title: 'x', status: 'kept', next_checkin: inHours(1) },
      { id: 'c', title: 'x', status: 'active', next_checkin: inHours(-1), recurrence: 'none' },
      { id: 'd', title: 'x', status: 'active', next_checkin: null, recurrence: 'none' },
    ])).toEqual([]);
  });

  it('pre-schedules a week of a daily word at its local time, after the pending one', () => {
    const next = new Date(); next.setDate(next.getDate() + 1); next.setHours(9, 30, 0, 0);
    const list = plan([{ id: 'd1', title: 'Run', status: 'active', next_checkin: next.toISOString(), recurrence: 'daily', local_time: '09:30', timezone: TZ }]);
    expect(list).toHaveLength(1 + RECURRING_LOOKAHEAD);
    for (const n of list) { expect(n.schedule.at.getHours()).toBe(9); expect(n.schedule.at.getMinutes()).toBe(30); }
    expect(new Set(list.map((n) => n.id)).size).toBe(list.length);
    expect(list[0].schedule.at.getTime()).toBe(next.getTime());
  });

  it('skips weekends for a weekdays word', () => {
    const list = plan([{ id: 'w1', title: 'Standup', status: 'active', next_checkin: null, recurrence: 'weekdays', local_time: '08:00', timezone: TZ }]);
    expect(list.length).toBe(RECURRING_LOOKAHEAD);
    for (const n of list) expect([0, 6]).not.toContain(n.schedule.at.getDay());
  });

  it('trusts only the server time when the word lives in another timezone', () => {
    const other = TZ === 'Pacific/Kiritimati' ? 'America/Adak' : 'Pacific/Kiritimati';
    const list = plan([{ id: 'z', title: 'x', status: 'active', next_checkin: inHours(3), recurrence: 'daily', local_time: '07:00', timezone: other }]);
    expect(list).toHaveLength(1);
  });

  it('stays under the iOS 64-pending ceiling, soonest first', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, title: 't', status: 'active', next_checkin: inHours(i + 1), recurrence: 'daily', local_time: '10:00', timezone: TZ }));
    const list = plan(many);
    expect(list.length).toBe(MAX_SCHEDULED);
    for (let i = 1; i < list.length; i++) expect(list[i].schedule.at.getTime()).toBeGreaterThanOrEqual(list[i - 1].schedule.at.getTime());
  });
});

describe('check-in schedule (device sync)', () => {
  it('replaces the device schedule from GET /api/commitments (cookie session)', async () => {
    const b = boot({ commitments: [{ id: 'c1', title: 'Ship it', status: 'active', next_checkin: inHours(1), recurrence: 'none' }] });
    b.LN.pending = [{ id: 42, extra: { fb: 'checkin' } }];
    const res = await b.win.FocusBroNative.sync();
    expect(res).toEqual({ scheduled: 1, exact: true });
    expect(b.fetch).toHaveBeenCalledWith('/api/commitments', expect.objectContaining({ credentials: 'same-origin' }));
    expect(b.LN.cancel).toHaveBeenCalledWith({ notifications: [{ id: 42 }] });
    expect(b.LN.createChannel).toHaveBeenCalledWith(expect.objectContaining({ id: 'checkins', name: 'Check-ins', importance: 5 }));
    expect(b.LN.scheduled).toHaveLength(1);
    expect(b.LN.scheduled[0].isExactNotification).toBe(true);
  });

  it('clears every scheduled check-in when the person is signed out (401)', async () => {
    const b = boot({ status: 401 });
    b.LN.pending = [{ id: 7, extra: { fb: 'checkin' } }];
    expect(await b.win.FocusBroNative.sync()).toEqual({ cleared: true });
    expect(b.LN.pending).toEqual([]);
    expect(b.LN.schedule).not.toHaveBeenCalled();
  });

  it('schedules nothing when notification permission is denied', async () => {
    const b = boot({ display: 'denied', commitments: [{ id: 'c1', title: 'x', status: 'active', next_checkin: inHours(1) }] });
    expect(await b.win.FocusBroNative.sync()).toEqual({ skipped: 'permission' });
    expect(b.LN.schedule).not.toHaveBeenCalled();
  });

  it('asks for exact alarms once, then schedules inexact instead of reopening Settings', async () => {
    const cs = [{ id: 'c1', title: 'x', status: 'active', next_checkin: inHours(1) }];
    const b = boot({ exact: 'denied', confirm: false, commitments: cs });
    expect((await b.win.FocusBroNative.sync()).exact).toBe(false);
    expect(b.win.confirm).toHaveBeenCalledTimes(1);
    await b.win.FocusBroNative.sync();
    expect(b.win.confirm).toHaveBeenCalledTimes(1);
  });

  it('re-syncs after the page changes a commitment, not after reads', async () => {
    const b = boot();
    const before = b.timers.length;
    await b.win.fetch('/api/commitments/abc/checkin', { method: 'POST' });
    await Promise.resolve();
    expect(b.timers.length).toBe(before + 1);
    await b.win.fetch('/api/commitments');
    await Promise.resolve();
    expect(b.timers.length).toBe(before + 1);
  });

  it('opens the check-in page on tap, and never navigates off-origin', () => {
    const b = boot();
    const tap = b.listeners['LN:localNotificationActionPerformed'];
    tap({ notification: { extra: { fb: 'checkin', url: '/me/' } } });
    tap({ notification: { extra: { fb: 'checkin', url: 'https://evil.example/me/' } } });
    tap({ notification: { extra: { fb: 'checkin', url: '//evil.example/x' } } });
    tap({ notification: { extra: { fb: 'checkin', url: '/\\evil.example/x' } } });
    expect(b.assigned).toEqual(['/me/']);
  });
});

describe('background soundscape + keep-awake', () => {
  it('starts a mediaPlayback foreground service while media plays and stops it when the person stops', async () => {
    const b = boot();
    const el = { paused: false, ended: false, pause() { this.paused = true; } };
    b.doc.media.push(el);
    b.doc.dispatch('playing');
    await new Promise((r) => setTimeout(r, 0));
    expect(b.FS.startForegroundService).toHaveBeenCalledWith(expect.objectContaining({ serviceType: 2, id: SOUNDSCAPE_NOTIFICATION_ID, notificationChannelId: 'soundscape' }));
    el.paused = true;
    b.doc.dispatch('pause');
    expect(b.FS.stopForegroundService).toHaveBeenCalledTimes(1);
  });

  it('keeps the service through a background pause (a Pomodoro break) and lets the Stop button end it', async () => {
    const b = boot();
    const el = { paused: false, ended: false, pause() { this.paused = true; } };
    b.doc.media.push(el);
    b.doc.dispatch('playing');
    await new Promise((r) => setTimeout(r, 0));
    b.doc.visibilityState = 'hidden';
    el.paused = true;
    b.doc.dispatch('pause');
    expect(b.FS.stopForegroundService).not.toHaveBeenCalled();
    expect(b.FS.updateForegroundService).toHaveBeenCalled();
    el.paused = false;
    b.win.stopAllSounds = vi.fn();
    b.listeners['FS:buttonClicked']({ buttonId: 1 });
    expect(b.win.stopAllSounds).toHaveBeenCalled();
    expect(el.paused).toBe(true);
    expect(b.FS.stopForegroundService).toHaveBeenCalledTimes(1);
  });

  it('backs navigator.wakeLock with KeepAwake only when the webview lacks it', async () => {
    const b = boot();
    const lock = await b.win.navigator.wakeLock.request('screen');
    expect(b.KA.keepAwake).toHaveBeenCalled();
    const onRelease = vi.fn();
    lock.addEventListener('release', onRelease);
    await lock.release();
    expect(onRelease).toHaveBeenCalled();
    expect(b.KA.allowSleep).toHaveBeenCalled();
    expect(boot({ hasWakeLock: true }).win.navigator.wakeLock.request).toBe('native');
  });

  it('marks the document as running inside the app', () => {
    expect(boot().doc.documentElement.attrs['data-native-app']).toBe('android');
  });
});

describe('Android App Links', () => {
  it('serves assetlinks.json for net.focusbro.app with the upload-key fingerprint', async () => {
    const res = await get('/.well-known/assetlinks.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual(ASSET_LINKS);
    expect(ANDROID_CERT_FINGERPRINTS.length).toBeGreaterThan(0); // an empty list verifies nothing, silently
    for (const fp of ANDROID_CERT_FINGERPRINTS) expect(fp).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it('agrees with the native project: same package, and the manifest claims only /me', () => {
    const cap = JSON.parse(readFileSync(repo('mobile/capacitor.config.json'), 'utf8'));
    expect(cap.appId).toBe(ANDROID_PACKAGE);
    expect(cap.server.url).toBe('https://focusbro.net');
    expect(cap.server.allowNavigation).toEqual(['focusbro.net']);
    const manifest = readFileSync(repo('mobile/android/app/src/main/AndroidManifest.xml'), 'utf8');
    const filter = manifest.match(/<intent-filter android:autoVerify="true">[\s\S]*?<\/intent-filter>/g);
    expect(filter).toHaveLength(1);
    expect(filter[0]).toContain('android:host="focusbro.net"');
    const paths = [...filter[0].matchAll(/android:(path|pathPrefix|pathPattern)="([^"]+)"/g)].map((m) => `${m[1]}=${m[2]}`);
    expect(paths).toEqual(['path=/me', 'pathPrefix=/me/']);
    expect(manifest).toContain('android:foregroundServiceType="mediaPlayback"');
    expect(manifest).toContain('android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK');
    const gradle = readFileSync(repo('mobile/android/app/build.gradle'), 'utf8');
    expect(gradle).toContain(`applicationId "${ANDROID_PACKAGE}"`);
  });
});
