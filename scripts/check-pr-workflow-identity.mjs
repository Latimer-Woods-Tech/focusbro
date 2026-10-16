#!/usr/bin/env node
// Guard: no job that can run on pull_request / pull_request_target may hold a
// cloud identity. This repo is public; PR-controlled code must never run next to
// `id-token: write` or google-github-actions/auth (SA-LEAST-PRIV1, D227).
//
// Parsing shells out to python3 + PyYAML (an explicit dependency: no npm package,
// but PyYAML must be importable; missing PyYAML exits 2, fail closed).
// Exit 1 listing file:job for each violation.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PR_EVENTS = ['pull_request', 'pull_request_target'];
const AUTH_RE = /^google-github-actions\/auth(@|$)/i;

export function parseYaml(text) {
  const r = spawnSync(
    'python3',
    ['-I', '-c', 'import sys, json\ntry:\n    import yaml\nexcept ImportError:\n    sys.stderr.write("PyYAML missing: pip install pyyaml==6.0.2\\n"); sys.exit(3)\nprint(json.dumps(yaml.safe_load(sys.stdin.read())))'],
    { input: text, encoding: 'utf8' },
  );
  if (r.error) throw new Error(`python3 unavailable: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`YAML parse failed: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout);
}

function triggers(doc) {
  const on = doc.on ?? doc.true ?? doc['true'];
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on;
  return on && typeof on === 'object' ? Object.keys(on) : [];
}

