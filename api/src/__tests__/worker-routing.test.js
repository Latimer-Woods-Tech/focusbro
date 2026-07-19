import { describe, expect, it } from 'vitest';
import worker from '../index.js';

function makeEnv() {
  const stmt = {
    bind() { return stmt; },
    first: async () => ({ count: 1 }),
    all: async () => ({ results: [] }),
    run: async () => ({ success: true })
  };

  return {
    JWT_SECRET: 'test-secret',
    KV_CACHE: { get: async () => null, put: async () => {} },
    DB: { prepare: () => stmt }
  };
}

function call(method, path, origin = 'https://focusbro.net') {
  return worker.fetch(new Request(origin + path, { method }), makeEnv(), {});
}

describe('Worker routing', () => {
  it('serves /me/ and only redirects the unslashed /me', async () => {
    const page = await call('GET', '/me/');
    expect(page.status).toBe(200);
    expect(page.headers.get('Location')).toBeNull();
    expect(await page.text()).toContain('<title>Your word');

    const redirect = await call('GET', '/me');
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get('Location')).toBe('/me/');
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

  it('gives the coach between-session note a share-by-email affordance', async () => {
    const html = await (await call('GET', '/coach/')).text();
    // Both actions on the note: copy (R-256) and the new one-tap email share.
    expect(html).toContain('class="note-copy"');
    expect(html).toContain('>Copy this note<');
    expect(html).toContain('class="note-share"');
    expect(html).toContain('>Share by email<');
    // The share opens a pre-filled mailto with the note as the body and a warm,
    // anti-shame subject — no recipient (the coach fills in their client), so the
    // client's email never enters the payload.
    expect(html).toContain("'mailto:?subject=' + subject + '&body=' + body");
    expect(html).toContain('A quick note between our sessions');
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
