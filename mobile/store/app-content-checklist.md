# Play Console "App content" forms for net.focusbro.app: what to click and what to paste

These forms have **no API**, for any app, ever (Factory `docs/runbooks/play-store-operations.md` §4).
Everything here was decided in advance by reading the code on 2026-10-03, so the console
session is clicking, not thinking. Location: Play Console → FocusBro → **Policy and
programs → App content**.

Data safety is **not** on this list. It's pushed by API from `data-safety.csv`
(`node mobile/store/push-listing.mjs`). Don't fill it in by hand.

---

## 1. Privacy policy

- **URL:** `https://focusbro.net/privacy.html`
- ⚠️ **Before you submit:** the live policy (last updated July 25, 2026) names only
  Cloudflare, still says "You can opt out of personalized advertising through Google
  controls" (left over from AdSense, which was retired in #371), and doesn't mention
  phone numbers, Telnyx, Stripe, Resend or account deletion. That contradicts the Data
  safety declaration, and Play reviews the two together. focusbro#379 rewrites the
  policy. **Merge and deploy #379 first.**

## 2. Ads

- **Does your app contain ads?** → **No, my app does not contain ads.**
  (AdSense code, hosts and cookies were removed in #371. Nothing in the shell serves ads.)

## 3. App access

- Pick **"All functionality in my app is available without any access restrictions."**
  - Why: the first screen works with no sign-in. Giving a word creates a guest account
    on the spot (`POST /auth/guest`), and the timer, sounds, breathing and weekly report
    all work for a guest.
  - Text check-ins need Pro, which is bought on the website and never in the app.
    Reviewers don't need it to judge the app, and the app shows no way to buy it.
- **If review comes back asking for access anyway** (for example, to the coach view),
  switch to "All or some functionality is restricted" and paste:

  > No login is needed. Open the app, type anything into "What are you avoiding?", pick
  > a time and tap "Give my word". That creates a private guest space and opens "Your
  > word", where the check-in for that word is listed. Tap "I did it" to see the kept-word
  > count and the weekly report (link at the top). The Focus tab has the timer; the
  > Restore tab has the sounds and the breathing guide. To test sign-in, use the account
  > below.

  …and add a test account. Create it yourself on https://focusbro.net/me/ → "Keep this
  word everywhere" (email + password). Don't let an agent create it in production.

## 4. Target audience and content

- **Target age groups:** select **18 and over** only.
  - Why not 13–17: the app offers text-message check-ins with phone numbers and quiet
    hours (TCPA consent flow), lets a coach see a person's momentum, and is written for
    adults. Including any under-18 group pulls in the Families policy and teen-specific
    review for no audience we serve.
- **Could the app unintentionally appeal to children?** → **No.** (No characters,
  games or child-oriented art. The 🧠 mark is a brain emoji on a teal tile.)
- No ads, so the ad-related follow-ups don't apply.

## 5. News apps

- **Is your app a news app?** → **No.**

## 6. Health apps declaration

Every app has to complete this now.

- **Does your app have health features?** → **Yes** (breathing, relaxation and focus
  tools count).
- Features to tick: **Stress management, relaxation, or mental acuity** (box / 4-7-8 /
  tactical breathing, 5-4-3-2-1 grounding, guided meditation timers, focus sessions).
- **Is your app a medical device / regulated?** → **No.** FocusBro is a wellness and
  productivity tool. It doesn't diagnose, monitor or address any condition, and the
  listing makes no medical claim (the `--dry-run` copy check enforces that).
- ⚠️ **Decide first: the Med Reminder card.** The dashboard has a "💊 Med Reminder —
  Track your medication & dopamine reset times" card (`public/index.html` ~line 2438).
  It only stores a dose time in local storage, and nothing leaves the phone. But it makes
  "**Medication and treatment management**" a feature you'd have to tick, which invites
  a closer health-policy review. Two options:
  - **(a) Recommended:** hide that card inside the app. It has no id today (`<!--
    MEDICATION REMINDER --> <div class="card" data-views="home">`), so give it one and
    add `html[data-native-app] #medCard { display: none }` (the bridge already sets
    `data-native-app`). Then tick only Stress management.
  - **(b)** Keep it, and also tick **Medication and treatment management**.

## 7. Government apps / Financial features / COVID-19

- **Government app?** → **No.**
- **Financial features** → **"My app doesn't provide any financial features."**
- **COVID-19 contact tracing or status app?** → **No** (if the console still shows it).

## 8. Advertising ID

- **Does your app use advertising ID?** → **No.** The manifest doesn't declare
  `com.google.android.gms.permission.AD_ID`, and no ads or analytics SDK is bundled.

## 9. Exact alarms (if the console asks)

The app requests `SCHEDULE_EXACT_ALARM`, which the person can grant or deny. It doesn't
request `USE_EXACT_ALARM`. If Play shows an exact-alarm declaration, choose the
**calendar / alarm-clock-style "user-set reminders"** use case and paste:

> FocusBro's core function is a check-in at the exact minute the user chooses. The user
> types a task and a time ("in 30 minutes", "tomorrow 9am", or a daily time), and the app
> schedules a local notification for that moment. The check-in is the product: if it
> arrives late, the person has usually already moved on. The app asks for the permission
> once, explains why, and falls back to inexact alarms if it's declined. Alarms are only
> ever scheduled for times the user picked.

## 10. Foreground service permissions (Android 14+)

The app declares one foreground service, type **`mediaPlayback`**
(`@capawesome-team/capacitor-android-foreground-service`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`).

- **Type:** Media playback.
- **Description to paste:**

  > FocusBro plays ambient soundscapes (rain, café, fireplace and similar recorded loops)
  > that the user starts during focus sessions. The media playback foreground service
  > keeps that user-started audio playing when the screen turns off or the user switches
  > apps. It shows an ongoing "Soundscape" notification with a Stop button. It starts
  > only when the user plays a sound and stops as soon as the user pauses or taps Stop.
  > Nothing else runs in this service.

- **User impact if it were deferred or stopped:** "The user's sound would cut out
  mid-session when the screen locks, which is the moment they rely on it most."
- **Video link (required):** an unlisted YouTube or Google Drive link, 30–60 s, recorded
  on a phone with the release build. Shot list:
  1. Open FocusBro → **Restore** tab → tap **Rainy café** (sound starts).
  2. Pull down the shade: the **Soundscape** notification with **Stop** is visible.
  3. Press the power button. Audio keeps playing (show the lock screen; the sound is
     audible in the recording).
  4. Unlock → tap **Stop** in the notification. Audio stops and the notification is gone.

  Screen-record with `adb shell screenrecord /sdcard/fgs.mp4`, or the phone's own screen
  recorder with "media sound" on. The machine can't make this video: it needs a
  physical phone.

## 11. Store settings (Main store listing → Store settings)

- **App category:** Productivity
- **Tags:** Productivity · Habit tracker · Meditation (pick the closest the console offers)
- **Contact email:** `support@focusbro.net` · **Website:** `https://focusbro.net`
  (these are also pushed by `push-listing.mjs` via `edits.details`).
