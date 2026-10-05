/**
 * FocusBro — production deploys are serialized, newest last.
 *
 * On 2026-10-05 two PRs merged 13 s apart (#408, #409). With no `concurrency`
 * on deploy.yml both deploy runs went at once, and the OLDER commit's run
 * deployed 4 s before the newer one — prod ended on the right build by luck.
 * Had the order flipped, prod would have rolled back to code without #409.
 *
 * One `concurrency` group for the production deploy, with
 * `cancel-in-progress: false`: a running deploy (and its D1 migration step)
 * always finishes, and GitHub keeps only the NEWEST pending run behind it, so
 * the last thing deployed is always main's head.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEPLOY_YML = fileURLToPath(new URL('../../../.github/workflows/deploy.yml', import.meta.url));
const yml = readFileSync(DEPLOY_YML, 'utf8');

/** The top-level `concurrency:` block (workflow scope), as raw lines. */
function topLevelConcurrency(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^concurrency:/.test(l));
  if (start === -1) return null;
  const block = [lines[start]];
  for (let i = start + 1; i < lines.length && /^\s+\S/.test(lines[i]); i++) block.push(lines[i]);
  return block.join('\n');
}

describe('deploy.yml serializes production deploys', () => {
  it('declares one workflow-level concurrency group', () => {
    const block = topLevelConcurrency(yml);
    expect(block, 'deploy.yml has no top-level concurrency block').not.toBeNull();
    expect(block).toMatch(/group:\s*\S+/);
  });

  it('never cancels a deploy that is already running (a half-applied migration is worse than a queue)', () => {
    const block = topLevelConcurrency(yml) || '';
    expect(block).toMatch(/cancel-in-progress:\s*false/);
  });
});
