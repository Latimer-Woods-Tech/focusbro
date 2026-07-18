#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TOOLS_ROOT = resolve(SCRIPT_DIR, '..', '..');
const ROOT = process.env.DOCS_TARGET_ROOT ? resolve(process.env.DOCS_TARGET_ROOT) : TOOLS_ROOT;
const CATALOG_DIR = join(ROOT, 'docs', '_catalog');
const PROFILE = process.env.DOCS_REPO_PROFILE ?? 'factory';

const nodeScript = (relativePath) => [process.execPath, join(TOOLS_ROOT, relativePath)];

const CORE_CHECKS = [
  {
    id: 'docs.catalog',
    command: nodeScript('scripts/docs/catalog.mjs'),
    blocking: true,
  },
  {
    id: 'docs.diagrams',
    command: nodeScript('scripts/docs/diagrams.mjs'),
    blocking: true,
  },
  {
    id: 'docs.catalog-refresh',
    command: nodeScript('scripts/docs/catalog.mjs'),
    blocking: true,
  },
  {
    id: 'docs.self-check',
    command: nodeScript('scripts/docs/self-check.mjs'),
    blocking: true,
  },
  {
    id: 'docs.metadata',
    command: nodeScript('scripts/docs/validate-metadata.mjs'),
    blocking: true,
  },
  {
    id: 'docs.drift',
    command: nodeScript('scripts/docs/drift.mjs'),
    blocking: true,
  },
  {
    id: 'docs.quality',
    command: [...nodeScript('scripts/validate-docs-quality.mjs'), '--max-errors', '0', '--json'],
    blocking: false,
  },
];

const FACTORY_CHECKS = [
  {
    id: 'service-registry',
    command: ['npm', 'run', 'validate:service-registry'],
    blocking: true,
  },
  {
    id: 'docs.registry-consistency',
    command: nodeScript('scripts/check-docs-registry-consistency.mjs'),
    blocking: false,
  },
  {
    id: 'docs.freshness',
    command: ['npm', 'run', 'audit:docs-freshness'],
    blocking: false,
  },
];

function checksForProfile(profile) {
  if (profile === 'factory') return [...CORE_CHECKS.slice(0, 6), ...FACTORY_CHECKS.slice(0, 2), CORE_CHECKS[6], FACTORY_CHECKS[2]];
  if (profile === 'docs-lite') return CORE_CHECKS.filter((check) => check.id !== 'docs.diagrams' && check.id !== 'docs.catalog-refresh');
  return CORE_CHECKS;
}

function runCheck(check) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(check.command[0], check.command.slice(1), {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32' && check.command[0] !== process.execPath,
    maxBuffer: 1024 * 1024 * 10,
    env: {
      ...process.env,
      DOCS_TARGET_ROOT: ROOT,
      DOCS_REPO_PROFILE: PROFILE,
    },
  });
  const finishedAt = new Date().toISOString();
  const exitCode = typeof result.status === 'number' ? result.status : 1;
  const severity = exitCode === 0 ? 'ok' : check.blocking ? 'error' : 'warning';

  return {
    id: check.id,
    command: check.command.join(' '),
    blocking: check.blocking,
    exit_code: exitCode,
    severity,
    started_at: startedAt,
    finished_at: finishedAt,
    stdout_tail: tail(result.stdout),
    stderr_tail: tail(result.stderr),
    error: result.error ? String(result.error.message ?? result.error) : null,
  };
}

function tail(text, maxLines = 80) {
  if (!text) return '';
  return text.trim().split(/\r?\n/).slice(-maxLines).join('\n');
}

