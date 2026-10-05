/**
 * The check-in IS the product — so the notification answers itself.
 *
 * Before this: a check-in push had no buttons, and tapping it deep-linked to `/`
 * — the toolkit home — not to the word it was about. The cron's own comment
 * said "Push carries its own in-app actions" and nothing ever did.
 *
 * Now the payload carries the two answers the /me/ card leads with ("I did it"
 * / "Not yet"), a one-tap reply ticket bound to this check-in (a service worker
 * has no session), and a deep-link to the word. The service worker resolves
 * "I did it" in place through /api/checkins/reply and lands "Not yet" on the
 * word with the warm reschedule open. /me/ honors that landing once.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';

const sent = [];
vi.mock('../webpush.js', () => ({
  vapidConfigured: () => true,
  sendWebPush: async (_env, sub, payload) => { sent.push({ sub, payload }); return { ok: true }; },
}));

// FBQ-24 R4: under `--no-isolate` the module registry is shared across files, so
// checkins-cron.js may already be cached bound to the REAL webpush.js. Drop the
// cache so the imports below are evaluated afresh against the mock above.
vi.resetModules();

const { deliverCheckin } = await import('../checkins-cron.js');
const { checkinActionLabels, renderMePage } = await import('../me.js');
const { verifyReplyTicket } = await import('../checkin-reply.js');
const { pageShellStyle } = await import('../page-shell.js');
const worker = (await import('../index.js')).default;

// ...and do not leave the mock (or modules bound to it) behind for the next file.
afterAll(() => {
  vi.doUnmock('../webpush.js');
  vi.resetModules();
});

const SECRET = 'test-secret-that-is-long-enough-for-hs256-0123456789';

/** A D1 stub: one active subscription, no coach, nothing else. */
function stubDB() {
  const stmt = {
    bind() { return stmt; },
    first: async () => null,
    all: async () => ({ results: [{ endpoint: 'https://push.example/abc', p256dh: 'k', auth: 'a' }] }),
    run: async () => ({ success: true }),
  };
  return { prepare: () => stmt };
}
const row = () => ({ checkin_id: 'ci-1', commitment_id: 'cm-1', user_id: 'u-1', channel: 'push', title: 'start the taxes', persona: 'ally' });

describe('the check-in push answers itself', () => {
  beforeEach(() => { sent.length = 0; });

  it('carries the two answers the /me/ card leads with, in the same words', async () => {
    const out = await deliverCheckin({ DB: stubDB(), JWT_SECRET: SECRET }, row());
    expect(out.status).toBe('sent');
    const { payload } = sent[0];
    const labels = checkinActionLabels();
    expect(payload.actions).toEqual([
      { action: 'kept', title: labels.kept },
      { action: 'not-yet', title: labels.missed },
    ]);
  });

  it('carries a reply ticket bound to THIS check-in, and lands on the word — never on /', async () => {
    await deliverCheckin({ DB: stubDB(), JWT_SECRET: SECRET }, row());
    const { data } = sent[0].payload;
    expect(data.url).toBe('/me/?word=cm-1');
    expect(await verifyReplyTicket(SECRET, data.reply)).toMatchObject({ checkinId: 'ci-1' });
    expect(await verifyReplyTicket('another-secret', data.reply)).toBeNull();
  });

  it('still sends (without a ticket) when the worker has no secret to sign with', async () => {
    const out = await deliverCheckin({ DB: stubDB() }, row());
    expect(out.status).toBe('sent');
    expect(sent[0].payload.data.reply).toBeNull();
    expect(sent[0].payload.data.url).toBe('/me/?word=cm-1');
  });
});

describe('the service worker handles the buttons', () => {
  const stmt = { bind() { return stmt; }, first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }) };
  const env = { JWT_SECRET: SECRET, BUILD_SHA: 'test', KV_CACHE: { get: async () => null, put: async () => {} }, DB: { prepare: () => stmt } };

  it('the SERVED /sw.js resolves "I did it" in place and lands "Not yet" on the word', async () => {
    const res = await worker.fetch(new Request('https://focusbro.net/sw.js'), env, { waitUntil() {} });
    const src = await res.text();
    expect(src).toContain("event.action === 'kept' && data.reply");
    expect(src).toContain("fetch('/api/checkins/reply'");
    expect(src).toContain("JSON.stringify({ ticket: data.reply, outcome: 'kept' })");
    expect(src).toContain("event.action === 'not-yet'");
    expect(src).toContain("'answer=not-yet'");
    // a failed reply never strands the person: fall back to opening the word
    expect(src).toMatch(/\.catch\(function \(\) \{ return clients\.openWindow \? clients\.openWindow\(data\.url \|\| '\/me\/'\)/);
    // the notification icon must be a raster, not the SVG favicon
    expect(src).toContain("icon: '/icon-192.png'");
    expect(src).not.toContain("icon: '/favicon.ico'");
    expect(() => new Function(src)).not.toThrow();
  });

  it('the static public/sw.js carries the same branches (the two must not drift)', () => {
    const src = readFileSync(new URL('../../../public/sw.js', import.meta.url), 'utf8');
    expect(src).toContain("event.action === 'kept' && data.reply");
    expect(src).toContain("event.action === 'not-yet'");
    expect(() => new Function(src)).not.toThrow();
  });
});

describe('/me/ lands on the word', () => {
  const page = renderMePage();

  it('reads ?word= and &answer=not-yet, rings the card once, and clears the URL so a reload never answers twice', () => {
    expect(page).toContain("q.get('word')");
    expect(page).toContain("q.get('answer') === 'not-yet'");
    expect(page).toContain("card.classList.add('landed')");
    expect(page).toContain("card.querySelector('button[data-act=\"missed\"]')");
    expect(page).toContain("history.replaceState(null, '', location.pathname)");
    expect(page).toContain('landOnWord();');
  });

  it('the landed card is styled by the shared shell', () => {
    expect(pageShellStyle()).toContain('.card.landed');
  });
});
