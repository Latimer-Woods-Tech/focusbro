/**
 * FocusBro — consent-by-construction tests (Contender #10, Phase A · TCPA).
 *
 * The moat is automated outbound contact, so consent is a hard gate, not a
 * nicety. These tests pin the three TCPA guarantees — express consent, quiet
 * hours, one-word opt-out — and re-assert the design LAW on every string the
 * consent surface can show (an opt-out is met with warmth, never a guilt trip).
 */

import { describe, it, expect } from 'vitest';
import {
  CONSENT_CHANNELS, CONSENT_VERSION, consentLanguage,
  normalizeHour, localHour, isWithinQuietHours,
  isStopKeyword, isStartKeyword, isHelpKeyword,
  normalizePhone, evaluateContactGate, consentCopySurface,
} from '../consent.js';

describe('consent disclosure language', () => {
  it('names the action, STOP, and rates — and is versioned', () => {
    const t = consentLanguage('text');
    expect(t).toMatch(/text you/i);
    expect(t).toMatch(/STOP/);
    expect(t).toMatch(/rates may apply/i);
    expect(CONSENT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });
  it('has a distinct voice disclosure that names calls', () => {
    expect(consentLanguage('voice')).toMatch(/call you/i);
  });
});

describe('quiet hours — recipient-local math', () => {
  it('normalizes hours to [0,23] or null', () => {
    expect(normalizeHour(0)).toBe(0);
    expect(normalizeHour('23')).toBe(23);
    expect(normalizeHour(24)).toBeNull();
    expect(normalizeHour(-1)).toBeNull();
    expect(normalizeHour('')).toBeNull();
    expect(normalizeHour(null)).toBeNull();
  });

  it('reads the recipient-local hour via IANA timezone', () => {
    // 2026-07-06T02:00:00Z is 22:00 the previous day in New York (UTC-4 in July).
    expect(localHour('2026-07-06T02:00:00.000Z', 'America/New_York')).toBe(22);
    expect(localHour('2026-07-06T02:00:00.000Z', 'UTC')).toBe(2);
  });

  it('no window (unset or start==end) is never quiet', () => {
    expect(isWithinQuietHours('2026-07-06T02:00:00Z', 'UTC', null, null)).toBe(false);
    expect(isWithinQuietHours('2026-07-06T02:00:00Z', 'UTC', 9, 9)).toBe(false);
  });

  it('same-day window [1,6) contains 02:00 but not 08:00', () => {
    expect(isWithinQuietHours('2026-07-06T02:00:00Z', 'UTC', 1, 6)).toBe(true);
    expect(isWithinQuietHours('2026-07-06T08:00:00Z', 'UTC', 1, 6)).toBe(false);
  });

  it('overnight window [22,8) wraps midnight', () => {
    expect(isWithinQuietHours('2026-07-06T23:00:00Z', 'UTC', 22, 8)).toBe(true);
    expect(isWithinQuietHours('2026-07-06T02:00:00Z', 'UTC', 22, 8)).toBe(true);
    expect(isWithinQuietHours('2026-07-06T14:00:00Z', 'UTC', 22, 8)).toBe(false);
  });

  it('respects the recipient timezone, not UTC', () => {
    // 14:00 UTC is 10:00 in New York — outside a 22→08 quiet window.
    expect(isWithinQuietHours('2026-07-06T14:00:00Z', 'America/New_York', 22, 8)).toBe(false);
    // 03:00 UTC is 23:00 previous day in New York — inside 22→08.
    expect(isWithinQuietHours('2026-07-06T03:00:00Z', 'America/New_York', 22, 8)).toBe(true);
  });
});

describe('one-word keywords (CTIA)', () => {
  it('detects STOP family, case/space-insensitive', () => {
    for (const w of ['STOP', 'stop', ' Stop ', 'UNSUBSCRIBE', 'cancel', 'END', 'quit']) {
      expect(isStopKeyword(w), w).toBe(true);
    }
    expect(isStopKeyword('please stop texting')).toBe(false); // one-word only
    expect(isStopKeyword('')).toBe(false);
  });
  it('detects START and HELP', () => {
    expect(isStartKeyword('START')).toBe(true);
    expect(isStartKeyword('unstop')).toBe(true);
    expect(isHelpKeyword('help')).toBe(true);
    expect(isHelpKeyword('INFO')).toBe(true);
    expect(isHelpKeyword('helpme')).toBe(false);
  });
});

describe('phone normalization', () => {
  it('coerces to a leading-+ E.164-ish form', () => {
    expect(normalizePhone('+1 (555) 765-4321')).toBe('+15557654321');
    expect(normalizePhone('5557654321')).toBe('+5557654321');
  });
  it('rejects junk / too-short / too-long', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('123')).toBeNull();
    expect(normalizePhone('not a phone')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
});

// ── a tiny D1-shaped fake for the gate (returns an env with a DB) ──
function gateDB(consentRow) {
  return {
    DB: {
      prepare() {
        return {
          bind() { return this; },
          async first() { return consentRow; },
        };
      },
    },
  };
}

describe('evaluateContactGate (delivery gate)', () => {
  it('never gates push', async () => {
    const g = await evaluateContactGate(gateDB(null), { userId: 'u', channel: 'push', nowISO: '2026-07-06T02:00:00Z' });
    expect(g).toEqual({ allow: true });
  });
  it('skips text with no consent', async () => {
    const g = await evaluateContactGate(gateDB(null), { userId: 'u', channel: 'text', nowISO: '2026-07-06T14:00:00Z' });
    expect(g).toEqual({ skip: 'no_consent' });
  });
  it('skips text after opt-out', async () => {
    const g = await evaluateContactGate(gateDB({ status: 'revoked' }), { userId: 'u', channel: 'text', nowISO: '2026-07-06T14:00:00Z' });
    expect(g).toEqual({ skip: 'opted_out' });
  });
  it('allows granted text outside quiet hours', async () => {
    const g = await evaluateContactGate(
      gateDB({ status: 'granted', quiet_start: 22, quiet_end: 8, timezone: 'UTC' }),
      { userId: 'u', channel: 'text', nowISO: '2026-07-06T14:00:00Z' });
    expect(g).toEqual({ allow: true });
  });
  it('defers granted text inside quiet hours', async () => {
    const g = await evaluateContactGate(
      gateDB({ status: 'granted', quiet_start: 22, quiet_end: 8, timezone: 'UTC' }),
      { userId: 'u', channel: 'text', nowISO: '2026-07-06T02:00:00Z' });
    expect(g).toEqual({ defer: 'quiet_hours' });
  });
});

describe('THE DESIGN LAW — no consent string ever shames', () => {
  const BANNED = [
    'fail', 'failed', 'failure', 'missed', 'miss', 'behind', 'lazy',
    'disappointed', 'guilt', 'shame', 'should have', 'you didn', 'permission',
  ];
  const CLINICAL = ['treat', 'treatment', 'cure', 'diagnos', 'disorder', 'symptom', 'patient', 'therapy'];

  it('every consent-surface string is warm, non-clinical, and has no bare "AI"', () => {
    const surface = consentCopySurface();
    expect(surface.length).toBeGreaterThan(10);
    for (const raw of surface) {
      const s = String(raw).toLowerCase();
      for (const w of BANNED) expect(s, `banned "${w}" in: ${raw}`).not.toContain(w);
      for (const w of CLINICAL) expect(s, `clinical "${w}" in: ${raw}`).not.toContain(w);
      expect(s, `bare AI in: ${raw}`).not.toMatch(/\bai\b/);
    }
  });
});

describe('module surface', () => {
  it('exposes the TCPA-scoped channels', () => {
    expect(CONSENT_CHANNELS).toContain('text');
    expect(CONSENT_CHANNELS).toContain('voice');
    expect(CONSENT_CHANNELS).not.toContain('push');
  });
});
