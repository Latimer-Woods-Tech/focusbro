/**
 * Site Quality Battery R-06 (TB4) — deploy.yml deploys [env.staging] to
 * staging.focusbro.net and proves it, without ever letting a staging trigger
 * reach production.
 *
 * Read as text, split into job blocks by indentation (no YAML dependency). The
 * checker runs against synthetic workflows as proof-of-rejection: a staging job
 * that deploys --env production, a production job that a push to `staging`
 * could start, or a staging job that never checks the noindex header all fail.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEPLOY_YML = fileURLToPath(new URL('../../../.github/workflows/deploy.yml', import.meta.url));

/** { onBlock, concurrencyBlock, jobs: { id: text } } from a workflow file. */
function splitWorkflow(text) {
  const lines = text.split('\n');
  const topBlock = (key) => {
    const start = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (start === -1) return '';
    const out = [lines[start]];
    for (let i = start + 1; i < lines.length && (/^\s/.test(lines[i]) || lines[i] === ''); i++) out.push(lines[i]);
    return out.join('\n');
  };
  const jobs = {};
  const jobsAt = lines.findIndex((l) => /^jobs:/.test(l));
  let cur = null;
  for (let i = jobsAt + 1; jobsAt !== -1 && i < lines.length; i++) {
    const l = lines[i];
    if (/^\S/.test(l)) break;
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l);
    if (m) { cur = m[1]; jobs[cur] = ''; continue; }
    if (cur) jobs[cur] += l + '\n';
  }
  return { onBlock: topBlock('on'), concurrencyBlock: topBlock('concurrency'), jobs };
}

/** The job-level `if:` expression (first `    if:` line of the job). */
const jobIf = (job) => (/^ {4}if:\s*(.+)$/m.exec(job) || [])[1] || '';

/** Returns violations (empty = staging deploy is wired and fenced). */
function findStagingDeployViolations(text) {
  const { onBlock, concurrencyBlock, jobs } = splitWorkflow(text);
  const bad = [];
  if (!/branches:[\s\S]*-\s*staging\b/.test(onBlock)) bad.push('deploy.yml does not trigger on push to the staging branch');
  if (!/workflow_dispatch/.test(onBlock)) bad.push('deploy.yml has no workflow_dispatch trigger');
  if (!/cancel-in-progress:\s*false/.test(concurrencyBlock)) bad.push('top-level concurrency must keep cancel-in-progress: false');
  if (!/group:.*staging/.test(concurrencyBlock)) bad.push('staging runs share the production concurrency group');

  const prodId = Object.keys(jobs).find((id) => /wrangler deploy --env production/.test(jobs[id]));
  const stgId = Object.keys(jobs).find((id) => /wrangler deploy --env staging/.test(jobs[id]));
  if (!prodId) bad.push('no production deploy job');
  if (!stgId) bad.push('no staging deploy job (wrangler deploy --env staging)');
  if (prodId && stgId && prodId === stgId) bad.push('one job deploys both production and staging');

  if (prodId) {
    const cond = jobIf(jobs[prodId]);
    if (!/github\.ref\s*==\s*'refs\/heads\/main'/.test(cond) || !/github\.event_name\s*==\s*'push'/.test(cond)) {
      bad.push(`production job "${prodId}" is not fenced to push on main (if: ${cond || 'none'})`);
    }
  }
  if (stgId) {
    const job = jobs[stgId];
    const cond = jobIf(job);
    if (!/refs\/heads\/staging/.test(cond) || !/workflow_dispatch/.test(cond)) bad.push(`staging job "${stgId}" if: must allow the staging branch and dispatch (if: ${cond || 'none'})`);
    if (/--env production/.test(job)) bad.push(`staging job "${stgId}" touches --env production`);
    if (/https:\/\/focusbro\.net/.test(job)) bad.push(`staging job "${stgId}" talks to the production host`);
    if (!/d1 migrations apply focusbro-staging-db --remote --env staging/.test(job)) bad.push(`staging job "${stgId}" does not migrate the staging D1`);
    if (!/curl[^\n]*-[A-Za-z]*I[A-Za-z]*\b[^\n]*https:\/\/staging\.focusbro\.net\/health/.test(job)) bad.push(`staging job "${stgId}" does not curl -I https://staging.focusbro.net/health`);
    if (!/x-robots-tag:\s*noindex/i.test(job)) bad.push(`staging job "${stgId}" does not check X-Robots-Tag: noindex`);
    if (!/BASE_URL:\s*https:\/\/staging\.focusbro\.net/.test(job) || !/playwright test/.test(job)) bad.push(`staging job "${stgId}" does not run the Playwright smoke against BASE_URL=https://staging.focusbro.net`);
    if (!/playwright test[^\n]*--grep-invert @local-fixture/.test(job)) bad.push(`staging job "${stgId}" does not exclude the @local-fixture smoke tests`);
  }
  return bad;
}

