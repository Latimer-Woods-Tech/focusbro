// ════════════════════════════════════════════════════════════
// FOCUSBRO — CONSENT BY CONSTRUCTION  (Contender #10, Phase A · TCPA)
// ════════════════════════════════════════════════════════════
// The moat is a phone call. The moment we call or text, we are making
// automated outbound contact to a consumer — so TCPA applies ($500–$1,500
// statutory per violation). This module is the law of that contact, built so
// a non-compliant message is impossible to send by construction:
//
//   1. EXPRESS CONSENT — a text/voice check-in cannot be delivered unless the
//      person granted consent for that channel, with the exact clear-language
//      disclosure recorded (what we'll do + STOP + rates). No consent → the
//      delivery cron marks the check-in `skipped`, never sends.
//   2. QUIET HOURS — enforced in the RECIPIENT's local time. A check-in that
//      comes due inside a person's quiet window is HELD (deferred), not dropped,
//      and delivered once the window passes. Never a text in the middle of a
//      night.
//   3. ONE-WORD OPT-OUT — STOP (and the CTIA family) is honored instantly and
//      durably. From the app (POST /api/consent/opt-out) or from an inbound SMS
//      webhook. Once revoked, the cron will not send again until the person
//      texts START / re-grants.
//
// The user CHOOSING their own check-in time is the consent UX gift the founder
// named — the same act that gives their word is the act that invites the call.
//
// DESIGN LAW still governs every word: an opt-out is met with warmth ("you're
// in control, your streak stays safe"), never a guilt trip for leaving. Every
// user-facing string here is scanned by consent.test.js for shame words, the
// banned "AI", and clinical/treatment language.
//
// SYSTEM-OF-RECORD NOTE: this is the DELIVERY-SIDE enforcement copy of consent —
// the app must hold consent state locally to gate every send. The org-wide
// durable consent ledger is the shared CRM/consent schema (Foundry #2001); the
// Phase B integration syncs to it. We do NOT hand-roll a competing CRM here.
// ════════════════════════════════════════════════════════════

import {
  detectCheckinReply,
  parseSnoozeMinutes,
  isStartHelpReply,
  isProgressReply,
  keptNoteFromReply,
  applyCheckinOutcome,
  parseWhenReply,
  smsKeptReplyCopy,
  smsAmbiguousReplyCopy,
  smsStartHelpCopy,
  smsAskWhenCopy,
  smsRescheduledCopy,
  smsWhenUnclearCopy,
  snoozeConfirmCopy,
  SNOOZE_DEFAULT_MIN,
  START_HELP_MIN,
  pickPersona,
} from './accountability.js';
import { recordEvent, EVENTS } from './events.js';

/** Channels that are TCPA-scoped outbound contact. Push is app UX, not a call/text. */
export const CONSENT_CHANNELS = ['text', 'voice'];

/**
 * Version stamp for the consent language. Bump when the disclosure wording
 * changes so a consent record always tells us exactly what the person agreed to.
 */
export const CONSENT_VERSION = '2026-07-06.1';

/**
 * The escalation ceiling: the hardest rung the ladder is EVER allowed to climb,
 * chosen by the person and never crossed. This is the wedge no rival sells —
 * everyone else jumps straight to a call; here YOU set the limit.
 *   - 'none' → just the nudge; a quiet check-in never gets a text follow-up.
 *   - 'text' → push → one SMS (the default; preserves the existing ladder).
 *   - 'call' → push → SMS → a gentle call. Stored forward-compatibly, but the
 *     cron tops out at SMS until the voice rung (Phase B) ships.
 * Low→high order also encodes "how far up the ladder may climb".
 */
export const CEILING_LEVELS = ['none', 'text', 'call'];
export const DEFAULT_CEILING = 'text';

/**
 * Read a user's chosen escalation ceiling. Defaults to 'text' when unset or on
 * any read error, so a missing preference preserves the current ladder rather
 * than silencing it.
 * @param {object} env  Worker env with a D1-shaped `DB`
 * @param {string} userId
 * @returns {Promise<'none'|'text'|'call'>}
 */
export async function getEscalationCeiling(env, userId) {
  try {
    const row = await env.DB.prepare(
      `SELECT ceiling FROM escalation_prefs WHERE user_id = ?`
    ).bind(userId).first();
    const c = row && row.ceiling;
    return CEILING_LEVELS.includes(c) ? c : DEFAULT_CEILING;
  } catch {
    return DEFAULT_CEILING;
  }
}

/**
 * The exact clear-language disclosure a person agrees to. This string is BOTH
 * shown at capture time AND stored verbatim on the consent record, so we can
 * always prove what was disclosed. Keep it plain, honest, TCPA-clear.
 * @param {string} channel 'text' | 'voice'
 */
export function consentLanguage(channel) {
  if (channel === 'voice') {
    return 'FocusBro will call you at the check-in times you choose. Call frequency depends on the check-ins you set. '
      + 'Say stop on any call, or text STOP, to end calls anytime. Message and data rates may apply.';
  }
  return 'FocusBro will text you at the check-in times you choose. Message frequency depends on the check-ins you set. '
    + 'Reply STOP anytime to stop, HELP for help. Msg & data rates may apply.';
}

// ── QUIET HOURS ──────────────────────────────────────────────
// Stored as whole local hours [0..23]. A window start==end (or unset) means
// "no quiet hours". A window where start<end is same-day (e.g. 1→6). A window
// where start>end wraps past midnight (e.g. 21→8, the classic overnight quiet).

/** Coerce a quiet-hour value to an integer in [0,23], or null if unusable. */
export function normalizeHour(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const h = Math.trunc(n);
  if (h < 0 || h > 23) return null;
  return h;
}

