---
verified: "2026-10-03"
verified_by: agent (kit dry-run, local Worker capture, code read; no Play write API called)
last_updated: "2026-10-03"
---

# FocusBro on Google Play: from "app created" to production

Package **`net.focusbro.app`**. Today (2026-10-03) the Publisher API answers **404** for
it: the app doesn't exist in Play Console yet, and no API can create one. Everything
that can be prepared without the app record is already in the repo:

| What | Where | How it reaches Play |
|---|---|---|
| Title, short + full description, release notes | `mobile/store/listing/en-US/` | `push-listing.mjs` (API) |
| Icon 512, feature graphic 1024×500, 7 phone screenshots 1080×1920 | `mobile/store/icon-512.png`, `mobile/store/graphics/` | `push-listing.mjs` (API) |
| Data safety declaration | `mobile/store/data-safety.csv` (built by `build-data-safety.mjs`) | `push-listing.mjs` → `applications.dataSafety` (API) |
| Content rating answers | `mobile/store/content-rating-answers.md` | Console (no API) |
| Every other App content form, with text to paste | `mobile/store/app-content-checklist.md` | Console (no API) |
| Signed AAB | Actions → **Android Release** | `push-listing.mjs --aab` (API) |

Check the kit at any time, with no network: `node mobile/store/push-listing.mjs --dry-run`.
It exits 1 on any over-length field, banned copy (price, how to buy, "AI", shame,
treatment or medical claims), wrong image size, or a malformed data-safety file.
Regenerate the graphics with `node mobile/store/make-assets.mjs`. It runs this checkout's
Worker locally against a throwaway D1 and never touches production.

Background on what Play's API can and can't do: Factory
`docs/runbooks/play-store-operations.md`.

---

## 0. Before anything is submitted (machine, in this repo)

- [ ] **focusbro#380 merged and deployed.** `/me/` showed an empty word list to anyone
      who'd kept a word. The screenshots were taken with that fix applied, and the
      reviewer will hit the bug in their first minute.
- [ ] **focusbro#379 merged and deployed:** account deletion at
      `https://focusbro.net/account/delete` (currently **404**) and the rewritten
      privacy policy. The data-safety CSV points at that URL, and the live policy still
      mentions Google ad controls and names no SMS, payment or email processor.
- [ ] **A working inbox for `support@focusbro.net`.** `focusbro.net` has **no MX
      record** (checked over DoH 2026-10-03), so mail to the address in the listing,
      privacy policy and contact details bounces. Turn on Cloudflare Email Routing for
      `focusbro.net` → the founder's inbox (DNS change), or switch the kit to an
      address that receives mail (`grep -rn support@focusbro.net mobile/store`).
- [ ] Decide the **Med Reminder** card (hide it in the app, or declare medication
      management): `app-content-checklist.md` §6.
- [ ] `curl -s -o /dev/null -w '%{http_code}' https://focusbro.net/health` → `200`.

## 1. Create the app (founder, console only, ~5 min)

1. Play Console → **Create app**: name **FocusBro** · default language **English (United
   States)** · **App** · **Free** · tick both declarations.
2. **Users and permissions** → `play-store-publisher@factory-495015.iam.gserviceaccount.com`
   → **Add app** → FocusBro, with *Release* and *Store presence* permissions.
   After this, everything marked "machine" below needs no more clicks.
3. **Check your developer account type** (it decides step 6): Play Console → ⚙️
   **Settings → Developer account → Account details** → *Account type* reads
   **Personal** or **Organization**. (Or: if you verified with a D-U-N-S number, it's an
   organization account.)

## 2. Push the listing, graphics and data safety (machine)

```bash
node mobile/store/push-listing.mjs --dry-run   # local rules
node mobile/store/push-listing.mjs             # edits.insert → listing → details → images → validate → commit → dataSafety
```

- `404` on `edits.insert` = step 1.1 not done. `403` = step 1.2 not done.
- Data safety success is **204** and has no read-back. Confirm it once in Console →
  App content → Data safety.

## 3. App content forms (founder, console only, ~20 min)

Work through `mobile/store/app-content-checklist.md` top to bottom (privacy policy, ads,
app access, target audience 18+, news, health, government/financial, advertising ID,
exact alarms, foreground service) and `mobile/store/content-rating-answers.md`. Every
answer and every paragraph to paste is in those two files.

The **foreground-service video** (checklist §10) needs a real phone: a 30–60 s screen
recording of starting a sound, locking the screen, and stopping it from the
notification. Upload it unlisted and paste the link.

