/**
 * FocusBro — landing funnel: the `word_offered` rung (Contender #10, Phase A).
 *
 * The homepage "Give my word" gesture was a pure client-side redirect to `/me/`,
 * so the acquisition funnel collapsed `acquisition_visit` → `guest_started` in
 * one unreadable step (936 visits, 0 guests, nothing in between). Recording the
 * offer splits that into the hook (visit → word_offered) and the handoff
 * (word_offered → guest_started), which is the read docs/IMPROVEMENT_PLAN.md's
 * decision tree needs. These tests hold the two design invariants: the coarse
 * time bucket is a closed vocabulary, and the task text is NEVER recorded.
 */

import { describe, it, expect } from 'vitest';
import {
  recordWordOffered, normalizeWhenBucket, WORD_WHEN_BUCKETS,
  computeAcquisitionMetrics, EVENTS,
} from '../events.js';

// A minimal D1-shaped fake: captures INSERTs (run) and answers the funnel reads
// by SQL comment tag. `throwOnRun` proves the non-fatal guarantee.
function makeDB({ visits = [], offers = [], funnel = [], throwOnRun = false } = {}) {
  const runs = [];
  const db = {
    runs,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a; return stmt; },
        async all() {
          if (/words_offered \*\//.test(sql)) return { results: offers };
          if (/acquisition_visits/.test(sql)) return { results: visits };
          if (/acquisition_funnel/.test(sql)) return { results: funnel };
          return { results: [] };
        },
        async first() { return null; },
        async run() {
          if (throwOnRun) throw new Error('no such table: analytics_events');
          runs.push({ sql, params });
          return { success: true };
        },
      };
      return stmt;
    },
  };
  return db;
}

describe('normalizeWhenBucket', () => {
  it('keeps each known bucket', () => {
    for (const b of ['t-10m', 't-30m', 't-1h', 't-tomorrow']) {
      expect(normalizeWhenBucket(b)).toBe(b);
    }
  });
  it('maps anything else — free text, the literal task, junk, non-strings — to "other"', () => {
    expect(normalizeWhenBucket('finish the taxes')).toBe('other');
    expect(normalizeWhenBucket('other')).toBe('other');
    expect(normalizeWhenBucket('')).toBe('other');
    expect(normalizeWhenBucket(undefined)).toBe('other');
    expect(normalizeWhenBucket(42)).toBe('other');
  });
  it('exposes exactly the four buckets plus the fallback', () => {
    expect(WORD_WHEN_BUCKETS).toEqual(['t-10m', 't-30m', 't-1h', 't-tomorrow', 'other']);
  });
});

describe('recordWordOffered', () => {
  it('writes a word_offered event carrying only attribution + bucket — never the task', async () => {
    const db = makeDB();
    const ok = await recordWordOffered({ DB: db }, {
      attribution: { source: 'homepage', campaign: 'launch' },
      when: 't-30m',
    });
    expect(ok).toBe(true);
    expect(db.runs).toHaveLength(1);
    // recordEvent binds (user_id, event_type, event_data): the guest is
    // anonymous here, so user_id is null and the type is the second param.
    const [userId, type, payload] = db.runs[0].params;
    expect(userId).toBeNull();
    expect(type).toBe(EVENTS.WORD_OFFERED);
    const data = JSON.parse(payload);
    expect(data).toEqual({ attribution: { source: 'homepage', campaign: 'launch' }, when: 't-30m' });
    // The invariant that protects the person: no task field, ever.
    expect(JSON.stringify(data)).not.toMatch(/task/i);
  });

  it('defaults a missing source to "direct" and coerces an unknown bucket', async () => {
    const db = makeDB();
    await recordWordOffered({ DB: db }, { attribution: {}, when: 'the actual private task' });
    const data = JSON.parse(db.runs[0].params[2]);
    expect(data.attribution.source).toBe('direct');
    expect(data.when).toBe('other');
  });

  it('is non-fatal: a broken table returns false and never throws', async () => {
    const db = makeDB({ throwOnRun: true });
    await expect(recordWordOffered({ DB: db }, { attribution: { source: 'x' }, when: 't-1h' })).resolves.toBe(false);
  });

  it('does nothing without a DB binding', async () => {
    await expect(recordWordOffered(null, { when: 't-1h' })).resolves.toBe(false);
  });
});

describe('computeAcquisitionMetrics — word_offered splits the funnel', () => {
  it('reports words_offered and both stage rates per attribution tuple', async () => {
    const tuple = { source: 'homepage', campaign: '', content: '', challenge: '' };
    const db = makeDB({
      visits: [{ ...tuple, landing_visits: 100 }],
      offers: [{ ...tuple, words_offered: 40 }],
      funnel: [{
        ...tuple, commitments_created: 10, users: 10,
        checkins_delivered: 0, kept: 0, rescheduled: 0, missed: 0,
      }],
    });
    const rows = await computeAcquisitionMetrics({ DB: db }, { sinceDays: 30 });
    const row = rows.find((r) => r.attribution.source === 'homepage');
    expect(row.landing_visits).toBe(100);
    expect(row.words_offered).toBe(40);
    expect(row.commitments_created).toBe(10);
    // Hook: 40 of 100 visitors offered a word.
    expect(row.landing_engagement_rate).toBe(0.4);
    // Handoff: 10 of those 40 offers became saved commitments.
    expect(row.offer_conversion_rate).toBe(0.25);
  });

  it('surfaces a tuple that offered words but converted none — the drop we are hunting', async () => {
    const tuple = { source: 'direct', campaign: '', content: '', challenge: '' };
    const db = makeDB({
      visits: [{ ...tuple, landing_visits: 50 }],
      offers: [{ ...tuple, words_offered: 12 }],
      funnel: [],
    });
    const rows = await computeAcquisitionMetrics({ DB: db }, { sinceDays: 30 });
    const row = rows.find((r) => r.attribution.source === 'direct');
    expect(row).toBeDefined();
    expect(row.words_offered).toBe(12);
    expect(row.commitments_created).toBe(0);
    expect(row.landing_engagement_rate).toBe(0.24);
    expect(row.offer_conversion_rate).toBe(0); // 0 of 12 — a dead handoff, now visible
  });
});
