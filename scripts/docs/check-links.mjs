#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CATALOG = resolve(ROOT, 'docs/CATALOG.md');

function catalogDocuments(markdown) {
  const activeEnd = markdown.indexOf('## Generated Docs');
  const governed = activeEnd >= 0 ? markdown.slice(0, activeEnd) : markdown;
  const paths = new Set();
  for (const match of governed.matchAll(/\[[^\]]+\]\(([^)]+\.md)\)/g)) {
    const target = match[1];
    paths.add(resolve(ROOT, 'docs', target));
  }
  return paths;
}

function localTargets(markdown) {
  const targets = [];
  for (const match of markdown.matchAll(/(?<!!)\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1].trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    if (!target || /^(?:https?:|mailto:|tel:|#)/i.test(target)) continue;
    target = target.split('#')[0].split('?')[0];
    if (!target) continue;
    try {
      targets.push(decodeURIComponent(target));
    } catch {
      targets.push(target);
    }
  }
  return targets;
}

function displayPath(path) {
  return path.startsWith(ROOT + '/') ? path.slice(ROOT.length + 1) : path;
}

function main() {
  if (!existsSync(CATALOG)) {
    console.error('[docs:links] missing docs/CATALOG.md');
    process.exit(1);
  }

  const documents = catalogDocuments(readFileSync(CATALOG, 'utf8'));
  documents.add(resolve(ROOT, 'docs/BREAKOUT_PLAN.md'));
  documents.add(resolve(ROOT, 'README.md'));
  documents.add(resolve(ROOT, 'CLAUDE.md'));

  const failures = [];
  for (const document of [...documents].sort()) {
    if (!existsSync(document) || !statSync(document).isFile()) {
      failures.push(`${displayPath(document)}: governed document is missing`);
      continue;
    }
    const markdown = readFileSync(document, 'utf8');
    for (const target of localTargets(markdown)) {
      const destination = resolve(dirname(document), target);
      if (!existsSync(destination)) {
        failures.push(`${displayPath(document)}: broken link ${target}`);
      }
    }
  }

  if (failures.length) {
    console.error(`[docs:links] FAIL (${failures.length})`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(`[docs:links] PASS (${documents.size} governed documents)`);
}

main();
