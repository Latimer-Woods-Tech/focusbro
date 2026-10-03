---
verified: "2026-10-01"
verified_by: agent (local Gradle build, apksigner/aapt2, Android 14 emulator, Firebase API read-back)
last_updated: "2026-10-01"
---

# FocusBro — native app (Android first, iOS-ready)

FocusBro's promise is *the nudge that reaches you at the moment you said*. On the
web that promise leaks: iPhone push only works for a home-screen PWA, web push
can't break through Focus/Do Not Disturb, and a soundscape stops when the screen
locks. The app exists to close those gaps — and to be findable in store search.

## Architecture

```
mobile/                         Capacitor 8 shell (own package.json — the site's deps are untouched)
  capacitor.config.json         appId net.focusbro.app · server.url https://focusbro.net · allowNavigation [focusbro.net]
  www/offline.html              shown (server.errorPath) only if the live site cannot load at all
  android/                      generated native project + our edits (manifest, signing, icons, theme)
  ios/                          generated native project (SPM) + background audio + time-sensitive entitlement
  scripts/generate-assets.mjs   icons + splash from the brand mark (npm run icons)
  scripts/firebase-distribute.sh tester distribution (Firebase App Distribution)
api/src/native-bridge.js        the web half: served at /native-bridge.js, loaded by / and /me/
api/src/assetlinks.js           /.well-known/assetlinks.json for App Links
```

**Remote-URL shell, same as Capricast.** The webview loads `https://focusbro.net`
itself (Capricast does the same with capricast.com; SELF:PRIME bundles its SPA
instead). Consequences, all deliberate:

- **Web deploys are app updates.** A new store build is needed only when the
  *native* shell changes (plugins, manifest, icons). FocusBro's UI is a single
  server-rendered page that changes daily — bundling it would freeze every
  installed copy at its build date.
- **No stale client can swallow a link.** SELF:PRIME's bundled SPA means an old
  build intercepts a new `/open/` route and drops it. Here a claimed path always
  renders whatever the site serves today.
- Navigation is limited to `focusbro.net`; any other host (Stripe, docs, socials)
  opens in the system browser.
- The Capacitor bridge is injected into the live page, so the website talks to
  native plugins through `window.Capacitor.Plugins` — the Capricast pattern.

### The bridge (`/native-bridge.js`)

One `<script src="/native-bridge.js" defer>` line in `public/index.html` and in
`/me/` (kept as a single isolated line so concurrent work on `index.html` rebases
trivially). In a browser it returns on its first line — the site is unchanged.
In the app it does three things, all with maintained plugins:

| Need | How | Plugin |
|---|---|---|
| Check-in at the minute chosen | Local notifications on Android channel **"Check-ins"** (importance HIGH), iOS `timeSensitive`, exact alarms | `@capacitor/local-notifications` |
| Soundscape with the screen off | `mediaPlayback` foreground service + ongoing "Soundscape" notification with **Stop** | `@capawesome-team/capacitor-android-foreground-service` |
| Screen stays awake | `navigator.wakeLock` backed by the plugin **only if** the webview lacks it (Android 14 WebView has it natively) | `@capacitor-community/keep-awake` |

It also sets `data-native-app="android|ios"` on `<html>` so the site can adapt
when it needs to (see the Play billing note below).

**Check-ins: local scheduling now, FCM later — why.** The server's cron delivers
check-ins as *web push*, and an Android WebView cannot receive web push. Two
options: (a) FCM push from the Worker (the estate has it — Factory
`@latimer-woods-tech/push` has an FCM v1 sender), or (b) schedule on the device
from the commitments API. v1 uses **(b)**:

- It needs no server change, no new secret, no D1 migration, and nothing in the
  production cron path — the app ships without touching delivery for web users.
- It is *more* punctual than push: an exact alarm fires at the minute, offline,
  through doze; push depends on network and FCM priority.
- The server stays the source of truth. Every sync reads `GET /api/commitments`
  (cookie session, plus the legacy bearer token if present) and **replaces** the
  device schedule: active words with a future `next_checkin` are scheduled;
  daily/weekdays words also get their next 7 occurrences at `local_time`
  (only when the word's timezone is the phone's). Paused/kept/released words and
  past check-ins are never scheduled. A 401 clears everything (signed out).
- Sync runs on load, on app resume, on visibility, and ~400 ms after any
  non-GET request to `/api/commitments*` (observed at the `fetch` boundary, so
  `me.js` is unchanged).