/**
 * Resolve the recipient's local hour [0..23] at a given instant.
 * Uses Intl (Workers + Node support IANA time zones); falls back to UTC hour
 * if the zone is unusable. No Node built-ins.
 * @param {string} nowISO  ISO instant
 * @param {string} timezone IANA zone (e.g. 'America/New_York')
 * @returns {number|null}
 */
export function localHour(nowISO, timezone) {
  const d = new Date(nowISO);
  if (Number.isNaN(d.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC', hour: 'numeric', hour12: false,
    }).formatToParts(d);
    const hp = parts.find((p) => p.type === 'hour');
    let hour = hp ? parseInt(hp.value, 10) : d.getUTCHours();
    if (hour === 24) hour = 0; // some ICU builds render midnight as 24 under hour12:false
    return hour;
  } catch {
    return d.getUTCHours();
  }
}

/**
 * Is `nowISO` inside the recipient-local quiet window [start, end)?
 * @returns {boolean} false when no window is set or the instant is unusable.
 */
export function isWithinQuietHours(nowISO, timezone, start, end) {
  const s = normalizeHour(start);
  const e = normalizeHour(end);
  if (s === null || e === null || s === e) return false; // no quiet hours
  const h = localHour(nowISO, timezone);
  if (h === null) return false;
  if (s < e) return h >= s && h < e; // same-day window
  return h >= s || h < e;            // overnight window (wraps midnight)
}

// ── ONE-WORD KEYWORDS (CTIA standard) ────────────────────────

/**
 * Reduce an inbound message to the bare keyword token CTIA matching runs on:
 * trim, then shed any punctuation / emoji / whitespace clinging to EITHER END.
 * A real texter almost never sends a naked "STOP" — it lands as "STOP.",
 * "Stop!", "(stop)", "🛑 STOP" (autocorrect appends the period; a thumb adds
 * the emoji). The raw `^stop$` match rejected every one of those, so the
 * opt-out fell straight through to the two-way check-in reply parser and the
 * person who just told us to stop kept getting texts — a TCPA/R-212 miss AND
 * the sharpest design-LAW break there is: ignoring someone asking us to leave.
 * Edge-stripping ONLY — an interior space is preserved, so a genuinely
 * multi-word message ("please stop texting", "stop the taxes at 3") still
 * fails the one-word match below and is never mistaken for an opt-out; the
 * existing false-positive guard is kept exactly. The interior hyphen of
 * "opt-out" / "opt-in" sits between letters, never at an edge, so it survives.
 */
export function keywordToken(t) {
  return String(t == null ? '' : t)
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '');
}

/** Standard opt-out keywords — honored instantly and durably. */
export function isStopKeyword(t) {
  return /^(stop|stopall|unsubscribe|cancel|end|quit|optout|opt-out)$/i.test(keywordToken(t));
}
/** Standard opt-in / resume keywords. */
export function isStartKeyword(t) {
  return /^(start|unstop|yes|optin|opt-in)$/i.test(keywordToken(t));
}
/** Standard help keyword. */
export function isHelpKeyword(t) {
  return /^(help|info)$/i.test(keywordToken(t));
}

// ── PHONE ────────────────────────────────────────────────────

/**
 * Normalize a phone to a loose E.164 form, or null if it can't be one.
 * We don't validate the carrier — just that it's plausibly dialable.
 */
export function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hadPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/[^\d]/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return (hadPlus ? '+' : '+') + digits; // always store with a leading +
}

// ── COPY ENGINE (design LAW: warm, never shame; no "AI"; no clinical) ─────

/** Leaving is never failing. Warmth on the way out, an open door back in. */
export function optOutConfirmCopy() {
  return "You're all set — I won't text you anymore. Your word and your streak stay safe with me. "
    + 'Text START whenever you want me back.';
}
/** Coming back is easy and celebrated. */
export function optInConfirmCopy() {
  return "Good to have you back — I'll text you at the times you choose. Text STOP anytime to pause.";
}
/** HELP reply — plain, honest, the controls in one line. */
export function helpReplyCopy() {
  return 'FocusBro check-ins: I text you at the times you pick. Text STOP to stop, START to resume. Msg & data rates may apply.';
}
/** Confirmation after granting consent in the app. */
export function consentSavedCopy() {
  return "You're set — I'll reach out only at the times you choose, and STOP always works. You're in control.";
}

/**
 * Copy for the /me/ text-consent panel. Kept here (not inline in me.js) so the
 * design-LAW scan in consent.test.js sees every visible string.
 */
export function consentPanelCopy() {
  return {
    heading: 'Text check-ins',
    intro: 'Want your nudges by text? Add a number, set your quiet hours, and give the word — you choose when I reach out.',
    phoneLabel: 'Mobile number',
    quietHeading: 'Quiet hours',
    quietHint: 'During quiet hours I hold a text and send it once the window passes — never in the middle of your night.',
    quietStartLabel: 'Quiet from',
    quietEndLabel: 'Quiet until',
    agreeLabel: consentLanguage('text'),
    saveButton: 'Save & turn on texts',
    optOutButton: 'Stop texts',
    savedOk: consentSavedCopy(),
    optedOut: 'Texts are off. Your streak is untouched — turn them back on whenever you like.',
    needAgree: 'Just check the box so I know you want me to text you — that keeps everything above board.',
    needPhone: 'Add a mobile number and I can text your check-ins.',
  };
}

/** Every user-facing string this module can emit — the design-LAW scan surface. */
export function consentCopySurface() {
  const p = consentPanelCopy();
  return [
    consentLanguage('text'),
    consentLanguage('voice'),
    optOutConfirmCopy(),
    optInConfirmCopy(),
    helpReplyCopy(),
    consentSavedCopy(),
    p.heading, p.intro, p.phoneLabel, p.quietHeading, p.quietHint,
    p.quietStartLabel, p.quietEndLabel, p.agreeLabel, p.saveButton,
    p.optOutButton, p.savedOk, p.optedOut, p.needAgree, p.needPhone,
  ];
}

