/**
 * FocusBro — the activation-gate scorecard (Contender #10, Phase A · R-317).
 *
 * R-313…R-316 instrumented the landing funnel end to end (visit → qualified →
 * word_offered → guest → commitment) but left the ONE readout the decision tree
 * is gated on — "N of 20 qualified visits, and the verdict once readable" —
 * computable only by hand-summing the per-tuple acquisition array in D1.
 * `computeActivationGate` rolls that up. These tests pin the two things that
 * make the rollup trustworthy: it never rules before the 20-qualified-visit gate
 * (proof-of-rejection), and each verdict band matches `docs/IMPROVEMENT_PLAN.md`
 * § Decision tree verbatim (<10% / 10–25% / >25%).
 */

import { describe, it, expect } from 'vitest';
import { computeActivationGate, ACTIVATION_QUALIFIED_GATE } from '../events.js';

// Build an acquisition-shaped tuple with just the fields the gate rolls up.
function tuple({ qualified = 0, bot = 0, offered = 0, commitments = 0, users = 0 } = {}) {
  return {
    qualified_visits: qualified,
    bot_visits: bot,
    words_offered: offered,
    commitments_created: commitments,
    users,
  };
}

describe('computeActivationGate — rollup', () => {
  it('sums qualified/bot/offered/commitments across attribution tuples', () => {
    const gate = computeActivationGate([
      tuple({ qualified: 12, bot: 3, offered: 4, commitments: 2, users: 2 }),
      tuple({ qualified: 8, bot: 1, offered: 1, commitments: 0, users: 0 }),
    ]);
    expect(gate.qualified_visits).toBe(20);
    expect(gate.bot_visits).toBe(4);
    expect(gate.words_offered).toBe(5);
    expect(gate.commitments_created).toBe(2);
  });

  it('an empty funnel is zeroed and not readable', () => {
    const gate = computeActivationGate([]);
    expect(gate.qualified_visits).toBe(0);
    expect(gate.qualified_visits_remaining).toBe(ACTIVATION_QUALIFIED_GATE);
    expect(gate.readable).toBe(false);
    expect(gate.verdict).toBe('insufficient_data');
    expect(gate.landing_engagement_rate).toBeNull();
    expect(gate.offer_conversion_rate).toBeNull();
  });

  it('tolerates a non-array / undefined input', () => {
    expect(computeActivationGate(undefined).qualified_visits).toBe(0);
    expect(computeActivationGate(null).verdict).toBe('insufficient_data');
  });
});

describe('computeActivationGate — the 20-qualified-visit gate (proof-of-rejection)', () => {
  it('19 qualified visits with a healthy hook is STILL insufficient_data — the gate refuses an early ruling', () => {
    // 10 offers / 19 visits = 53% engagement — well past every "act" band — yet
    // one qualified visit short of the gate. If the threshold logic were wrong
    // this would rule; it must not.
    const gate = computeActivationGate([tuple({ qualified: 19, offered: 10, commitments: 5, users: 5 })]);
    expect(gate.readable).toBe(false);
    expect(gate.qualified_visits_remaining).toBe(1);
    expect(gate.verdict).toBe('insufficient_data');
  });

  it('exactly 20 qualified visits flips readable and lets the verdict rule', () => {
    const gate = computeActivationGate([tuple({ qualified: 20, offered: 10, commitments: 5, users: 5 })]);
    expect(gate.readable).toBe(true);
    expect(gate.qualified_visits_remaining).toBe(0);
    expect(gate.verdict).not.toBe('insufficient_data');
  });
});

describe('computeActivationGate — verdict bands (docs/IMPROVEMENT_PLAN.md § Decision tree)', () => {
  it('<10% landing engagement → rewrite_hook (tree row 1)', () => {
    // 1 offer / 20 = 5%.
    const gate = computeActivationGate([tuple({ qualified: 20, offered: 1, commitments: 0 })]);
    expect(gate.landing_engagement_rate).toBe(0.05);
    expect(gate.verdict).toBe('rewrite_hook');
  });

  it('exactly 10% is the reduce_friction band, not rewrite_hook (boundary)', () => {
    // 4 offers / 40 = 10%.
    const gate = computeActivationGate([tuple({ qualified: 40, offered: 4, commitments: 1 })]);
    expect(gate.landing_engagement_rate).toBe(0.1);
    expect(gate.verdict).toBe('reduce_friction');
  });

  it('10–25% → reduce_friction (tree row 2)', () => {
    // 4 offers / 20 = 20%.
    const gate = computeActivationGate([tuple({ qualified: 20, offered: 4, commitments: 1 })]);
    expect(gate.landing_engagement_rate).toBe(0.2);
    expect(gate.verdict).toBe('reduce_friction');
  });

  it('exactly 25% stays in the reduce_friction band (boundary)', () => {
    // 5 offers / 20 = 25%.
    const gate = computeActivationGate([tuple({ qualified: 20, offered: 5, commitments: 2 })]);
    expect(gate.landing_engagement_rate).toBe(0.25);
    expect(gate.verdict).toBe('reduce_friction');
  });

  it('>25% → hook_healthy (tree row 3 entry; the hook works, read down the funnel)', () => {
    // 6 offers / 20 = 30%.
    const gate = computeActivationGate([tuple({ qualified: 20, offered: 6, commitments: 3 })]);
    expect(gate.landing_engagement_rate).toBe(0.3);
    expect(gate.verdict).toBe('hook_healthy');
  });
});

describe('computeActivationGate — the hook / handoff split stays legible', () => {
  it('carries offer_conversion_rate alongside engagement so "rewrite hook" vs "fix the /me/ door" is readable', () => {
    // Healthy hook (40% engagement) but the door converts nothing (0/8).
    const gate = computeActivationGate([tuple({ qualified: 20, offered: 8, commitments: 0, users: 0 })]);
    expect(gate.verdict).toBe('hook_healthy'); // the hook itself is not the suspect
    expect(gate.landing_engagement_rate).toBe(0.4);
    expect(gate.offer_conversion_rate).toBe(0); // the door is — surfaced, not verdicted
  });

  it('honors a custom threshold (e.g. a dry-run gate) without touching the default', () => {
    const gate = computeActivationGate([tuple({ qualified: 5, offered: 3 })], { threshold: 5 });
    expect(gate.threshold).toBe(5);
    expect(gate.readable).toBe(true);
    expect(ACTIVATION_QUALIFIED_GATE).toBe(20);
  });
});
