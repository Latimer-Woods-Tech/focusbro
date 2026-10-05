// A D1-shaped adapter over a REAL in-memory SQLite database built from the
// repo's own migrations/ (every NNNN_*.sql, in order) — so a test exercises the
// schema production actually has, CHECK constraints and all. node:sqlite is
// present on the CI Node (24.x) and on 22.5+; `DatabaseSync` is null on older
// Node and callers skip their suite.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* older node */ }
export { DatabaseSync };

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../migrations', import.meta.url));

export function makeMigratedD1() {
  const sdb = new DatabaseSync(':memory:');
  // D1 enforces foreign keys; SQLite does not unless asked. Without this a test
  // can seed an orphan row (or delete a parent) that production would reject.
  sdb.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync(MIGRATIONS_DIR).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()) {
    sdb.exec(readFileSync(`${MIGRATIONS_DIR}/${f}`, 'utf8'));
  }
  const numbered = (sql) => /\?\d/.test(sql);
  const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v);
  return {
    sqlite: sdb,
    // D1's batch(): every statement in one implicit transaction — all or nothing.
    async batch(statements) {
      sdb.exec('BEGIN');
      try {
        const out = [];
        for (const st of statements) out.push(await st.run());
        sdb.exec('COMMIT');
        return out;
      } catch (err) {
        sdb.exec('ROLLBACK');
        throw err;
      }
    },
    prepare(sql) {
      const stmt = sdb.prepare(sql);
      let params = [];
      const args = () => (numbered(sql)
        ? [Object.fromEntries(params.map((v, i) => [String(i + 1), norm(v)]))]
        : params.map(norm));
      return {
        bind(...a) { params = a; return this; },
        async all() { return { results: stmt.all(...args()) }; },
        async first() { const r = stmt.get(...args()); return r === undefined ? null : { ...r }; },
        async run() { const r = stmt.run(...args()); return { success: true, meta: { changes: r.changes } }; },
      };
    },
  };
}

/** A Map-backed KV_CACHE stand-in. */
export function makeKV() {
  const m = new Map();
  return {
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
  };
}