describe('deploy.yml staging job (Site Quality Battery R-06)', () => {
  it('deploys and verifies staging, fenced off from production', () => {
    expect(findStagingDeployViolations(readFileSync(DEPLOY_YML, 'utf8'))).toEqual([]);
  });

  describe('proof-of-rejection', () => {
    const good = `name: Deploy
on:
  push:
    branches:
      - main
      - staging
  workflow_dispatch:
concurrency:
  group: deploy-\${{ github.ref == 'refs/heads/main' && 'production' || 'staging' }}
  cancel-in-progress: false
jobs:
  deploy:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    steps:
    - run: npx wrangler deploy --env production
    - run: curl https://focusbro.net/health
  deploy-staging:
    if: github.ref == 'refs/heads/staging' || github.event_name == 'workflow_dispatch'
    steps:
    - run: npx wrangler d1 migrations apply focusbro-staging-db --remote --env staging
    - run: npx wrangler deploy --env staging
    - run: |
        h=$(curl -sI https://staging.focusbro.net/health)
        echo "$h" | grep -qi '^x-robots-tag: noindex'
    - run: npx playwright test smoke.spec.js --grep-invert @local-fixture
      env:
        BASE_URL: https://staging.focusbro.net
`;
    it('accepts the healthy control', () => {
      expect(findStagingDeployViolations(good)).toEqual([]);
    });
    it('rejects a production job a staging push could start', () => {
      const v = findStagingDeployViolations(good.replace("    if: github.event_name == 'push' && github.ref == 'refs/heads/main'\n", ''));
      expect(v).toEqual(['production job "deploy" is not fenced to push on main (if: none)']);
    });
    it('rejects a staging job that deploys --env production', () => {
      const v = findStagingDeployViolations(good.replace('npx wrangler d1 migrations apply focusbro-staging-db --remote --env staging', 'npx wrangler d1 migrations apply focusbro-staging-db --remote --env staging\n    - run: npx wrangler d1 migrations apply focusbro-db --remote --env production'));
      expect(v).toEqual(['staging job "deploy-staging" touches --env production']);
    });
    it('rejects a staging job that skips the noindex check', () => {
      const v = findStagingDeployViolations(good.replace("grep -qi '^x-robots-tag: noindex'", 'true'));
      expect(v).toEqual(['staging job "deploy-staging" does not check X-Robots-Tag: noindex']);
    });
    it('rejects a staging job that never curls staging /health', () => {
      const v = findStagingDeployViolations(good.replace('curl -sI https://staging.focusbro.net/health', 'curl -sI https://staging.focusbro.net/'));
      expect(v).toEqual(['staging job "deploy-staging" does not curl -I https://staging.focusbro.net/health']);
    });
    it('rejects a staging job that runs the smoke against the local server', () => {
      const v = findStagingDeployViolations(good.replace('        BASE_URL: https://staging.focusbro.net\n', '        CI: true\n'));
      expect(v).toEqual(['staging job "deploy-staging" does not run the Playwright smoke against BASE_URL=https://staging.focusbro.net']);
    });
    it('rejects a staging smoke that also runs the serve.mjs-only tests', () => {
      const v = findStagingDeployViolations(good.replace(' --grep-invert @local-fixture', ''));
      expect(v).toEqual(['staging job "deploy-staging" does not exclude the @local-fixture smoke tests']);
    });
    it('rejects staging sharing the production concurrency group', () => {
      const v = findStagingDeployViolations(good.replace(/group: .*/, 'group: deploy-production'));
      expect(v).toEqual(['staging runs share the production concurrency group']);
    });
    it('rejects a workflow with no staging trigger', () => {
      const v = findStagingDeployViolations(good.replace('      - staging\n', '').replace('  workflow_dispatch:\n', ''));
      expect(v).toEqual(['deploy.yml does not trigger on push to the staging branch', 'deploy.yml has no workflow_dispatch trigger']);
    });
  });
});