## 4. First upload: internal testing (machine)

```bash
gh workflow run android-release.yml -f version_name=0.1.0          # signed AAB + APK, verified in-job
gh run download <run-id> -n focusbro-0.1.0-<code>-release.aab
node mobile/store/push-listing.mjs --skip-images --skip-data-safety \
  --aab app-release.aab --track internal --version-name 0.1.0      # status defaults to draft
```

Play accepts only `draft` releases until the app has been published once. Roll the draft
out from Console → Testing → Internal testing (founder, one click), or re-run with
`--status completed` after the first publication.

## 5. App Links: the Play signing certificate (machine, after the first Play upload)

Google re-signs builds installed from Play, so `/.well-known/assetlinks.json` needs
the **Play App Signing** SHA-256 next to the upload key's:

```bash
TOKEN=$(gcloud auth print-access-token \
  --impersonate-service-account=play-store-publisher@factory-495015.iam.gserviceaccount.com \
  --scopes=https://www.googleapis.com/auth/androidpublisher)
curl -s -H "Authorization: Bearer $TOKEN" \
  https://androidpublisher.googleapis.com/androidpublisher/v3/applications/net.focusbro.app/generatedApks/<versionCode>
# → certificateSha256Hash (base64) → convert to colon hex → append to ANDROID_CERT_FINGERPRINTS in api/src/assetlinks.js
```

Deploy, then verify from Google's side:
`https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://focusbro.net&relation=delegate_permission/common.handle_all_urls`
must list **both** fingerprints. (Don't call `appsigning.enrollApp` to try to read
it: that's a mutation.)

## 6. Closed testing: 12 testers × 14 days (personal accounts only)

**Organization accounts skip this step.** Go straight to step 7.

A **personal** developer account created after 13 Nov 2023 has to run a **closed test
with at least 12 testers who stay opted in for 14 consecutive days** before Play lets it
apply for production. The clock starts only once 12 are opted in. Anyone who leaves
early resets the count.

- **Founder:** create a Google Group at groups.google.com, e.g.
  `focusbro-testers@googlegroups.com` (no API exists for consumer Google Groups). Set
  *Who can join* to "Anyone can ask" or invite people directly. Play's tester list
  accepts **Google Groups only**, and group membership is the one tester list a machine
  can check.
- **Machine:** create the closed track release (same command as step 4 with
  `--track alpha`) and attach the group with `edits.testers.update`:
  `PUT …/edits/{id}/testers/alpha {"googleGroups":["focusbro-testers@googlegroups.com"]}`.
- **Founder (recruitment, the real constraint):** get 12+ people who'll keep it
  installed for two weeks into the group. Each tester must (1) join the group, (2) open
  the **opt-in link** shown in Console → Closed testing → Testers (form:
  `https://play.google.com/apps/testing/net.focusbro.app`), (3) install from Play.
  Recruit 15–20, since some will drop.
- Don't send the `play.google.com/apps/test/<pkg>/<versionCode>` link from a release
  run as "the install link". It renders blank for anyone not on the list.
- Until the track is live, Firebase App Distribution still works for hand-picked
  testers: Android Release workflow → `distribute_to`.

## 7. Production (founder applies; machine promotes)

1. **Founder:** Console → Dashboard → **Apply for production** (personal accounts, after
   the 14 days; answers about the test go in that form). Organization accounts don't
   need this.
2. **Machine:** promote the tested build: `edits.tracks.update` on `production` with the
   same `versionCodes`, `status: inProgress` and a `userFraction` (e.g. 0.2) for a
   staged rollout, then raise it to 1.0.
3. **Machine:** after rollout, install from the public listing on a test phone, open a
   `https://focusbro.net/me/` link, and confirm it opens the app (App Links verified).

## Who does what

| Step | Founder (console only) | Machine |
|---|---|---|
| 0 | Approve the support-inbox DNS change; decide the Med Reminder card | Merge/deploy #380 and #379; set up email routing once approved |
| 1 | Create app; add the SA; read the account type | — |
| 2 | — | `push-listing.mjs` (listing, details, images, data safety) |
| 3 | App content forms + content rating; record the FGS video | — |
| 4 | Roll out the first draft to internal (one click) | Build, upload AAB, create the internal release |
| 5 | — | Read the Play signing cert, update assetlinks, deploy, verify |
| 6 | Create the Google Group; recruit 12+ testers | Closed release + attach the group; watch the count |
| 7 | Apply for production (personal accounts) | Promote, staged rollout, verify App Links |
