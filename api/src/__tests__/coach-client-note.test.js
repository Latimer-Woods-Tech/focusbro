/**
 * FocusBro — the coach's between-session NOTE (Contender #10, Phase A · coach-GTM).
 *
 * The weekly snapshot (coach-client-weekly) lets a coach SEE where a client's
 * week stands. This slice turns that same seven-day picture into a ready-to-send,
 * copy-pasteable note a coach can drop into a text or email BETWEEN sessions —
 * the leverage artifact the coach-operator channel is about (issue #10: "the
 * coach gets the dashboard and keeps the client"). It reads in the client's own
 * second person so the coach can send it as-is or personalise it first.
 *
 * DESIGN LAW checks live here: the note is built from the SAME kept-word-framed
 * buildWeeklyReport as the rest of the surface. It celebrates kept words, a
 * reached milestone, and the next moment the bro shows up — never a miss. A quiet
 * week reads as a clean page, never a shortfall. No "AI", no clinical claim.
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import {
  registerCoachRoutes,
  clientNoteKeptCopy,
  clientNoteMomentumCopy,
  buildClientNote,
} from '../coach.js';
import { buildWeeklyReport } from '../report.js';
import { generateUUID } from '../middleware.js';

const banned = /\b(late|overdue|missed|miss|behind|fail|failed|failure|slack(ing)?|lazy|should have|guilt|shame|slipping|excuse|AI|diagnos|treat(ment)?|cure|disorder|symptom|ADHD|medication)\b/i;

// ── pure helper: the second-person kept-word headline of the note ──
describe('clientNoteKeptCopy — the note\'s kept-word line', () => {
  it('a quiet week reads as a clean page, never a shortfall', () => {
    const s = clientNoteKeptCopy({ keptThisWeek: 0 });
    expect(s.toLowerCase()).toContain('clean page');
    expect(s).not.toMatch(/\b0\b/);
    expect(banned.test(s)).toBe(false);
  });
  it('names the count, singular for one, plural for many', () => {
    expect(clientNoteKeptCopy({ keptThisWeek: 1 })).toContain('1 word ');
    expect(clientNoteKeptCopy({ keptThisWeek: 4 })).toContain('4 words');
  });
  it('capitalises its first character so it stands on its own', () => {
    expect(clientNoteKeptCopy({ keptThisWeek: 3 })[0]).toBe('Y'); // "You kept…"
    expect(clientNoteKeptCopy({ keptThisWeek: 0 })[0]).toBe('A'); // "A quiet week…"
  });
  it('is defensive about missing/garbage input (always a non-empty clean-page string)', () => {
    expect(typeof clientNoteKeptCopy()).toBe('string');
    expect(clientNoteKeptCopy().length).toBeGreaterThan(0);
    expect(clientNoteKeptCopy({ keptThisWeek: -3 }).toLowerCase()).toContain('clean page');
    expect(clientNoteKeptCopy({ keptThisWeek: 'x' }).toLowerCase()).toContain('clean page');
  });
});

// ── pure helper: the note's longer-arc kept-word momentum line ──
describe('clientNoteMomentumCopy — the note\'s momentum line', () => {
  it('names the count, the window, and the sparkline when there are wins', () => {
    const s = clientNoteMomentumCopy({ total: 12, days: 14, sparkline: '▁▂▅▃▇▄▂▅▆█▃▂▄▅' });
    expect(s).toContain('last 14 days');
    expect(s).toContain('kept 12 words');
    expect(s).toContain('▁▂▅▃▇▄▂▅▆█▃▂▄▅');
    expect(banned.test(s), `banned word in momentum line:\n${s}`).toBe(false);
  });

  it('is singular for a single kept word', () => {
    expect(clientNoteMomentumCopy({ total: 1, days: 14, sparkline: '▁' })).toContain('kept 1 word.');
  });

  it('adds a strongest-day callout only when a peak day name is supplied', () => {
    const withPeak = clientNoteMomentumCopy({ total: 5, days: 14, sparkline: '▁▂▇' }, { peakDayName: 'Tuesday' });
    expect(withPeak).toContain('your strongest day was Tuesday');
    const noPeak = clientNoteMomentumCopy({ total: 5, days: 14, sparkline: '▁▂▇' });
    expect(noPeak).not.toContain('strongest day');
  });

  it('omits itself on a quiet window — never a "0 over N days" tally', () => {
    expect(clientNoteMomentumCopy({ total: 0, days: 14, sparkline: '▁▁▁▁' })).toBe('');
    expect(clientNoteMomentumCopy({ total: -2, days: 14 })).toBe('');
  });

  it('is defensive about missing/garbage input (returns the empty string)', () => {
    expect(clientNoteMomentumCopy()).toBe('');
    expect(clientNoteMomentumCopy(null)).toBe('');
    expect(clientNoteMomentumCopy({})).toBe('');
  });
});

// ── pure builder: the full plain-text note ──
describe('buildClientNote — the copy-pasteable between-session note', () => {
  const future = (hrs) => new Date(Date.now() + hrs * 3600 * 1000).toISOString();

  it('greets by the client label and carries the kept-word line', () => {
    const weekly = { kept_this_week: 3 };
    const note = buildClientNote(weekly, { label: 'Alex' });
    expect(note).toContain('Hi Alex —');
    expect(note).toContain('You kept 3 words this week');
    expect(note).toContain('focusbro.net');
  });

  it('still greets warmly with no label', () => {
    const note = buildClientNote({ kept_this_week: 1 }, {});
    expect(note.startsWith('Hi —')).toBe(true);
    expect(note).toContain('You kept 1 word ');
  });

  it('a quiet week is a clean page — no miss, no shame, nowhere in the note', () => {
    const note = buildClientNote({ kept_this_week: 0 }, { label: 'Bo' });
    expect(note.toLowerCase()).toContain('clean page');
    expect(banned.test(note)).toBe(false);
  });

  it('includes the milestone line only when the report carries one', () => {
    const withM = buildClientNote({ kept_this_week: 3, milestone: '🎯 3 kept words in a row — that’s a real milestone. Proud of you.' }, { label: 'Cy' });
    expect(withM).toContain('milestone');
    const withoutM = buildClientNote({ kept_this_week: 2, milestone: '' }, { label: 'Cy' });
    expect(withoutM).not.toContain('milestone');
  });

  it('carries the momentum line when a momentum block with wins is supplied', () => {
    const note = buildClientNote(
      { kept_this_week: 3 },
      { label: 'Ivy', momentum: { total: 9, days: 14, sparkline: '▁▂▅▃▇▄▂▅▆' }, peakDayName: 'Wednesday' },
    );
    expect(note).toContain('Zooming out to the last 14 days');
    expect(note).toContain('kept 9 words');
    expect(note).toContain('your strongest day was Wednesday');
    expect(banned.test(note), `banned word in note:\n${note}`).toBe(false);
  });

  it('omits the momentum line on a quiet window (and when no momentum is supplied)', () => {
    const quiet = buildClientNote({ kept_this_week: 0 }, { label: 'Jo', momentum: { total: 0, days: 14, sparkline: '▁▁▁' } });
    expect(quiet).not.toContain('Zooming out');
    const none = buildClientNote({ kept_this_week: 2 }, { label: 'Jo' });
    expect(none).not.toContain('Zooming out');
  });

  it('names the SOONEST upcoming word (a future check-in only) and its cadence', () => {
    const weekly = {
      kept_this_week: 2,
      rhythms: [
        { title: 'Taxes', cadence: 'Weekdays at 9:00 AM', next_checkin: future(48) },
        { title: 'Gym', cadence: 'Daily at 7:00 AM', next_checkin: future(6) }, // soonest
      ],
    };
    const note = buildClientNote(weekly, { label: 'Dee' });
    expect(note).toContain('You’ve got "Gym" on the books');
    expect(note).toContain('Daily at 7:00 AM');
    expect(note).not.toContain('"Taxes"'); // only the soonest is surfaced
  });

  it('omits the upcoming line when there is nothing on the books', () => {
    const note = buildClientNote({ kept_this_week: 4, rhythms: [] }, { label: 'Eli' });
    expect(note).not.toContain('on the books');
  });

  it('surfaces a past-but-still-open check-in warmly, never as overdue', () => {
    const past = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    // The endpoint only ever feeds OUTSTANDING check-ins here (pending/sent/
    // deferred) — momentum, a moment about to be kept — so a slightly-past-but-
    // open one still belongs on the books, and the copy stays forward-looking.
    const note = buildClientNote({ kept_this_week: 1, rhythms: [{ title: 'Taxes', cadence: 'Weekly', next_checkin: past }] }, { label: 'Fin' });
    expect(note).toContain('"Taxes" on the books');
    expect(note).toContain('I’ll be there for it');
    expect(banned.test(note), `banned word in note:\n${note}`).toBe(false);
  });

  it('is defensive: a garbage weekly still yields a clean, sendable note', () => {
    const note = buildClientNote(null, { label: 'Gus' });
    expect(typeof note).toBe('string');
    expect(note).toContain('Hi Gus —');
    expect(note.toLowerCase()).toContain('clean page');
    expect(banned.test(note)).toBe(false);
  });

  it('the whole note is clean when built from a real buildWeeklyReport at a milestone', () => {
    const H = 3600 * 1000;
    const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
    const weekly = buildWeeklyReport({
      streak: { current_streak: 3, longest_streak: 5, total_kept: 12 },
      keptTimestamps: [iso(1 * H), iso(26 * H), iso(50 * H)],
      deliveredTimestamps: [iso(2 * H)],
      rhythms: [{ title: 'Taxes', recurrence: 'daily', local_time: '09:00', timezone: 'UTC', next_checkin: new Date(Date.now() + 6 * H).toISOString() }],
      timezone: 'UTC',
    });
    const note = buildClientNote(weekly, { label: 'Hana' });
    expect(banned.test(note), `banned word in note:\n${note}`).toBe(false);
    expect(note).toContain('You kept 3 words this week');
    expect(note).toContain('milestone'); // current run is exactly 3 → a milestone
  });
});

// ── integration: GET /api/coach/clients/:clientId exposes note_text ──
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
const ctx = {
  getAuthToken: (request) => {
    const h = request.headers.get('Authorization');
    return h && h.startsWith('Bearer ') ? h.slice(7) : null;
  },
  verifyToken: async (token) => (token === 'good' ? { sub: 'coach1' } : null),
  jsonResponse,
  generateUUID,
};

function makeDB({ link, streak, commitments = [], nextRows = [], tz = 'UTC', kept = [], delivered = [] } = {}) {
  return {
    prepare(sql) {
      const stmt = {
        bind() { return stmt; },
        async first() {
          if (/FROM coach_clients/.test(sql)) return link || null;
          if (/FROM accountability_streaks/.test(sql)) return streak || null;
          if (/SELECT timezone\s+FROM commitments/.test(sql)) return tz ? { timezone: tz } : null;
          return null;
        },
        async all() {
          if (/FROM commitments/.test(sql) && /status = 'active'/.test(sql)) return { results: commitments };
          if (/MIN\(scheduled_for\)/.test(sql)) return { results: nextRows };
          if (/status = 'kept'/.test(sql)) return { results: kept.map((t) => ({ responded_at: t })) };
          if (/FROM analytics_events/.test(sql)) return { results: delivered.map((t) => ({ created_at: t })) };
          return { results: [] };
        },
        async run() { return { success: true, meta: { changes: 1 } }; },
      };
      return stmt;
    },
  };
}

function call(db, path, { token = 'good' } = {}) {
  const router = Router();
  registerCoachRoutes(router, ctx);
  const env = { DB: db, JWT_SECRET: 'test' };
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  const req = new Request('https://x' + path, { method: 'GET', headers });
  return router.handle(req, env);
}

const H = 3600 * 1000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const future = (hrs) => new Date(Date.now() + hrs * H).toISOString();

describe('GET /api/coach/clients/:clientId — the between-session note artifact', () => {
  it('attaches a copy-pasteable note_text greeting the client and celebrating kept words', async () => {
    const db = makeDB({
      link: { client_label: 'Alex', status: 'active' },
      streak: { current_streak: 3, longest_streak: 5, total_kept: 12 },
      commitments: [{ id: 'c1', title: 'Taxes', start_at: iso(-H), checkin_at: iso(-H), status: 'active', recurrence: 'daily', local_time: '09:00', timezone: 'UTC' }],
      nextRows: [{ commitment_id: 'c1', next_for: future(6) }],
      kept: [iso(1 * H), iso(26 * H), iso(50 * H)],
      delivered: [iso(2 * H)],
    });
    const res = await call(db, '/api/coach/clients/u-a');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.note_text).toBe('string');
    expect(body.note_text).toContain('Hi Alex —');
    expect(body.note_text).toContain('You kept 3 words this week');
    expect(body.note_text).toContain('"Taxes" on the books');
    // The sendable note now also carries the longer kept-word arc (the same
    // momentum the endpoint attaches as `momentum`), voiced for the client.
    expect(body.note_text).toContain('Zooming out to the last');
    expect(banned.test(body.note_text), `banned word in note:\n${body.note_text}`).toBe(false);
  });

  it('a quiet week still yields a clean-page note (no miss anywhere)', async () => {
    const db = makeDB({
      link: { client_label: 'Bo', status: 'active' },
      streak: { current_streak: 0, longest_streak: 0, total_kept: 0 },
      commitments: [],
      kept: [],
      delivered: [],
    });
    const res = await call(db, '/api/coach/clients/u-b');
    const body = await res.json();
    expect(body.note_text.toLowerCase()).toContain('clean page');
    expect(body.note_text).not.toContain('on the books');
    expect(body.note_text).not.toContain('Zooming out'); // no momentum tally on a quiet window
    expect(banned.test(body.note_text)).toBe(false);
  });

  it('does not leak a note for a link that is not active (consent gate)', async () => {
    const db = makeDB({ link: { client_label: 'Cass', status: 'pending' } });
    const res = await call(db, '/api/coach/clients/u-c');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.note_text).toBeUndefined();
  });
});
