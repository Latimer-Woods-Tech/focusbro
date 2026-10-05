/**
 * One service worker, one source (G797).
 *
 * The worker that runs used to be a template literal inside index.js, while
 * public/sw.js was a mirror nothing served — #386 had to edit both and add a
 * parity test to keep them from drifting. Now public/sw.js is the source and
 * `npm run build:html` (the predeploy hook) stringifies it into sw-source.js
 * the way it does html.js. This test fails the moment someone edits the file
 * and forgets to build, or re-inlines a copy.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import worker from '../index.js';
import swSource from '../sw-source.js';

const repo = (p) => new URL(`../../../${p}`, import.meta.url);

describe('the service worker has one source', () => {
  it('sw-source.js is the built copy of public/sw.js (run `npm run build:html`)', () => {
    expect(swSource).toBe(readFileSync(repo('public/sw.js'), 'utf8'));
  });

  it('/sw.js serves exactly that source', async () => {
    const res = await worker.fetch(new Request('https://focusbro.net/sw.js'), { BUILD_SHA: 'abc' }, {});
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(swSource);
  });

  it('no inline copy survives in the Worker (proof of rejection)', () => {
    const src = readFileSync(repo('api/src/index.js'), 'utf8');
    expect(src).not.toContain('const swCode');
    expect(src).not.toMatch(/self\.addEventListener\('push'/);
    // and the source itself is still a service worker, not an empty string
    expect(swSource).toContain("self.addEventListener('push'");
    expect(swSource).toContain("self.addEventListener('notificationclick'");
  });
});
