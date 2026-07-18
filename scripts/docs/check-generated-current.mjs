#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.DOCS_TARGET_ROOT ? resolve(process.env.DOCS_TARGET_ROOT) : resolve(SCRIPT_DIR, '..', '..');

const GENERATED_PATHS = [
  'docs/CATALOG.md',
  'docs/CANONICAL_DOCS.md',
  'docs/STALE_DOCS.md',
  'docs/OWNER_INDEX.md',
  'docs/_catalog/docs-graph.json',
  'docs/_catalog/drift.json',
  'docs/_catalog/drift-report.md',
  'docs/_catalog/debt-index.md',
  'docs/_catalog/link-report.json',
  'docs/_catalog/link-report.md',
  'docs/_generated',
];

function main() {
  try {
    const status = execFileSync('git', ['status', '--short', '--', ...GENERATED_PATHS], { cwd: ROOT, encoding: 'utf8' }).trim();
    if (status) throw new Error(status);
    console.log('[docs:check-generated] PASS');
  } catch (error) {
    console.error('[docs:check-generated] FAIL: generated docs artifacts are not current.');
    console.error('Run npm run docs:health and commit the resulting generated docs changes.');
    if (error?.message) console.error(error.message);
    try {
      execFileSync('git', ['diff', '--stat', '--', ...GENERATED_PATHS], { cwd: ROOT, stdio: 'inherit' });
    } catch {
      // ignore secondary diff failure; the failure above is enough.
    }
    process.exit(1);
  }
}

main();
