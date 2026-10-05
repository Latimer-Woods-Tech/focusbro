/**
 * FBQ-18 — the free-text time parser, as a TABLE (fixed clocks, fixed zones).
 *
 * One parser (`parseWhenReply`) serves the SMS reschedule, the in-app "Move it /
 * Not yet" prompt and the first-word create form. QA proved it could read a
 * time the person never said and land it in the small hours:
 *   "5:30" at 10:00 -> 5:30 AM tomorrow; "in 2 months" -> 2 minutes;
 *   "3" at 7:30 PM -> 3:00 AM (an SMS at 3 AM to a Pro user).
 *
 * The rules this table pins (see parseWhenReply's header):
 *  R1 a number followed by an unsupported unit (seconds, months, years, ...) is
 *     null -> the caller re-asks. Supported units are unchanged.
 *  R2 a bare "h" / "h:mm" (h 1..12, no am/pm, no leading zero) reads as the
 *     next DAYTIME instance: 1..6 -> PM, 7..11 -> the next 07:00-21:59 slot,
 *     12 -> noon. Same rule in every form ("5:30", "tomorrow 5:30", "mon 3:30").
 *  R3 nothing parsed lands in 00:00-05:59 local without an explicit "am"
 *     (or the word "midnight"); a leading-zero 24h form in that window is null.
 *  R4 a recurring time inside the spring-forward gap resolves FORWARD.
 */
import { describe, it, expect } from 'vitest';
import { parseWhenReply, nextOccurrenceISO } from '../accountability.js';

const NY = 'America/New_York';
// "now" instants, chosen so the LOCAL clock reads what the row says.
const NY_1000 = '2026-10-05T14:00:00.000Z'; // Mon 10:00 EDT
const NY_1930 = '2026-10-05T23:30:00.000Z'; // Mon 19:30 EDT
const UTC_1000 = '2026-10-05T10:00:00.000Z';
const KIRI_1000 = '2026-10-04T20:00:00.000Z'; // Mon 10:00 at +14 (Pacific/Kiritimati)
const KTM_1000 = '2026-10-05T04:15:00.000Z'; // Mon 10:00 at +05:45 (Asia/Kathmandu)

const local = (iso, tz) => (iso == null ? null : new Intl.DateTimeFormat('sv', {
  timeZone: tz, dateStyle: 'short', timeStyle: 'short',
}).format(new Date(iso)));

