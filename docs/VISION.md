---
last_updated: "2026-07-05"
---

# FocusBro — Vision

> One page. Changes rarely. Founder-voice: build loops may propose edits via PR but never merge thesis changes silently. This rewrite was directed by the founder in [issue #10](https://github.com/Latimer-Woods-Tech/focusbro/issues/10) (2026-07-05).

## What FocusBro is

FocusBro is a **focus + accountability companion — the bro who calls to make sure you did the thing.** Not another timer. Not another to-do list. A warm, always-there partner that holds your word with you: you say what you'll do and when, and at that moment FocusBro reaches out — "You said you'd start the taxes at 2. Ready? I'll check back at 3." — and then it actually checks back.

"Bro" means ride-or-die friend. It is gender-neutral in usage and the persona is configurable (calm ally vs. hype friend, per user). It is never a boss and never a scold.

## Who it's for

People whose attention needs external scaffolding to start and finish things — the ADHD / executive-function crowd first, then anyone who keeps meaning to do the thing and doesn't. They have tried every to-do app and abandoned each one, because each one quietly became a "you failed" machine. They don't need another tracker. They need something that feels like it's *on their side*.

("ADHD" describes the audience and lives in SEO and the coach pitch. FocusBro makes no clinical or treatment claim — it is tools, accountability, and coaching, not a treatment for anything.)

## The problem

Starting and sustaining intended work is hard, and the standard advice ("just concentrate," "use a timer") doesn't help people whose follow-through breaks at the moment of initiation. A push notification is swiped away by an ADHD brain in half a second of reflex — it's one more thing to dismiss. The gap between *deciding to do it* and *doing it* is where every productivity tool fails, and where shame accumulates.

## The moat: the check-in that can't be swiped away

The differentiator is the **check-in call**. A ringing phone with a warm voice is categorically harder to reflexively dismiss than a banner notification, and it lands as *a friend showing up* rather than *an app nagging*. We start with push and text (buildable now, engine-independent) and earn the right to the voice call as the product proves itself. When the voice check-in lands, no notification-based habit app can follow us there — the telephony investment is strategic, not cosmetic.

Around the check-in sit three things that make it stick: **kept-word streaks** (proof to yourself that your word is good), a **no-shame reschedule** on every miss ("no problem — when do you want to try again?"), and an optional **real coach** behind the line.

## The one design LAW: never shame

The audience is drowning in shame. The voice and every line of copy is an ally glad you picked up — never a boss tallying misses. "You said, I'm here, let's go." On a miss: "no problem, when do you want to try again?" Any surface that counts your failures back to you is a **defect**, not a feature. Get the tone wrong and it's another guilt engine they delete; get it right and it's the first accountability tool that ever felt on their side.

## Product structure

Three layers, each funding and feeding the next:

1. **Free, ad-supported tools** (Pomodoro timer, ambient sound, and the research-grounded guides library — the [#6](https://github.com/Latimer-Woods-Tech/focusbro/issues/6) work). This is the top of funnel and the SEO surface; AdSense on the content layer covers infrastructure and keeps the free tier free.
2. **Premium accountability tier** (consumer). Commitments, scheduled check-ins, kept-word streaks, the no-shame flow, configurable persona — and, when it lands, the voice call.
3. **Coach wholesale** (operator white-label). ADHD coaches already do between-session check-ins by hand and want leverage. Coach = operator: configures cadence, voice, and scripts; the product makes the check-ins; the coach keeps the client and gets the dashboard. We never touch the client and never make a clinical claim.

## What winning looks like

An 18-month picture: a person who abandoned five to-do apps keeps FocusBro, because it's the first one that didn't make them feel bad — and their kept-word streak is the longest they've ever held. Concretely: a working accountability core (commitments → scheduled check-ins → kept-word streaks → no-shame reschedule) live on real users; the voice check-in shipped on the shared voice engine; a first cohort of ADHD coaches running client check-ins through the white-label; and the free tools/guides layer still earning the organic traffic and ad revenue that funds it all.

## Monetization thesis

Two engines. **Free tier:** AdSense display advertising on the guides/content layer — the app stays uncluttered, the content is the ad-monetized and organic-acquisition surface (unchanged from the #6 thesis; that work continues underneath this one). **Paid tiers:** consumer premium subscription for the accountability companion, and coach wholesale (white-label) on the shared Stripe platform. The free layer acquires; the accountability layer is what people pay to keep.

## Non-goals

- **Any "presence-faking" features** — the "Keep Teams/Slack green" widget, keystroke-injection companion scripts, and synthetic activity simulation are permanently rejected: they are Google "enabling dishonest behavior" policy violations and were a root cause of the AdSense rejection. Accountability is about doing the real thing, not faking it.
- **Shame mechanics of any kind** — no miss tallies shown to the user, no red streak-broken guilt, no "you're behind" framing. This is the design LAW, restated as a non-goal so it's never negotiated away.
- **Clinical / treatment claims** — FocusBro does not treat ADHD or any condition. Tools, accountability, and coaching only.
- **Hand-rolling a voice stack** — the voice check-in rides the shared `@latimer-woods-tech/voice-agent` + personas engines. We consume that engine; we do not build a parallel telephony stack.
- **The word "AI" in user-facing copy** — ever.
- **Marketing-fluff content** — no testimonial surfaces, no filler articles, no fabricated citations.

## Kill-signals

- The accountability core ships to real users and **no one keeps a streak past a few days across a meaningful cohort** → the check-in-plus-streak loop isn't sticky; re-examine the mechanic before investing in voice.
- The voice check-in lands and **pickup / engagement is no better than push** → the "call is the moat" bet is falsified; fall back to the strongest non-voice channel and stop the telephony spend.
- The anti-shame tone can't be held — copy or persona drifts into guilt to drive engagement → stop; a guilt engine is a product we refuse to ship, even if it retains.
- (Free tier, inherited from #6) A second AdSense rejection after the content layer is live and indexed → re-evaluate the free-tier monetization thesis.

## Portfolio position

Standalone LWT portfolio asset. The free tools/guides layer must never draw engineering time from revenue-primary apps. The accountability core is engine-independent and buildable now; the voice and operator layers **consume shared Factory engines** (`@latimer-woods-tech/voice-agent`, the operator hub — Factory#1947) rather than rebuilding them, and the commitment/check-in mechanic **reuses wordis-bond's suite→scheduled-run→scored-outcome pattern** (extraction toward a shared accountability engine per the star map). It adds a 4th operator segment — ADHD coaches — to the operator hub and growth loop.
