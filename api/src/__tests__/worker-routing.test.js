import { describe, expect, it } from 'vitest';
import worker, { generateToken } from '../index.js';

function makeEnv({ founderEmail, userEmail = founderEmail, metricsRows = [] } = {}) {
  const stmt = {
    bind() { return stmt; },
    first: async () => userEmail ? { email: userEmail } : { count: 1 },
    all: async () => ({ results: metricsRows }),
    run: async () => ({ success: true })
  };

  return {
    JWT_SECRET: 'test-secret',
    FOUNDER_EMAIL: founderEmail,
    KV_CACHE: { get: async () => null, put: async () => {} },
    DB: { prepare: () => stmt }
  };
}

function call(method, path, origin = 'https://focusbro.net', options = {}) {
  return worker.fetch(
    new Request(origin + path, { method, headers: options.headers, body: options.body }),
    options.env || makeEnv(),
    {},
  );
}

describe('Worker routing', () => {
  it('makes accountability the public front door without hiding the toolkit', async () => {
    const page = await call('GET', '/');
    const html = await page.text();
    expect(html).toContain('<title>FocusBro — The ADHD Check-In That Follows Up</title>');
    expect(html).toContain('id="quickWordForm"');
    expect(html).toContain('What are you avoiding?');
    expect(html).toContain("destination.searchParams.set('task', task)");
    expect(html).toContain("destination.searchParams.set('source'");
    expect(html).toContain("fetch('/api/acquisition/visit'");
    expect(html).toContain("sessionStorage.setItem(visitKey, '1')");
    expect(html).toContain('id="pomoStartBtn"');
  });

  it('accepts same-origin acquisition visits and rejects hostile origins', async () => {
    const accepted = await call('POST', '/api/acquisition/visit', 'https://focusbro.net', {
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://focusbro.net',
      },
      body: JSON.stringify({ attribution: { source: 'tiktok', campaign: 'demo-01' } }),
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ ok: true });

    const rejected = await call('POST', '/api/acquisition/visit', 'https://focusbro.net', {
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://hostile.example',
      },
      body: JSON.stringify({ attribution: { source: 'spam' } }),
    });
    expect(rejected.status).toBe(403);
  });

  it('serves /me/ and only redirects the unslashed /me', async () => {
    const page = await call('GET', '/me/');
    expect(page.status).toBe(200);
    expect(page.headers.get('Location')).toBeNull();
    const html = await page.text();
    expect(html).toContain('<title>Your word');
    expect(html).toContain('id="founderMetrics"');
    expect(html).toContain("fetch('/api/internal/metrics?since_days=30'");

    const redirect = await call('GET', '/me');
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get('Location')).toBe('/me/');
  });

  it('shows the acquisition scorecard only to the authenticated founder', async () => {
    const env = makeEnv({ founderEmail: 'founder@example.com' });
    const token = await generateToken('founder-user', env.JWT_SECRET);
    const founder = await call('GET', '/api/internal/metrics?since_days=30',
      'https://focusbro.net', {
        env,
        headers: { Authorization: 'Bearer ' + token },
      });
    expect(founder.status).toBe(200);
    expect((await founder.json()).metrics).toHaveProperty('acquisition');

    const outsiderEnv = makeEnv({
      founderEmail: 'founder@example.com',
      userEmail: 'someone-else@example.com',
    });
    const outsider = await call('GET', '/api/internal/metrics?since_days=30',
      'https://focusbro.net', {
        env: outsiderEnv,
        headers: { Authorization: 'Bearer ' + token },
      });
    expect(outsider.status).toBe(401);
  });

  it('serves /coach/ and only redirects the unslashed /coach', async () => {
    const page = await call('GET', '/coach/');
    expect(page.status).toBe(200);
    expect(page.headers.get('Location')).toBeNull();
    expect(await page.text()).toContain('<h1>Coach dashboard</h1>');

    const redirect = await call('GET', '/coach');
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get('Location')).toBe('/coach/');
  });

  it('gives the coach between-session note a native share affordance that degrades to email', async () => {
    const html = await (await call('GET', '/coach/')).text();
    // Both actions on the note: copy (R-256) and the one-tap share.
    expect(html).toContain('class="note-copy"');
    expect(html).toContain('>Copy this note<');
    expect(html).toContain('class="note-share"');
    // The share button reaches the phone's native sheet (text / WhatsApp / email)
    // and is labelled for the general share, not email specifically.
    expect(html).toContain('>Share note<');
    // On mobile it prefers the Web Share sheet, guarded by canShare when present.
    expect(html).toContain('navigator.share');
    expect(html).toContain('navigator.canShare');
    // Where Web Share is unavailable it degrades to a pre-filled mailto with the
    // note as the body and a warm, anti-shame subject — no recipient (the coach
    // fills in their client), so the client's email never enters the payload.
    expect(html).toContain("'mailto:?subject=' + subject + '&body=' + body");
    expect(html).toContain('A quick note between our sessions');
    // A cancelled share sheet must not silently pop email in its place.
    expect(html).toContain("err.name === 'AbortError'");
    // Design LAW: the share subject/status copy names no miss or clinical claim.
    expect(html).not.toMatch(/\boverdue\b|\byou missed\b|\byou failed\b|\bbehind\b/i);
  });

  it('gives the person-side /me/report the same native share affordance that degrades to email', async () => {
    const html = await (await call('GET', '/me/report')).text();
    // Both actions the person already had stay: copy and the coach share.
    expect(html).toContain('>Copy report<');
    expect(html).toContain('>Share with coach<');
    // Share parity with the coach note: prefer the phone's Web Share sheet
    // (text / WhatsApp / email), guarded by canShare when present.
    expect(html).toContain('navigator.share');
    expect(html).toContain('navigator.canShare');
    // Where Web Share is unavailable it degrades to the same pre-filled mailto
    // with the report as the body and no recipient set.
    expect(html).toContain("'mailto:?subject=' + subject + '&body=' + body");
    expect(html).toContain('My FocusBro weekly report');
    // A cancelled share sheet must not silently pop email in its place.
    expect(html).toContain("err.name === 'AbortError'");
    // Design LAW: the share subject/status copy names no miss or clinical claim.
    expect(html).not.toMatch(/\boverdue\b|\byou missed\b|\byou failed\b|\bbehind\b/i);
  });

  it('canonicalizes the guides index slash', async () => {
    const redirect = await call('GET', '/guides');
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get('Location')).toBe('/guides/');

    const page = await call('GET', '/guides/');
    expect(page.status).toBe(200);
    expect(page.headers.get('Content-Type')).toContain('text/html');
  });

  it('answers HEAD like GET without a response body', async () => {
    for (const path of ['/', '/index.html', '/privacy.html', '/me/', '/guides/']) {
      const head = await call('HEAD', path);
      expect(head.status, path).toBe(200);
      expect(await head.text(), path).toBe('');
    }
  });

  it('discloses privacy-minimal campaign measurement', async () => {
    const privacy = await call('GET', '/privacy.html');
    const html = await privacy.text();
    expect(html).toContain('Aggregate campaign visit counts');
    expect(html).toContain('not a visitor ID, fingerprint, task, email, or contact information');
  });

  it('redirects production HTTP requests to HTTPS', async () => {
    const res = await call('GET', '/', 'http://focusbro.net');
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('https://focusbro.net/');
  });

  it('the served service worker deep-links a tapped notification via data.url', async () => {
    const res = await call('GET', '/sw.js');
    expect(res.status).toBe(200);
    const sw = await res.text();
    // A tapped notification must honor its explicit deep-link (data.url) first —
    // this is what carries the return nudge to /me/?from=return instead of '/'.
    expect(sw).toContain('data.url ||');
    expect(sw).toContain('notificationclick');
  });
});