// ── DELIVERY GATE (consumed by the check-in cron) ────────────

/**
 * Decide whether a text/voice check-in may be delivered right now.
 *
 * @param {object} env  Worker env with a D1-shaped `DB`
 * @param {object} args { userId, channel, nowISO }
 * @returns {Promise<{allow:true} | {skip:'no_consent'|'opted_out'} | {defer:'quiet_hours'}>}
 *   - push (and anything not in CONSENT_CHANNELS) is never gated → {allow:true}
 *   - no granted consent → {skip:'no_consent'} (terminal, no shame)
 *   - consent revoked (opted out) → {skip:'opted_out'}
 *   - inside recipient quiet hours → {defer:'quiet_hours'} (hold, retry later)
 */
export async function evaluateContactGate(env, { userId, channel, nowISO } = {}) {
  if (!CONSENT_CHANNELS.includes(channel)) return { allow: true };

  const row = await env.DB.prepare(
    `SELECT status, quiet_start, quiet_end, timezone
       FROM contact_consent WHERE user_id = ? AND channel = ?`
  ).bind(userId, channel).first();

  if (!row) return { skip: 'no_consent' };
  if (row.status === 'revoked') return { skip: 'opted_out' };
  if (row.status !== 'granted') return { skip: 'no_consent' };

  if (isWithinQuietHours(nowISO, row.timezone, row.quiet_start, row.quiet_end)) {
    return { defer: 'quiet_hours' };
  }
  return { allow: true };
}

// ── TELNYX INBOUND SIGNATURE (Ed25519) ───────────────────────

