/**
 * FBQ-24 R7 — the real-D1 helper must enforce foreign keys the way D1 does, so a
 * fixture cannot seed an orphan row or delete a parent that production would
 * refuse. Proof of rejection: with enforcement off, every test here fails.
 */
import { describe, expect, it } from 'vitest';
import { DatabaseSync, makeMigratedD1 } from './helpers/real-d1.js';

const suite = DatabaseSync ? describe : describe.skip;

suite('makeMigratedD1 enforces foreign keys', () => {
  it('reports the pragma on', () => {
    const { sqlite } = makeMigratedD1();
    expect(sqlite.prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
  });

  it('rejects a child row whose parent does not exist', () => {
    const { sqlite } = makeMigratedD1();
    expect(() => sqlite.prepare("INSERT INTO devices (device_id, user_id) VALUES ('d1', 'no-such-user')").run())
      .toThrow(/FOREIGN KEY/i);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM devices').get().n).toBe(0);
  });

  it('cascades a parent delete to its children (ON DELETE CASCADE)', () => {
    const { sqlite } = makeMigratedD1();
    sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES ('u1', 'u1@example.com', 'x')").run();
    sqlite.prepare("INSERT INTO devices (device_id, user_id) VALUES ('d1', 'u1')").run();
    sqlite.prepare("DELETE FROM users WHERE id = 'u1'").run();
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM devices').get().n).toBe(0);
  });
});
