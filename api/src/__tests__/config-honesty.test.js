/**
 * FocusBro — config says only what the code does.
 *
 * `config.api` declared eight "API validation" limits, including an event-type
 * whitelist, and nothing read any of them; its batch cap (500) even contradicted
 * the real one in sync.js (100). A limit that exists only in config is a gate
 * that can never fail and a reader that is lied to. This FAILS on the tree that
 * still carried the block.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

describe('config.js carries no dead validation block', () => {
  it('has no `api` block, and no key anywhere that the source never reads', () => {
    expect(config.api).toBeUndefined();
    const src = readFileSync(fileURLToPath(new URL('../config.js', import.meta.url)), 'utf8');
    expect(src).not.toContain('validEventTypes');
    expect(src).not.toContain('maxEventsPerRequest');
  });

  it('the ingest documents the absence of a whitelist where the loop is', () => {
    const sync = readFileSync(fileURLToPath(new URL('../sync.js', import.meta.url)), 'utf8');
    expect(sync).toContain('There is NO type whitelist, by design.');
    expect(sync).toContain('const MAX_EVENTS_PER_BATCH = 100;');
  });
});
