---
last_updated: "2026-07-25"
owner: focusbro
status: ratified
---

# FocusBro Breakout Plan

**Ratified:** 2026-07-25 by founder direction. This is the product-growth plan
of record; later amendments require explicit founder approval.

Engineering sequence, acceptance tests, rollout rules, and rollback rules live
in [`IMPROVEMENT_PLAN.md`](./IMPROVEMENT_PLAN.md). That document executes this
strategy; it does not replace or waive the learning gates below.

## Thesis

FocusBro owns a narrower and more valuable category than “ADHD productivity”:

> Warm, persistent accountability for the moment you need to start.

The founder story creates attention. A near-term commitment creates activation. A
real check-in creates an outcome. The outcome creates shareable proof. That proof
recruits the next person.

The product is the accountability loop. The wellness toolkit supports it. Voice
strengthens it. Coaches distribute it.

## North star

**Weekly users who keep at least one word after receiving a FocusBro check-in.**

Supporting measures:

- landing → commitment-created activation
- check-in delivery success by channel
- check-in response rate
- reschedule recovery rate
- commitments per activated user
- D1 and D7 return
- activated referral rate
- cost per kept word

Views, registrations, and guide traffic are diagnostic measures, not success.

## Compounding loop

```text
Founder story or challenge
        ↓
Near-term “Give your word” entry
        ↓
Real push or text check-in
        ↓
Done / move it / help me start
        ↓
Kept-word moment
        ↓
Share the result or challenge a friend
        ↓
Referred person gives their first word
```

Voice strengthens the intervention. Coaches multiply entry into the same loop.
Neither becomes a separate product roadmap before the core loop retains.

## Product hierarchy

1. **Consumer wedge:** Give your word; your bro shows up.
2. **Retention:** delivery, response, warm reschedule, momentum, weekly proof.
3. **Distribution:** share a result and challenge a friend.
4. **Revenue:** voice credits/subscription, then coach seats.
5. **Supporting inventory:** timer, breathing, sounds, guides, and other tools.

The homepage is the accountability doorway. The toolkit remains available but
does not lead positioning or first use.

## Experience rules

- First meaningful action in under 90 seconds.
- First check-in can happen within 10–30 minutes.
- Ask only for the task and check-in time before explaining configuration.
- Never auto-commit or assume consent.
- Never tally failure; “not yet” always opens a warm reschedule.
- Every acquisition link carries source, campaign, and challenge attribution.
- Accountability and active-focus surfaces remain ad-free.
- Voice is marketed as live only after a real consented call works end to end.

## Content system

The founder is the recurring protagonist:

> “I have ADHD. I built reminders. I swiped them away. So I built a bro that
> follows up without making me feel worse.”

Each short-form episode contains:

1. a real avoided task;
2. the word and check-in time;
3. the check-in arriving;
4. the honest outcome;
5. completion or warm reschedule;
6. a deep link to try the same challenge.

The render pipeline automates captions, crops, overlays, variants, and packaging.
It must not automate the founder’s confession or reaction.

Every guide and video should resolve to an interactive challenge such as:

- open the tax document;
- send the uncomfortable email;
- put five dishes away;
- start the assignment;
- get ready to leave;
- clean for ten minutes.

## Execution status

**As of 2026-07-25:** the agent-executable foundation for Phases 1 and 2 is
shipped and production-verified. This status records delivery; it does not waive
any learning gate.