function writeSummary(report) {
  const drift = readJsonIfExists(join(CATALOG_DIR, 'drift.json'));
  const links = readJsonIfExists(join(CATALOG_DIR, 'link-report.json'));
  const freshness = readJsonIfExists(join(CATALOG_DIR, 'freshness.json'));
  let md = '# Docs Health\n\n';
  md += `**Generated:** ${report.generated_at}\n`;
  md += `**Mode:** ${report.mode}\n`;
  md += `**Result:** ${report.ok ? 'PASS' : 'FAIL'}\n\n`;
  md += '| Check | Blocking | Exit | Severity |\n|---|---:|---:|---|\n';
  for (const check of report.checks) {
    md += `| ${check.id} | ${check.blocking ? 'yes' : 'no'} | ${check.exit_code} | ${check.severity} |\n`;
  }
  md += '\n';

  if (drift) {
    md += '## Drift\n\n';
    md += `**Errors:** ${drift.counts?.errors ?? 0}  \n`;
    md += `**Warnings:** ${drift.counts?.warnings ?? 0}\n\n`;
    md += '### Top Owners\n\n';
    md += '| Owner | Issues |\n|---|---:|\n';
    for (const [owner, count] of topCounts(drift.issues ?? [], 'owner', 10)) {
      md += `| ${owner} | ${count} |\n`;
    }
    md += '\n### Top Issue Types\n\n';
    md += '| Issue | Count |\n|---|---:|\n';
    for (const [id, count] of topCounts(drift.issues ?? [], 'id', 10)) {
      md += `| ${id} | ${count} |\n`;
    }
    md += '\n';
  }

  if (links) {
    md += '## Broken Links\n\n';
    md += `**Broken links:** ${links.counts?.broken ?? 0}  \n`;
    md += `**Canonical broken links:** ${links.counts?.canonical ?? 0}  \n`;
    md += `**Active broken links:** ${links.counts?.active ?? 0}\n\n`;
    md += '### Broken Links By Owner\n\n';
    md += '| Owner | Broken Links |\n|---|---:|\n';
    for (const [owner, count] of Object.entries(links.by_owner ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10)) {
      md += `| ${owner} | ${count} |\n`;
    }
    md += '\n';
  }

  if (freshness) {
    md += '## Freshness\n\n';
    md += `**Fresh:** ${freshness.counts?.fresh ?? 0}  \n`;
    md += `**Missing Last Updated:** ${freshness.counts?.missing ?? 0}  \n`;
    md += `**Yellow:** ${freshness.counts?.yellow ?? 0}  \n`;
    md += `**Red:** ${freshness.counts?.red ?? 0}  \n`;
    md += `**Critical:** ${freshness.counts?.critical ?? 0}\n\n`;
  }

  const warningChecks = report.checks.filter((check) => check.severity === 'warning');
  if (warningChecks.length > 0) {
    md += '## Non-Blocking Warnings\n\n';
    for (const check of warningChecks) {
      md += `### ${check.id}\n\n`;
      md += `Command: \`${check.command}\`\n\n`;
      const output = check.stderr_tail || check.stdout_tail || '(no output)';
      md += '```text\n';
      md += `${output.split(/\r?\n/).slice(-20).join('\n')}\n`;
      md += '```\n\n';
    }
  }

  md += 'Non-blocking warnings are recorded so the corpus can be cleaned up without making the first rollout unusable.\n';
  writeFileSync(join(CATALOG_DIR, 'docs-health-summary.md'), md);
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function topCounts(items, key, limit) {
  const counts = new Map();
  for (const item of items) {
    const value = item[key] ?? 'unknown';
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, limit);
}

function checkLinkRatchet() {
  const baselinePath = join(ROOT, 'docs', '_catalog', 'link-baseline.json');
  const reportPath = join(ROOT, 'docs', '_catalog', 'link-report.json');
  if (!existsSync(baselinePath) || !existsSync(reportPath)) return false;

  const baseline = readJsonIfExists(baselinePath);
  const report = readJsonIfExists(reportPath);
  if (!baseline || !report) return false;

  const baselineCount = baseline.broken ?? Infinity;
  const currentCount = report.counts?.broken ?? 0;
  const isNewlyIntroduced = currentCount > baselineCount;

  if (isNewlyIntroduced) {
    const delta = currentCount - baselineCount;
    console.error(`[docs:link-ratchet] FAIL: ${currentCount} broken links exceeds baseline of ${baselineCount} (+${delta} new). Fix the new broken links or update docs/_catalog/link-baseline.json if they are pre-existing.`);
    return true;
  }

  if (currentCount < baselineCount) {
    console.log(`[docs:link-ratchet] improved: ${currentCount} broken links (baseline: ${baselineCount}, -${baselineCount - currentCount}). Consider lowering link-baseline.json to lock in the improvement.`);
  } else {
    console.log(`[docs:link-ratchet] OK: ${currentCount} broken links (at baseline)`);
  }
  return false;
}

function main() {
  mkdirSync(CATALOG_DIR, { recursive: true });

  const mode = process.env.DOCS_HEALTH_MODE ?? 'observe-plus-core';
  const checkDefinitions = checksForProfile(PROFILE);
  const checks = checkDefinitions.map((check) => {
    console.log(`[docs:health] running ${check.id}: ${check.command.join(' ')}`);
    const result = runCheck(check);
    console.log(`[docs:health] ${check.id}: ${result.severity} (exit ${result.exit_code})`);
    return result;
  });

  writeLinkReport();
  const linkRatchetFailed = checkLinkRatchet();

  const blockingFailures = checks.filter((check) => check.blocking && check.exit_code !== 0);
  if (linkRatchetFailed) blockingFailures.push({ id: 'docs.link-ratchet', blocking: true, exit_code: 1, severity: 'error' });
  const report = {
    version: 1,
    generated_by: 'scripts/docs/health.mjs',
    generated_at: new Date().toISOString(),
    mode,
    profile: PROFILE,
    target_root: ROOT,
    tools_root: TOOLS_ROOT,
    ok: blockingFailures.length === 0,
    blocking_failures: blockingFailures.map((check) => check.id),
    counts: {
      checks: checks.length,
      ok: checks.filter((check) => check.exit_code === 0).length,
      warnings: checks.filter((check) => check.severity === 'warning').length,
      errors: checks.filter((check) => check.severity === 'error').length,
    },
    checks,
  };

  writeFileSync(join(CATALOG_DIR, 'docs-health.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeSummary(report);

  if (report.ok) {
    console.log(`[docs:health] PASS (${report.counts.warnings} non-blocking warning check(s))`);
  } else {
    console.error(`[docs:health] FAIL: ${blockingFailures.map((check) => check.id).join(', ')}`);
  }

  process.exit(report.ok ? 0 : 1);
}

function writeLinkReport() {
  const qualityPath = join(ROOT, 'docs-quality-report.json');
  const graphPath = join(CATALOG_DIR, 'docs-graph.json');
  const quality = readJsonIfExists(qualityPath);
  const graph = readJsonIfExists(graphPath);
  if (!quality || !graph) return;

  const docs = new Map((graph.docs ?? []).map((doc) => [doc.path.replace(/\\/g, '/'), doc]));
  const broken = (quality.broken ?? []).map((entry) => {
    const path = entry.file.replace(/\\/g, '/');
    const doc = docs.get(path);
    return {
      ...entry,
      file: path,
      owner: doc?.owner ?? 'unknown',
      status: doc?.status ?? 'unknown',
      fidelity: doc?.fidelity ?? 'unknown',
    };
  });

  const byOwner = {};
  const byStatus = {};
  for (const entry of broken) {
    byOwner[entry.owner] = (byOwner[entry.owner] ?? 0) + 1;
    byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
  }

  const report = {
    version: 1,
    generated_by: 'scripts/docs/health.mjs#writeLinkReport',
    generated_at: graph.generated_at,
    ok: broken.length === 0,
    counts: {
      broken: broken.length,
      canonical: broken.filter((entry) => entry.status === 'canonical').length,
      active: broken.filter((entry) => entry.status === 'active').length,
      archive: broken.filter((entry) => entry.status === 'archive').length,
      generated: broken.filter((entry) => entry.status === 'generated').length,
    },
    by_owner: byOwner,
    by_status: byStatus,
    broken,
  };

  writeFileSync(join(CATALOG_DIR, 'link-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(CATALOG_DIR, 'link-report.md'), renderLinkReport(report));
  writeDebtIndex(report, readJsonIfExists(join(CATALOG_DIR, 'drift.json')));
}

function renderLinkReport(report) {
  let md = '# Documentation Broken Link Report\n\n';
  md += `**Generated:** ${report.generated_at}\n`;
  md += `**Broken links:** ${report.counts.broken}\n`;
  md += `**Canonical:** ${report.counts.canonical}\n`;
  md += `**Active:** ${report.counts.active}\n`;
  md += `**Archive:** ${report.counts.archive}\n\n`;

  md += '## By Owner\n\n';
  md += '| Owner | Broken Links |\n|---|---:|\n';
  for (const [owner, count] of Object.entries(report.by_owner).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    md += `| ${owner} | ${count} |\n`;
  }

  md += '\n## First 150 Broken Links\n\n';
  md += '| Status | Owner | File | Line | Target | Reason |\n|---|---|---|---:|---|---|\n';
  for (const entry of report.broken.slice(0, 150)) {
    md += `| ${entry.status} | ${entry.owner} | ${entry.file} | ${entry.line} | ${String(entry.target).replaceAll('|', '\\|')} | ${entry.reason} |\n`;
  }
  return md;
}

function writeDebtIndex(linkReport, driftReport) {
  let md = '# Documentation Debt Index\n\n';
  md += `**Generated:** ${linkReport.generated_at}\n\n`;
  md += 'This generated index combines drift and broken-link debt into an owner-routed cleanup queue. Freshness debt is emitted separately as `docs/_catalog/freshness.md` during `npm run audit:docs-freshness`.\n\n';

  const owners = new Set([
    ...Object.keys(linkReport.by_owner ?? {}),
    ...((driftReport?.issues ?? []).map((issue) => issue.owner)),
  ]);

  md += '| Owner | Drift Warnings | Broken Links |\n|---|---:|---:|\n';
  for (const owner of [...owners].sort()) {
    const driftCount = (driftReport?.issues ?? []).filter((issue) => issue.owner === owner).length;
    const linkCount = linkReport.by_owner?.[owner] ?? 0;
    md += `| ${owner} | ${driftCount} | ${linkCount} |\n`;
  }

  md += '\n## Highest Link Debt Docs\n\n';
  md += '| Broken Links | Doc |\n|---:|---|\n';
  const linkDocCounts = new Map();
  for (const entry of linkReport.broken ?? []) {
    linkDocCounts.set(entry.file, (linkDocCounts.get(entry.file) ?? 0) + 1);
  }
  for (const [doc, count] of [...linkDocCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 25)) {
    md += `| ${count} | ${doc} |\n`;
  }

  md += '\n## Highest Drift Docs\n\n';
  md += '| Drift Warnings | Doc |\n|---:|---|\n';
  const driftDocCounts = new Map();
  for (const entry of driftReport?.issues ?? []) {
    driftDocCounts.set(entry.doc, (driftDocCounts.get(entry.doc) ?? 0) + 1);
  }
  for (const [doc, count] of [...driftDocCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 25)) {
    md += `| ${count} | ${doc} |\n`;
  }

  writeFileSync(join(CATALOG_DIR, 'debt-index.md'), md);
}

main();