// [label, now, zone, text, expected local 'YYYY-MM-DD HH:MM' | null]
const ROWS = [
  // ── the QA defects ───────────────────────────────────────────────────────
  ['5:30 at 10:00 reads PM, not 5:30 AM tomorrow', NY_1000, NY, '5:30', '2026-10-05 17:30'],
  ['4:15 at 10:00', NY_1000, NY, '4:15', '2026-10-05 16:15'],
  ['unknown unit: months', NY_1000, NY, 'in 2 months', null],
  ['unknown unit: years', NY_1000, NY, 'in 5 years', null],
  ['unknown unit: secs', NY_1000, NY, 'in 10 secs', null],
  ['unknown unit: seconds', NY_1000, NY, 'in 30 seconds', null],
  ['unknown unit without "in"', NY_1000, NY, '2 months', null],
  ['3 at 19:30 -> tomorrow 3 PM, never 3 AM', NY_1930, NY, '3', '2026-10-06 15:00'],
  ['12 at 19:30 is noon tomorrow, not midnight', NY_1930, NY, '12', '2026-10-06 12:00'],
  ['4:30 at 19:30', NY_1930, NY, '4:30', '2026-10-06 16:30'],
  ['9 at 19:30 is 9 PM tonight (inside 07:00-21:59)', NY_1930, NY, '9', '2026-10-05 21:00'],
  ['10 at 19:30 skips 10 PM (after 21:59) -> 10 AM tomorrow', NY_1930, NY, '10', '2026-10-06 10:00'],
  ['7 at 19:30 -> 7 AM tomorrow (a 07:00 slot is daytime)', NY_1930, NY, '7', '2026-10-06 07:00'],
  ['same rule in the weekday form with minutes', NY_1000, NY, 'monday 3:30', '2026-10-05 15:30'],
  ['same rule in the tomorrow form with minutes', NY_1930, NY, 'tomorrow 5:30', '2026-10-06 17:30'],
  ['same rule in a dated form', NY_1000, NY, 'oct 8 4:15', '2026-10-08 16:15'],
  // ── R3: the small hours need an explicit am ──────────────────────────────
  ['explicit 3am is honoured', NY_1930, NY, '3am', '2026-10-06 03:00'],
  ['explicit tomorrow 3am is honoured', NY_1930, NY, 'tomorrow 3am', '2026-10-06 03:00'],
  ['leading-zero 24h form in the small hours is null', NY_1930, NY, '05:30', null],
  ['0:30 is null', NY_1930, NY, '0:30', null],
  ['tomorrow 04:00 (24h, small hours) is null', NY_1930, NY, 'tomorrow 04:00', null],
  ['leading-zero 24h form in the day stays literal', NY_1000, NY, '08:15', '2026-10-06 08:15'],
  // ── behaviour that must not move ─────────────────────────────────────────
  ['3pm', NY_1000, NY, '3pm', '2026-10-05 15:00'],
  ['tomorrow 9am', NY_1000, NY, 'tomorrow 9am', '2026-10-06 09:00'],
  ['tomorrow 9 stays morning', NY_1000, NY, 'tomorrow 9', '2026-10-06 09:00'],
  ['in 20 minutes', NY_1000, NY, 'in 20 minutes', '2026-10-05 10:20'],
  ['in 20 (documented: minutes)', NY_1000, NY, 'in 20', '2026-10-05 10:20'],
  ['in 20 mins please', NY_1000, NY, 'in 20 mins please', '2026-10-05 10:20'],
  ['in 2 hours', NY_1000, NY, 'in 2 hours', '2026-10-05 12:00'],
  ['in 2 days', NY_1000, NY, 'in 2 days', '2026-10-07 10:00'],
  ['in a couple hours', NY_1000, NY, 'in a couple hours', '2026-10-05 12:00'],
  ['tonight', NY_1000, NY, 'tonight', '2026-10-05 20:00'],
  ['gimme 20 (24h literal)', NY_1000, NY, 'gimme 20', '2026-10-05 20:00'],
  ['midnight is the start of tomorrow', NY_1000, NY, 'midnight', '2026-10-06 00:00'],
  ['noon', NY_1000, NY, 'noon', '2026-10-05 12:00'],
  ['tomorrowish', NY_1000, NY, 'tomorrowish', '2026-10-06 09:00'],
  ['14:00 24h', NY_1000, NY, '14:00', '2026-10-05 14:00'],
  ['22:30 24h late evening is not blocked', NY_1930, NY, '22:30', '2026-10-05 22:30'],
  ['12:30 is half past noon', NY_1000, NY, '12:30', '2026-10-05 12:30'],
  ['6 at 10:00 -> 6 PM', NY_1000, NY, '6', '2026-10-05 18:00'],
  // ── other zones ──────────────────────────────────────────────────────────
  ['UTC 5:30', UTC_1000, 'UTC', '5:30', '2026-10-05 17:30'],
  ['UTC in 2 months', UTC_1000, 'UTC', 'in 2 months', null],
  ['Kiritimati 5:30', KIRI_1000, 'Pacific/Kiritimati', '5:30', '2026-10-05 17:30'],
  ['Kiritimati 3 at 19:30 local', '2026-10-05T05:30:00.000Z', 'Pacific/Kiritimati', '3', '2026-10-06 15:00'],
  ['Kathmandu 5:30', KTM_1000, 'Asia/Kathmandu', '5:30', '2026-10-05 17:30'],
  ['Kathmandu in 5 years', KTM_1000, 'Asia/Kathmandu', 'in 5 years', null],
];

describe('parseWhenReply table (FBQ-18)', () => {
  it.each(ROWS)('%s', (_label, now, tz, text, want) => {
    const got = parseWhenReply(text, { nowISO: now, timezone: tz });
    expect(local(got, tz)).toBe(want);
  });
});

describe('recurring times across DST (FBQ-18 R4)', () => {
  it('a time inside the spring-forward gap resolves forward, 02:30 -> 03:30 EDT', () => {
    const got = nextOccurrenceISO({
      recurrence: 'daily', timezone: NY, localTime: '02:30', afterISO: '2026-03-07T12:00:00.000Z',
    });
    expect(got).toBe('2026-03-08T07:30:00.000Z');
    expect(local(got, NY)).toBe('2026-03-08 03:30');
  });
  it('the first valid wall time after the gap is unchanged (03:00 -> 03:00 EDT)', () => {
    const got = nextOccurrenceISO({
      recurrence: 'daily', timezone: NY, localTime: '03:00', afterISO: '2026-03-07T12:00:00.000Z',
    });
    expect(got).toBe('2026-03-08T07:00:00.000Z');
  });
  it('the fall-back repeated hour keeps the first (EDT) pass, then rolls to EST next day', () => {
    const first = nextOccurrenceISO({
      recurrence: 'daily', timezone: NY, localTime: '01:30', afterISO: '2026-11-01T00:00:00.000Z',
    });
    expect(first).toBe('2026-11-01T05:30:00.000Z'); // 01:30 EDT
    const next = nextOccurrenceISO({
      recurrence: 'daily', timezone: NY, localTime: '01:30', afterISO: first,
    });
    expect(next).toBe('2026-11-02T06:30:00.000Z'); // 01:30 EST next day, never the 06:30Z repeat
  });
  it('an ordinary day is untouched', () => {
    const got = nextOccurrenceISO({
      recurrence: 'daily', timezone: NY, localTime: '09:00', afterISO: '2026-10-05T14:00:00.000Z',
    });
    expect(got).toBe('2026-10-06T13:00:00.000Z');
  });
});
