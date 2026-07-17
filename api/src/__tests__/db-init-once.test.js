import { describe, expect, it, vi } from 'vitest';

// R1 (#10 · reliability) — `initializeDatabase()` must issue its schema DDL
// exactly ONCE per isolate. The guard originally wrapped only the CREATE loop,
// so the ALTER loop + the verify SELECT re-ran on EVERY fetch and EVERY cron
// tick (~9 D1 round-trips per call with no effect after the first). These tests
// pin the run-once contract and the fact that the legacy user/session ALTERs
// (previously declared in a second array that was never iterated) now actually
// run in the single pass.
//
// `dbInitialized` is module-level state, so each test loads a FRESH module
// instance via vi.resetModules() to start from an un-initialized flag.

/** A D1-shaped double that records every SQL string prepared against it. */
function makeRecordingDb() {
  const sql = [];
  return {
    sql,
    prepare(statement) {
      sql.push(statement);
      return {
        bind() { return this; },
        async run() { return { success: true }; },
        async first() { return { count: 0 }; },
        async all() { return { results: [] }; },
      };
    },
  };
}

async function freshInit() {
  vi.resetModules();
  const mod = await import('../index.js');
  return mod.initializeDatabase;
}

describe('initializeDatabase — run-once guard (R1)', () => {
  it('issues its schema DDL on the first call, then nothing on later calls', async () => {
    const initializeDatabase = await freshInit();
    const db = makeRecordingDb();
    const env = { DB: db };

    await initializeDatabase(env);
    const firstPass = db.sql.length;

    // The first pass must actually do the work: CREATE TABLEs, ALTERs, and the
    // verify SELECT all issued.
    expect(firstPass).toBeGreaterThan(0);
    expect(db.sql.some((s) => /CREATE TABLE IF NOT EXISTS users/.test(s))).toBe(true);
    expect(db.sql.some((s) => /SELECT COUNT\(\*\)/.test(s))).toBe(true);

    // Warm calls (a normal request or cron tick) must add ZERO further statements.
    await initializeDatabase(env);
    await initializeDatabase(env);
    expect(db.sql.length).toBe(firstPass);
  });

  it('runs the legacy user/session ALTERs that used to be dead code', async () => {
    const initializeDatabase = await freshInit();
    const db = makeRecordingDb();
    await initializeDatabase({ DB: db });

    // These seven ALTERs previously lived in a declared-but-never-iterated array,
    // so on a long-lived production table the columns were never added. They must
    // now appear in the single DDL pass.
    const wanted = [
      'ALTER TABLE users ADD COLUMN avatar_url',
      "ALTER TABLE users ADD COLUMN subscription_tier TEXT DEFAULT 'free'",
      'ALTER TABLE users ADD COLUMN last_login',
      'ALTER TABLE sessions ADD COLUMN is_active',
      'ALTER TABLE sessions ADD COLUMN device_id',
      'ALTER TABLE sessions ADD COLUMN device_name',
      'ALTER TABLE sessions ADD COLUMN last_activity',
    ];
    for (const frag of wanted) {
      expect(db.sql.some((s) => s.includes(frag))).toBe(true);
    }
  });

  it('never throws when a DDL statement rejects (per-statement failures are swallowed)', async () => {
    const initializeDatabase = await freshInit();
    const failingDb = {
      prepare() {
        return {
          bind() { return this; },
          async run() { throw new Error('duplicate column name: avatar_url'); },
          async first() { throw new Error('no such table: users'); },
        };
      },
    };
    await expect(initializeDatabase({ DB: failingDb })).resolves.toBeUndefined();
  });
});
