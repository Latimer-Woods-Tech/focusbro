import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const runtimeSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const bootstrapSchema = readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');
const migrationBaseline = readFileSync(new URL('../../../migrations/0000_production_schema_baseline.sql', import.meta.url), 'utf8');

function tableColumns(source) {
  const tables = new Map();
  const pattern = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\)\s*(?:`|;)/g;
  let match;

  while ((match = pattern.exec(source))) {
    const columns = match[2]
      .split('\n')
      .map((line) => line.replace(/--.*$/, '').trim())
      .filter(Boolean)
      .filter((line) => !/^(?:FOREIGN|PRIMARY|UNIQUE|CHECK|CONSTRAINT)\b/i.test(line))
      .map((line) => line.match(/^["'`]?(\w+)/)?.[1])
      .filter(Boolean);
    tables.set(match[1], new Set(columns));
  }

  for (const match of source.matchAll(/ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/g)) {
    if (!tables.has(match[1])) tables.set(match[1], new Set());
    tables.get(match[1]).add(match[2]);
  }

  return tables;
}

function indexNames(source) {
  return new Set(
    [...source.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX IF NOT EXISTS\s+(\w+)/g)]
      .map((match) => match[1]),
  );
}

describe('fresh D1 bootstrap schema', () => {
  it('defines one dormant future billing contract', () => {
    for (const source of [bootstrapSchema, migrationBaseline]) {
      expect(source).toMatch(/CREATE TABLE(?: IF NOT EXISTS)? subscriptions\b/);
      expect(source).not.toMatch(/CREATE TABLE(?: IF NOT EXISTS)? stripe_subscriptions\b/);
    }
  });

  it('contains every table and column required by runtime initialization', () => {
    const runtimeTables = tableColumns(runtimeSource);
    const bootstrapTables = tableColumns(bootstrapSchema);
    const missing = [];

    for (const [table, columns] of runtimeTables) {
      if (!bootstrapTables.has(table)) {
        missing.push(`${table} (table)`);
        continue;
      }
      for (const column of columns) {
        if (!bootstrapTables.get(table).has(column)) {
          missing.push(`${table}.${column}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it('contains every index required by runtime initialization', () => {
    const runtimeIndexes = indexNames(runtimeSource);
    const bootstrapIndexes = indexNames(bootstrapSchema);
    const missing = [...runtimeIndexes].filter((index) => !bootstrapIndexes.has(index));

    expect(missing).toEqual([]);
  });
});
