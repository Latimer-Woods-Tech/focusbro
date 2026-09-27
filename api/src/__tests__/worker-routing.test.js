import { cspModeFor } from '../index.js';
import { describe, expect, it } from 'vitest';
import worker, { generateToken, isBillingEnabled } from '../index.js';

function makeEnv({ founderEmail, userEmail = founderEmail, metricsRows = [], webhookInbox = {} } = {}) {
  const stmt = {
    bind() { return stmt; },
    first: async () => ({ email: userEmail, ...webhookInbox }),
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
  it('applies the enforced security baseline to every response class', async () => {
    for (const [method, path, origin] of [
      ['GET', '/', 'https://focusbro.net'],
      ['GET', '/me/', 'https://focusbro.net'],
      ['GET', '/health', 'https://focusbro.net'],
      ['GET', '/not-a-route', 'https://focusbro.net'],
      ['GET', '/', 'http://focusbro.net'],
    ]) {
      const response = await call(method, path, origin);
      expect(response.headers.get('Strict-Transport-Security'), path).toBe(
        'max-age=31536000; includeSubDomains',
      );
      expect(response.headers.get('X-Content-Type-Options'), path).toBe('nosniff');
      expect(response.headers.get('X-Frame-Options'), path).toBe('DENY');
      expect(response.headers.get('Referrer-Policy'), path).toBe('strict-origin-when-cross-origin');
      expect(response.headers.get('Permissions-Policy'), path).toContain('camera=()');
      const csp = response.headers.get('Content-Security-Policy-Report-Only');
      expect(csp, path).toContain("default-src 'self'");
      expect(csp, path).toContain("frame-ancestors 'none'");
    }
  });

  it('ENFORCES the CSP on the guides layer and the Index, and only reports it on the app shell', async () => {
    // The clean surfaces run no inline script (every script is first-party
    // under /guides/*.js), so there a violation is a bug the browser should
    // refuse. The app shell still carries the legacy inline scripts; the same
    // policy is report-only there until Stage 3 extracts them.
    const enforced = ['/guides/', '/guides/box-breathing.html', '/guides/breath.js?v=x', '/follow-through-index.html', '/api/public/follow-through'];
    const reported = ['/', '/me/', '/health', '/not-a-route', '/about.html'];
    for (const path of enforced) {
      const r = await call('GET', path);
      const csp = r.headers.get('Content-Security-Policy');
      expect(csp, path).toBeTruthy();
      expect(r.headers.get('Content-Security-Policy-Report-Only'), path).toBeNull();
      expect(csp, path).toContain("script-src 'self' https://pagead2.googlesyndication.com");
      expect(csp, path).not.toMatch(/script-src[^;]*'unsafe-inline'/);
      expect(csp, path).not.toContain('unsafe-eval');
      // the three live blockers, allowlisted from observation, not guessed
      expect(csp, path).toContain("style-src 'self' 'unsafe-inline'");
      expect(csp, path).toMatch(/script-src[^;]*https:\/\/ep2\.adtrafficquality\.google/);
      expect(csp, path).toMatch(/img-src[^;]*https:\/\/ep1\.adtrafficquality\.google/);
      expect(csp, path).toMatch(/script-src[^;]*https:\/\/static\.cloudflareinsights\.com/);
      expect(csp, path).toMatch(/connect-src[^;]*https:\/\/cloudflareinsights\.com/);
    }
    for (const path of reported) {
      const r = await call('GET', path);
      expect(r.headers.get('Content-Security-Policy'), path).toBeNull();
      expect(r.headers.get('Content-Security-Policy-Report-Only'), path).toContain("default-src 'self'");
    }
    // the mode is decided by the normalised path alone; a path that merely
    // starts with a clean prefix, or climbs out of one, does not inherit it
    expect(cspModeFor('https://focusbro.net/guides/x.html')).toBe('enforce');
    expect(cspModeFor('https://focusbro.net/guidesx')).toBe('report-only');
    expect(cspModeFor('https://focusbro.net/guides/../me/')).toBe('report-only');
    expect(cspModeFor('not a url')).toBe('report-only');
  });

  it('uses an AA-contrast action color on the accountability CTA', async () => {
    const html = await (await call('GET', '/')).text();
    expect(html).toContain('.accountability-entry button');
    expect(html).toContain('background: #0369a1');
    expect(html).not.toContain('.accountability-entry button {\n    padding: 0 18px;\n    border: 0;\n    color: #fff;\n    background: var(--primary)');
  });

  it('keeps dormant billing unavailable unless explicitly enabled', async () => {
    expect(isBillingEnabled()).toBe(false);
    expect(isBillingEnabled({})).toBe(false);
    expect(isBillingEnabled({ BILLING_ENABLED: true })).toBe(false);
    expect(isBillingEnabled({ BILLING_ENABLED: 'false' })).toBe(false);
    expect(isBillingEnabled({ BILLING_ENABLED: 'true' })).toBe(true);

    const routes = [
      ['POST', '/api/billing/create-checkout'],
      ['GET', '/api/billing/portal'],
      ['POST', '/api/billing/webhook'],
      ['GET', '/api/billing/tier'],
    ];
    for (const [method, path] of routes) {
      const response = await call(method, path);
      expect(response.status, path).toBe(404);
      expect(await response.json(), path).toEqual({ error: 'Not found' });
    }
  });

  it('only reaches billing handlers behind the exact enable flag', async () => {
    const env = { ...makeEnv(), BILLING_ENABLED: 'true' };
    for (const [method, path] of [
      ['POST', '/api/billing/create-checkout'],
      ['GET', '/api/billing/portal'],
      ['GET', '/api/billing/tier'],
    ]) {
      const response = await call(method, path, 'https://focusbro.net', { env });
      expect(response.status, path).toBe(401);
    }

    const webhook = await call('POST', '/api/billing/webhook', 'https://focusbro.net', {
      env,
      body: '{}',
    });
    expect(webhook.status).toBe(401);
  });

  it('does not expose legacy debug and test handlers', async () => {
    for (const path of ['/debug-routes', '/debug-api', '/api/test', '/api/gallery/test']) {
      const response = await call('GET', path);
      expect(response.status, path).toBe(404);
      expect(await response.json(), path).toEqual({ error: 'Not found' });
    }
  });

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
    expect(html).toContain("fetch('/auth/session')");
    expect(html).toContain('let fbAuthenticated = false');
    expect(html).not.toContain('function fbAuthToken()');
    expect(html).not.toContain("localStorage.getItem('focusbro_token')");
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
    const body = await founder.json();
    expect(body.metrics).toHaveProperty('acquisition');
    expect(body.webhook_inbox).toEqual({ failed_count: 0, unprocessed_count: 0, oldest_unprocessed_at: null });

    const inboxEnv = makeEnv({
      founderEmail: 'founder@example.com',
      webhookInbox: { failed_count: 2, unprocessed_count: 1, oldest_unprocessed_at: '2026-07-26T10:00:00.000Z' },
    });
    const inboxMetrics = await call('GET', '/api/internal/metrics', 'https://focusbro.net', {
      env: inboxEnv,
      headers: { Authorization: 'Bearer ' + await generateToken('founder-user', inboxEnv.JWT_SECRET) },
    });
    expect((await inboxMetrics.json()).webhook_inbox).toEqual({
      failed_count: 2, unprocessed_count: 1, oldest_unprocessed_at: '2026-07-26T10:00:00.000Z',
    });

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
    const html = await page.text();
    expect(html).toContain('<h1>Coach dashboard</h1>');
    expect(html).toContain("fetch('/auth/exchange'");
    expect(html).toContain("fetch('/auth/session')");
    expect(html).not.toContain('localStorage.setItem(TOKEN_KEY');

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
    expect(html).toContain("fetch('/api/me/report')");
    expect(html).not.toContain("localStorage.getItem('focusbro_token')");
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
