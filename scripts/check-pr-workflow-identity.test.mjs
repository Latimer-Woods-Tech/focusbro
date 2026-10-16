import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, checkDir } from './check-pr-workflow-identity.mjs';

const STEP = '      - uses: actions/checkout@v4\n';

test('(a) top-level id-token + PR job fails', () => {
  const y = `on: [pull_request]\npermissions:\n  contents: read\n  id-token: write\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n${STEP}`;
  assert.equal(analyze(y, 'a.yml').length, 1);
  assert.match(analyze(y, 'a.yml')[0], /^a\.yml:build/);
});

test('(b) job-level auth step in a PR job fails', () => {
  const y = `on:\n  pull_request:\n    paths: ['x/**']\npermissions:\n  contents: read\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n${STEP}      - uses: google-github-actions/auth@abc\n`;
  const r = analyze(y, 'b.yml');
  assert.equal(r.length, 1);
  assert.match(r[0], /google-github-actions\/auth/);
});

test('(c) id-token job gated off pull_request passes', () => {
  const y = `on:\n  push:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  sign:\n    if: github.event_name != 'pull_request'\n    permissions:\n      id-token: write\n    runs-on: ubuntu-latest\n    steps:\n${STEP}      - uses: google-github-actions/auth@abc\n  pr:\n    if: github.event_name == 'pull_request'\n    permissions:\n      contents: read\n    runs-on: ubuntu-latest\n    steps:\n${STEP}`;
  assert.deepEqual(analyze(y, 'c.yml'), []);
  const y2 = y.replace("if: github.event_name == 'pull_request'", "if: github.ref != 'x'");
  assert.deepEqual(analyze(y2, 'c.yml'), []); // pr job has no identity either way
});

test('non-PR workflow with id-token passes', () => {
  const y = `on:\n  push:\npermissions:\n  id-token: write\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n${STEP}`;
  assert.deepEqual(analyze(y, 'd.yml'), []);
});

test('job-level permissions override top-level id-token', () => {
  const y = `on: pull_request\npermissions:\n  id-token: write\njobs:\n  j:\n    permissions:\n      contents: read\n    runs-on: ubuntu-latest\n    steps:\n${STEP}`;
  assert.deepEqual(analyze(y, 'e.yml'), []);
});

test('(d) the repo workflows pass', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows');
  assert.deepEqual(checkDir(dir), []);
});
