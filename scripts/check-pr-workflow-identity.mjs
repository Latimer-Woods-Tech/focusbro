#!/usr/bin/env node
/**
 * Workflow identity guard (D227, SA-LEAST-PRIV1).
 *
 * An "identity job" has effective `id-token: write` (job `permissions`, else top-level), uses
 * `google-github-actions/auth` (directly, or inside a local `./` composite action, depth <= 3), calls a
 * local reusable workflow containing an identity job, or calls an external reusable workflow with
 * `secrets: inherit`. Local paths resolve against the repo root (cwd); unresolvable = identity (fail closed).
 *
 * RULE 1: in a workflow triggered by pull_request / pull_request_target, no identity job may be able
 *   to run on those events. A job `if` counts only if it excludes EVERY PR-family event the workflow
 *   listens on (`github.event_name != 'ev'` per event, a positive `event_name == 'push'|...`, or a tag
 *   ref). `github.ref == 'refs/heads/main'` excludes pull_request only when its `types` is absent or
 *   lacks `closed` (a merged `closed` event runs on refs/heads/main); it never excludes
 *   pull_request_target (whose ref is the base branch).
 * RULE 2: in a workflow that can run from an arbitrary ref (workflow_dispatch, workflow_call,
 *   workflow_run, repository_dispatch, or `push` whose `branches` is missing / not exactly [main]),
 *   every identity job needs an `if` whose WHOLE expression requires `github.ref == 'refs/heads/main'`
 *   and/or `startsWith(github.ref, 'refs/tags/...')`. A top-level `||` with any disjunct lacking a ref
 *   check does not count. Exceptions come ONLY from the allowlist file
 *   `check-pr-workflow-identity.allow.json` next to this script: `[{file, job, rule: 2, reason}]` (file = workflow
 *   basename). It never silences rule 1; a matching violation prints WARN and passes; an entry matching no
 *   violating job prints `WARN stale allowlist entry`. Comments in workflows are never consulted.
 *   `push` is main-only only with `branches` exactly [main] and no tags / tags-ignore / branches-ignore.
 * A PR-reachable job that reads `secrets.X` (other than GITHUB_TOKEN) in steps / env / with prints WARN, exit 0.
 * Local `uses:` paths resolve with realpath and must stay inside the repo root (else identity, fail closed);
 * remote `uses:` matching is case-insensitive (GitHub action refs are); local `./` paths are kept byte-exact.
 * An external reusable on a PR-reachable job with explicitly named secrets (not `inherit`) prints WARN, exit 0.
 *
 * The workflow is parsed with PyYAML (python3). If it is unavailable the guard exits 2 (fail closed).
 *
 * Usage: node scripts/check-pr-workflow-identity.mjs [workflows-dir [allowlist.json]]   (default .github/workflows)
 * Exit 1 lists `file:job` per violation; exit 2 on parser/environment error.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PR_EVENTS = ['pull_request', 'pull_request_target'];
const ANY_REF_EVENTS = ['workflow_dispatch', 'workflow_call', 'workflow_run', 'repository_dispatch'];
const SAFE_EVENTS = ['schedule', ...PR_EVENTS];

const PY = `
import sys, json
try:
    import yaml
except ImportError:
    sys.stderr.write("PyYAML is not importable (pip install pyyaml==6.0.2)\\n"); sys.exit(3)
try:
    json.dump(yaml.safe_load(sys.stdin.read()), sys.stdout, default=str)
except Exception as e:
    sys.stderr.write("YAML parse error: %s\\n" % e); sys.exit(4)
`;

export function parseYaml(text) {
  const r = spawnSync('python3', ['-c', PY], { input: text, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    throw new Error(`cannot parse workflow YAML: ${(r.error?.message ?? r.stderr ?? '').trim()}`);
  }
  return JSON.parse(r.stdout);
}

/** event name -> config, from `on` (PyYAML loads the key `on` as boolean true). */
function triggerMap(doc) {
  const on = doc && typeof doc === 'object' ? (doc.on ?? doc.true) : undefined;
  if (typeof on === 'string') return { [on]: null };
  if (Array.isArray(on)) return Object.fromEntries(on.map((e) => [String(e), null]));
  if (on && typeof on === 'object') return on;
  return {};
}

