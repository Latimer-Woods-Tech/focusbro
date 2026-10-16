import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkWorkflow } from './check-pr-workflow-identity.mjs';

const topLevel = `name: x
on:
  pull_request:
    branches: [main]
permissions:
  id-token: write
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
const jobLevel = `name: x
on: [push, pull_request]
jobs:
  ci:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - run: echo hi
`;
const gated = `name: x
on:
  push:
    branches: [main]
  pull_request:
jobs:
  ci:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - run: echo hi
  cal:
    if: github.event_name != 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: google-github-actions/auth@abc # v3
`;
const authOnly = `on: pull_request
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: google-github-actions/auth@abc
`;
const pushOnly = `on:
  push:
    branches: [main]
permissions:
  id-token: write
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: google-github-actions/auth@abc
`;
const jobOverrides = `on: pull_request
permissions:
  id-token: write
jobs:
  ci:
    permissions:
      contents: read
    runs-on: ubuntu-latest
    steps:
      - run: echo
`;

test('(a) top-level id-token + PR job fails', () => assert.deepEqual(checkWorkflow(topLevel), ['ci']));
test('(b) job-level id-token PR job fails', () => assert.deepEqual(checkWorkflow(jobLevel), ['ci']));
test('(c) push-gated job passes; ungated sibling is not flagged', () => assert.deepEqual(checkWorkflow(gated), []));
test('auth step in a PR job fails', () => assert.deepEqual(checkWorkflow(authOnly), ['ci']));
test('non-PR workflow is out of scope', () => assert.deepEqual(checkWorkflow(pushOnly), []));
test('job permissions override the top-level grant', () => assert.deepEqual(checkWorkflow(jobOverrides), []));

test('CLI exits 1 listing file:job on a violating dir', () => {
  const d = mkdtempSync(join(tmpdir(), 'wfid-'));
  writeFileSync(join(d, 'bad.yml'), jobLevel);
  const r = spawnSync('node', ['scripts/check-pr-workflow-identity.mjs', d], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /bad\.yml:ci/);
});

// (d) focusbro's real workflows: green at head, red at the original 6e86c70 (android-release + ios-release build).
test('(d) the real .github/workflows pass with no WARN', () => {
  const out = spawnSync('node', ['scripts/check-pr-workflow-identity.mjs', '.github/workflows'], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.doesNotMatch(out.stderr, /WARN/);
});

test('(d) the real workflows at 6e86c70 fail on android-release and ios-release build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fb-orig-'));
  for (const f of ['android-release', 'ios-release', 'test', 'deploy', 'docs-health', 'heartbeat', 'lighthouse', 'complete-focusbro-10dlc']) {
    const o = spawnSync('git', ['show', `6e86c70:.github/workflows/${f}.yml`], { encoding: 'utf8' });
    if (o.status === 0) writeFileSync(join(dir, `${f}.yml`), o.stdout);
  }
  const out = spawnSync('node', ['scripts/check-pr-workflow-identity.mjs', dir], { encoding: 'utf8' });
  assert.equal(out.status, 1, out.stdout + out.stderr);
  assert.match(out.stdout + out.stderr, /android-release\.yml:build/);
  assert.match(out.stdout + out.stderr, /ios-release\.yml:build/);
});

// ---- Codex bypasses (XV-wordis-bond-407) ----
const wrap = (on, job) => `${on}\njobs:\n${job}`;
const prJob = (extra = '') => `  cal:\n    runs-on: ubuntu-latest\n${extra}    permissions:\n      id-token: write\n    steps:\n      - run: echo\n`;
test('FAIL: quoted permission key/value', () => assert.deepEqual(checkWorkflow(
  'on: pull_request\njobs:\n  cal:\n    runs-on: x\n    permissions:\n      "id-token": "write"\n    steps:\n      - run: echo\n'), ['cal']));
test('FAIL: double-quoted on', () => assert.deepEqual(checkWorkflow(
  '"on":\n  pull_request:\njobs:\n  cal:\n    runs-on: x\n    permissions:\n      id-token: write\n    steps:\n      - run: echo\n'), ['cal']));
test('FAIL: quoted event name', () => assert.deepEqual(checkWorkflow(
  wrap('on:\n  "pull_request":', prJob())), ['cal']));
test('FAIL: 4-space job indentation', () => assert.deepEqual(checkWorkflow(
  'on: pull_request\njobs:\n    cal:\n        runs-on: x\n        permissions:\n            id-token: write\n        steps:\n            - run: echo\n'), ['cal']));
test('FAIL: pull_request_target with != pull_request', () => assert.deepEqual(checkWorkflow(
  wrap('on:\n  pull_request:\n  pull_request_target:', prJob("    if: github.event_name != 'pull_request'\n"))), ['cal']));
test('PASS: both PR events excluded', () => assert.deepEqual(checkWorkflow(
  wrap('on:\n  push:\n    branches: [main]\n  pull_request:\n  pull_request_target:',
    prJob("    if: github.event_name != 'pull_request' && github.event_name != 'pull_request_target'\n"))), []));
test('FAIL: main ref does not exclude pull_request_target', () => assert.deepEqual(checkWorkflow(
  wrap('on:\n  pull_request_target:', prJob("    if: github.ref == 'refs/heads/main'\n"))), ['cal']));

// ---- rule 2 ----
const disp = (extra = '', on = 'on:\n  workflow_dispatch:') => wrap(on, prJob(extra));
test('R2 FAIL: dispatch + id-token, no if', () => assert.deepEqual(checkWorkflow(disp()), ['cal']));
test('R2 PASS: main-gated', () => assert.deepEqual(checkWorkflow(disp("    if: github.event_name != 'x' && github.ref == 'refs/heads/main'\n")), []));
test('R2 FAIL: main || workflow_dispatch', () => assert.deepEqual(
  checkWorkflow(disp("    if: github.ref == 'refs/heads/main' || github.event_name == 'workflow_dispatch'\n")), ['cal']));
test('R2 PASS: tag-gated', () => assert.deepEqual(
  checkWorkflow(disp("    if: github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/sdk/v')\n", 'on:\n  push:\n    tags: [\'sdk/v*\']\n  workflow_dispatch:')), []));
test('R2 PASS: push [main] only, no dispatch', () => assert.deepEqual(
  checkWorkflow(disp('', 'on:\n  push:\n    branches: [main]')), []));
test('R2 FAIL: push with tags only (branches missing)', () => assert.deepEqual(
  checkWorkflow(disp('', "on:\n  push:\n    tags: ['v*']")), ['cal']));
test('R2 FAIL: ref check only in a disjunct of a parenthesised ||', () => assert.deepEqual(
  checkWorkflow(disp("    if: (github.ref == 'refs/heads/main' || success()) && always()\n")), ['cal']));
test('R2 opt-out: WARN and exit 0', () => {
  const d = mkdtempSync(join(tmpdir(), 'wfopt-'));
  writeFileSync(join(d, 'o.yml'), disp('').replace('  cal:', '  # identity-guard: allow staging runs\n  cal:'));
  const r = spawnSync('node', ['scripts/check-pr-workflow-identity.mjs', d], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WARN o\.yml:cal staging runs/);
});
// ---- round 3: opt-out scope, composite and reusable workflows ----
const optOutDir = (yml) => {
  const d = mkdtempSync(join(tmpdir(), 'wfopt3-'));
  writeFileSync(join(d, 'o.yml'), yml);
  return spawnSync('node', ['scripts/check-pr-workflow-identity.mjs', d], { encoding: 'utf8' });
};
const fakeOptOut = `on:
  workflow_dispatch:
jobs:
  decoy:
    runs-on: ubuntu-latest
    steps:
      - run: |
          # identity-guard: allow sneaky
          real:
  real:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
    steps:
      - run: echo
`;
test('R3 FAIL: opt-out + fake job key inside another job\'s run block does not authorize', () => {
  const r = optOutDir(fakeOptOut);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /o\.yml:real \(rule 2\)/);
  assert.doesNotMatch(r.stderr, /WARN/);
});
test('R3 FAIL: opt-out comment not immediately above the key', () => {
  assert.equal(optOutDir(disp('').replace('  cal:', '  # identity-guard: allow x\n\n  cal:')).status, 1);
});
test('R3 PASS: genuine opt-out with 4-space job indentation', () => {
  const y = 'on:\n  workflow_dispatch:\njobs:\n    # identity-guard: allow staging\n    cal:\n        permissions:\n            id-token: write\n        steps:\n            - run: echo\n';
  const r = optOutDir(y);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WARN o\.yml:cal staging/);
});

const repo = (files) => {
  const root = mkdtempSync(join(tmpdir(), 'wfroot-'));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(root, f, '..'), { recursive: true });
    writeFileSync(join(root, f), c);
  }
  return root;
};
const prCaller = (jobBody) => `on: pull_request\njobs:\n  j:\n${jobBody}`;
const authAction = 'runs:\n  using: composite\n  steps:\n    - uses: google-github-actions/auth@abc\n';
test('R3 FAIL: local composite action containing auth, on a PR job', () => {
  const root = repo({ '.github/actions/x/action.yml': authAction });
  assert.deepEqual(checkWorkflow(prCaller('    runs-on: x\n    steps:\n      - uses: ./.github/actions/x\n'), root), ['j']);
});
test('R3 FAIL: composite nesting another local composite with auth', () => {
  const root = repo({
    '.github/actions/x/action.yaml': 'runs:\n  using: composite\n  steps:\n    - uses: ./.github/actions/y\n',
    '.github/actions/y/action.yml': authAction,
  });
  assert.deepEqual(checkWorkflow(prCaller('    runs-on: x\n    steps:\n      - uses: ./.github/actions/x\n'), root), ['j']);
});
test('R3 PASS: local composite without auth', () => {
  const root = repo({ '.github/actions/x/action.yml': 'runs:\n  using: composite\n  steps:\n    - run: echo\n      shell: bash\n' });
  assert.deepEqual(checkWorkflow(prCaller('    runs-on: x\n    steps:\n      - uses: ./.github/actions/x\n'), root), []);
});
test('R3 FAIL: missing local composite fails closed', () => {
  assert.deepEqual(checkWorkflow(prCaller('    runs-on: x\n    steps:\n      - uses: ./nope\n'), repo({})), ['j']);
});
test('R3 FAIL: local reusable workflow containing auth', () => {
  const root = repo({ '.github/workflows/r.yml': 'on: workflow_call\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: google-github-actions/auth@abc\n' });
  assert.deepEqual(checkWorkflow(prCaller('    uses: ./.github/workflows/r.yml\n'), root), ['j']);
});
test('R3 PASS: local reusable workflow without identity', () => {
  const root = repo({ '.github/workflows/r.yml': 'on: workflow_call\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: echo\n' });
  assert.deepEqual(checkWorkflow(prCaller('    uses: ./.github/workflows/r.yml\n'), root), []);
});
test('R3 FAIL: external reusable + secrets: inherit on a PR job', () => {
  assert.deepEqual(checkWorkflow(prCaller('    uses: o/r/.github/workflows/w.yml@abc\n    secrets: inherit\n'), repo({})), ['j']);
});
test('R3 FAIL: external reusable granted id-token: write', () => {
  assert.deepEqual(checkWorkflow(prCaller('    uses: o/r/.github/workflows/w.yml@abc\n    permissions:\n      id-token: write\n'), repo({})), ['j']);
});
test('R3 PASS: external reusable with no id-token and no secrets', () => {
  assert.deepEqual(checkWorkflow(prCaller('    uses: o/r/.github/workflows/w.yml@abc\n    permissions:\n      contents: read\n'), repo({})), []);
});

// ---- round 4: tag pushes, named secrets to external reusables ----
test('R4 FAIL: push branches [main] + tags [**], ungated identity job', () => assert.deepEqual(
  checkWorkflow(disp('', "on:\n  push:\n    branches: [main]\n    tags: ['**']")), ['cal']));
test('R4 FAIL: push tags only, no gate', () => assert.deepEqual(
  checkWorkflow(disp('', "on:\n  push:\n    tags: ['**']")), ['cal']));
test('R4 FAIL: push branches-ignore', () => assert.deepEqual(
  checkWorkflow(disp('', "on:\n  push:\n    branches: [main]\n    branches-ignore: [x]")), ['cal']));
test('R4 FAIL: push tags-ignore', () => assert.deepEqual(
  checkWorkflow(disp('', "on:\n  push:\n    branches: [main]\n    tags-ignore: [x]")), ['cal']));
test('R4 FAIL: push paths with no branches', () => assert.deepEqual(
  checkWorkflow(disp('', "on:\n  push:\n    paths: ['a/**']")), ['cal']));
test('R4 PASS: push branches [main] only', () => assert.deepEqual(
  checkWorkflow(disp('', 'on:\n  push:\n    branches: [main]')), []));
test('R4 PASS: branches [main] + tags with a ref gate', () => assert.deepEqual(
  checkWorkflow(disp("    if: github.ref == 'refs/heads/main'\n", "on:\n  push:\n    branches: [main]\n    tags: ['**']")), []));
test('R4 FAIL: external reusable secrets: inherit stays a failure', () => assert.deepEqual(
  checkWorkflow(prCaller('    uses: o/r/.github/workflows/w.yml@abc\n    secrets: inherit\n'), repo({})), ['j']));
test('R4 WARN: external reusable with named secrets passes with a WARN', () => {
  const r = optOutDir(prCaller('    uses: o/r/.github/workflows/w.yml@abc\n    secrets:\n      A: ${{ secrets.A }}\n      B: ${{ secrets.B }}\n'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WARN o\.yml:j passes secrets A, B to external reusable o\/r\/\.github\/workflows\/w\.yml@abc/);
});
test('R4 no WARN: named secrets on a job that excludes PR events', () => {
  const r = optOutDir("on:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  j:\n    if: github.event_name != 'pull_request'\n    uses: o/r/.github/workflows/w.yml@abc\n    secrets:\n      A: x\n");
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /WARN/);
});

// publish-sdk's gate is NOT identity-scoped (it uses NPM_TOKEN, no id-token/auth), so the guard has
// nothing to assert about it; no fixture is faked here.

test('unparseable YAML exits 2 (fail closed)', () => {
  const d = mkdtempSync(join(tmpdir(), 'wfbad-'));
  writeFileSync(join(d, 'b.yml'), 'on: [\n');
  assert.equal(spawnSync('node', ['scripts/check-pr-workflow-identity.mjs', d], { encoding: 'utf8' }).status, 2);
});
