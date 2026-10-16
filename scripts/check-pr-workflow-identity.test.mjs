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

// ── pull_request_target is a PR event too (round 3) ────────────────────────
const prt = (ifLine) =>
  `on: [pull_request_target]\npermissions:\n  id-token: write\njobs:\n  j:\n    if: ${ifLine}\n    runs-on: ubuntu-latest\n    steps:\n${STEP}      - uses: google-github-actions/auth@abc\n`;
test('PRT: != pull_request does not exclude pull_request_target -> FAIL (Codex repro)', () => {
  assert.equal(analyze(prt("github.event_name != 'pull_request'"), 'p.yml').length, 1);
});
test('PRT: main-ref if does not exclude pull_request_target -> FAIL', () => {
  assert.equal(analyze(prt("github.ref == 'refs/heads/main'"), 'p.yml').length, 1);
});
test('PRT: positive push requirement is unreachable -> PASS', () => {
  assert.deepEqual(analyze(prt("github.event_name == 'push'"), 'p.yml'), []);
});
test('PRT: both PR events excluded by separate != clauses -> PASS', () => {
  assert.deepEqual(analyze(prt("github.event_name != 'pull_request' && github.event_name != 'pull_request_target'"), 'p.yml'), []);
});

// ── RULE 2: dispatch / non-main push must be ref-gated ─────────────────────
import { analyzeRef } from './check-pr-workflow-identity.mjs';

const wf = (on, ifLine = '', pre = '') =>
  `on:\n${on}\njobs:\n${pre}  sign:\n${ifLine}    permissions:\n      id-token: write\n    runs-on: ubuntu-latest\n    steps:\n${STEP}`;
const DISPATCH = '  workflow_dispatch:';

test('R2 dispatch + id-token, no if -> FAIL', () => {
  assert.equal(analyzeRef(wf(DISPATCH), 'r.yml').bad.length, 1);
});
test('R2 dispatch + main ref if -> PASS', () => {
  assert.equal(analyzeRef(wf(DISPATCH, "    if: github.ref == 'refs/heads/main'\n"), 'r.yml').bad.length, 0);
});
test('R2 || with non-ref disjunct -> FAIL', () => {
  const i = "    if: github.ref == 'refs/heads/main' || github.event_name == 'workflow_dispatch'\n";
  assert.equal(analyzeRef(wf(DISPATCH, i), 'r.yml').bad.length, 1);
});
test('R2 tag-gated -> PASS; ref check as && conjunct with parenthesised ||', () => {
  assert.equal(analyzeRef(wf(DISPATCH, "    if: startsWith(github.ref, 'refs/tags/v')\n"), 'r.yml').bad.length, 0);
  const i = "    if: github.event_name != 'pull_request' && (github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/a-v'))\n";
  assert.equal(analyzeRef(wf(DISPATCH, i), 'r.yml').bad.length, 0);
});
test('R2 push tags-only trigger without if -> FAIL', () => {
  assert.equal(analyzeRef(wf('  push:\n    tags: [v*]'), 'r.yml').bad.length, 1);
});
test('R2 push branches [main] only, no dispatch -> PASS', () => {
  assert.equal(analyzeRef(wf('  push:\n    branches: [main]'), 'r.yml').bad.length, 0);
  assert.equal(analyzeRef(wf('  push:\n    branches: [main, dev]'), 'r.yml').bad.length, 1);
});
test('R2 opt-out comment -> WARN, no failure', () => {
  const r = analyzeRef(wf(DISPATCH, '', '  # identity-guard: allow reviewed manual path\n'), 'r.yml');
  assert.equal(r.bad.length, 0);
  assert.deepEqual(r.warn, ['WARN r.yml:sign reviewed manual path']);
});