/** base64 → Uint8Array without Buffer. */
function b64ToBytes(b64) {
  const bin = atob(String(b64 || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Verify a Telnyx inbound webhook signature (Ed25519 over `${timestamp}|${rawBody}`).
 * Returns true/false. Any crypto error → false (fail closed when a key is set).
 * @param {string} publicKeyB64 Telnyx Ed25519 public key (base64, raw 32 bytes)
 */
export async function verifyTelnyxSignature(publicKeyB64, rawBody, timestamp, signatureB64) {
  try {
    if (!publicKeyB64 || !signatureB64 || !timestamp) return false;
    const key = await crypto.subtle.importKey(
      'raw', b64ToBytes(publicKeyB64), { name: 'Ed25519' }, false, ['verify']
    );
    const data = new TextEncoder().encode(`${timestamp}|${rawBody}`);
    return await crypto.subtle.verify('Ed25519', key, b64ToBytes(signatureB64), data);
  } catch {
    return false;
  }
}

/**
 * Send a one-off SMS via Telnyx. Guarded + fail-safe: with no Telnyx config it
 * no-ops (returns false), and any transport error is swallowed — a reply that
 * fails to send must NEVER break the state change it is confirming (the check-in
 * is already resolved; the confirmation text is best-effort). Used to answer an
 * inbound reply so a text check-in is a real two-way conversation.
 * @returns {Promise<boolean>} true if the carrier accepted the message
 */
export async function sendSms(env, to, text) {
  try {
    if (!env || !env.TELNYX_API_KEY || !env.TELNYX_FROM_NUMBER) return false;
    if (!to || !text) return false;
    const res = await fetch('https://api.telnyx.com/v2/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.TELNYX_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: env.TELNYX_FROM_NUMBER, to, text }),
    }).catch(() => ({ ok: false }));
    return !!(res && res.ok);
  } catch (err) {
    console.error('[consent] sendSms error:', err && err.message);
    return false;
  }
}

// ── ROUTES ───────────────────────────────────────────────────

/**
 * Register the consent API on an itty-router instance.
 * @param {object} router  itty-router instance
 * @param {object} ctx  Route dependencies. `verifyInboundSignature` is injectable
 * for route tests; production always uses `verifyTelnyxSignature`.
 */
export function registerConsentRoutes(router, ctx) {
  const {
    getAuthToken,
    verifyToken,
    jsonResponse,
    generateUUID,
    verifyInboundSignature = verifyTelnyxSignature,
  } = ctx;

  async function requireUser(request, env) {
    const token = getAuthToken(request);
    if (!token) return { error: jsonResponse({ error: 'Unauthorized' }, 401) };
    const payload = await verifyToken(token, env.JWT_SECRET, env);
    if (!payload) return { error: jsonResponse({ error: 'Invalid token' }, 401) };
    return { userId: payload.sub };
  }

  // ── GET my contact-consent state (per channel) ──
  router.get('/api/consent', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;

      const rows = await env.DB.prepare(
        `SELECT channel, status, consent_version, quiet_start, quiet_end, timezone, granted_at, revoked_at
           FROM contact_consent WHERE user_id = ?`
      ).bind(auth.userId).all();

      const user = await env.DB.prepare(`SELECT phone FROM users WHERE id = ?`).bind(auth.userId).first();
      const channels = {};
      for (const r of (rows && rows.results) || []) channels[r.channel] = r;

      return jsonResponse({
        channels,
        phone_present: !!(user && user.phone),
        consent_version: CONSENT_VERSION,
        disclosure: { text: consentLanguage('text') },
      }, 200, 'short');
    } catch (err) {
      console.error('[consent] get error:', err && err.message);
      return jsonResponse({ error: 'Could not load your check-in settings.' }, 500);
    }
  });

  // ── GRANT consent for a channel (express, with recorded language) ──
  router.post('/api/consent', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;

      let body;
      try { body = await request.json(); } catch { body = null; }
      if (!body || typeof body !== 'object') return jsonResponse({ error: 'Tell me how to reach you.' }, 400);

      const channel = typeof body.channel === 'string' ? body.channel.toLowerCase() : 'text';
      if (!CONSENT_CHANNELS.includes(channel)) {
        return jsonResponse({ error: `Channel must be one of: ${CONSENT_CHANNELS.join(', ')}.` }, 400);
      }
      if (channel === 'voice') {
        // Voice contact rides Phase B (the voice engine + its own consent flow); not grantable yet.
        return jsonResponse({ error: 'Voice check-ins are coming soon — for now, text works great.' }, 400);
      }
      // Express consent is affirmative and explicit — the box must be checked.
      if (body.agree !== true) {
        return jsonResponse({ error: consentPanelCopy().needAgree }, 400);
      }

      const phone = normalizePhone(body.phone);
      if (!phone) return jsonResponse({ error: consentPanelCopy().needPhone }, 400);

      const quietStart = normalizeHour(body.quiet_start);
      const quietEnd = normalizeHour(body.quiet_end);
      const timezone = typeof body.timezone === 'string' && body.timezone.trim() ? body.timezone.trim() : 'UTC';
      const now = new Date().toISOString();
      const consentText = consentLanguage(channel);

      // Store the phone on the user (the text channel needs it).
      await env.DB.prepare(`UPDATE users SET phone = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(phone, auth.userId).run();

      // Upsert the consent record. Re-granting clears any prior opt-out.
      const id = generateUUID();
      await env.DB.prepare(
        `INSERT INTO contact_consent
           (id, user_id, channel, status, consent_text, consent_version, phone,
            quiet_start, quiet_end, timezone, granted_at, revoked_at, revoke_source, updated_at)
         VALUES (?, ?, ?, 'granted', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, datetime('now'))
         ON CONFLICT(user_id, channel) DO UPDATE SET
           status = 'granted',
           consent_text = excluded.consent_text,
           consent_version = excluded.consent_version,
           phone = excluded.phone,
           quiet_start = excluded.quiet_start,
           quiet_end = excluded.quiet_end,
           timezone = excluded.timezone,
           granted_at = excluded.granted_at,
           revoked_at = NULL,
           revoke_source = NULL,
           updated_at = datetime('now')`
      ).bind(id, auth.userId, channel, consentText, CONSENT_VERSION, phone,
             quietStart, quietEnd, timezone, now).run();

      return jsonResponse({
        ok: true,
        channel,
        status: 'granted',
        consent_version: CONSENT_VERSION,
        quiet_hours: (quietStart !== null && quietEnd !== null && quietStart !== quietEnd)
          ? { start: quietStart, end: quietEnd, timezone } : null,
        message: consentSavedCopy(),
      }, 200);
    } catch (err) {
      console.error('[consent] grant error:', err && err.message);
      return jsonResponse({ error: 'Could not save that just now — try again in a moment.' }, 500);
    }
  });

  // ── OPT OUT (durable revoke) from the app ──
  router.post('/api/consent/opt-out', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;

      let body;
      try { body = await request.json(); } catch { body = {}; }
      const channel = typeof (body && body.channel) === 'string' ? body.channel.toLowerCase() : 'text';
      if (!CONSENT_CHANNELS.includes(channel)) {
        return jsonResponse({ error: `Channel must be one of: ${CONSENT_CHANNELS.join(', ')}.` }, 400);
      }

      await revokeConsent(env, { userId: auth.userId, channel, source: 'user' });
      return jsonResponse({ ok: true, channel, status: 'revoked', message: optOutConfirmCopy() }, 200);
    } catch (err) {
      console.error('[consent] opt-out error:', err && err.message);
      return jsonResponse({ error: 'Could not update that just now — try again in a moment.' }, 500);
    }
  });

  // ── INBOUND SMS webhook (STOP / START / HELP over the carrier) ──
  // TCPA one-word opt-out honored instantly + durably. Fail closed before any
  // lookup or state transition: an unsigned request can never reach a person's
  // contact state, even when production verification configuration is missing.
  router.post('/api/webhooks/telnyx/inbound', async (request, env) => {
    let inboxEventId = null;
    try {
      const raw = await request.text();

      if (!env || !env.TELNYX_PUBLIC_KEY) {
        console.error('[consent] inbound webhook verification is not configured');
        return jsonResponse({ error: 'webhook unavailable' }, 503);
      }
      const ts = request.headers.get('telnyx-timestamp') || '';
      const sig = request.headers.get('telnyx-signature-ed25519') || '';
      if (!ts || !sig) return jsonResponse({ error: 'bad signature' }, 401);
      const ok = await verifyInboundSignature(env.TELNYX_PUBLIC_KEY, raw, ts, sig);
      if (!ok) return jsonResponse({ error: 'bad signature' }, 401);

      let evt;
      try { evt = JSON.parse(raw); } catch { evt = null; }
      const event = evt && evt.data;
      const eventId = event && typeof event.id === 'string' ? event.id : '';
      const eventType = event && typeof event.event_type === 'string' ? event.event_type : '';
      if (!eventId || eventType !== 'message.received') {
        return jsonResponse({ error: 'invalid event' }, 400);
      }
      inboxEventId = eventId;

      // Telnyx may retry the same signed event. Persist its provider event ID
      // before any consent, check-in, analytics, or SMS side effect; a duplicate
      // gets a successful acknowledgement and cannot process twice.
      const receipt = await env.DB.prepare(
        `INSERT INTO webhook_inbox
           (provider, event_id, event_type, occurred_at, raw_payload, signature_ed25519, signed_timestamp)
         VALUES ('telnyx', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, event_id) DO NOTHING`
      ).bind(eventId, eventType, event.occurred_at || null, raw, sig, ts).run();
      if (!(receipt && receipt.meta && receipt.meta.changes)) {
        // A provider retry may be the recovery path for an event we explicitly
        // recorded as failed. Claim only that terminal failure state; completed
        // and already-processing rows are immutable duplicate acknowledgements.
        const reclaim = await env.DB.prepare(
          `UPDATE webhook_inbox
              SET status = 'processing', processing_started_at = CURRENT_TIMESTAMP,
                  failed_at = NULL, last_error = NULL
            WHERE provider = 'telnyx' AND event_id = ? AND status = 'failed'`
        ).bind(eventId).run();
        if (!(reclaim && reclaim.meta && reclaim.meta.changes)) {
          return jsonResponse({ ok: true, duplicate: true }, 200);
        }
      } else {
        await env.DB.prepare(
          `UPDATE webhook_inbox SET status = 'processing', processing_started_at = CURRENT_TIMESTAMP
            WHERE provider = 'telnyx' AND event_id = ?`
        ).bind(eventId).run();
      }

      const finish = async (body, status = 200) => {
        await env.DB.prepare(
          `UPDATE webhook_inbox SET status = 'completed', completed_at = CURRENT_TIMESTAMP, last_error = NULL
            WHERE provider = 'telnyx' AND event_id = ?`
        ).bind(eventId).run();
        return jsonResponse(body, status);
      };

      const payload = event.payload;
      const from = payload && payload.from && payload.from.phone_number;
      const text = payload && typeof payload.text === 'string' ? payload.text : '';
      const phone = normalizePhone(from);
      if (!phone) return finish({ ok: true, ignored: 'no_from' });

      const user = await env.DB.prepare(`SELECT id FROM users WHERE phone = ?`).bind(phone).first();
      if (!user) return finish({ ok: true, ignored: 'unknown_number' });

      // ── Compliance keywords first (STOP always wins; HELP is informational) ──
      if (isStopKeyword(text)) {
        await revokeConsent(env, { userId: user.id, channel: 'text', source: 'sms' });
        await sendSms(env, phone, optOutConfirmCopy());
        return finish({ ok: true, action: 'opted_out' });
      }
      if (isHelpKeyword(text)) {
        await sendSms(env, phone, helpReplyCopy());
        return finish({ ok: true, action: 'help' });
      }
      // START/YES only means "resume" when the person is actually opted out.
      // Otherwise a bare "yes" is an answer to a check-in, not a re-subscribe.
      if (isStartKeyword(text)) {
        const res = await env.DB.prepare(
          `UPDATE contact_consent
              SET status = 'granted', revoked_at = NULL, revoke_source = NULL, updated_at = datetime('now')
            WHERE user_id = ? AND channel = 'text' AND status = 'revoked'`
        ).bind(user.id).run();
        if (res && res.meta && res.meta.changes) {
          await sendSms(env, phone, optInConfirmCopy());
          return finish({ ok: true, action: 'opted_in' });
        }
        // not opted out → fall through and treat as a check-in reply
      }

      // ── Two-way check-in reply: resolve the person's open text check-in ──
      // A text check-in is only half the loop if you can't answer it. Find the
      // single open text check-in that is currently awaiting the person's word —
      // whether it was just delivered ('sent'), is mid-"when do you want to try
      // again?" conversation ('awaiting_time'), or was DELIVERED and then re-pended
      // into a short wait window (a "help me start" check-back, or an "I'm on it"
      // snooze) — those carry `status = 'pending'` but keep their `delivered_at`.
      // Without the delivered-pending arm, the most engaged reply on the live moat
      // met silence: the "help me start" copy literally says "Text STARTED when
      // you're moving," yet a STARTED / done / on-it texted inside those two minutes
      // found no open check-in and was dropped (no_open_checkin) — the same cold
      // gap the recent two-way work has been closing, one channel at a time. The
      // `delivered_at IS NOT NULL` guard is exact: a never-yet-delivered future
      // occurrence is materialized with `delivered_at` NULL and only ever reaches
      // 'sent' on delivery, so this arm matches ONLY a delivered-then-re-pended
      // check-in — never a future one. The `status='pending'` rows rank LAST in the
      // order (sent/awaiting first, then newest), so a fresh nudge is never
      // shadowed by a snoozed row scheduled further out. STOP/START/HELP are handled
      // above, so they never land here.
      //
      // `m.status = 'active'` is load-bearing under the design LAW. Setting a word
      // DOWN (release), pausing a rhythm, and the terminal resolves all cancel a
      // commitment's *waiting* rows — but their cancel scan is
      // `IN ('pending','deferred','awaiting_time')`, so a nudge already DELIVERED
      // (status='sent', responded_at NULL) is deliberately left live. Without this
      // guard a late "done"/"3pm" reply to that stray sent row would match it and
      // run applyCheckinOutcome — resurrecting a released word (re-activating the
      // rhythm + re-arming the next occurrence, or moving a one-shot released→kept)
      // and ringing the bro again on a word the person explicitly set down: the
      // exact guilt-engine the LAW forbids. Parity with reconcileStrandedCheckins,
      // which already scopes its resolve to `m.status='active'`. A non-active parent
      // falls through to `no_open_checkin` (silent ack — never text unprompted).
      const open = await env.DB.prepare(
        `SELECT c.id AS checkin_id, c.commitment_id, c.status AS checkin_status,
                m.recurrence, m.timezone, m.local_time, m.channel, m.persona
           FROM commitment_checkins c
           JOIN commitments m ON m.id = c.commitment_id
          WHERE c.user_id = ? AND c.channel = 'text' AND c.responded_at IS NULL
            AND m.status = 'active'
            AND ( c.status IN ('sent', 'awaiting_time')
                  OR (c.status = 'pending' AND c.delivered_at IS NOT NULL) )
          ORDER BY (c.status = 'pending') ASC, c.scheduled_for DESC LIMIT 1`
      ).bind(user.id).first();

      if (!open) {
        // Nothing to answer — acknowledge silently (never text unprompted).
        return finish({ ok: true, action: 'no_open_checkin' });
      }

      const persona = pickPersona(open.persona);
      const nowISO = new Date().toISOString();
      const commitment = {
        id: open.commitment_id,
        recurrence: open.recurrence,
        timezone: open.timezone,
        local_time: open.local_time,
        channel: open.channel,
        persona: open.persona,
      };

      // Any inbound message answering an open check-in is a response—even
      // "on it", "help me start", or words we need to clarify. Record that fact
      // once here instead of inferring engagement from a final outcome.
      await recordEvent(env, {
        userId: user.id,
        type: EVENTS.CHECKIN_RESPONDED,
        data: { commitment_id: open.commitment_id, channel: 'text' },
      });

      // ── "Help me start": a tiny intervention, then a promised check-back ──
      // Bare HELP remains the carrier-mandated information response above. A
      // specific starting request keeps the word open, re-pends this check-in
      // for two minutes, and gives one tiny move right here over text.
      if (isStartHelpReply(text)) {
        const checkBackAt = new Date(Date.now() + START_HELP_MIN * 60000).toISOString();
        await env.DB.prepare(
          `UPDATE commitment_checkins
              SET status = 'pending', scheduled_for = ?, attempts = 0,
                  last_error = NULL, responded_at = NULL
            WHERE id = ? AND user_id = ?`
        ).bind(checkBackAt, open.checkin_id, user.id).run();
        await recordEvent(env, {
          userId: user.id,
          type: EVENTS.CHECKIN_START_HELP,
          data: { commitment_id: open.commitment_id },
        });
        await sendSms(env, phone, smsStartHelpCopy({ persona }));
        return finish({
          ok: true, action: 'start_help', scheduled_for: checkBackAt,
        });
      }

      const resolveKept = async () => {
        const result = await applyCheckinOutcome(env, {
          userId: user.id,
          checkin: { id: open.checkin_id, commitment_id: open.commitment_id },
          // Keep the person's OWN words as the note when their "done" carried
          // them ("done, finally filed the taxes 🎉"), so the kept-word history
          // reads back in their voice, not a robotic label. A wordless emoji
          // "done" falls back to the neutral provenance note. `text` is the raw
          // inbound body in scope at both call sites.
          commitment, outcome: 'kept', note: keptNoteFromReply(text),
        });
        await sendSms(env, phone, smsKeptReplyCopy({ persona, streak: result.streak.current_streak }));
        return finish({ ok: true, action: 'checkin_kept' });
      };

      // ── Mid-conversation: we already asked "when?", so read this as a time ──
      // A late "done" is still honored (they did it after all); an "I'm on it"
      // mid-task is honored as a snooze — the engaged person never meets "I
      // couldn't read that time" on the exact channel the moat is built on;
      // otherwise parse a concrete time and re-arm THIS check-in for it — never a
      // miss, never punt to the app.
      if (open.checkin_status === 'awaiting_time') {
        const awaitingReply = detectCheckinReply(text);
        if (awaitingReply === 'kept') return await resolveKept();
        // "I'm on it — gimme a few" AFTER we asked "when?" is still the best-case
        // user: actively doing the thing, not rescheduling. The fresh-nudge path
        // already reads this warmly as a snooze; without this, the awaiting_time
        // path parsed it as a time, failed, and replied "I couldn't read that
        // time" — the coldest answer to the most engaged reply. Mirror the
        // fresh-nudge snooze exactly: re-pend a few minutes out, reset attempts,
        // never touch the streak (a snooze is not a resolution and not a miss). A
        // reschedule word ("later" again) is NOT a snooze — detectCheckinReply
        // runs RESCHEDULE before SNOOZE, so it returns 'reschedule' and falls
        // through to the time parse below, which warmly re-asks for a time.
        if (awaitingReply === 'snooze') {
          // Check back WHEN they said ("gimme 20", "in an hour"), not at a fixed
          // default; no named interval keeps the default. Clamped, streak-safe.
          const minutes = parseSnoozeMinutes(text) ?? SNOOZE_DEFAULT_MIN;
          const snoozedUntil = new Date(Date.now() + minutes * 60000).toISOString();
          await env.DB.prepare(
            `UPDATE commitment_checkins
                SET status = 'pending', scheduled_for = ?, attempts = 0, last_error = NULL, responded_at = NULL
              WHERE id = ? AND user_id = ?`
          ).bind(snoozedUntil, open.checkin_id, user.id).run();
          await recordEvent(env, {
            userId: user.id,
            type: EVENTS.COMMITMENT_SNOOZE,
            data: {
              commitment_id: open.commitment_id,
              is_recurring: open.recurrence === 'daily' || open.recurrence === 'weekdays',
              channel: 'text',
            },
          });
          await sendSms(env, phone, snoozeConfirmCopy({ persona, minutes, progress: isProgressReply(text) }));
          return finish({ ok: true, action: 'snoozed', scheduled_for: snoozedUntil });
        }
        const whenISO = parseWhenReply(text, {
          nowISO, timezone: open.timezone, defaultTime: open.local_time,
        });
        if (!whenISO) {
          await sendSms(env, phone, smsWhenUnclearCopy({ persona }));
          return finish({ ok: true, action: 'reschedule_when_unclear' });
        }
        // Re-pend this check-in at the chosen time. The streak is NEVER touched —
        // a reschedule protects the chain by construction. The next recurring
        // occurrence was already materialized at delivery, so the rhythm holds.
        await env.DB.prepare(
          `UPDATE commitment_checkins
              SET status = 'pending', scheduled_for = ?, attempts = 0, last_error = NULL, responded_at = NULL
            WHERE id = ? AND user_id = ?`
        ).bind(whenISO, open.checkin_id, user.id).run();
        await recordEvent(env, {
          userId: user.id,
          type: EVENTS.COMMITMENT_RESCHEDULE,
          data: {
            commitment_id: open.commitment_id,
            is_recurring: open.recurrence === 'daily' || open.recurrence === 'weekdays',
            channel: 'text',
          },
        });
        // If they reported movement in the same breath as the new time ("made good
        // progress, tomorrow 9am"), meet it by name — parity with the snooze path,
        // which already acknowledges progress. Still a reschedule: streak untouched.
        await sendSms(env, phone, smsRescheduledCopy({ persona, when: whenISO, timezone: open.timezone, nowISO, progress: isProgressReply(text), seed: open.checkin_id }));
        return finish({ ok: true, action: 'rescheduled', scheduled_for: whenISO });
      }

      // ── Fresh reply to a delivered nudge ──
      const reply = detectCheckinReply(text);

      if (reply === 'kept') return await resolveKept();

      // ── "I'm on it" over text: the third answer, mid-task ──
      // The in-app nudge has always had a snooze button beside DONE / LATER; the
      // SMS channel — the live moat — did not, so an engaged person mid-task who
      // texts "on it!" / "still working on it" got the generic "reply DONE or
      // LATER" instead of the warm "you got it, I'll swing back." That is the
      // BEST-case user (actively doing the thing) meeting the coldest reply. Mirror
      // the in-app snooze exactly: re-pend THIS check-in a few minutes out, reset
      // its attempts, and never touch the kept-word streak — a snooze is not a
      // resolution and not a miss, by construction. On the next return they can
      // still say DONE or LATER. Runs before the direct-time/ambiguous fallbacks.
      if (reply === 'snooze') {
        // An engaged reply that also names a concrete return TIME ("on it — check
        // back at 3pm", "still working, come back at 4") is not a bounded hold: the
        // person told us exactly when to return. `parseSnoozeMinutes` returns null
        // for a clock time by construction (a clock time is "a reschedule TARGET,
        // never a hold length"), so the old path silently DROPPED the 3pm and fell to
        // the default ~15-min snooze — re-nudging on top of someone who is actively
        // working and just told us when to come back, the exact nag the design LAW
        // forbids. When a clock/date target is present AND no bounded duration was
        // stated, let it fall through to the direct-time reschedule branch below,
        // which re-pends this check-in to that exact time and names it back. A bare
        // "on it" or a DURATION ("give me 20", "in an hour") is a true, bounded snooze
        // and stays here. The duration guard is load-bearing: `parseWhenReply`
        // misreads a bare "give me 20" as 20:00, so `statedMinutes == null` — not mere
        // `parseWhenReply` truthiness — is what isolates a real named clock target.
        const statedMinutes = parseSnoozeMinutes(text);
        const snoozeTargetISO = parseWhenReply(text, {
          nowISO, timezone: open.timezone, defaultTime: open.local_time,
        });
        const namesReturnTime = Boolean(snoozeTargetISO) && statedMinutes == null;
        if (!namesReturnTime) {
          // Honor a stated hold-length ("on it, give me 20", "still working, check
          // back in an hour"); no named interval keeps the default. Clamped, streak-safe.
          const minutes = statedMinutes ?? SNOOZE_DEFAULT_MIN;
          const snoozedUntil = new Date(Date.now() + minutes * 60000).toISOString();
          await env.DB.prepare(
            `UPDATE commitment_checkins
                SET status = 'pending', scheduled_for = ?, attempts = 0, last_error = NULL, responded_at = NULL
              WHERE id = ? AND user_id = ?`
          ).bind(snoozedUntil, open.checkin_id, user.id).run();
          await recordEvent(env, {
            userId: user.id,
            type: EVENTS.COMMITMENT_SNOOZE,
            data: {
              commitment_id: open.commitment_id,
              is_recurring: open.recurrence === 'daily' || open.recurrence === 'weekdays',
              channel: 'text',
            },
          });
          await sendSms(env, phone, snoozeConfirmCopy({ persona, minutes, progress: isProgressReply(text) }));
          return finish({ ok: true, action: 'snoozed', scheduled_for: snoozedUntil });
        }
        // else: an "on it, at 3pm"-style engaged reply that named a concrete return
        // time — fall through to the direct-time reschedule branch below, which honors
        // that exact time (streak untouched, a reschedule protects the chain).
      }

      // ── Answered directly with a new TIME? Reschedule in one step ──
      // The most natural way to reschedule is to answer the nudge with a concrete
      // time — "3pm", "Saturday", "tomorrow 9am", "Jul 20" — not the literal word
      // LATER. The widened parser (R-258→R-263) already reads all of it, but this
      // fresh-nudge path never called it: such a reply was either re-asked (the
      // "when?" round-trip throwing away the time they just gave) or — for a
      // phrasing detectCheckinReply can't classify, like a bare "3pm" — met with
      // "I didn't catch that", which reads as the bro not listening on the exact
      // two-way interaction the moat is built on. Honor it here, one step, exactly
      // like the awaiting-time branch: re-pend THIS check-in and read the new time
      // back. The nudge is itself a "Ready?" prompt, so a time in reply to it is
      // unambiguously a reschedule; the streak is NEVER touched — a reschedule
      // protects the chain. Runs before the ambiguous/ask-when fallbacks so a
      // "tomorrow 9am" lands directly instead of being re-asked "when tomorrow?".
      const directWhenISO = parseWhenReply(text, {
        nowISO, timezone: open.timezone, defaultTime: open.local_time,
      });
      if (directWhenISO) {
        await env.DB.prepare(
          `UPDATE commitment_checkins
              SET status = 'pending', scheduled_for = ?, attempts = 0, last_error = NULL, responded_at = NULL
            WHERE id = ? AND user_id = ?`
        ).bind(directWhenISO, open.checkin_id, user.id).run();
        await recordEvent(env, {
          userId: user.id,
          type: EVENTS.COMMITMENT_RESCHEDULE,
          data: {
            commitment_id: open.commitment_id,
            is_recurring: open.recurrence === 'daily' || open.recurrence === 'weekdays',
            channel: 'text',
          },
        });
        // Same as the awaiting-time branch: a time given with reported progress
        // ("chipping away, make it 3pm") is met by name. Still a reschedule.
        await sendSms(env, phone, smsRescheduledCopy({ persona, when: directWhenISO, timezone: open.timezone, nowISO, progress: isProgressReply(text), seed: open.checkin_id }));
        return finish({ ok: true, action: 'rescheduled', scheduled_for: directWhenISO });
      }

      if (reply === null) {
        // Not DONE, not LATER, and no concrete time — ask, warmly. NEVER assume a
        // miss from a message we didn't understand; leave the check-in open.
        await sendSms(env, phone, smsAmbiguousReplyCopy({ persona }));
        return finish({ ok: true, action: 'checkin_unclear' });
      }

      // "later" / "not yet" with no time attached → don't punt to the app. Ask
      // when, right here over text, and hold this check-in in 'awaiting_time' for
      // the person's next reply. The design LAW's literal promise: "no problem —
      // when do you want to try again?"
      //
      // Park the SPECIFIC open row we already resolved (`open`), guarded only on it
      // still being unanswered — the exact condition the open lookup required at
      // selection. The old `AND status = 'sent'` guard was too narrow: the open
      // lookup validly matches a delivered-then-re-pended check-in too (a "help me
      // start" or snooze re-pend carries `status='pending'` with `delivered_at`
      // set), so a "later" reply to one of those left the UPDATE matching zero rows
      // — the check-in stayed 'pending' at its near-future time, the promised
      // "when?" holding state never took effect, and `runDueCheckins` re-delivered
      // the nudge minutes later, nagging the person on the very moment they just
      // deferred (a design-LAW brush). `responded_at IS NULL` transitions both a
      // fresh 'sent' row and a delivered-'pending' one, matching the sibling
      // re-pend branches (which all key on `id` alone), and is a stronger optimistic
      // guard than the old one — a concurrently-resolved row is correctly skipped.
      // An 'awaiting_time' row never reaches here (handled above); a 'deferred' row
      // is never selected by the inbound open lookup — so this can only ever match
      // the intended open, unresponded occurrence.
      await env.DB.prepare(
        `UPDATE commitment_checkins SET status = 'awaiting_time'
          WHERE id = ? AND user_id = ? AND responded_at IS NULL`
      ).bind(open.checkin_id, user.id).run();
      await sendSms(env, phone, smsAskWhenCopy({ persona }));
      return finish({ ok: true, action: 'reschedule_ask_when' });
    } catch (err) {
      console.error('[consent] inbound webhook error:', err && err.message);
      if (inboxEventId && env && env.DB) {
        try {
          await env.DB.prepare(
            `UPDATE webhook_inbox
                SET status = 'failed', failed_at = CURRENT_TIMESTAMP, last_error = ?
              WHERE provider = 'telnyx' AND event_id = ?`
          ).bind(String((err && err.message) || 'processing failed').slice(0, 500), inboxEventId).run();
        } catch (recordError) {
          console.error('[consent] webhook failure recording error:', recordError && recordError.message);
        }
      }
      // A persisted processing failure is retryable by Telnyx; never hide it
      // behind a 200 that would strand the event in the inbox.
      return jsonResponse({ error: 'webhook processing failed' }, 500);
    }
  });

  // ── GET the escalation ceiling (how far up the ladder may ever climb) ──
  router.get('/api/escalation', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;
      const ceiling = await getEscalationCeiling(env, auth.userId);
      return jsonResponse({ ceiling, levels: CEILING_LEVELS }, 200, 'short');
    } catch (err) {
      console.error('[escalation] get error:', err && err.message);
      return jsonResponse({ error: 'Could not load your nudge settings.' }, 500);
    }
  });

  // ── SET the escalation ceiling ──
  // The person is always in control: this caps the ladder and the cron never
  // climbs past it. 'call' is accepted forward-compatibly (the voice rung,
  // Phase B) even though the ladder tops out at SMS until voice ships.
  router.post('/api/escalation', async (request, env) => {
    try {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;
      let body;
      try { body = await request.json(); } catch { body = null; }
      const ceiling = body && typeof body.ceiling === 'string' ? body.ceiling.toLowerCase() : null;
      if (!CEILING_LEVELS.includes(ceiling)) {
        return jsonResponse({ error: `Ceiling must be one of: ${CEILING_LEVELS.join(', ')}.` }, 400);
      }
      await env.DB.prepare(
        `INSERT INTO escalation_prefs (user_id, ceiling, updated_at)
              VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id) DO UPDATE SET ceiling = excluded.ceiling, updated_at = CURRENT_TIMESTAMP`
      ).bind(auth.userId, ceiling).run();
      return jsonResponse({ ok: true, ceiling }, 200);
    } catch (err) {
      console.error('[escalation] set error:', err && err.message);
      return jsonResponse({ error: 'Could not save that just now — try again.' }, 500);
    }
  });

  /** Durably revoke a channel's consent. Only ever writes an existing row's status. */
  async function revokeConsent(env, { userId, channel, source }) {
    await env.DB.prepare(
      `UPDATE contact_consent
          SET status = 'revoked', revoked_at = datetime('now'), revoke_source = ?, updated_at = datetime('now')
        WHERE user_id = ? AND channel = ?`
    ).bind(source || 'user', userId, channel).run();
  }
}