| Area | State | Evidence or next proof |
|---|---|---|
| Accountability-first entry and attribution | shipped | [#144](https://github.com/Latimer-Woods-Tech/focusbro/pull/144), [#156](https://github.com/Latimer-Woods-Tech/focusbro/pull/156) |
| Founder scorecard and acquisition cohorts | shipped | [#145](https://github.com/Latimer-Woods-Tech/focusbro/pull/145), [#146](https://github.com/Latimer-Woods-Tech/focusbro/pull/146) |
| Founding-cohort creative kit | shipped | [#157](https://github.com/Latimer-Woods-Tech/focusbro/pull/157), [`DISTRIBUTION.md`](../DISTRIBUTION.md) |
| “Help me start” over SMS | shipped | [#158](https://github.com/Latimer-Woods-Tech/focusbro/pull/158) |
| One-tap next-word bridge | shipped | [#159](https://github.com/Latimer-Woods-Tech/focusbro/pull/159) |
| Truthful outcomes and Phase 2 decision metrics | shipped | [#161](https://github.com/Latimer-Woods-Tech/focusbro/pull/161), [#162](https://github.com/Latimer-Woods-Tech/focusbro/pull/162), [#163](https://github.com/Latimer-Woods-Tech/focusbro/pull/163) |
| Fresh-D1 install and runtime-schema parity | shipped | [#164](https://github.com/Latimer-Woods-Tech/focusbro/pull/164) |
| Creative- and challenge-level scorecard | shipped | [#165](https://github.com/Latimer-Woods-Tech/focusbro/pull/165) |
| Release, dependency, and cron health | green | [#166](https://github.com/Latimer-Woods-Tech/focusbro/pull/166); 734 automated tests, coverage floors, browser smoke, zero npm audit findings, live `/health` |
| Phase 1 learning gate | unproven | publish the founding-cohort links, then observe 100 qualified visits and 10 complete loops |
| Phase 2 decision gate | unproven | recruit 50–100 people and allow D1/D7 cohorts to mature |
| Phase 3 | held | starts only after the Phase 2 retention gate passes |

### Gate ownership

- **Agent-owned:** product changes, privacy-safe instrumentation, scorecard,
  tagged links, test coverage, deployment, and production health.
- **Founder-owned:** record and publish five honest demonstrations per week,
  recruit the cohort, observe sessions, and conduct user interviews.
- **Time-owned:** D1 and D7 cannot be ratified before one and seven full days
  have elapsed for a qualified cohort.

The 2026-07-25 closeout audit found no remaining agent-owned Phase 1 or Phase 2
deliverable. “Software complete” here means ready to run the learning plan—not
that adoption or retention has been proven. Those claims remain deliberately
open until the founder-owned work and elapsed cohorts produce the numbers above.

The immediate operating move is not another feature. Generate the five links in
[`DISTRIBUTION.md`](../DISTRIBUTION.md), publish the corresponding founder
demonstrations, recruit the first ten observed users, and read the signed-in
founder scorecard after each batch. Do not begin Phase 3 because the software is
ready; begin it only because the retained cohort says the loop is ready.

## 90-day sequence

### Phase 1 — Truth and activation (days 1–14)

Ship:

- accountability-first homepage and metadata;
- near-term “Give your word” entry;
- campaign/challenge attribution;
- complete acquisition → commitment → delivery funnel;
- founder cohort onboarding;
- reliable root install/build;
- ad-free accountability surfaces.

Run 10 observed sessions and 10–15 founder-led creative tests.

Learning gate:

- 100 qualified visitors;
- 25 first commitments;
- 20 delivered check-ins;
- 10 people completing or rescheduling through the loop;
- delivery success above 95%.

### Phase 2 — Retention (days 15–35)

Ship:

- “Help me start” over text;
- one-tap next commitment;
- return nudge and weekly kept-word story;
- inactivity feedback;
- cohorts by acquisition source.

Run a 50–100-person founding cohort and interview both retained and quiet users.

Decision gate:

- D1 return at least 30%;
- D7 return at least 15%;
- median activated user creates at least three commitments;
- at least half of check-in recipients respond;
- reschedule recovers a meaningful share of “not yet” outcomes.

If retention misses, fix task selection, timing, channel, reliability, and tone.
Do not answer weak retention with more tools.

### Phase 3 — Product-led distribution (days 36–55)

Ship:

- challenge-a-friend links;
- activated-referral attribution;
- shareable kept-word artifact;
- permissioned story capture;
- communication-credit rewards.

Decision gate:

- 15% of activated users share or invite;
- 20% of invitees create a commitment;
- referred-user retention is at least as strong as creator-acquired retention;
- five permissioned outcome stories exist.

### Phase 4 — Voice and monetization (days 56–75)

Test the smallest consented voice intervention:

- a scheduled call;
- a fixed warm script;
- done / move it / stay with me;
- a two-minute starting mode;
- hard frequency ceilings and transparent credit use.

Compare push, push→text, and push→text→call on answer, response, task-start,
reschedule recovery, D7 return, cost, and annoyance.

Voice earns scale only if it materially improves successful interventions.

### Phase 5 — Coach multiplication (days 76–90)

Pilot five ADHD coaches with three to ten clients each. Use only:

- invitation and client consent;
- cadence ceiling;
- weekly progress artifact;
- between-session note;
- simple billing.

Measure invitation activation, client retention, coach weekly use, time saved,
renewal intent, and willingness to pay per active client.

Do not build enterprise, Slack, or extensive white-label features before this
cohort proves demand.

## Weekly operating cadence

Every week produces:

1. one activation or retention experiment;
2. at least five founder-led creative tests;
3. five user conversations or observed sessions;
4. one cohort scorecard by acquisition source.

The weekly decision is: **which message brought people who received a check-in,
kept or moved their word, and returned?**

## Explicitly deferred

- new wellness tools;
- enterprise tier work;
- Slack integrations;
- broad paid acquisition;
- extensive coach white-labeling;
- complex gamification;
- large body-doubling rooms;
- AdSense optimization as the primary business model.

Technical work enters the critical path only when it improves release
reliability, delivery reliability, experiment velocity, funnel visibility,
performance, or trust.
