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

/** Channels that are TCPA-scoped outbound contact. Push is app UX, not a call/text. */
export const CONSENT_CHANNELS = ['text', 'voice'];

/**
 * Version stamp for the consent language. Bump when the disclosure wording
 * changes so a consent record always tells us exactly what the person agreed to.
 */
export const CONSENT_VERSION = '2026-07-06.1';

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

/** Standard opt-out keywords — honored instantly and durably. */
export function isStopKeyword(t) {
  return /^(stop|stopall|unsubscribe|cancel|end|quit|optout|opt-out)$/i.test(String(t == null ? '' : t).trim());
}
/** Standard opt-in / resume keywords. */
export function isStartKeyword(t) {
  return /^(start|unstop|yes|optin|opt-in)$/i.test(String(t == null ? '' : t).trim());
}
/** Standard help keyword. */
export function isHelpKeyword(t) {
  return /^(help|info)$/i.test(String(t == null ? '' : t).trim());
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

// ── ROUTES ───────────────────────────────────────────────────

/**
 * Register the consent API on an itty-router instance.
 * @param {object} router  itty-router instance
 * @param {object} ctx  { getAuthToken, verifyToken, jsonResponse, generateUUID }
 */
export function registerConsentRoutes(router, ctx) {
  const { getAuthToken, verifyToken, jsonResponse, generateUUID } = ctx;

  async function requireUser(request, env) {
    const token = getAuthToken(request);
    if (!token) return { error: jsonResponse({ error: 'Unauthorized' }, 401) };
    const payload = await verifyToken(token, env.JWT_SECRET);
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
  // TCPA one-word opt-out honored instantly + durably. Fail-safe: this route
  // only ever toggles a person's own contact state by their number — it never
  // leaks data or sends. Signature is verified when TELNYX_PUBLIC_KEY is set.
  router.post('/api/webhooks/telnyx/inbound', async (request, env) => {
    try {
      const raw = await request.text();

      if (env.TELNYX_PUBLIC_KEY) {
        const ts = request.headers.get('telnyx-timestamp') || '';
        const sig = request.headers.get('telnyx-signature-ed25519') || '';
        const ok = await verifyTelnyxSignature(env.TELNYX_PUBLIC_KEY, raw, ts, sig);
        if (!ok) return jsonResponse({ error: 'bad signature' }, 401);
      }

      let evt;
      try { evt = JSON.parse(raw); } catch { evt = null; }
      const payload = evt && evt.data && evt.data.payload;
      const from = payload && payload.from && payload.from.phone_number;
      const text = payload && typeof payload.text === 'string' ? payload.text : '';
      const phone = normalizePhone(from);
      if (!phone) return jsonResponse({ ok: true, ignored: 'no_from' }, 200);

      const user = await env.DB.prepare(`SELECT id FROM users WHERE phone = ?`).bind(phone).first();
      if (!user) return jsonResponse({ ok: true, ignored: 'unknown_number' }, 200);

      let action = 'none';
      if (isStopKeyword(text)) {
        await revokeConsent(env, { userId: user.id, channel: 'text', source: 'sms' });
        action = 'opted_out';
      } else if (isStartKeyword(text)) {
        // Re-grant only if a prior consent exists for this channel (keeps its recorded language).
        const res = await env.DB.prepare(
          `UPDATE contact_consent
              SET status = 'granted', revoked_at = NULL, revoke_source = NULL, updated_at = datetime('now')
            WHERE user_id = ? AND channel = 'text'`
        ).bind(user.id).run();
        action = (res && res.meta && res.meta.changes) ? 'opted_in' : 'none';
      } else if (isHelpKeyword(text)) {
        action = 'help';
      }

      return jsonResponse({ ok: true, action }, 200);
    } catch (err) {
      console.error('[consent] inbound webhook error:', err && err.message);
      // Webhooks must not retry-storm on our errors; acknowledge.
      return jsonResponse({ ok: true, action: 'error' }, 200);
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
