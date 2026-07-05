---
last_updated: "2026-07-04"
---

# FocusBro — Requirements

> The real and true requirements this build is held accountable to. Numbered, testable, statused. Every control-issue slice references the requirement IDs it advances; every `live` flip needs verification evidence in the control-issue comment. Status ∈ `live | building | roadmap | rejected | parked`. `rejected` rows stay here with their reason — rejected scope is a guardrail.
>
> Control plane: [issue #6](https://github.com/Latimer-Woods-Tech/focusbro/issues/6). Statuses below verified against live focusbro.net on **2026-07-04 ~22:20 UTC** (browser-UA curl; CF WAF blocks bot UAs).

## Functional

| ID | Requirement | Status | Verification |
|---|---|---|---|
| R-001 | `GET /ads.txt` serves `google.com, pub-1346297152611586, DIRECT, f08c47fec0942fa0` (matches the homepage AdSense client) | building | `curl -A "<browser UA>" https://focusbro.net/ads.txt`. Fixed in source (`3b9a2e9`, both `public/ads.txt` and the Worker route) but **live still serves old `pub-7015938501859914`** — deploy pipeline silently broken (see ARCHITECTURE Known Debt) |
| R-002 | Zero placeholder ad markup: live homepage HTML contains no "Ad Space" labels and no `data-ad-slot="XXXXXXXXXX"`; the `adsbygoogle.js?client=ca-pub-1346297152611586` ownership script is kept | building | `curl -A "<browser UA>" https://focusbro.net/ \| grep -c 'Ad Space\|data-ad-slot="XXXXXXXXXX"'` → 0. Removed in source (`3b9a2e9`); **live HTML still has 3× each** (2026-07-04) |
| R-003 | No presence-faking feature anywhere: no "Keep Teams/Slack green" widget, no keystroke-companion download, no synthetic activity engine; legitimate Screen Wake Lock only | building | `curl -A "<browser UA>" https://focusbro.net/ \| grep -c 'Keep Teams\|simulateActivity\|downloadPresenceScript'` → 0. Removed in source (`3b9a2e9`); **live HTML still has the widget** (2026-07-04) |
| R-004 | `/privacy.html` contains third-party/DoubleClick cookie disclosure and **both** opt-out links: `https://adssettings.google.com` and `https://www.aboutads.info/choices` | building | `curl -A "<browser UA>" https://focusbro.net/privacy.html \| grep -c 'adssettings.google.com\|aboutads.info'` → ≥2. Source shipped 2026-07-05 (expanded route in `api/src/index.js`: third-party/DoubleClick disclosure, both opt-out links + youronlinechoices.eu, GDPR/CCPA rights, date-stamp). **Live curl pending** — this loop session's egress denies focusbro.net; verify after deploy |
| R-005 | Dismissible cookie-consent banner on the homepage (vanilla JS + localStorage, no external deps) | building | Curl homepage for the banner markup; manual dismiss-and-reload check. Source shipped 2026-07-05 (`#cookieConsent` banner in `public/index.html`, key `focusbro_cookie_consent_v1`, regenerated into `api/src/html.js`; no external deps). **Live curl pending** (egress blocked this session) |
| R-006 | Substantive About (what FocusBro is, the method, built by Latimer Woods Tech) and Contact (email + response expectation) pages — no marketing fluff, no testimonials | building | Curl both pages; human-judge substance. Source shipped 2026-07-05 (About = 4 paras incl. "The method" + "Who builds it"; Contact = Support/Privacy/Business sections with 2-business-day response expectation; no "AI", no testimonials). **Live curl pending** (egress blocked this session) |
| R-007 | 16 original guides (900–1300 words each) live at `/guides/<slug>.html`, server-rendered in the site shell with title + meta description + 2–3 internal links; `/guides/` index page; "Guides" nav link on homepage; all listed in `/sitemap.xml` with lastmod | roadmap | `curl https://focusbro.net/guides/` → 200 listing 16; 2 random article URLs → 200 full text; sitemap lists them. Live 2026-07-04: `/guides/` → **404**, sitemap has 5 URLs |
| R-008 | Timer app unbroken: homepage renders the Pomodoro timer/tasks/stats/sound UI | live | `curl -A "<browser UA>" https://focusbro.net/` → 200; Pomodoro/timer markup present (42 matches, verified 2026-07-04). Re-verify after every deploy |

## Non-functional

| ID | Requirement | Status | Verification |
|---|---|---|---|
| R-100 | Deploy pipeline is trustworthy: a failed `wrangler deploy` fails the workflow (pipefail or explicit exit-code capture), the CF API token authenticates, and a merge to main measurably updates worker `focusbro-production` | building | CF API `modified_on` for `focusbro-production` advances after merge + live curl shows new content. **Masking bug fixed 2026-07-05:** both deploy steps in `deploy.yml` now `set -o pipefail` and capture `${PIPESTATUS[0]}` so a failed `wrangler deploy` can no longer pass as green. Confirm `modified_on` advances on the next merge. (Failed 2026-07-04: run 28718694798 green, `modified_on` still 2026-05-06) |
| R-101 | `/sitemap.xml` and `/robots.txt` valid; sitemap includes every public page incl. all guides | building | Curl both; count URLs. Live 2026-07-04: valid but 5 URLs, no guides |
| R-102 | No secrets in source or wrangler vars: `JWT_SECRET` removed from `wrangler.toml` (root and `api/`) and set via `wrangler secret put` with a new random value; `node_modules/` + `.wrangler/` gitignored and untracked | roadmap | `grep JWT_SECRET wrangler.toml api/wrangler.toml` → no plaintext values; `git ls-files \| grep node_modules` → empty. Live 2026-07-04: **plaintext secret present in both files; node_modules committed** |
| R-103 | `/health` returns 200 on the branded domain | live | `curl -A "<browser UA>" https://focusbro.net/health` → 200 (verified 2026-07-04) |

## Rejected (do-not-build guardrails)

| ID | Requirement | Status | Reason |
|---|---|---|---|
| R-900 | "Keep Teams/Slack green" presence-faking (synthetic mouse/keyboard/wheel activity, idle suppression) in any framing | rejected | Google "enabling dishonest behavior" policy — a root cause of the AdSense rejection; permanently out regardless of monetization |
| R-901 | Promoting the keystroke-injection companion script (Scroll Lock/F15 senders) on monetized pages | rejected | Same Google policy class; also reintroduces the R-900 surface via a side door |
| R-902 | Fabricated or unverifiable citations in guides (invented studies, misattributed researchers, fake statistics) | rejected | Destroys the "genuine content" thesis the entire AdSense strategy rests on; thin-but-honest beats thick-and-fake |
| R-903 | Resubmitting to AdSense before the guides are live AND indexed (~2–4 weeks post-ship) | rejected | Premature resubmission burns a review cycle on the same "low value content" verdict; the resubmission click is founder-only (no AdSense API) |
| R-904 | The word "AI" in any user-facing copy | rejected | LWT portfolio-wide brand rule |
| R-905 | Paid subscriptions / paywall (for now) | rejected | Pre-traffic paywall kills the organic-acquisition loop the ad thesis depends on; revisit only per VISION kill-signal review |