Known v1 limits, and when to add FCM: a word created on *another* device is not
on this phone until the app is next opened; and the server still records the
web-push attempt (`no_subscription`) for an app-only user, so `/me/` shows the
warm "still here" door after a check-in the phone already delivered. When either
matters, add FCM: register a device token (`@capacitor/push-notifications`,
`google-services.json` for app `1:891842778224:android:be1f87f7a29fa1d836d0b5`),
store it beside web-push subscriptions, and send via `@latimer-woods-tech/push`
from `checkins-cron.js`.

**Exact alarms (Android 12+).** `SCHEDULE_EXACT_ALARM` is denied by default on
Android 14 for new installs. The bridge asks once, with a reason, before the
plugin opens "Alarms & reminders"; if declined it schedules inexact alarms and
never bounces the person into Settings again. Play Console will ask for an
exact-alarm declaration — the answer is in the founder steps.

**Soundscape.** The bridge listens (capture phase) for `playing` / `pause` /
`ended` on any `<audio>`/`<video>`. The current engine routes the soundscape
through `<audio id="soundscapeOut">`, so it is covered; **any future sound engine
must also play through a media element** (Web Audio straight to
`ctx.destination` is invisible to the bridge). A pause while the page is visible
stops the service at once; a pause in the background (a Pomodoro break) keeps it
for 20 minutes so the next focus block can bring the mix back. Stop on the
notification calls the page's `stopAllSounds()` and pauses every media element.

### App Links

The manifest claims **only** `https://focusbro.net/me` and `/me/*` with
`autoVerify` — `/me` exact and `/me/` as a prefix, so a future `/media` is not
claimed. Matching is path-only (a `?query` is invisible), and a claim lasts as
long as the build is installed, so widen it only on purpose.
`/.well-known/assetlinks.json` lists the **upload key** SHA-256
(`74:D3:5D:4A:…:A6:E5`). Builds installed from **Play** are re-signed by Google,
so after the first Play upload read the Play App Signing certificate by API —
`GET /androidpublisher/v3/applications/net.focusbro.app/generatedApks/{versionCode}`
→ `certificateSha256Hash` — and append it to `api/src/assetlinks.js`. Verify from
Google's side:
`https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://focusbro.net&relation=delegate_permission/common.handle_all_urls`.

iOS universal links are **not** wired yet (needs the Team ID, an
`apple-app-site-association` file and the Associated Domains capability).

## Build and release

| What | How |
|---|---|
| Local debug build | `cd mobile && npm ci && npx cap sync android && cd android && ./gradlew assembleDebug` (JDK 21, Android SDK 36) |
| Icons / splash | `cd mobile && npm run icons` (source: `mobile/assets/noto-brain.svg`, Noto Emoji U+1F9E0, Apache-2.0) |
| Signed release | Actions → **Android Release** → Run workflow (or push tag `android-vX.Y.Z`). Produces `…-release.aab` and `…-sideload.apk` artifacts, verified in-job: signer = upload key, package, versionCode, App Link host |
| Testers | Same workflow with `distribute_to` = comma-separated emails → Firebase App Distribution. Or locally: `mobile/scripts/firebase-distribute.sh <apk> "<notes>" <emails>` |
| PR check | Any PR touching `mobile/**` runs the same signed build (no distribution) |
| iOS | Actions → **iOS Release**: always a simulator build; archive + TestFlight upload only once the ASC key exists (below) |

`versionCode` = 10000 + workflow run number (monotonic; Play rejects reuse).
Signing material lives only in GCP Secret Manager (`factory-495015`), read by
`factory-sa` via WIF:

| Secret | What |
|---|---|
| `focusbro-android-keystore-b64` | base64 PKCS12 **upload** keystore, alias `focusbro-upload`, RSA 4096, valid to 2054 |
| `focusbro-android-keystore-password` | store password = key password |

Firebase: Android app `net.focusbro.app` = `1:891842778224:android:be1f87f7a29fa1d836d0b5`
in project `factory-495015` (number **891842778224** — the App Distribution API
rejects the project ID with 400), upload-key SHA-256 registered.

> Trap: right after an Android app is registered in Firebase, App Distribution
> answers `releases:upload` with **503** and `releases` with **404** for roughly
> half an hour. It is propagation, not a broken recipe — the same call returned
> 200 about 30 minutes later. First build distributed 2026-10-01: CI run
> 36894659397, v0.1.0 (10001), release `4os3te96nsnn8`. The upload operation ID
> equals the APK's SHA-256, so it is provably the CI artifact.

