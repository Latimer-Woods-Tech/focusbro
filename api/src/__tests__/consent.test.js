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
  verifyTelnyxSignature,
} from '../consent.js';
import { scanDesignLaw } from '../design-law.js';

function bytesToB64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

describe('Telnyx signature verification', () => {
  it('accepts the signed raw body and rejects altered or incomplete input', async () => {
    const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const publicKey = bytesToB64(await crypto.subtle.exportKey('raw', keys.publicKey));
    const timestamp = '1785000000';
    const raw = '{"data":{"id":"evt-1"}}';
    const signed = new TextEncoder().encode(`${timestamp}|${raw}`);
    const signature = bytesToB64(await crypto.subtle.sign('Ed25519', keys.privateKey, signed));

    await expect(verifyTelnyxSignature(publicKey, raw, timestamp, signature)).resolves.toBe(true);
    await expect(verifyTelnyxSignature(publicKey, raw + ' ', timestamp, signature)).resolves.toBe(false);
    await expect(verifyTelnyxSignature(publicKey, raw, '', signature)).resolves.toBe(false);
    await expect(verifyTelnyxSignature('', raw, timestamp, signature)).resolves.toBe(false);
  });
});

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
  // A real texter's opt-out arrives dressed in punctuation/emoji ("STOP.",
  // "Stop!", autocorrect's trailing period, a thumb's 🛑). The bare `^stop$`
  // match dropped every one of these to the check-in parser and kept texting
  // someone who asked us to stop — a TCPA/R-212 + design-LAW miss. These fail
  // WITHOUT the edge-stripping keywordToken (proof-of-rejection).
  it('honors a lone STOP wrapped in punctuation / emoji, but still not multi-word', () => {
    for (const w of ['STOP.', 'Stop!', 'stop...', '(stop)', 'STOP - ', '🛑 STOP', 'unsubscribe.', 'opt-out!', 'CANCEL.']) {
      expect(isStopKeyword(w), w).toBe(true);
    }
    // The one-word-only false-positive guard is preserved: a real sentence that
    // merely contains "stop" is never an opt-out (an interior space survives).
    for (const w of ['please stop texting', 'stop the taxes at 3', "don't stop", 'stop it', '...', '   ', '']) {
      expect(isStopKeyword(w), w).toBe(false);
    }
  });
  it('detects START and HELP', () => {
    expect(isStartKeyword('START')).toBe(true);
    expect(isStartKeyword('unstop')).toBe(true);
    expect(isHelpKeyword('help')).toBe(true);
    expect(isHelpKeyword('INFO')).toBe(true);
    expect(isHelpKeyword('helpme')).toBe(false);
  });
  it('honors START / HELP wrapped in punctuation too', () => {
    for (const w of ['START!', 'yes.', 'UNSTOP.', 'opt-in!']) {
      expect(isStartKeyword(w), w).toBe(true);
    }
    for (const w of ['HELP!', 'info.', 'help?']) {
      expect(isHelpKeyword(w), w).toBe(true);
    }
    // Still one-word-only: a sentence is not a keyword.
    expect(isStartKeyword('yes i did it')).toBe(false);
    expect(isHelpKeyword('help me start the taxes')).toBe(false);
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

// THE DESIGN LAW is ONE lexicon now (design-law.js). Every consent-surface
// string used to be guarded by a hand-rolled BANNED/CLINICAL substring pair
// local to this file, and `.toContain()` matching had drifted WEAKER than
// canonical in two ways:
//   • substring matching with no word boundaries — its bare `miss` false-matched
//     "permission"/"dismiss" (a false POSITIVE), while `lazy` never caught
//     `laziness` and the clinical list never listed `medication`.
//   • whole framings it never listed at all: `pathetic`, `worthless`, `slipping`,
//     `unrespons`, the incredulous `again?!` (the R-331 dead-regex class),
//     `excuse`, plus the consumer-banned bare `ADHD`.
// Route every consent-surface string through `scanDesignLaw` (shame + clinical +
// "AI" branding + consumer-ADHD in one pass) so this surface is held to the exact
// same bar as every other. The scan runs on the RAW string (never lowercased) so
// its case-sensitive `\bAI\b` guard stays meaningful.
//
// The one genuine per-surface extra canonical intentionally does NOT carry is
// preserved locally so the fold never WEAKENS this surface:
//   • bare `should have` — canonical anchors it to "you should have"; this
//     surface's old list guarded the bare form, so keep it.
// Two words the OLD local list carried are deliberately DROPPED, not preserved:
//   • bare `patient` — canonical intentionally omits it so warm copy can say "be
//     patient with yourself"; re-banning it here would contradict the LAW.
//   • bare `permission` — not a shame/clinical/"AI"/ADHD concern at all (it was
//     only ever collateral from the old bare-`miss` substring, which canonical's
//     word-boundary `\bmiss…\b` deliberately stopped matching); guarding a
//     non-design-LAW word on one surface is exactly the drift this fold ends.
const localExtras = /\bshould have\b/i;
const scanConsent = (s) => [
  ...scanDesignLaw(String(s)).map((v) => v.kind),
  ...(localExtras.test(String(s)) ? ['per-surface-extra'] : []),
];

describe('THE DESIGN LAW — no consent string ever shames', () => {
  it('every consent-surface string is warm, non-clinical, no bare "AI", no consumer "ADHD" — via the ONE canonical scanner', () => {
    const surface = consentCopySurface();
    expect(surface.length).toBeGreaterThan(10);
    for (const raw of surface) {
      // RAW string (not lowercased) so the case-sensitive `\bAI\b` guard is meaningful.
      expect(scanConsent(raw), `design-LAW violation in consent copy: ${raw}`).toEqual([]);
    }
  });
});

// ── proof-of-rejection (Standing Law #1): the fold STRENGTHENS this surface ──
// Pins that routing through scanDesignLaw catches shame/clinical framings the old
// hand-rolled substring pair silently missed, that the preserved per-surface
// extra still fires, and — the load-bearing one — that the warm consent copy this
// module actually emits stays clean, so the anti-shame LAW is protected by
// construction. Verified load-bearing by mutation (both reverted):
//   • drop the scanDesignLaw half → "catches missed framings" goes red.
//   • drop the local-extras half  → "per-surface extra" goes red.
describe('the consent surface is guarded by the ONE canonical design-LAW scanner (never shame)', () => {
  it('catches shame/clinical framings the old per-surface substring list silently missed', () => {
    for (const bad of [
      'that was pathetic',        // pathetic — never listed
      'you feel worthless',       // worthless — never listed
      "you're slipping",          // slipping — never listed
      'not this again?!',         // the incredulous again?! (the R-331 dead-regex class)
      'no more excuses',          // excuse — never listed
      'take your medication',     // medication (clinical, unlisted)
      'built for your ADHD',      // consumer-banned bare ADHD
      'sheer laziness',           // laziness — only bare `lazy` was listed
      'you were unresponsive',    // unrespons — never listed
    ]) {
      expect(scanConsent(bad).length, `should be caught: ${bad}`).toBeGreaterThan(0);
    }
  });

  it('still fires on the genuine per-surface extra kept out of the canonical list', () => {
    // Canonical anchors "should have" to "you should have"; the bare form is this
    // surface's local extra, so it must still trip without a preceding "you".
    expect(scanConsent('it should have been easier').length, 'per-surface extra should fire').toBeGreaterThan(0);
    // ...and canonical alone does NOT catch the bare form — proving the extra is load-bearing.
    expect(scanDesignLaw('it should have been easier').length).toBe(0);
  });

  it('leaves the warm consent copy this module emits clean (the anti-shame LAW survives)', () => {
    for (const good of consentCopySurface()) {
      expect(scanConsent(good).length, `warm copy must stay clean: ${good}`).toBe(0);
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
