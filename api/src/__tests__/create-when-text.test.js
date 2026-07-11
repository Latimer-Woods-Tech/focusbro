/**
 * FocusBro — the give-a-word form accepts natural-language time
 * (Contender #10, Phase A, R-226).
 *
 * The reschedule ("Move it", R-225) and the SMS reply already understood a
 * person's warm words — "in 30 min", "tomorrow 9am", "3pm" — but the very FIRST
 * word you gave still demanded a datetime picker. This suite pins the last
 * surface onto the SAME `parseWhenReply` the other two use, so a person's own
 * language works everywhere they give their word:
 *   - a natural-language `when_text` is resolved server-side and the commitment
 *     starts at that instant,
 *   - a repeating word derives its same-time-each-day anchor (`local_time`) from
 *     the resolved instant — no separate field needed,
 *   - an unreadable time is refused warmly (400, the shared voice) and writes
 *     NOTHING — never assume a time, and (per the design LAW) never a miss,
 *   - an explicit ISO `start_at` still works (backward compatible with the API
 *     and any client that sends an instant).
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import {
  registerAccountabilityRoutes,
  smsWhenUnclearCopy,
} from '../accountability.js';
import { generateUUID } from '../middleware.js';

// ── router harness (mirrors reschedule-when-text.test.js) ──────────────────
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
const ctx = {
  getAuthToken: (request) => {
    const h = request.headers.get('Authorization');
    return h && h.startsWith('Bearer ') ? h.slice(7) : null;
  },
  verifyToken: async (token) => (token === 'good' ? { sub: 'u1' } : null),
  jsonResponse,
  generateUUID,
};

// In-memory D1 double: no ownership row is needed on create; every run() is
// recorded so the test can assert exactly what was — and was NOT — written.
function makeDB() {
  const runs = [];
  const db = {
    runs,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a; return stmt; },
        async first() { return null; },
        async all() { return { results: [] }; },
        async run() { runs.push({ sql, params }); return { success: true, meta: { changes: 1 } }; },
      };
      return stmt;
    },
  };
  return db;
}

function buildRouter(db) {
  const router = Router();
  registerAccountabilityRoutes(router, ctx);
  const env = { DB: db, JWT_SECRET: 'test' };
  return (method, path, { token = 'good', body } = {}) => {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    const init = { method, headers };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    const req = new Request('https://x' + path, init);
    return router.handle(req, env);
  };
}

const insertedCommitment = (runs) => runs.some((x) => /INSERT INTO commitments\b/.test(x.sql));

describe('give-a-word accepts natural language via the shared parseWhenReply', () => {
  it('reads a natural-language when_text and starts the word ~30 min out (never past)', async () => {
    const db = makeDB();
    const call = buildRouter(db);
    const before = Date.now();
    const res = await call('POST', '/api/commitments', {
      body: { title: 'Start the taxes', when_text: 'in 30 min', timezone: 'America/New_York' },
    });
    expect(res.status).toBe(201);
    const b = await res.json();
    const t = Date.parse(b.commitment.start_at);
    expect(Number.isNaN(t)).toBe(false);
    expect(t).toBeGreaterThan(before + 29 * 60 * 1000);
    expect(t).toBeLessThan(before + 31 * 60 * 1000);
    // The word carries the person's zone, not a silent UTC.
    expect(b.commitment.timezone).toBe('America/New_York');
  });

  it('understands the same warm forms the reschedule + text channels do', async () => {
    for (const phrase of ['tomorrow 9am', '3pm', 'in 2 hours', 'tonight']) {
      const db = makeDB();
      const call = buildRouter(db);
      const res = await call('POST', '/api/commitments', {
        body: { title: 'Focus block', when_text: phrase, timezone: 'America/New_York' },
      });
      expect(res.status, phrase).toBe(201);
      const b = await res.json();
      expect(Number.isNaN(Date.parse(b.commitment.start_at)), phrase).toBe(false);
    }
  });

  it('derives the same-time-each-day anchor from the resolved instant for a repeating word', async () => {
    const db = makeDB();
    const call = buildRouter(db);
    const res = await call('POST', '/api/commitments', {
      body: { title: 'Daily outreach', when_text: 'tomorrow 9am', recurrence: 'daily', timezone: 'America/New_York' },
    });
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(b.commitment.recurrence).toBe('daily');
    // No local_time was sent — the server derived it from the resolved 9am instant.
    expect(b.commitment.local_time).toBe('09:00');
  });

  it('refuses an unreadable time warmly and writes NOTHING (never assume, never a miss)', async () => {
    const db = makeDB();
    const call = buildRouter(db);
    const res = await call('POST', '/api/commitments', {
      body: { title: 'Start the taxes', when_text: 'zzz whenever i feel like it', persona: 'ally' },
    });
    expect(res.status).toBe(400);
    const b = await res.json();
    // Shared voice — the exact copy the SMS/reschedule "when?" reply uses.
    expect(b.error).toBe(smsWhenUnclearCopy({ persona: 'ally' }));
    // No word was created from an unreadable time.
    expect(insertedCommitment(db.runs)).toBe(false);
  });

  it('still accepts an explicit ISO start_at (backward compatible)', async () => {
    const db = makeDB();
    const call = buildRouter(db);
    const iso = '2026-09-01T14:00:00.000Z';
    const res = await call('POST', '/api/commitments', {
      body: { title: 'Start the taxes', start_at: iso, timezone: 'America/New_York' },
    });
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(Date.parse(b.commitment.start_at)).toBe(Date.parse(iso));
  });
});
