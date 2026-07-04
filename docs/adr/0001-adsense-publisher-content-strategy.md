---
last_updated: "2026-07-04"
---

# ADR-0001: Win AdSense via a genuine content layer, not checklist cosmetics

- **Status:** Accepted
- **Date:** 2026-07-04
- **Deciders:** Founder (via control issue #6, "FocusBro AdSense approval — control + log")

## Context

FocusBro's monetization thesis is AdSense display advertising, and the site was rejected. The May 2026 "compliance" work (commits `4f1a2dc`, `7a16a3f`, `19308bc`) treated the rejection as a checklist problem: it added policy pages, robots.txt, a sitemap, and ads.txt — surface that *looks* like a publisher site. That work:

1. **Never addressed the primary rejection reason** — "low value content." The site was (and at the time of this ADR still is, live) a bare tool: a 5-URL sitemap, zero articles, homepage text that is widget labels.
2. **Introduced the ads.txt publisher-ID mismatch** — commit `7a16a3f` updated the page's AdSense client to `ca-pub-1346297152611586` but left `/ads.txt` serving the old `pub-7015938501859914`, an outright disqualifier.
3. **Left live policy risks in place** — placeholder "Ad Space" units reading as under-construction, and the "Keep Teams/Slack green" presence-faking feature squarely inside Google's "enabling dishonest behavior" policy.

Checklist cosmetics demonstrably do not produce approval; the 2026-07-04 audit in issue #6 established the real root causes.

## Decision

Win AdSense approval by making focusbro.net a **genuine publisher property**, in this order of importance:

1. **A real content layer is the decisive fix:** 16 original, genuinely useful, accurately sourced guides (900–1300 words) on focus/productivity science, server-rendered at stable URLs, internally linked, indexed via the sitemap. No fabricated citations, no filler, never the word "AI" in copy.
2. **Remove everything dishonest or fake, permanently:** placeholder ad markup and the presence-faking feature set are deleted (not reworded), because they are policy violations independent of approval mechanics.
3. **Make the compliance surface actually correct:** ads.txt matching `ca-pub-1346297152611586`, privacy policy with third-party/DoubleClick cookie language and both opt-out links, a consent banner, substantive About/Contact.
4. **Resubmit only after the content is indexed** (~2–4 weeks post-ship), and only by the founder — AdSense has no API; the click is a human act.

Execution is phased and logged in control issue #6; requirement rows live in `docs/REQUIREMENTS.md`.

## Consequences

- **Positive:** the same work that satisfies AdSense review builds the organic-search acquisition loop the revenue thesis needs anyway; rejected scope (R-900…R-905) becomes a durable guardrail against re-introducing policy risk.
- **Negative / cost:** ~16 substantive guides is real editorial effort; approval is delayed by the deliberate indexing wait instead of an immediate resubmission.
- **Risk accepted:** if a second rejection follows a genuine content layer plus the indexing wait, that is a VISION kill-signal — the answer is to re-evaluate monetization, not to add more cosmetics.
- **Operational corollary (discovered while grounding this ADR):** "shipped to main + CI green" has been proven ≠ live — the deploy workflow masked wrangler failures while worker `focusbro-production` sat unchanged since 2026-05-06. Every phase's acceptance is therefore a live browser-UA curl, never a CI status.
