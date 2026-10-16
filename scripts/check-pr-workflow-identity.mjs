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
 *   ref). `github.ref == 'refs/heads/main'` excludes pull_request but NOT pull_request_target (whose
 *   ref is the base branch).
 * RULE 2: in a workflow that can run from an arbitrary ref (workflow_dispatch, workflow_call,
 *   workflow_run, repository_dispatch, or `push` whose `branches` is missing / not exactly [main]),
 *   every identity job needs an `if` whose WHOLE expression requires `github.ref == 'refs/heads/main'`
 *   and/or `startsWith(github.ref, 'refs/tags/...')`. A top-level `||` with any disjunct lacking a ref
 *   check does not count. Opt-out (rule 2 only): `# identity-guard: allow <reason>` directly above the
 *   job key line (a direct child of top-level `jobs:`, never inside a block scalar); prints WARN and passes.
 *   `push` is main-only only with `branches` exactly [main] and no tags / tags-ignore / branches-ignore.
 * An external reusable on a PR-reachable job with explicitly named secrets (not `inherit`) prints WARN, exit 0.
 *
 * The workflow is parsed with PyYAML (python3). If it is unavailable the guard exits 2 (fail closed).
 *
 * Usage: node scripts/check-pr-workflow-identity.mjs [workflows-dir]   (default .github/workflows)
 * Exit 1 lists `file:job` per violation; exit 2 on parser/environment error.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
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

/** rule 1: `if` provably excludes every PR event in `prEvents`. */
export function excludesPrEvents(cond, prEvents) {
  if (cond === undefined || cond === null || cond === false) return false;
  return prEvents.every((ev) => requiresAll(stripExpr(cond), (a) =>
    new RegExp(`^github\\.event_name\\s*!=\\s*'${ev}'$`).test(a) ||
    /^github\.event_name\s*==\s*'(push|workflow_dispatch|schedule)'$/.test(a) ||
    REF_TAG.test(a) ||
    (ev === 'pull_request' && REF_MAIN.test(a))));
}

// ---- job inspection -----------------------------------------------------------------------
/** true / false when `permissions` is declared, null when absent. */
function grantsIdToken(perms) {
  if (perms === undefined || perms === null) return null;
  if (typeof perms === 'string') return perms === 'write-all';
  if (typeof perms === 'object') return perms['id-token'] === 'write';
  return true; // unexpected shape: fail closed
}

const AUTH_USES = /^google-github-actions\/auth@/;
const MAX_DEPTH = 3;

/** Parse a repo-relative local file; null when missing, unparseable or outside the root (caller fails closed). */
function readLocal(root, rel) {
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  try { return parseYaml(readFileSync(abs, 'utf8')); } catch { return null; }
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
    if (AUTH_USES.test(u)) return true;
    return u.startsWith('./') && compositeUsesAuth(root, u, depth + 1);
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

/**
 * reason text of a `# identity-guard: allow <reason>` comment on the line immediately above the job's
 * key line, where the key is a direct child of top-level `jobs:` (matched by exact indentation, never
 * inside a block scalar). Else null.
 */
function optOutReason(text, job) {
  const ls = text.split('\n');
  const indentOf = (l) => l.length - l.trimStart().length;
  const jobsAt = ls.findIndex((l) => /^jobs\s*:\s*(#.*)?$/.test(l));
  if (jobsAt < 0) return null;
  const esc = job.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let childIndent = null, scalarIndent = null;
  for (let i = jobsAt + 1; i < ls.length; i++) {
    const l = ls[i];
    if (!l.trim()) continue;
    const ind = indentOf(l);
    if (scalarIndent !== null) {
      if (ind > scalarIndent) continue; // inside a | or > block scalar
      scalarIndent = null;
    }
    if (l.trim().startsWith('#')) continue;
    if (ind === 0) return null; // left the jobs mapping
    childIndent ??= ind;
    if (ind === childIndent && new RegExp(`^ {${ind}}['"]?${esc}['"]?\\s*:\\s*(#.*)?$`).test(l)) {
      const m = ls[i - 1]?.match(new RegExp(`^ {${ind}}#\\s*identity-guard:\\s*allow\\s+(\\S.*?)\\s*$`));
      return m ? m[1] : null;
    }
    if (/(^|[\s:-])[|>][+-]?\d*\s*(#.*)?$/.test(l)) scalarIndent = ind;
  }
  return null;
}

/** @returns {{violations: {job: string, rule: number}[], warnings: {job: string, reason: string}[]}} */
export function analyzeWorkflow(text, root = process.cwd()) {
  const doc = parseYaml(text);
  const result = { violations: [], warnings: [] };
  if (!doc || typeof doc !== 'object' || !doc.jobs || typeof doc.jobs !== 'object') return result;
  const triggers = triggerMap(doc);
  const events = Object.keys(triggers);
  const prEvents = PR_EVENTS.filter((e) => events.includes(e));

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
    const named = ext && job.secrets && typeof job.secrets === 'object' ? Object.keys(job.secrets) : [];
    if (named.length && prEvents.length && !excludesPrEvents(job.if, prEvents)) {
      result.warnings.push({ job: name, reason: `passes secrets ${named.join(', ')} to external reusable ${job.uses.trim()}` });
    }
    if (!isIdentityJob(job, doc.permissions, root)) continue;
    const cond = job?.if;
    if (prEvents.length && !excludesPrEvents(cond, prEvents)) {
      result.violations.push({ job: name, rule: 1 });
    }
    if (anyRef && !requiresMainOrTagRef(cond)) {
      const reason = optOutReason(text, name);
      if (reason) result.warnings.push({ job: name, reason });
      else result.violations.push({ job: name, rule: 2 });
    }
  }
  return result;
}

/** @returns {string[]} violating job names */
export function checkWorkflow(text, root) {
  return [...new Set(analyzeWorkflow(text, root).violations.map((v) => v.job))];
}

export function checkDir(dir, root = process.cwd()) {
  const violations = [], warnings = [];
  for (const f of readdirSync(dir).sort()) {
    if (!/\.ya?ml$/.test(f)) continue;
    const r = analyzeWorkflow(readFileSync(join(dir, f), 'utf8'), root);
    for (const v of r.violations) violations.push(`${f}:${v.job} (rule ${v.rule})`);
    for (const w of r.warnings) warnings.push(`${f}:${w.job} ${w.reason}`);
  }
  return { violations, warnings };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? '.github/workflows';
  let res;
  try {
    res = checkDir(dir);
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
