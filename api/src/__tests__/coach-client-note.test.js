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
  clientNotePeakDayCopy,
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

// ── pure helper: the "strongest day" callout under the sparkline ──
describe('clientNotePeakDayCopy — a warm anchor for the shape', () => {
  it('names the peak day and its count on a genuine standout (2+ kept)', () => {
    const s = clientNotePeakDayCopy({ count: 4, whenPhrase: 'Wednesday' });
    expect(s).toContain('Wednesday');
    expect(s).toContain('4 words kept');
    expect(s.toLowerCase()).toContain('strongest day');
    expect(banned.test(s), `banned word: ${s}`).toBe(false);
  });
  it('stays silent for an all-singles window (no arbitrary best day)', () => {
    expect(clientNotePeakDayCopy({ count: 1, whenPhrase: 'Monday' })).toBe('');
  });
  it('stays silent for a quiet window and for a missing day phrase', () => {
    expect(clientNotePeakDayCopy({ count: 0, whenPhrase: 'Monday' })).toBe('');
    expect(clientNotePeakDayCopy({ count: 3, whenPhrase: '' })).toBe('');
    expect(clientNotePeakDayCopy()).toBe('');
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

  it('carries the momentum sparkline (the week\'s shape) when the weekly has one', () => {
    const note = buildClientNote({
      kept_this_week: 3,
      momentum: { days: 14, sparkline: '▁▂▃▄▅▆▇█' },
    }, { label: 'Ivy' });
    expect(note).toContain('shape of your last 14 days');
    expect(note).toContain('▁▂▃▄▅▆▇█');
    expect(banned.test(note), `banned word in note:\n${note}`).toBe(false);
  });

  it('omits the sparkline line entirely when the weekly has no momentum', () => {
    const note = buildClientNote({ kept_this_week: 2 }, { label: 'Jo' });
    expect(note).not.toContain('shape of your last');
  });

  it('carries the strongest-day callout under the sparkline on a standout window', () => {
    const note = buildClientNote({
      kept_this_week: 5,
      momentum: { days: 14, sparkline: '▁▂▃▄▅▆▇█', peak: { date: '2026-07-15', count: 3 } },
    }, { label: 'Nia', peakDayName: 'Wednesday' });
    const spark = note.indexOf('shape of your last');
    const peak = note.indexOf('strongest day so far');
    expect(spark).toBeGreaterThan(-1);
    expect(peak).toBeGreaterThan(spark); // sits directly under the shape line
    expect(note).toContain('Wednesday — 3 words kept');
    expect(banned.test(note), `banned word in note:\n${note}`).toBe(false);
  });

  it('omits the callout when the peak is only a single kept day', () => {
    const note = buildClientNote({
      kept_this_week: 2,
      momentum: { days: 14, sparkline: '▁▁▁█', peak: { date: '2026-07-15', count: 1 } },
    }, { label: 'Ola', peakDayName: 'Wednesday' });
    expect(note).toContain('shape of your last'); // shape still shows
    expect(note).not.toContain('strongest day'); // but no arbitrary best day
  });

  it('omits the callout when no peak-day phrase is supplied', () => {
    const note = buildClientNote({
      kept_this_week: 5,
      momentum: { days: 14, sparkline: '▁▂▃█', peak: { date: '2026-07-15', count: 3 } },
    }, { label: 'Pax' }); // no peakDayName
    expect(note).not.toContain('strongest day');
  });

  it('the sparkline is present and clean when built from a real buildWeeklyReport', () => {
    const H = 3600 * 1000;
    const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
    const weekly = buildWeeklyReport({
      streak: { current_streak: 2, longest_streak: 5, total_kept: 12 },
      keptTimestamps: [iso(1 * H), iso(26 * H)],
      timezone: 'UTC',
    });
    const note = buildClientNote(weekly, { label: 'Kai' });
    // buildWeeklyReport always builds a momentum block with a sparkline string.
    expect(note).toContain('shape of your last');
    expect(note).toContain(weekly.momentum.sparkline);
    expect(banned.test(note), `banned word in note:\n${note}`).toBe(false);
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
