import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
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
// ---- round 5: allowlist file replaces comment opt-outs ----
const emptyAllow = '[]';
const run = (yml, allow = emptyAllow) => {
  const d = mkdtempSync(join(tmpdir(), 'wfopt5-'));
  writeFileSync(join(d, 'o.yml'), yml);
  const f = join(mkdtempSync(join(tmpdir(), 'wfallow-')), 'a.json');
  writeFileSync(f, typeof allow === 'string' ? allow : JSON.stringify(allow));
  return spawnSync('node', ['scripts/check-pr-workflow-identity.mjs', d, f], { encoding: 'utf8' });
};
const entry = (o = {}) => ({ file: 'o.yml', job: 'cal', rule: 2, reason: 'staging runs', ...o });
test('R5 FAIL: comment opt-out is ignored', () => {
  const r = run(disp('').replace('  cal:', '  # identity-guard: allow staging runs\n  cal:'));
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /o\.yml:cal \(rule 2\)/);
});
test('R5 FAIL: forged comment above flow-mapping decoy.env.real is ignored', () => {
  const y = `on:\n  workflow_dispatch:\njobs:\n  decoy: {env: {\n  # identity-guard: allow sneaky\n  real: x}}\n  real:\n    permissions:\n      id-token: write\n    steps:\n      - run: echo\n`;
  assert.equal(run(y).status, 1);
});
test('R5 FAIL: fake job key in a run block with comment is ignored', () => {
  const y = `on:\n  workflow_dispatch:\njobs:\n  decoy:\n    steps:\n      - run: |\n          # identity-guard: allow sneaky\n          real:\n  real:\n    permissions:\n      id-token: write\n    steps:\n      - run: echo\n`;
  const r = run(y);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /o\.yml:real \(rule 2\)/);
});
test('R5 PASS: allowlist rule-2 entry gives WARN, exit 0', () => {
  const r = run(disp(''), [entry()]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WARN o\.yml:cal staging runs/);
  assert.doesNotMatch(r.stderr, /stale/);
});
test('R5 FAIL: allowlist cannot silence rule 1', () => {
  const r = run('on: pull_request\njobs:\n' + prJob(), [entry(), entry({ rule: 1 })]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /o\.yml:cal \(rule 1\)/);
});
test('R5 FAIL: allowlist entry for another job/file does not match', () => {
  assert.equal(run(disp(''), [entry({ job: 'other' }), entry({ file: 'x.yml' })]).status, 1);
});
test('R5 WARN: stale allowlist entry, exit 0', () => {
  const r = run('on: push\njobs:\n  cal:\n    steps:\n      - run: echo\n', [entry()]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WARN stale allowlist entry o\.yml:cal/);
});
test('R5 FAIL: malformed allowlist exits 2', () => assert.equal(run(disp(''), '{').status, 2));

test('R5 FAIL: mixed-case google-github-actions/auth on a PR job', () => assert.deepEqual(
  checkWorkflow('on: pull_request\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: Google-GitHub-Actions/Auth@abc\n'), ['j']));

test('R6 FAIL: ./Action has auth, clean decoy ./action (local paths are case-sensitive)', () => {
  const root = repo({
    'Action/action.yml': authAction,
    'action/action.yml': 'runs:\n  using: composite\n  steps:\n    - run: echo\n      shell: bash\n',
  });
  assert.deepEqual(checkWorkflow(prCaller('    runs-on: x\n    steps:\n      - uses: ./Action\n'), root), ['j']);
});

test('R5 FAIL: job permissions: write-all on a PR workflow', () => assert.deepEqual(
  checkWorkflow('on: pull_request\njobs:\n  j:\n    runs-on: x\n    permissions: write-all\n    steps:\n      - run: echo\n'), ['j']));
test('R5 FAIL: top-level write-all, no job permissions', () => assert.deepEqual(
  checkWorkflow('on: pull_request\npermissions: write-all\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo\n'), ['j']));
test('R5 PASS: permissions: read-all is not identity', () => assert.deepEqual(
  checkWorkflow('on: pull_request\npermissions: read-all\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo\n'), []));

test('R5 WARN: plain secret use in env on a PR job', () => {
  const r = run('on: pull_request\njobs:\n  j:\n    runs-on: x\n    env:\n      KEY: ${{ secrets.MY_KEY }}\n    steps:\n      - run: echo\n        env:\n          T: ${{ secrets.GITHUB_TOKEN }}\n');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WARN o\.yml:j reads secrets MY_KEY on a PR-reachable job \(D227 scope is identity; see leader ruling\)/);
});
test('R5 WARN: secret in a step `with:`', () => {
  const r = run('on: pull_request\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: a/b@1\n        with:\n          t: ${{ secrets.TOK }}\n');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WARN o\.yml:j reads secrets TOK /);
});
test('R5 no WARN: GITHUB_TOKEN only, or non-PR workflow', () => {
  assert.doesNotMatch(run('on: pull_request\njobs:\n  j:\n    steps:\n      - run: echo ${{ secrets.GITHUB_TOKEN }}\n').stderr, /WARN/);
  assert.doesNotMatch(run('on: push\njobs:\n  j:\n    steps:\n      - run: echo ${{ secrets.K }}\n').stderr, /WARN/);
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
test('R5 FAIL: symlink to a clean composite outside the root fails closed', () => {
  const outside = mkdtempSync(join(tmpdir(), 'wfout-'));
  writeFileSync(join(outside, 'action.yml'), 'runs:\n  using: composite\n  steps:\n    - run: echo\n      shell: bash\n');
  const root = repo({});
  mkdirSync(join(root, '.github/actions'), { recursive: true });
  symlinkSync(outside, join(root, '.github/actions/x'));
  assert.deepEqual(checkWorkflow(prCaller('    runs-on: x\n    steps:\n      - uses: ./.github/actions/x\n'), root), ['j']);
});
test('R5 PASS: symlink inside the root to a clean composite', () => {
  const root = repo({ 'real/action.yml': 'runs:\n  using: composite\n  steps:\n    - run: echo\n      shell: bash\n' });
  mkdirSync(join(root, '.github/actions'), { recursive: true });
  symlinkSync(join(root, 'real'), join(root, '.github/actions/x'));
  assert.deepEqual(checkWorkflow(prCaller('    runs-on: x\n    steps:\n      - uses: ./.github/actions/x\n'), root), []);
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
  const r = run(prCaller('    uses: o/r/.github/workflows/w.yml@abc\n    secrets:\n      A: ${{ secrets.A }}\n      B: ${{ secrets.B }}\n'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WARN o\.yml:j passes secrets A, B to external reusable o\/r\/\.github\/workflows\/w\.yml@abc/);
});
test('R4 no WARN: named secrets on a job that excludes PR events', () => {
  const r = run("on:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  j:\n    if: github.event_name != 'pull_request'\n    uses: o/r/.github/workflows/w.yml@abc\n    secrets:\n      A: x\n");
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