// ---- `if` expression analysis -------------------------------------------------------------
function stripExpr(cond) {
  let c = String(cond).trim();
  const m = c.match(/^\$\{\{([\s\S]*)\}\}$/);
  if (m) c = m[1].trim();
  return c;
}

/** Split on a top-level operator, ignoring parentheses and quoted strings. */
function splitTop(expr, op) {
  const out = [];
  let depth = 0, quote = null, cur = '';
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth === 0 && expr.startsWith(op, i)) { out.push(cur.trim()); cur = ''; i += op.length - 1; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function unwrap(atom) {
  let a = atom.trim();
  while (a.startsWith('(') && a.endsWith(')') && balanced(a.slice(1, -1))) a = a.slice(1, -1).trim();
  return a;
}
function balanced(s) {
  let d = 0, q = null;
  for (const ch of s) {
    if (q) { if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"') q = ch;
    else if (ch === '(') d++;
    else if (ch === ')' && --d < 0) return false;
  }
  return d === 0 && !q;
}

/**
 * Every disjunct must satisfy `atomOk` through at least one conjunct (recursing into parentheses).
 * Unknown shapes return false (fail closed).
 */
function requiresAll(expr, atomOk) {
  const disj = splitTop(expr, '||');
  return disj.every((d) => splitTop(d, '&&').some((conj) => {
    const u = unwrap(conj);
    return u !== conj.trim() ? requiresAll(u, atomOk) : atomOk(u);
  }));
}

const REF_MAIN = /^github\.ref\s*==\s*'refs\/heads\/main'$/;
const REF_TAG = /^startsWith\(\s*github\.ref\s*,\s*'refs\/tags\/[^']+'\s*\)$/;
const isRefAtom = (a) => REF_MAIN.test(a) || REF_TAG.test(a);

/** rule 2: `if` requires a main/tag ref as a conjunct of the whole expression. */
export function requiresMainOrTagRef(cond) {
  if (cond === undefined || cond === null || cond === false) return false;
  return requiresAll(stripExpr(cond), isRefAtom);
}

/**
 * rule 1: `if` provably excludes every PR event in `prEvents`. A ref conjunct only excludes
 * pull_request when `closedPossible` is false: a merged `closed` event runs on the base ref (refs/heads/main).
 */
export function excludesPrEvents(cond, prEvents, closedPossible = false) {
  if (cond === undefined || cond === null || cond === false) return false;
  return prEvents.every((ev) => requiresAll(stripExpr(cond), (a) =>
    new RegExp(`^github\\.event_name\\s*!=\\s*'${ev}'$`).test(a) ||
    /^github\.event_name\s*==\s*'(push|workflow_dispatch|schedule)'$/.test(a) ||
    (ev === 'pull_request' ? !closedPossible && isRefAtom(a) : REF_TAG.test(a))));
}

/** can the workflow's pull_request trigger fire on `closed`? Absent `types` = defaults (no); odd shapes fail closed. */
function prClosedPossible(cfg) {
  if (!cfg || typeof cfg !== 'object' || cfg.types === undefined || cfg.types === null) return false;
  const t = cfg.types;
  if (typeof t === 'string') return t.trim().toLowerCase() === 'closed';
  return !Array.isArray(t) || t.some((x) => typeof x !== 'string' || x.trim().toLowerCase() === 'closed');
}

// ---- job inspection -----------------------------------------------------------------------
/** true / false when `permissions` is declared, null when absent. */
function grantsIdToken(perms) {
  if (perms === undefined || perms === null) return null;
  if (typeof perms === 'string') return perms === 'write-all';
  if (typeof perms === 'object') return perms['id-token'] === 'write';
  return true; // unexpected shape: fail closed
}

const AUTH_USES = /^google-github-actions\/auth@/i;
const ALLOW_FILE = join(dirname(fileURLToPath(import.meta.url)), 'check-pr-workflow-identity.allow.json');
const MAX_DEPTH = 3;

/** Parse a repo-relative local file; null when missing, unparseable or (after realpath) outside the root (caller fails closed). */
function readLocal(root, rel) {
  try {
    const realRoot = realpathSync(root);
    const abs = realpathSync(resolve(root, rel));
    if (abs !== realRoot && !abs.startsWith(realRoot + sep)) return null;
    return parseYaml(readFileSync(abs, 'utf8'));
  } catch { return null; }
}

/** local composite action (`./path`): do its steps, recursively, use google-github-actions/auth? Unresolvable = true. */
function compositeUsesAuth(root, ref, depth) {
  if (depth > MAX_DEPTH) return true;
  for (const name of ['action.yml', 'action.yaml']) {
    const doc = readLocal(root, join(ref, name));
    if (doc === null) continue;
    const steps = Array.isArray(doc?.runs?.steps) ? doc.runs.steps : [];
    return stepsUseAuth(steps, root, depth);
  }
  return true;
}

function stepsUseAuth(steps, root, depth) {
  return steps.some((s) => {
    if (typeof s?.uses !== 'string') return false;
    const u = s.uses.trim();
    // local `./` paths stay byte-exact (case-sensitive on Linux); only remote refs match case-insensitively
    if (u.startsWith('./')) return compositeUsesAuth(root, u, depth + 1);
    return AUTH_USES.test(u);
  });
}

/** local reusable workflow: is any of its jobs an identity job? Unresolvable = true. */
function reusableHasIdentity(root, ref, depth) {
  if (depth > MAX_DEPTH) return true;
  const doc = readLocal(root, ref);
  if (!doc || typeof doc !== 'object') return true;
  if (!doc.jobs || typeof doc.jobs !== 'object') return false;
  return Object.values(doc.jobs).some((j) => isIdentityJob(j, doc.permissions, root, depth + 1));
}

function isIdentityJob(job, topPerms, root, depth = 0) {
  const effective = grantsIdToken(job?.permissions) ?? grantsIdToken(topPerms) ?? false;
  if (effective) return true;
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  if (stepsUseAuth(steps, root, depth)) return true;
  if (typeof job?.uses === 'string') {
    const u = job.uses.trim();
    if (u.startsWith('./')) return reusableHasIdentity(root, u, depth + 1);
    // external reusable workflow: opaque, so fail closed when it can receive secrets
    return job.secrets === 'inherit';
  }
  return false;
}

const SECRET_REF = /secrets\s*(?:\.\s*([A-Za-z_][\w-]*)|\[\s*['"]([^'"]+)['"]\s*\])/g;
/** names of secrets (other than GITHUB_TOKEN) referenced anywhere in the job's own steps / env / with. */
function secretsRead(job, topEnv) {
  const { secrets: _passed, ...rest } = job ?? {};
  const names = new Set();
  for (const m of JSON.stringify([rest, topEnv ?? null]).matchAll(SECRET_REF)) {
    const n = m[1] ?? m[2];
    if (n.toUpperCase() !== 'GITHUB_TOKEN') names.add(n);
  }
  return [...names].sort();
}

/** @returns {{violations: {job: string, rule: number}[], warnings: {job: string, reason: string}[]}} */
export function analyzeWorkflow(text, root = process.cwd()) {
  const doc = parseYaml(text);
  const result = { violations: [], warnings: [] };
  if (!doc || typeof doc !== 'object' || !doc.jobs || typeof doc.jobs !== 'object') return result;
  const triggers = triggerMap(doc);
  const events = Object.keys(triggers);
  const prEvents = PR_EVENTS.filter((e) => events.includes(e));
  const closed = prClosedPossible(triggers.pull_request);

  const pushCfg = triggers.push;
  const pushBranches = pushCfg && typeof pushCfg === 'object' ? pushCfg.branches : undefined;
  // main-only: branches exactly [main] and nothing that widens the ref set (a tag push runs on refs/tags/*)
  const pushMainOnly = Array.isArray(pushBranches) && pushBranches.length === 1 && pushBranches[0] === 'main' &&
    !['tags', 'tags-ignore', 'branches-ignore'].some((k) => pushCfg[k] !== undefined);
  const anyRef = events.some((e) => ANY_REF_EVENTS.includes(e)) ||
    (events.includes('push') && !pushMainOnly) ||
    events.some((e) => e !== 'push' && !SAFE_EVENTS.includes(e) && !ANY_REF_EVENTS.includes(e)); // unknown event: fail closed

  for (const [name, job] of Object.entries(doc.jobs)) {
    const ext = typeof job?.uses === 'string' && !job.uses.trim().startsWith('./');
    const prReachable = prEvents.length > 0 && !excludesPrEvents(job?.if, prEvents, closed);
    const read = prReachable ? secretsRead(job, doc.env) : [];
    if (read.length) {
      result.warnings.push({ job: name, reason: `reads secrets ${read.join(', ')} on a PR-reachable job (D227 scope is identity; see leader ruling)` });
    }
    const named = ext && job.secrets && typeof job.secrets === 'object' ? Object.keys(job.secrets) : [];
    if (named.length && prEvents.length && !excludesPrEvents(job.if, prEvents, closed)) {
      result.warnings.push({ job: name, reason: `passes secrets ${named.join(', ')} to external reusable ${job.uses.trim()}` });
    }
    if (!isIdentityJob(job, doc.permissions, root)) continue;
    const cond = job?.if;
    if (prEvents.length && !excludesPrEvents(cond, prEvents, closed)) {
      result.violations.push({ job: name, rule: 1 });
    }
    if (anyRef && !requiresMainOrTagRef(cond)) {
      result.violations.push({ job: name, rule: 2 });
    }
  }
  return result;
}

/** @returns {string[]} violating job names */
export function checkWorkflow(text, root) {
  return [...new Set(analyzeWorkflow(text, root).violations.map((v) => v.job))];
}

/** Load the rule-2 allowlist; a missing file is empty, a malformed one throws (fail closed). */
export function loadAllowlist(file = ALLOW_FILE) {
  if (!existsSync(file)) return [];
  const list = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(list)) throw new Error(`${file}: allowlist must be a JSON array`);
  return list;
}

export function checkDir(dir, root = process.cwd(), allowFile = ALLOW_FILE) {
  const violations = [], warnings = [];
  const allow = loadAllowlist(allowFile).map((e) => ({ ...e, used: false }));
  for (const f of readdirSync(dir).sort()) {
    if (!/\.ya?ml$/.test(f)) continue;
    const r = analyzeWorkflow(readFileSync(join(dir, f), 'utf8'), root);
    for (const w of r.warnings) warnings.push(`${f}:${w.job} ${w.reason}`);
    for (const v of r.violations) {
      const hit = v.rule === 2 ? allow.find((e) => e.rule === 2 && e.file === basename(f) && e.job === v.job && e.reason) : undefined;
      if (hit) {
        hit.used = true;
        warnings.push(`${f}:${v.job} ${hit.reason}`);
      } else violations.push(`${f}:${v.job} (rule ${v.rule})`);
    }
  }
  for (const e of allow) {
    if (!e.used) warnings.push(`stale allowlist entry ${e.file}:${e.job} (rule ${e.rule}) matches no violating job`);
  }
  return { violations, warnings };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? '.github/workflows';
  let res;
  try {
    res = checkDir(dir, process.cwd(), process.argv[3] ?? ALLOW_FILE);
  } catch (e) {
    console.error(`check-pr-workflow-identity: ${e.message}`);
    process.exit(2);
  }
  for (const w of res.warnings) console.warn(`WARN ${w}`);
  if (res.violations.length) {
    console.error('Identity violation: rule 1 = no PR-reachable id-token/auth job; rule 2 = identity jobs on any-ref triggers must require main or a release tag:');
    for (const b of res.violations) console.error(`  ${b}`);
    process.exit(1);
  }
  console.log(`check-pr-workflow-identity: ok (${dir})`);
}
