/**
 * FBQ-16 — preview / dev / default scopes must never share a PRODUCTION
 * resource id (D1 database_id, KV id, preview_id, preview_database_id), and
 * preview URLs / workers.dev must be off (a preview of the production worker
 * runs with the production bindings by construction).
 *
 * Reads the real wrangler.toml with a small TOML reader (no dependency). The
 * checker is exercised against synthetic bad configs as proof-of-rejection.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseToml } from './helpers/toml.js';

const idsOf = (scope) => {
  const out = [];
  for (const d of scope.d1_databases ?? []) {
    out.push(['d1 database_id', d.database_id], ['d1 preview_database_id', d.preview_database_id]);
  }
  for (const k of scope.kv_namespaces ?? []) {
    out.push(['kv id', k.id], ['kv preview_id', k.preview_id]);
  }
  return out.filter(([, v]) => typeof v === 'string' && v.length > 0);
};

/** Returns a list of human-readable violations (empty = isolated). */
function findIsolationViolations(cfg) {
  const prod = cfg.env?.production ?? {};
  const prodIds = new Set(
    [...(prod.d1_databases ?? []).map((d) => d.database_id), ...(prod.kv_namespaces ?? []).map((k) => k.id)]
      .filter(Boolean)
  );
  const bad = [];
  const scopes = { '(default/top-level)': cfg };
  for (const [name, env] of Object.entries(cfg.env ?? {})) if (name !== 'production') scopes[`env.${name}`] = env;
  for (const [name, scope] of Object.entries(scopes)) {
    for (const [what, v] of idsOf(scope)) {
      if (prodIds.has(v)) bad.push(`${name}: ${what} is a production id`);
    }
  }
  // Inside production itself, preview_* may not point at production either.
  for (const [what, v] of idsOf(prod)) {
    if (what.includes('preview') && prodIds.has(v)) bad.push(`env.production: ${what} is a production id`);
  }
  const eff = (k) => prod[k] ?? cfg[k];
  if (eff('preview_urls') !== false) bad.push('preview_urls is not disabled (previews run with prod bindings)');
  if (eff('workers_dev') !== false) bad.push('workers_dev is not disabled');
  return bad;
}

const cfg = parseToml(readFileSync(fileURLToPath(new URL('../../../wrangler.toml', import.meta.url)), 'utf8'));

describe('wrangler.toml isolation (FBQ-16)', () => {
  it('production still binds the production D1 and KV', () => {
    expect(cfg.env.production.d1_databases[0].database_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(cfg.env.production.kv_namespaces[0].id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('no non-production scope or preview binding shares a production resource id', () => {
    expect(findIsolationViolations(cfg)).toEqual([]);
  });

  describe('proof-of-rejection', () => {
    const base = () => parseToml(`
preview_urls = false
workers_dev = false
[env.production]
d1_databases = [{ binding = "DB", database_id = "prod-d1" }]
kv_namespaces = [{ binding = "K", id = "prodkv" }]
`);
    it('accepts an isolated config', () => {
      expect(findIsolationViolations(base())).toEqual([]);
    });
    it('rejects a default-scope D1 sharing the prod id', () => {
      const c = base(); c.d1_databases = [{ binding: 'DB', database_id: 'prod-d1' }];
      expect(findIsolationViolations(c)).toHaveLength(1);
    });
    it('rejects a KV preview_id equal to the prod id (the FBQ-16 defect)', () => {
      const c = base(); c.kv_namespaces = [{ binding: 'K', id: 'dev', preview_id: 'prodkv' }];
      expect(findIsolationViolations(c)[0]).toMatch(/preview_id/);
    });
    it('rejects a staging env sharing a prod id', () => {
      const c = base(); c.env.staging = { kv_namespaces: [{ binding: 'K', id: 'prodkv' }] };
      expect(findIsolationViolations(c)[0]).toMatch(/env\.staging/);
    });
    it('rejects preview_urls / workers_dev enabled', () => {
      const c = base(); c.preview_urls = true; c.workers_dev = true;
      expect(findIsolationViolations(c)).toHaveLength(2);
    });
  });
});
