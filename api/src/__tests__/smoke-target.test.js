/**
 * Site Quality Battery TB4 — the Playwright smoke can be pointed at a deployed
 * host (staging.focusbro.net) with BASE_URL, without changing the local default.
 *
 * Unset BASE_URL: the smoke serves the built html.js on localhost:4173 through
 * e2e/serve.mjs, exactly as before. Set BASE_URL: no local server is started and
 * every page.goto resolves against that host. A malformed or non-https remote
 * BASE_URL is refused, so a typo can never silently fall back to localhost and
 * report a green "staging" run that never left the runner.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { smokeTarget, LOCAL_BASE_URL, LOCAL_FIXTURE_TAG } from '../../e2e/target.mjs';

describe('smokeTarget', () => {
  it('defaults to the local static server (unchanged behaviour)', () => {
    const t = smokeTarget({});
    expect(t.baseURL).toBe(LOCAL_BASE_URL);
    expect(LOCAL_BASE_URL).toBe('http://localhost:4173');
    expect(t.webServer).toMatchObject({ command: 'node e2e/serve.mjs', url: 'http://localhost:4173/' });
  });

  it('keeps reusing a running local server outside CI only', () => {
    expect(smokeTarget({}).webServer.reuseExistingServer).toBe(true);
    expect(smokeTarget({ CI: 'true' }).webServer.reuseExistingServer).toBe(false);
  });

  it('treats an empty BASE_URL as unset', () => {
    expect(smokeTarget({ BASE_URL: '' }).baseURL).toBe(LOCAL_BASE_URL);
    expect(smokeTarget({ BASE_URL: '   ' }).webServer).toBeDefined();
  });

  it('points at a remote https host with no local server', () => {
    const t = smokeTarget({ BASE_URL: 'https://staging.focusbro.net' });
    expect(t.baseURL).toBe('https://staging.focusbro.net');
    expect(t.webServer).toBeUndefined();
  });

  it('drops a trailing slash so "/" paths resolve once', () => {
    expect(smokeTarget({ BASE_URL: 'https://staging.focusbro.net/' }).baseURL).toBe('https://staging.focusbro.net');
  });

  it('allows an explicit http localhost target (a wrangler dev run)', () => {
    const t = smokeTarget({ BASE_URL: 'http://localhost:8787' });
    expect(t.baseURL).toBe('http://localhost:8787');
    expect(t.webServer).toBeUndefined();
  });

  it.each([
    ['staging.focusbro.net'],
    ['http://staging.focusbro.net'],
    ['ftp://staging.focusbro.net'],
    ['https://staging.focusbro.net/me/'],
  ])('refuses %s', (bad) => {
    expect(() => smokeTarget({ BASE_URL: bad })).toThrow(/BASE_URL/);
  });
});

/**
 * A smoke test that reads a hook only e2e/serve.mjs provides (`/__smoke/*`,
 * `?fixture=`) cannot pass against a deployed host. It must carry the
 * @local-fixture tag, which the staging job excludes with --grep-invert, so a
 * remote run fails only on real defects. Every other test must be portable.
 */
function untaggedFixtureTests(specText) {
  const blocks = specText.split(/\n(?=\s{2}test\()/).slice(1);
  return blocks
    .filter((b) => /\/__smoke\/|[?&]fixture=/.test(b))
    .filter((b) => !b.split('\n')[0].includes(`tag: '${LOCAL_FIXTURE_TAG}'`))
    .map((b) => (/test\('([^']+)'/.exec(b) || [])[1]);
}

describe('smoke.spec.js local-fixture tagging', () => {
  const spec = readFileSync(fileURLToPath(new URL('../../e2e/smoke.spec.js', import.meta.url)), 'utf8');

  it('the tag is @local-fixture', () => {
    expect(LOCAL_FIXTURE_TAG).toBe('@local-fixture');
  });

  it('every test that reads a serve.mjs-only hook is tagged @local-fixture', () => {
    expect(untaggedFixtureTests(spec)).toEqual([]);
  });

  it('most of the smoke still runs remotely (the tag is not a blanket opt-out)', () => {
    const total = (spec.match(/\n\s{2}test\(/g) || []).length;
    const tagged = (spec.match(/tag: '@local-fixture'/g) || []).length;
    expect(tagged).toBeLessThanOrEqual(3);
    expect(total - tagged).toBeGreaterThanOrEqual(10);
  });

  it('proof-of-rejection: an untagged /__smoke/ reader is named', () => {
    const bad = `x\n  test('reads the view log', async ({ page }) => {\n    await page.request.get('/__smoke/views');\n  });\n  test('portable', async () => {});\n`;
    expect(untaggedFixtureTests(bad)).toEqual(['reads the view log']);
    const good = bad.replace("test('reads the view log', async", "test('reads the view log', { tag: '@local-fixture' }, async");
    expect(untaggedFixtureTests(good)).toEqual([]);
  });
});
