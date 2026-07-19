/**
 * FocusBro — two-way text check-ins (Contender #10, Phase A).
 *
 * A text check-in ("You said you'd start the taxes at 2 — ready?") is only half
 * the loop if you can't answer it. This suite covers the reply half:
 *   - detectCheckinReply reads "done / did it / yep" as KEPT and
 *     "later / not yet / tomorrow" as the no-shame RESCHEDULE, and returns null
 *     (ask, never assume a miss) for anything it can't read.
 *   - applyCheckinOutcome resolves the open check-in, moves the streak the same
 *     way the in-app path does, and re-queues a recurring rhythm.
 *   - the inbound Telnyx webhook wires an SMS reply through to resolution and
 *     texts a warm confirmation back — with STOP/HELP/START still winning first.
 *
 * The design LAW is re-asserted on every reply string: an ally, never a scold,
 * never "AI", never a clinical claim.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Router } from 'itty-router';
import {
  detectCheckinReply,
  applyCheckinOutcome,
  parseWhenReply,
  formatWhenLocal,
  smsKeptReplyCopy,
  smsRescheduleReplyCopy,
  smsAmbiguousReplyCopy,
  smsAskWhenCopy,
  smsRescheduledCopy,
  smsWhenUnclearCopy,
} from '../accountability.js';
import { registerConsentRoutes } from '../consent.js';
import { generateUUID } from '../middleware.js';

// ── detectCheckinReply ───────────────────────────────────────
describe('detectCheckinReply — reads a reply the way a friend would', () => {
  it('reads "done" and its family as KEPT', () => {
    for (const t of ['done', 'Done!', 'did it', 'did that', 'finished', 'complete',
                     'completed', 'got it done', 'all done', 'yep', 'yup', 'yeah',
                     'yes', 'nailed it', 'crushed it ✅', 'DONE ✔️']) {
      expect(detectCheckinReply(t), t).toBe('kept');
    }
  });

  it('reads an elongated / variant yes ("yea", "yesss", "yaas", "yah") as KEPT', () => {
    // An excited one-word affirmation is a near-universal "done" on the live
    // two-way moat; the un-stretched forms used to be the only ones that landed,
    // so "yesss"/"yea"/"yah" fell through to "I didn't catch that".
    for (const t of ['yea', 'yeaah', 'yesss', 'yess', 'yaas', 'yasss', 'yah', 'yahh',
                     'yepp', 'yuppp', 'yayyy', 'YESSS!']) {
      expect(detectCheckinReply(t), t).toBe('kept');
    }
  });

  it('does not read a real word that merely starts with a yes-run as KEPT', () => {
    // The elongation runs are anchored on both ends, so ordinary words never trip it.
    for (const t of ['yeast', 'year', 'yesterday', 'yard']) {
      expect(detectCheckinReply(t), t).toBeNull();
    }
    // A negated affirmation is still a reschedule, never misread as kept.
    expect(detectCheckinReply('not yet yea')).toBe('reschedule');
  });

  it('reads "later" and its family as the no-shame RESCHEDULE', () => {
    for (const t of ['later', 'not yet', 'notyet', 'nope', 'tomorrow', 'reschedule',
                     'snooze', 'skip', 'rain check', 'another time', "can't right now",
                     'no can do', "didn't get to it", 'move it', 'push it']) {
      expect(detectCheckinReply(t), t).toBe('reschedule');
    }
  });

  it('never misreads a negated "done" as kept', () => {
    expect(detectCheckinReply('not done')).toBe('reschedule');
    expect(detectCheckinReply("didn't finish")).toBe('reschedule');
  });

  it('handles bare one-letter answers', () => {
    expect(detectCheckinReply('y')).toBe('kept');
    expect(detectCheckinReply('n')).toBe('reschedule');
    expect(detectCheckinReply('no')).toBe('reschedule');
  });

  it('returns null when it cannot tell — so we ask, never assume a miss', () => {
    // (Note: a message like "call me later about the car" contains "later" and is
    //  read as reschedule — that's acceptable. We only assert the truly ambiguous.)
    expect(detectCheckinReply('')).toBeNull();
    expect(detectCheckinReply('what?')).toBeNull();
    expect(detectCheckinReply('who is this')).toBeNull();
    expect(detectCheckinReply('🤔')).toBeNull();
  });

  it('reads a bare positive emoji as KEPT — a 👍 is a "done" on the live moat', () => {
    for (const t of ['👍', '✅', '✔️', '🙌', '💪', '🎉', '🔥', '💯', '👌',
                     '👍👍', '👍 ', ' ✅']) {
      expect(detectCheckinReply(t), t).toBe('kept');
    }
  });

  it('lets the words win when a positive emoji rides along with them', () => {
    // A textual reschedule signal is never overridden by a trailing 👍.
    expect(detectCheckinReply('not yet 👍')).toBe('reschedule');
    expect(detectCheckinReply('later 🙌')).toBe('reschedule');
    expect(detectCheckinReply("can't 💪")).toBe('reschedule');
    // A textual "done" still reads as kept via the words (independent of emoji).
    expect(detectCheckinReply('did it 🎉')).toBe('kept');
    // A positive emoji beside words we can't classify still counts as done.
    expect(detectCheckinReply('meh 👍')).toBe('kept');
  });

  it('never maps a non-affirmation emoji to a miss — it falls through to the warm ask', () => {
    // Only positive-completion emoji mean "done"; anything else stays ambiguous so
    // the bro asks "when do you want to try again?" instead of assuming a miss.
    expect(detectCheckinReply('🤔')).toBeNull();
    expect(detectCheckinReply('😴')).toBeNull();
    expect(detectCheckinReply('👎')).toBeNull();
  });
});

// ── DESIGN LAW on the reply copy ─────────────────────────────
describe('copy law — SMS reply strings never shame, never "AI", never clinical', () => {
  const SHAME = [
    /\bfail(ed|ure|ing|s)?\b/i, /\blaz(y|iness)\b/i, /\bdisappoint/i, /\bguilt/i,
    /\bashamed\b/i, /\bshame\b/i, /\byou (didn.?t|should have|should.?ve)\b/i,
    /\bfall(ing|en)? behind\b/i, /\bbehind again\b/i, /\bexcuse/i, /\bpathetic\b/i,
    /\bworthless\b/i,
  ];
  const CLINICAL = [/\btreat(s|ment|ing)?\b/i, /\bcure/i, /\bdiagnos/i, /\bdisorder/i, /\bsymptom/i, /\bADHD\b/i, /\bmedication\b/i];
  const AI = /\bAI\b/;

  const samples = [];
  for (const persona of ['ally', 'hype', 'unknown']) {
    for (const streak of [0, 1, 2, 30]) samples.push(smsKeptReplyCopy({ persona, streak }));
    samples.push(smsRescheduleReplyCopy({ persona }));
    samples.push(smsAmbiguousReplyCopy({ persona }));
  }

  it('are all non-empty strings', () => {
    for (const s of samples) { expect(typeof s).toBe('string'); expect(s.trim().length).toBeGreaterThan(0); }
  });
  it('never shame', () => {
    for (const s of samples) for (const p of SHAME) expect(p.test(s), `${s} matched ${p}`).toBe(false);
  });
  it('never say "AI"', () => {
    for (const s of samples) expect(AI.test(s), s).toBe(false);
  });
  it('never make a clinical claim', () => {
    for (const s of samples) for (const p of CLINICAL) expect(p.test(s), `${s} matched ${p}`).toBe(false);
  });
  it('the reschedule reply keeps the door open (a new time, streak safe)', () => {
    for (const persona of ['ally', 'hype']) {
      const s = smsRescheduleReplyCopy({ persona }).toLowerCase();
      expect(s).toMatch(/new time|fresh time|whenever|no problem|all good/);
      expect(s).toMatch(/streak|word|counts?|safe/);
    }
  });
});

// ── applyCheckinOutcome — the shared resolution core ─────────
// A minimal D1-shaped fake that records run() calls and answers first()/all()
// by SQL substring. Streak reads return `streak`; the recurring "is there a
// future pending row?" probe returns `existingPending`.
function makeDB({ streak = null, existingPending = null } = {}) {
  const runs = [];
  const db = {
    runs,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a; return stmt; },
        async first() {
          if (/FROM accountability_streaks/.test(sql)) return streak;
          if (/FROM commitment_checkins\s+WHERE commitment_id = \? AND status = 'pending'/.test(sql)) return existingPending;
          return null;
        },
        async all() { return { results: [] }; },
        async run() { runs.push({ sql, params }); return { success: true, meta: { changes: 1 } }; },
      };
      return stmt;
    },
  };
  return db;
}

const oneShot = { id: 'cm1', recurrence: 'none', timezone: 'UTC', local_time: null, channel: 'text', persona: 'ally' };
const daily = { id: 'cm2', recurrence: 'daily', timezone: 'America/New_York', local_time: '08:40', channel: 'text', persona: 'ally' };

describe('applyCheckinOutcome — resolves the check-in + moves the streak', () => {
  it('KEPT increments the streak and stamps the exact check-in row', async () => {
    const db = makeDB({ streak: { current_streak: 4, longest_streak: 4, total_kept: 4, last_kept_date: '2026-07-05' } });
    const r = await applyCheckinOutcome({ DB: db }, {
      userId: 'u1', checkin: { id: 'ci1', commitment_id: 'cm1' }, commitment: oneShot,
      outcome: 'kept', nowISO: '2026-07-06T14:00:00.000Z',
    });
    expect(r.streak.current_streak).toBe(5);
    // the specific check-in row was stamped kept
    const upd = db.runs.find((x) => /UPDATE commitment_checkins/.test(x.sql));
    expect(upd.params).toContain('ci1');
    expect(upd.params).toContain('kept');
    // one-shot commitment moved to terminal 'kept'
    const cUpd = db.runs.find((x) => /UPDATE commitments SET status/.test(x.sql));
    expect(cUpd.params).toContain('kept');
    // streak persisted
    expect(db.runs.some((x) => /INSERT INTO accountability_streaks/.test(x.sql))).toBe(true);
  });

  it('RESCHEDULE protects the streak (never breaks the chain)', async () => {
    const db = makeDB({ streak: { current_streak: 6, longest_streak: 9, total_kept: 20, last_kept_date: '2026-07-05' } });
    const r = await applyCheckinOutcome({ DB: db }, {
      userId: 'u1', checkin: { id: 'ci1', commitment_id: 'cm1' }, commitment: oneShot, outcome: 'reschedule',
    });
    expect(r.streak.current_streak).toBe(6); // unchanged — the no-shame guarantee
    const cUpd = db.runs.find((x) => /UPDATE commitments SET status/.test(x.sql));
    expect(cUpd.params).toContain('rescheduled');
  });

  it('a recurring commitment stays active and re-queues its next occurrence', async () => {
    const db = makeDB({ streak: null, existingPending: null });
    const r = await applyCheckinOutcome({ DB: db }, {
      userId: 'u1', checkin: { id: 'ci9', commitment_id: 'cm2' }, commitment: daily,
      outcome: 'kept', nowISO: '2026-07-06T13:00:00.000Z',
    });
    expect(r.isRecurring).toBe(true);
    // commitment kept 'active' (a rhythm is never "done")
    const cUpd = db.runs.find((x) => /UPDATE commitments SET status/.test(x.sql));
    expect(cUpd.params).toContain('active');
    // next occurrence materialized
    expect(db.runs.some((x) => /INSERT INTO commitment_checkins/.test(x.sql))).toBe(true);
  });

  it('a recurring commitment does NOT double-queue if a future pending row exists', async () => {
    const db = makeDB({ existingPending: { id: 'future' } });
    await applyCheckinOutcome({ DB: db }, {
      userId: 'u1', checkin: { id: 'ci9', commitment_id: 'cm2' }, commitment: daily,
      outcome: 'kept', nowISO: '2026-07-06T13:00:00.000Z',
    });
    expect(db.runs.some((x) => /INSERT INTO commitment_checkins/.test(x.sql))).toBe(false);
  });
});

// ── the inbound webhook, end to end ──────────────────────────
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// A fuller fake DB for the webhook: resolves the user, the open check-in, and
// records run()s. `optedOut` controls whether a START re-grant "changes" a row.
function makeWebhookDB({ user = { id: 'u1' }, open = null, optedOut = false, streak = null } = {}) {
  const runs = [];
  const db = {
    runs,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a; return stmt; },
        async first() {
          if (/FROM users WHERE phone/.test(sql)) return user;
          if (/FROM commitment_checkins c\s+JOIN commitments m/.test(sql)) return open;
          if (/FROM accountability_streaks/.test(sql)) return streak;
          if (/FROM commitment_checkins\s+WHERE commitment_id = \? AND status = 'pending'/.test(sql)) return null;
          return null;
        },
        async all() { return { results: [] }; },
        async run() {
          runs.push({ sql, params });
          // START re-grant only "changes" a row when the user was opted out.
          if (/UPDATE contact_consent[\s\S]*status = 'revoked'/.test(sql)) {
            return { success: true, meta: { changes: optedOut ? 1 : 0 } };
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return db;
}

const TELNYX_ENV = { TELNYX_API_KEY: 'k', TELNYX_FROM_NUMBER: '+15550001111' };
const openText = { checkin_id: 'ci1', commitment_id: 'cm1', recurrence: 'none', timezone: 'UTC', local_time: null, channel: 'text', persona: 'ally' };

function buildRouter(db) {
  const router = Router();
  registerConsentRoutes(router, { getAuthToken: () => null, verifyToken: async () => null, jsonResponse, generateUUID });
  return router;
}

function inbound(text, from = '+15551234567') {
  return new Request('https://focusbro.net/api/webhooks/telnyx/inbound', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { payload: { from: { phone_number: from }, text } } }),
  });
}

describe('inbound webhook — a text check-in is a real two-way conversation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('"done" resolves the open check-in as KEPT and texts a warm confirmation', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const db = makeWebhookDB({ open: openText, streak: { current_streak: 2, longest_streak: 2, total_kept: 2 } });
    const res = await buildRouter(db).handle(inbound('done'), { ...TELNYX_ENV, DB: db });
    const body = await res.json();
    expect(body.action).toBe('checkin_kept');
    expect(db.runs.some((x) => /UPDATE commitment_checkins/.test(x.sql) && x.params.includes('kept'))).toBe(true);
    // a confirmation SMS went out
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.to).toBe('+15551234567');
    expect(sent.text.toLowerCase()).toMatch(/did the thing|you did/);
  });

  it('"later" ASKS when — right over text, holding the check-in for the answer (never punts to the app)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const db = makeWebhookDB({ open: openText });
    const res = await buildRouter(db).handle(inbound('later'), { ...TELNYX_ENV, DB: db });
    expect((await res.json()).action).toBe('reschedule_ask_when');
    // the check-in is parked awaiting a time — NOT resolved, NOT a miss, streak untouched
    expect(db.runs.some((x) => /UPDATE commitment_checkins SET status = 'awaiting_time'/.test(x.sql))).toBe(true);
    expect(db.runs.some((x) => /UPDATE commitments SET status/.test(x.sql))).toBe(false);
    // and the bro asks "when do you want to try again?" on the channel that reached them
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.text.toLowerCase()).toMatch(/when do you want to try again/);
    expect(sent.text.toLowerCase()).not.toMatch(/in the app/);
  });

  // ── Answering the FRESH nudge directly with a time (R-264) ──
  // A person's most natural reschedule is to answer "Ready?" with a new time, not
  // the literal word LATER. Before R-264 that reply was stranded on the fresh
  // path: a clock/weekday/date detectCheckinReply can't classify hit the "I
  // didn't catch that" copy, and even "tomorrow 9am" cost a redundant "when?"
  // round-trip. These lock the one-step reschedule — same read-back, streak safe.
  it('a bare TIME reply to a fresh nudge ("3pm") reschedules in one step — no "when?" round-trip, no "I didn\'t catch that"', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const db = makeWebhookDB({ open: openText });
    const res = await buildRouter(db).handle(inbound('3pm'), { ...TELNYX_ENV, DB: db });
    const body = await res.json();
    expect(body.action).toBe('rescheduled');
    expect(typeof body.scheduled_for).toBe('string');
    // re-pended directly at the chosen time — never parked awaiting_time, never ambiguous
    expect(db.runs.some((x) => /UPDATE commitment_checkins\s+SET status = 'pending', scheduled_for/.test(x.sql))).toBe(true);
    expect(db.runs.some((x) => /awaiting_time/.test(x.sql))).toBe(false);
    // streak is NEVER touched — a reschedule protects the chain by construction
    expect(db.runs.some((x) => /INSERT INTO accountability_streaks|UPDATE commitments SET status/.test(x.sql))).toBe(false);
    // the warm read-back confirmation went out (not the "I didn't catch that" copy)
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.text.toLowerCase()).toMatch(/check back/);
    expect(sent.text.toLowerCase()).not.toMatch(/did you|reply done|pick a new time/);
  });

  it('a weekday reply to a fresh nudge ("Saturday") reschedules directly', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const db = makeWebhookDB({ open: openText });
    const res = await buildRouter(db).handle(inbound('Saturday'), { ...TELNYX_ENV, DB: db });
    const body = await res.json();
    expect(body.action).toBe('rescheduled');
    expect(typeof body.scheduled_for).toBe('string');
    expect(db.runs.some((x) => /UPDATE commitment_checkins\s+SET status = 'pending', scheduled_for/.test(x.sql))).toBe(true);
  });

  it('"tomorrow 9am" on a fresh nudge lands directly instead of a redundant "when tomorrow?"', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const db = makeWebhookDB({ open: openText });
    const res = await buildRouter(db).handle(inbound('tomorrow 9am'), { ...TELNYX_ENV, DB: db });
    const body = await res.json();
    expect(body.action).toBe('rescheduled');
    // one step: rescheduled, NOT parked awaiting a further "when?" answer
    expect(db.runs.some((x) => /awaiting_time/.test(x.sql))).toBe(false);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.text.toLowerCase()).not.toMatch(/when do you want to try again/);
  });

  it('regression: bare "later" (no time) STILL asks when — the direct path only fires on a real time', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const db = makeWebhookDB({ open: openText });
    const res = await buildRouter(db).handle(inbound('later'), { ...TELNYX_ENV, DB: db });
    expect((await res.json()).action).toBe('reschedule_ask_when');
    expect(db.runs.some((x) => /UPDATE commitment_checkins SET status = 'awaiting_time'/.test(x.sql))).toBe(true);
    // no direct re-pend happened
    expect(db.runs.some((x) => /SET status = 'pending', scheduled_for/.test(x.sql))).toBe(false);
  });

  it('regression: a truly unreadable fresh reply ("who is this?") STILL leaves it open (never a miss)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const db = makeWebhookDB({ open: openText });
    const res = await buildRouter(db).handle(inbound('who is this?'), { ...TELNYX_ENV, DB: db });
    expect((await res.json()).action).toBe('checkin_unclear');
    expect(db.runs.some((x) => /UPDATE commitment_checkins/.test(x.sql))).toBe(false);
  });

  it('a time reply while awaiting → re-arms THIS check-in for that time (streak safe, no app)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const awaiting = { ...openText, checkin_status: 'awaiting_time', timezone: 'America/New_York', local_time: '08:40' };
    const db = makeWebhookDB({ open: awaiting });
    const res = await buildRouter(db).handle(inbound('in 1 hour'), { ...TELNYX_ENV, DB: db });
    const body = await res.json();
    expect(body.action).toBe('rescheduled');
    expect(typeof body.scheduled_for).toBe('string');
    // the check-in was re-pended (not resolved, streak never read/written)
    expect(db.runs.some((x) => /UPDATE commitment_checkins\s+SET status = 'pending', scheduled_for/.test(x.sql))).toBe(true);
    expect(db.runs.some((x) => /INSERT INTO accountability_streaks|UPDATE commitments SET status/.test(x.sql))).toBe(false);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.text.toLowerCase()).toMatch(/check back/);
  });

  it('a late "done" while awaiting a time is still honored as KEPT', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    const awaiting = { ...openText, checkin_status: 'awaiting_time' };
    const db = makeWebhookDB({ open: awaiting, streak: { current_streak: 1, longest_streak: 1, total_kept: 1 } });
    const res = await buildRouter(db).handle(inbound('actually done'), { ...TELNYX_ENV, DB: db });
    expect((await res.json()).action).toBe('checkin_kept');
    expect(db.runs.some((x) => /UPDATE commitment_checkins/.test(x.sql) && x.params.includes('kept'))).toBe(true);
  });

  it('an unreadable time while awaiting → re-asks warmly, still no miss', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const awaiting = { ...openText, checkin_status: 'awaiting_time' };
    const db = makeWebhookDB({ open: awaiting });
    const res = await buildRouter(db).handle(inbound('ummm idk'), { ...TELNYX_ENV, DB: db });
    expect((await res.json()).action).toBe('reschedule_when_unclear');
    // nothing resolved; the check-in stays awaiting
    expect(db.runs.some((x) => /UPDATE commitment_checkins/.test(x.sql))).toBe(false);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.text.toLowerCase()).toMatch(/try something like/);
  });

  it('a bare "yes" from a NOT-opted-out user answers the check-in (not a re-subscribe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    const db = makeWebhookDB({ open: openText, optedOut: false, streak: null });
    const res = await buildRouter(db).handle(inbound('yes'), { ...TELNYX_ENV, DB: db });
    expect((await res.json()).action).toBe('checkin_kept');
  });

  it('STOP still wins — it opts out and never touches a check-in', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    const db = makeWebhookDB({ open: openText });
    const res = await buildRouter(db).handle(inbound('STOP'), { ...TELNYX_ENV, DB: db });
    expect((await res.json()).action).toBe('opted_out');
    expect(db.runs.some((x) => /UPDATE commitment_checkins/.test(x.sql))).toBe(false);
  });

  it('an unreadable reply leaves the check-in OPEN and asks warmly (never a miss)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const db = makeWebhookDB({ open: openText });
    const res = await buildRouter(db).handle(inbound('who is this?'), { ...TELNYX_ENV, DB: db });
    expect((await res.json()).action).toBe('checkin_unclear');
    // no resolution was written
    expect(db.runs.some((x) => /UPDATE commitment_checkins/.test(x.sql))).toBe(false);
    // but a gentle clarifying nudge was sent
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.text.toLowerCase()).toMatch(/done|later/);
  });

  it('a reply with no open check-in is acknowledged silently (never text unprompted)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const db = makeWebhookDB({ open: null });
    const res = await buildRouter(db).handle(inbound('done'), { ...TELNYX_ENV, DB: db });
    expect((await res.json()).action).toBe('no_open_checkin');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── parseWhenReply — read a "when do you want to try again?" answer ──
describe('parseWhenReply — natural-language time, DST-correct, never guesses a miss', () => {
  const NOW = '2026-07-06T15:00:00.000Z'; // UTC anchor for the simple cases

  it('reads relative "in ..." forms', () => {
    expect(parseWhenReply('in 30 min', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-06T15:30:00.000Z');
    expect(parseWhenReply('in 2 hours', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-06T17:00:00.000Z');
    expect(parseWhenReply('in an hour', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-06T16:00:00.000Z');
    expect(parseWhenReply('in half an hour', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-06T15:30:00.000Z');
    expect(parseWhenReply('in 20', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-06T15:20:00.000Z');
  });

  it('reads relative "in N days / weeks" forms, not as N minutes', () => {
    // Regression: "in 2 days" used to land 2 *minutes* out (no unit → numeric
    // branch), the bro arriving seconds later instead of in two days — a nag.
    expect(parseWhenReply('in 2 days', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-08T15:00:00.000Z');
    expect(parseWhenReply('in 1 day', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-07T15:00:00.000Z');
    expect(parseWhenReply('in 3d', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-09T15:00:00.000Z');
    expect(parseWhenReply('in a day', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-07T15:00:00.000Z');
    expect(parseWhenReply('in a week', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-13T15:00:00.000Z');
    expect(parseWhenReply('in 1 week', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-13T15:00:00.000Z');
    // Two weeks is exactly the 14-day reschedule horizon — still in range.
    expect(parseWhenReply('in 2 weeks', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-20T15:00:00.000Z');
    // Past the horizon → unreadable, falls through to the warm "when again?" ask.
    expect(parseWhenReply('in 3 weeks', { nowISO: NOW, timezone: 'UTC' })).toBeNull();
    expect(parseWhenReply('in 30 days', { nowISO: NOW, timezone: 'UTC' })).toBeNull();
    // Minutes/hours unchanged; a bare number still reads as minutes.
    expect(parseWhenReply('in 45 minutes', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-06T15:45:00.000Z');
    expect(parseWhenReply('in 5', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-06T15:05:00.000Z');
  });

  it('reads clock times, rolling to tomorrow when already past', () => {
    expect(parseWhenReply('6pm', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-06T18:00:00.000Z');
    expect(parseWhenReply('18:00', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-06T18:00:00.000Z');
    // noon already passed at 15:00 → tomorrow noon
    expect(parseWhenReply('noon', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-07T12:00:00.000Z');
    // ambiguous bare "8": 08:00 today passed, 20:00 today is the soonest future
    expect(parseWhenReply('8', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-06T20:00:00.000Z');
  });

  it('reads "tomorrow", using the usual check-in time when no clock is given', () => {
    expect(parseWhenReply('tomorrow 9am', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-07T09:00:00.000Z');
    expect(parseWhenReply('tomorrow', { nowISO: NOW, timezone: 'UTC', defaultTime: '08:40' })).toBe('2026-07-07T08:40:00.000Z');
    expect(parseWhenReply('tomorrow morning', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-07T09:00:00.000Z');
  });

  it('reads a bare part-of-day today ("this afternoon", "this morning"), rolling to the same part of day tomorrow if it has passed', () => {
    // Early in the day (08:00 UTC) the part of day is still ahead → lands TODAY,
    // instead of falling through to a null "I didn't catch a time" (the bug this
    // pins: a natural reschedule answer going unread on the two-way text moat).
    const MORNING = '2026-07-06T08:00:00.000Z';
    expect(parseWhenReply('this morning', { nowISO: MORNING, timezone: 'UTC' })).toBe('2026-07-06T09:00:00.000Z');
    expect(parseWhenReply('this afternoon', { nowISO: MORNING, timezone: 'UTC' })).toBe('2026-07-06T14:00:00.000Z');
    expect(parseWhenReply('later this afternoon', { nowISO: MORNING, timezone: 'UTC' })).toBe('2026-07-06T14:00:00.000Z');
    // Bare part-of-day (no "this") reads the same way.
    expect(parseWhenReply('afternoon', { nowISO: MORNING, timezone: 'UTC' })).toBe('2026-07-06T14:00:00.000Z');
    // Once that part of day has passed, it rolls to the SAME part of day tomorrow
    // (never-past, mirroring the "tonight" branch) — never a null. NOW is 15:00,
    // so today's afternoon (14:00) and morning (09:00) are both behind us.
    expect(parseWhenReply('this afternoon', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-07T14:00:00.000Z');
    expect(parseWhenReply('this morning', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-07T09:00:00.000Z');
    // "this evening"/"tonight" are unchanged — their own branch lands today 20:00.
    expect(parseWhenReply('this evening', { nowISO: MORNING, timezone: 'UTC' })).toBe('2026-07-06T20:00:00.000Z');
    // DST-correct in the recipient zone: this afternoon (14:00 local) in
    // America/New_York (EDT, UTC-4) → 18:00Z.
    expect(parseWhenReply('this afternoon', { nowISO: MORNING, timezone: 'America/New_York' })).toBe('2026-07-06T18:00:00.000Z');
  });

  it('reads "day after tomorrow" as two days out, not one (contains "tomorrow" but means +2)', () => {
    // NOW is Monday 2026-07-06 → day-after-tomorrow is Wednesday 2026-07-08.
    expect(parseWhenReply('day after tomorrow', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-08T09:00:00.000Z');
    expect(parseWhenReply('day after tomorrow', { nowISO: NOW, timezone: 'UTC', defaultTime: '08:40' })).toBe('2026-07-08T08:40:00.000Z');
    // A clock time / part-of-day / abbreviation rides it, same reading as the tomorrow branch.
    expect(parseWhenReply('day after tomorrow 3pm', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-08T15:00:00.000Z');
    expect(parseWhenReply('the day after tomorrow at 10am', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-08T10:00:00.000Z');
    expect(parseWhenReply('day after tmrw', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-08T09:00:00.000Z');
    expect(parseWhenReply('day after tomorrow morning', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-08T09:00:00.000Z');
    // A plain "tomorrow" is unchanged — still one day out.
    expect(parseWhenReply('tomorrow', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-07T09:00:00.000Z');
    // DST-correct in the recipient zone: 3pm on Jul 8 in America/New_York (EDT, UTC-4) → 19:00Z.
    expect(parseWhenReply('day after tomorrow 3pm', { nowISO: NOW, timezone: 'America/New_York' })).toBe('2026-07-08T19:00:00.000Z');
  });

  it('reads a named weekday within the two-week horizon (NOW is Monday 2026-07-06)', () => {
    // Bare weekday = soonest future occurrence at the usual/default time.
    expect(parseWhenReply('tuesday', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-07T09:00:00.000Z');
    expect(parseWhenReply('sunday', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-12T09:00:00.000Z');
    // Naming today's own weekday rolls to next week when the default time has passed.
    expect(parseWhenReply('monday', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-13T09:00:00.000Z');
    // A clock time rides the weekday, same reading as the tomorrow branch.
    expect(parseWhenReply('mon 5pm', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-06T17:00:00.000Z');
    expect(parseWhenReply('friday 3pm', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-10T15:00:00.000Z');
    // Part-of-day rides the weekday too.
    expect(parseWhenReply('saturday morning', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-11T09:00:00.000Z');
    // "weekend" reads as Saturday.
    expect(parseWhenReply('this weekend', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-11T09:00:00.000Z');
    // "next X" forces the following week.
    expect(parseWhenReply('next tuesday', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-14T09:00:00.000Z');
    // "at" is stripped, short forms and abbreviations understood.
    expect(parseWhenReply('weds at 2pm', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-08T14:00:00.000Z');
    expect(parseWhenReply('thurs', { nowISO: NOW, timezone: 'UTC', defaultTime: '08:40' })).toBe('2026-07-09T08:40:00.000Z');
  });

  it('reads an explicit calendar date within the horizon (NOW is Monday 2026-07-06 15:00Z)', () => {
    // Month + day, both orders, long and short forms — all at the default time.
    expect(parseWhenReply('jul 8', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-08T09:00:00.000Z');
    expect(parseWhenReply('july 8th', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-08T09:00:00.000Z');
    expect(parseWhenReply('8 july', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-08T09:00:00.000Z');
    // A bare day-of-month (ordinal required) = this month if still future.
    expect(parseWhenReply('the 8th', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-08T09:00:00.000Z');
    expect(parseWhenReply('on the 20th', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-20T09:00:00.000Z');
    // The usual check-in time is honored when no clock is given.
    expect(parseWhenReply('jul 8', { nowISO: NOW, timezone: 'UTC', defaultTime: '08:40' })).toBe('2026-07-08T08:40:00.000Z');
    // A clock time / part-of-day rides the date, same reading as the other branches.
    expect(parseWhenReply('jul 8 3pm', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-08T15:00:00.000Z');
    expect(parseWhenReply('the 8th at 2pm', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-08T14:00:00.000Z');
    expect(parseWhenReply('jul 8 morning', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-08T09:00:00.000Z');
    // A bare hour is NEVER read as a date — "8" stays the clock branch (20:00 today).
    expect(parseWhenReply('8', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-06T20:00:00.000Z');
    // A date beyond the 14-day horizon re-asks warmly (never assumes): a past
    // day rolls to next month (out of range) and a past month to next year.
    expect(parseWhenReply('the 3rd', { nowISO: NOW, timezone: 'UTC' })).toBeNull();
    expect(parseWhenReply('jan 20', { nowISO: NOW, timezone: 'UTC' })).toBeNull();
    // A day that overflows its month is dropped, not rolled forward.
    expect(parseWhenReply('feb 30', { nowISO: NOW, timezone: 'UTC' })).toBeNull();
  });

  it('reads a calendar date DST-correctly in the recipient timezone', () => {
    // 3pm on Jul 8 in America/New_York (EDT, UTC-4) → 19:00Z.
    expect(parseWhenReply('jul 8 3pm', { nowISO: NOW, timezone: 'America/New_York' })).toBe('2026-07-08T19:00:00.000Z');
  });

  it('reads a numeric MM/DD date, requiring a separator so a lone number stays a clock (R-260)', () => {
    // Slash and dash, month-first (US), zero-padded forms — the default time.
    expect(parseWhenReply('7/8', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-08T09:00:00.000Z');
    expect(parseWhenReply('07-08', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-08T09:00:00.000Z');
    // Spaces around the separator are fine; "7 / 20" is still Jul 20.
    expect(parseWhenReply('7 / 20', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-20T09:00:00.000Z');
    // The usual check-in time is honored when no clock is given.
    expect(parseWhenReply('7/8', { nowISO: NOW, timezone: 'UTC', defaultTime: '08:40' })).toBe('2026-07-08T08:40:00.000Z');
    // A clock time rides the numeric date, same reading as the named-date branch.
    expect(parseWhenReply('7/8 3pm', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-08T15:00:00.000Z');
    expect(parseWhenReply('7-8 at 2pm', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-08T14:00:00.000Z');
    // DST-correct: 3pm on Jul 8 in America/New_York (EDT, UTC-4) → 19:00Z.
    expect(parseWhenReply('7/8 3pm', { nowISO: NOW, timezone: 'America/New_York' })).toBe('2026-07-08T19:00:00.000Z');
    // GUARD 1 — a lone number (no separator) is still a clock, never a date.
    expect(parseWhenReply('8', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-06T20:00:00.000Z');
    // GUARD 2 — a clock range "3-4pm" (a meridiem right after the pair) is NOT a date.
    expect(parseWhenReply('3-4pm', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-07T03:00:00.000Z');
    // UPGRADE-ONLY — an out-of-horizon numeric date (Mar 4) falls through to the
    // clock reading rather than regressing a previously-working reply to a re-ask.
    expect(parseWhenReply('3/4', { nowISO: NOW, timezone: 'UTC' })).toBe('2026-07-07T03:00:00.000Z');
    // An invalid month (>12) is not a date; it falls through, never asserting a miss.
    expect(parseWhenReply('13/5', { nowISO: NOW, timezone: 'UTC' })).not.toBeNull();
  });

  it('is DST-correct in the recipient timezone', () => {
    // 08:00 EDT (UTC-4). "in 1 hour" → 13:00Z. "3pm" local → 19:00Z same day.
    const now = '2026-07-06T12:00:00.000Z';
    expect(parseWhenReply('in 1 hour', { nowISO: now, timezone: 'America/New_York' })).toBe('2026-07-06T13:00:00.000Z');
    expect(parseWhenReply('3pm', { nowISO: now, timezone: 'America/New_York' })).toBe('2026-07-06T19:00:00.000Z');
  });

  it('returns null for a vague / unreadable answer (caller re-asks, never assumes)', () => {
    for (const t of ['later', 'idk', 'ummm', 'soon', '', 'whenever', 'call me later about the car']) {
      expect(parseWhenReply(t, { nowISO: NOW, timezone: 'UTC' }), t).toBeNull();
    }
  });

  it('refuses an absurd far-future value (>14 days out)', () => {
    expect(parseWhenReply('in 25000 min', { nowISO: NOW, timezone: 'UTC' })).toBeNull();
  });
});

describe('formatWhenLocal — warm, recipient-local confirmation', () => {
  it('says "at H:MM AM/PM" for a same-local-day time', () => {
    expect(formatWhenLocal('2026-07-06T19:00:00.000Z', 'America/New_York', '2026-07-06T12:00:00.000Z')).toBe('at 3:00 PM');
  });
  it('prefixes "tomorrow" across the local day boundary', () => {
    expect(formatWhenLocal('2026-07-07T12:40:00.000Z', 'America/New_York', '2026-07-06T12:00:00.000Z')).toBe('tomorrow at 8:40 AM');
  });
  it('uses a bare weekday within this week (2–6 days out)', () => {
    // Mon 2026-07-06 → Sat 2026-07-11 is 5 days out: one Saturday in the window, unambiguous.
    expect(formatWhenLocal('2026-07-11T13:00:00.000Z', 'America/New_York', '2026-07-06T12:00:00.000Z')).toBe('Sat at 9:00 AM');
  });
  it('names the calendar date for a target 7+ days out so a bare weekday cannot be misheard', () => {
    // Mon 2026-07-06 → Mon 2026-07-20 is 14 days out and shares "Mon" with the nearer 07-13.
    expect(formatWhenLocal('2026-07-20T19:00:00.000Z', 'America/New_York', '2026-07-06T12:00:00.000Z')).toBe('Mon Jul 20 at 3:00 PM');
  });
  it('names the date exactly at the 7-day boundary (same weekday as today)', () => {
    // Mon → Mon, 7 days out: bare "Mon" would read as today, so the date is named.
    expect(formatWhenLocal('2026-07-13T19:00:00.000Z', 'America/New_York', '2026-07-06T12:00:00.000Z')).toBe('Mon Jul 13 at 3:00 PM');
  });
  it('stays recipient-local + DST-correct when naming a far date', () => {
    // America/New_York is EDT (UTC−4) on this date; 19:00Z → 3:00 PM local.
    expect(formatWhenLocal('2026-07-18T19:00:00.000Z', 'America/New_York', '2026-07-06T12:00:00.000Z')).toBe('Sat Jul 18 at 3:00 PM');
  });
});

// ── The design LAW, on the conversational-reschedule copy ──
describe('conversational-reschedule copy obeys the one LAW: never shame', () => {
  const SHAME = /\b(fail(ed|ure)?|miss(ed)?|behind|lazy|should have|guilt|disappoint|streak (lost|broken)|again\?!)\b/i;
  const CLINICAL = /\b(ADHD|diagnos|treat(ment)?|therap|disorder|symptom|patient)\b/i;
  const AI = /\bA\.?I\.?\b/i;
  for (const persona of ['ally', 'hype']) {
    for (const fn of [smsAskWhenCopy, smsWhenUnclearCopy]) {
      it(`${fn.name} (${persona}) is warm, no shame / clinical / "AI"`, () => {
        const s = fn({ persona });
        expect(s).not.toMatch(SHAME);
        expect(s).not.toMatch(CLINICAL);
        expect(s).not.toMatch(AI);
        expect(s.toLowerCase()).toMatch(/try again|time|check back/);
      });
    }
    it(`smsRescheduledCopy (${persona}) confirms warmly and protects the streak`, () => {
      const s = smsRescheduledCopy({ persona, when: '2026-07-06T19:00:00.000Z', timezone: 'America/New_York', nowISO: '2026-07-06T12:00:00.000Z' });
      expect(s).not.toMatch(SHAME);
      expect(s).not.toMatch(CLINICAL);
      expect(s).not.toMatch(AI);
      expect(s.toLowerCase()).toMatch(/check back .*3:00 pm/);
      expect(s.toLowerCase()).toMatch(/still counts|streak/);
    });
  }
});

// ── The invitation copy may only advertise phrasings the parser can read ──
// The ask/re-ask copy is the ONLY thing that tells a person what they can text.
// After teaching parseWhenReply to hear a named weekday (R-258) and a calendar
// date (R-259/260), the copy must actually offer them — and must never advertise
// an example the parser can't parse. This locks the two together so they can't drift.
describe('reschedule invitation copy stays in lock-step with parseWhenReply', () => {
  const nowISO = '2026-07-10T12:00:00.000Z'; // a Friday in NY — "Saturday", "Jul 20", "the 20th" all land ≤14 days out
  const timezone = 'America/New_York';
  const examples = ['3pm', 'tomorrow 9am', 'Saturday', 'Jul 20', 'the 20th'];
  for (const ex of examples) {
    it(`parseWhenReply reads the advertised example "${ex}"`, () => {
      expect(parseWhenReply(ex, { nowISO, timezone })).not.toBeNull();
    });
  }
  for (const persona of ['ally', 'hype']) {
    it(`smsAskWhenCopy (${persona}) advertises a weekday and a date`, () => {
      const s = smsAskWhenCopy({ persona });
      expect(s).toMatch(/Saturday/);
      expect(s).toMatch(/Jul 20/);
    });
    it(`smsWhenUnclearCopy (${persona}) advertises a weekday and a date`, () => {
      const s = smsWhenUnclearCopy({ persona });
      expect(s).toMatch(/Saturday/);
      expect(s).toMatch(/the 20th/);
    });
  }
});
