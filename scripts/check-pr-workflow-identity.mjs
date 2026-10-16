#!/usr/bin/env node
// Guard: no job that can run on pull_request / pull_request_target may hold a
// cloud identity. This repo is public; PR-controlled code must never run next to
// `id-token: write` or google-github-actions/auth (SA-LEAST-PRIV1, D227).
//
// Parsing shells out to python3 + PyYAML (preinstalled on GitHub ubuntu runners);
// no npm dependency. Exit 1 listing file:job for each violation.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PR_EVENTS = ['pull_request', 'pull_request_target'];
const AUTH_RE = /^google-github-actions\/auth(@|$)/i;

export function parseYaml(text) {
  const r = spawnSync(
    'python3',
    ['-I', '-c', 'import sys, json\ntry:\n    import yaml\nexcept ImportError:\n    sys.stderr.write("PyYAML missing: install python3-yaml\\n"); sys.exit(3)\nprint(json.dumps(yaml.safe_load(sys.stdin.read())))'],
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

// False only when the job `if` clearly excludes pull_request events.
export function canRunOnPr(cond) {
  if (cond === undefined || cond === null) return true;
  let c = String(cond).trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, '$1').trim();
  if (/\|\||\bor\b/.test(c)) return true; // any disjunction: assume it can run
  const clauses = c.split('&&').map((s) => s.trim());
  return !clauses.some((cl) => {
    if (/^github\.event_name\s*!=\s*['"]pull_request(_target)?['"]$/.test(cl)) return true;
    return /^github\.event_name\s*==\s*['"](push|workflow_dispatch|schedule|release|workflow_run)['"]$/.test(cl);
  });
}

const idTokenWrite = (perms) =>
  perms === 'write-all' || (perms && typeof perms === 'object' && perms['id-token'] === 'write');

export function analyze(text, file = 'workflow') {
  const doc = parseYaml(text);
  if (!doc || typeof doc !== 'object') return [];
  if (!triggers(doc).some((t) => PR_EVENTS.includes(t))) return [];
  const bad = [];
  for (const [name, job] of Object.entries(doc.jobs ?? {})) {
    if (!canRunOnPr(job.if)) continue;
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

export function checkDir(dir) {
  const bad = [];
  for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).sort()) {
    bad.push(...analyze(readFileSync(join(dir, f), 'utf8'), `${dir}/${f}`));
  }
  return bad;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows');
  let bad;
  try {
    bad = checkDir(dir);
  } catch (e) {
    console.error(`check-pr-workflow-identity: ${e.message}`);
    process.exit(2);
  }
  if (bad.length) {
    console.error('FAIL: jobs that can run on pull_request hold a cloud identity:');
    for (const b of bad) console.error(`  ${b}`);
    process.exit(1);
  }
  console.log('OK: no pull_request job has id-token: write or google-github-actions/auth');
}