// A PR-family event is excluded only by a clause that names it, or by one that
// positively requires a non-PR event. A ref check (github.ref == main) excludes
// nothing: pull_request_target runs on the base ref.
function clauseExcludes(cl, ev) {
  const neq = cl.match(/^github\.event_name\s*!=\s*['"](\w+)['"]$/);
  if (neq) return neq[1] === ev;
  return /^github\.event_name\s*==\s*['"](push|workflow_dispatch|schedule|release|workflow_run)['"]$/.test(cl);
}

// False only when the job `if` excludes EVERY PR-family event in `events`.
export function canRunOnPr(cond, events = PR_EVENTS) {
  if (cond === undefined || cond === null) return true;
  let c = String(cond).trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, '$1').trim();
  if (splitTop(c, '||').length > 1 || /\bor\b/.test(c)) return true; // top-level disjunction: assume it can run
  const clauses = splitTop(c, '&&');
  return !events.every((ev) => clauses.some((cl) => clauseExcludes(cl, ev)));
}

const idTokenWrite = (perms) =>
  perms === 'write-all' || (perms && typeof perms === 'object' && perms['id-token'] === 'write');

export function analyze(text, file = 'workflow') {
  const doc = parseYaml(text);
  if (!doc || typeof doc !== 'object') return [];
  const prEvents = triggers(doc).filter((t) => PR_EVENTS.includes(t));
  if (!prEvents.length) return [];
  const bad = [];
  for (const [name, job] of Object.entries(doc.jobs ?? {})) {
    if (!canRunOnPr(job.if, prEvents)) continue;
    const perms = job.permissions !== undefined ? job.permissions : doc.permissions;
    const reasons = [];
    if (idTokenWrite(perms)) reasons.push('effective id-token: write');
    if ((job.steps ?? []).some((s) => typeof s.uses === 'string' && AUTH_RE.test(s.uses))) {
      reasons.push('uses google-github-actions/auth');
    }
    if (reasons.length) bad.push(`${file}:${name} (${reasons.join('; ')})`);
  }
  return bad;
}

// RULE 2: a workflow reachable by dispatch (or a push from a non-main ref)
// lets the caller pick any ref, so identity jobs must be gated to trusted refs.
const DISPATCH_EVENTS = ['workflow_dispatch', 'workflow_call', 'workflow_run', 'repository_dispatch'];

function reachableFromAnyRef(doc) {
  const ts = triggers(doc);
  if (ts.some((t) => DISPATCH_EVENTS.includes(t))) return true;
  if (!ts.includes('push')) return false;
  const on = doc.on ?? doc.true;
  const br = on && typeof on === 'object' && !Array.isArray(on) ? on.push?.branches : undefined;
  return !(Array.isArray(br) && br.length === 1 && br[0] === 'main');
}

// Split on a top-level operator, ignoring parentheses and quoted strings.
function splitTop(e, op) {
  const parts = [];
  let depth = 0, q = null, last = 0;
  for (let i = 0; i < e.length; i++) {
    const ch = e[i];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"') q = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && e.startsWith(op, i)) { parts.push(e.slice(last, i)); last = i + op.length; i += op.length - 1; }
  }
  parts.push(e.slice(last));
  return parts.map((x) => x.trim());
}

const REF_ATOM = /^(github\.ref\s*==\s*'refs\/heads\/main'|startsWith\(\s*github\.ref\s*,\s*'refs\/tags\/[^']+'\s*\))$/;

// True only when every path through the expression requires a trusted ref.
export function requiresTrustedRef(expr) {
  let e = String(expr ?? '').trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, '$1').trim();
  if (!e) return false;
  const ors = splitTop(e, '||');
  if (ors.length > 1) return ors.every(requiresTrustedRef);
  const ands = splitTop(e, '&&');
  if (ands.length > 1) return ands.some(requiresTrustedRef);
  if (/^\(.*\)$/.test(e) && splitTop(e.slice(1, -1), '||').length >= 1 && balanced(e)) return requiresTrustedRef(e.slice(1, -1));
  return REF_ATOM.test(e);
}

// Outer parens wrap the whole expression (not "(a) && (b)").
function balanced(e) {
  let d = 0;
  for (let i = 0; i < e.length; i++) {
    if (e[i] === '(') d++;
    else if (e[i] === ')' && --d === 0 && i < e.length - 1) return false;
  }
  return true;
}

const OPT_OUT = /^\s*#\s*identity-guard:\s*allow\s+(\S.*?)\s*$/;

export function analyzeRef(text, file = 'workflow') {
  const warn = [];
  const bad = [];
  const doc = parseYaml(text);
  if (!doc || typeof doc !== 'object' || !reachableFromAnyRef(doc)) return { bad, warn };
  const lines = text.split('\n');
  for (const [name, job] of Object.entries(doc.jobs ?? {})) {
    const perms = job.permissions !== undefined ? job.permissions : doc.permissions;
    const reasons = [];
    if (idTokenWrite(perms)) reasons.push('effective id-token: write');
    if ((job.steps ?? []).some((s) => typeof s.uses === 'string' && AUTH_RE.test(s.uses))) {
      reasons.push('uses google-github-actions/auth');
    }
    if (!reasons.length || requiresTrustedRef(job.if)) continue;
    const idx = lines.findIndex((l) => new RegExp(`^\\s+['"]?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*:\\s*$`).test(l));
    const m = idx > 0 ? lines[idx - 1].match(OPT_OUT) : null;
    if (m) warn.push(`WARN ${file}:${name} ${m[1]}`);
    else bad.push(`${file}:${name} (${reasons.join('; ')}) reachable from any ref without a main/release-tag if`);
  }
  return { bad, warn };
}

export function checkDirFull(dir) {
  const bad = [];
  const warn = [];
  for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).sort()) {
    const text = readFileSync(join(dir, f), 'utf8');
    bad.push(...analyze(text, `${dir}/${f}`));
    const r = analyzeRef(text, `${dir}/${f}`);
    bad.push(...r.bad);
    warn.push(...r.warn);
  }
  return { bad, warn };
}

export function checkDir(dir) {
  return checkDirFull(dir).bad;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows');
  let bad, warn;
  try {
    ({ bad, warn } = checkDirFull(dir));
  } catch (e) {
    console.error(`check-pr-workflow-identity: ${e.message}`);
    process.exit(2);
  }
  for (const w of warn) console.log(w);
  if (bad.length) {
    console.error('FAIL: identity jobs are reachable from pull_request or from any ref:');
    for (const b of bad) console.error(`  ${b}`);
    process.exit(1);
  }
  console.log('OK: identity jobs are off pull_request and gated to main / release tags');
}