## Founder steps (console-only — no API exists for these)

### Google Play (app `net.focusbro.app`)

> **The full launch checklist and the store kit live in [`PLAY_LAUNCH.md`](./PLAY_LAUNCH.md)**
> (listing, graphics, data-safety CSV, console answers, `mobile/store/push-listing.mjs`).
> Where the summary below differs (for example App access: the guest flow needs no
> test account), PLAY_LAUNCH.md and `mobile/store/app-content-checklist.md` are current.

1. **Create the app** in Play Console: name *FocusBro*, default language
   English (US), App, Free. The package name is fixed by the first upload and must
   be exactly `net.focusbro.app`.
2. **Users and permissions** → `play-store-publisher@factory-495015.iam.gserviceaccount.com`
   → *Add app* → FocusBro (release + store-presence permissions). After this
   every remaining step below except the App content forms can be done by machine.
3. **App content** forms (console-only, forever): Privacy policy URL
   (`https://focusbro.net/privacy.html`) · Ads (**No** — AdSense was
   retired in #371) · App access (sign-in needed for check-ins → provide a test account) ·
   Content rating questionnaire · Target audience (18+) · News app (No) ·
   Health apps declaration (a wellness tool — *not* a medical device) ·
   Government / Financial features (No) · **Exact alarm** permission
   declaration: core function is user-set reminders at a chosen time.
   Data safety is **API-writable** (`applications.dataSafety`, see Factory
   `docs/runbooks/play-store-operations.md` §3) — do not fill it by hand.
4. **Testers**: Play's internal-tester list is console-only and takes Google
   Groups only. Firebase App Distribution is the front door meanwhile.
5. Production access on a personal developer account needs a **closed test with
   12+ opted-in testers for 14 consecutive days**.

⚠️ **Play billing policy.** Pro is a digital subscription sold through Stripe on
the website. Google Play requires Play Billing for digital goods bought *inside*
the app. Before a production release, decide: hide purchase/upgrade surfaces
when `html[data-native-app]` is set (simplest), or integrate Play Billing.
Today no upgrade button is visible in the app shell or `/me/`, but confirm
before submission.

### Apple (iOS — not started)

1. **Register the bundle ID** `net.focusbro.app` (Certificates, Identifiers &
   Profiles → Identifiers) with capabilities: **Time Sensitive Notifications**
   (and later Push Notifications, Associated Domains).
2. **Create the app** in App Store Connect with that bundle ID.
3. **Create an App Store Connect API key**: Users and Access → Integrations →
   App Store Connect API → Team Keys → *Generate*, role **App Manager**. Download
   the `.p8` (one chance only).
4. Store all three in GCP Secret Manager `factory-495015` with `printf '%s'`
   (no trailing newline) and grant `factory-sa` *Secret Manager Secret Accessor*:
   `ASC_KEY_ID` (10-char key ID), `ASC_ISSUER_ID` (issuer UUID shown above the
   key list), `ASC_PRIVATE_KEY` (full `.p8` contents).
   The existing `APPLE_CLIENT_ID/KEY_ID/PRIVATE_KEY/TEAM_ID` secrets are
   SELF:PRIME's Sign in with Apple key and **cannot** do this.
5. Run **iOS Release**. iOS background audio additionally needs the app's
   `AVAudioSession` category set to playback — verify on a device; not yet done.

## What has and has not been verified (2026-10-01)

Verified: the release APK/AAB build locally and are signed by the upload key
(`apksigner verify` exit 0, `jarsigner` "jar verified"); `aapt2` shows
`net.focusbro.app`, target SDK 36, the permissions above, the `/me` App Link
filter, and the `mediaPlayback` service. On an **Android 14 emulator**: the app
installs and loads focusbro.net; with the bridge injected (debug build,
remote debugging) it scheduled 8 check-ins from a stubbed commitments list as
exact `RTC_WAKEUP` alarms, the first one fired on the `checkins` channel at
importance 5, tapping it opened `/me/`, and a playing `<audio>` element started
the foreground service (`types=0x2`) and kept playing for 25 s with the screen
asleep (process not frozen), then stopped when paused.

Not verified: a real phone; real accounts end to end (the bridge is not live
until this branch deploys); App Link verification (`assetlinks.json` is not
live until deploy — state `1024` = unverified on the emulator); the offline page
(the site's service worker served the cached shell offline instead, which is
the better outcome); anything on iOS.
