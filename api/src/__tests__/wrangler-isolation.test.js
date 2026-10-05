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

// Minimal TOML reader: tables, array tables, strings, numbers, bools, inline
// tables, (multi-line) arrays, comments. Enough for wrangler.toml.
function parseToml(src) {
  let i = 0;
  const root = {};
  let cur = root;
  const ws = () => { while (i < src.length && /[ \t\r\n]/.test(src[i])) i++; };
  const skipLine = () => { while (i < src.length && src[i] !== '\n') i++; };
  const skipWsComments = () => {
    for (;;) { ws(); if (src[i] === '#') skipLine(); else return; }
  };
  const str = () => {
    const q = src[i++]; let out = '';
    while (i < src.length && src[i] !== q) {
      if (q === '"' && src[i] === '\\') { i++; out += src[i++]; } else out += src[i++];
    }
    i++; return out;
  };
  const key = () => {
    ws();
    if (src[i] === '"' || src[i] === "'") return str();
    const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i));
    if (!m) throw new Error('toml: bad key at ' + i);
    i += m[0].length; return m[0];
  };
  const value = () => {
    skipWsComments();
    const c = src[i];
    if (c === '"' || c === "'") return str();
    if (c === '[') {
      i++; const arr = [];
      for (;;) {
        skipWsComments();
        if (src[i] === ']') { i++; return arr; }
        arr.push(value()); skipWsComments();
        if (src[i] === ',') i++;
      }
    }
    if (c === '{') {
      i++; const obj = {};
      for (;;) {
        skipWsComments();
        if (src[i] === '}') { i++; return obj; }
        const k = key(); skipWsComments();
        if (src[i] !== '=') throw new Error('toml: expected = at ' + i);
        i++; obj[k] = value(); skipWsComments();
        if (src[i] === ',') i++;
      }
    }
    const m = /^[^\s,\]}#]+/.exec(src.slice(i));
    i += m[0].length;
    if (m[0] === 'true') return true;
    if (m[0] === 'false') return false;
    return Number.isNaN(Number(m[0])) ? m[0] : Number(m[0]);
  };
  const descend = (path, isArray) => {
    let o = root;
    path.forEach((p, n) => {
      const last = n === path.length - 1;
      if (last && isArray) { (o[p] ||= []).push({}); o = o[p][o[p].length - 1]; return; }
      o = Array.isArray(o[p]) ? o[p][o[p].length - 1] : (o[p] ||= {});
    });
    return o;
  };
  while (i < src.length) {
    skipWsComments();
    if (i >= src.length) break;
    if (src[i] === '[') {
      const isArray = src[i + 1] === '[';
      i += isArray ? 2 : 1;
      const path = [];
      for (;;) { path.push(key()); ws(); if (src[i] === '.') { i++; continue; } break; }
      i += isArray ? 2 : 1;
      cur = descend(path, isArray);
    } else {
      const k = key(); ws();
      if (src[i] !== '=') throw new Error('toml: expected = at ' + i);
      i++; cur[k] = value();
    }
  }
  return root;
}

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
