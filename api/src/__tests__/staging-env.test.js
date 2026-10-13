/**
 * Site Quality Battery R-06 (TB4) — wrangler [env.staging] is a real, isolated
 * staging environment at staging.focusbro.net.
 *
 * What "isolated" means here, each a rule below:
 *  - its own worker (`focusbro-staging`, PLATFORM_STANDARDS §15.1 `{name}-staging`);
 *  - its own D1 and KV — never a production id, never the all-zero placeholder
 *    of the default scope (a remote run against a placeholder fails, it does not
 *    stage anything);
 *  - every binding production declares is declared again (bindings are NOT
 *    inherited by a wrangler env; a missing DB/KV would 500 every route);
 *  - a ZONE ROUTE `staging.focusbro.net/*`, not a Custom Domain: production owns
 *    the wildcard route `*.focusbro.net/*`, and routes run BEFORE a Custom
 *    Domain's worker, so a staging Custom Domain would be served by the
 *    production worker with production data. The more specific route wins over
 *    the wildcard;
 *  - ENV = "staging" (the worker's noindex switch, staging-noindex.test.js) and
 *    the staging origin;
 *  - no workers.dev / preview URL, and not the live Stripe price.
 *
 * The one resource staging may share is the AUDIO R2 bucket: read-only public
 * recordings (api/src/audio.js only head()s and get()s), not user data.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseToml } from './helpers/toml.js';

const STAGING_HOST = 'staging.focusbro.net';
const SHARED_READ_ONLY_R2 = new Set(['AUDIO']);
const isPlaceholder = (id) => typeof id === 'string' && /^[0-]+$/.test(id);

const bindingsOf = (scope = {}) => ({
  d1: new Map((scope.d1_databases ?? []).map((d) => [d.binding, d])),
  kv: new Map((scope.kv_namespaces ?? []).map((k) => [k.binding, k])),
  r2: new Map((scope.r2_buckets ?? []).map((b) => [b.binding, b])),
});

/** Every resource id a scope binds (D1 ids, KV ids, incl. preview ids). */
const resourceIds = (scope = {}) => [
  ...(scope.d1_databases ?? []).flatMap((d) => [d.database_id, d.preview_database_id]),
  ...(scope.kv_namespaces ?? []).flatMap((k) => [k.id, k.preview_id]),
].filter((v) => typeof v === 'string' && v.length > 0);

/** Returns human-readable violations (empty = staging is real and isolated). */
function findStagingViolations(cfg) {
  const prod = cfg.env?.production ?? {};
  const stg = cfg.env?.staging;
  if (!stg) return ['env.staging is missing'];
  const bad = [];

  if (stg.name !== 'focusbro-staging') bad.push(`env.staging name is ${JSON.stringify(stg.name)}, expected "focusbro-staging"`);

  const vars = stg.vars ?? {};
  if (vars.ENV !== 'staging') bad.push('env.staging vars.ENV must be "staging" (the noindex switch)');
  if (vars.API_ORIGIN !== `https://${STAGING_HOST}`) bad.push(`env.staging vars.API_ORIGIN must be https://${STAGING_HOST}`);
  const livePrice = prod.vars?.PRO_PRICE_ID;
  if (livePrice && Object.values(vars).includes(livePrice)) bad.push('env.staging carries the production Stripe price id');

  // Routing: the specific zone route, never a Custom Domain, never a prod host.
  const routes = stg.routes ?? [];
  const want = routes.find((r) => r.pattern === `${STAGING_HOST}/*` && r.zone_name === 'focusbro.net');
  if (!want) bad.push(`env.staging has no zone route { pattern = "${STAGING_HOST}/*", zone_name = "focusbro.net" }`);
  for (const r of routes) {
    if (r.custom_domain) bad.push(`env.staging route ${r.pattern} is a Custom Domain — the production wildcard route *.focusbro.net/* would run first`);
    if (!String(r.pattern).startsWith(STAGING_HOST)) bad.push(`env.staging route ${r.pattern} is not a staging host`);
  }
  const eff = (k) => stg[k] ?? cfg[k];
  if (eff('workers_dev') !== false) bad.push('env.staging workers_dev is not disabled');
  if (eff('preview_urls') !== false) bad.push('env.staging preview_urls is not disabled');

  // Bindings: every production binding re-declared; D1/KV ids real and not prod.
  const p = bindingsOf(prod);
  const s = bindingsOf(stg);
  for (const kind of ['d1', 'kv', 'r2']) {
    for (const name of p[kind].keys()) if (!s[kind].has(name)) bad.push(`env.staging is missing the ${kind} binding ${name}`);
  }
  const prodIds = new Set(resourceIds(prod));
  for (const d of s.d1.values()) {
    if (!d.database_id || isPlaceholder(d.database_id)) bad.push(`env.staging d1 ${d.binding} has no real database_id`);
    if (prodIds.has(d.database_id) || prodIds.has(d.preview_database_id)) bad.push(`env.staging d1 ${d.binding} uses a production id`);
    const prodDb = p.d1.get(d.binding);
    if (prodDb && d.database_name === prodDb.database_name) bad.push(`env.staging d1 ${d.binding} has the production database_name (migrations would target it by name)`);
  }
  for (const k of s.kv.values()) {
    if (!k.id || isPlaceholder(k.id)) bad.push(`env.staging kv ${k.binding} has no real id`);
    if (prodIds.has(k.id) || prodIds.has(k.preview_id)) bad.push(`env.staging kv ${k.binding} uses a production id`);
  }
  for (const b of s.r2.values()) {
    const prodBucket = p.r2.get(b.binding);
    if (prodBucket && prodBucket.bucket_name === b.bucket_name && !SHARED_READ_ONLY_R2.has(b.binding)) {
      bad.push(`env.staging r2 ${b.binding} shares the production bucket`);
    }
  }
  return bad;
}

const cfg = parseToml(readFileSync(fileURLToPath(new URL('../../../wrangler.toml', import.meta.url)), 'utf8'));

describe('wrangler.toml [env.staging] (Site Quality Battery R-06)', () => {
  it('is a real, isolated staging environment', () => {
    expect(findStagingViolations(cfg)).toEqual([]);
  });

  it('binds D1 and KV ids that appear nowhere in production', () => {
    const prodIds = new Set(resourceIds(cfg.env.production));
    const stagingIds = resourceIds(cfg.env.staging);
    expect(stagingIds.length).toBeGreaterThanOrEqual(2);
    for (const id of stagingIds) expect(prodIds.has(id), `${id} is a production id`).toBe(false);
  });

  describe('proof-of-rejection', () => {
    const good = () => parseToml(`
workers_dev = false
preview_urls = false
[env.production]
d1_databases = [{ binding = "DB", database_id = "prod-d1", database_name = "focusbro-db" }]
kv_namespaces = [{ binding = "KV_CACHE", id = "prodkv" }]
r2_buckets = [{ binding = "AUDIO", bucket_name = "focusbro-audio" }]
vars = { ENV = "production", PRO_PRICE_ID = "price_live" }
[env.staging]
name = "focusbro-staging"
routes = [{ pattern = "staging.focusbro.net/*", zone_name = "focusbro.net" }]
d1_databases = [{ binding = "DB", database_id = "stg-d1", database_name = "focusbro-staging-db" }]
kv_namespaces = [{ binding = "KV_CACHE", id = "stgkv" }]
r2_buckets = [{ binding = "AUDIO", bucket_name = "focusbro-audio" }]
vars = { ENV = "staging", API_ORIGIN = "https://staging.focusbro.net" }
`);
    const only = (mutate) => { const c = good(); mutate(c); return findStagingViolations(c); };

    it('accepts the healthy control', () => {
      expect(findStagingViolations(good())).toEqual([]);
    });
    it('rejects a missing env.staging', () => {
      expect(only((c) => { delete c.env.staging; })).toEqual(['env.staging is missing']);
    });
    it('rejects a staging D1 copied from production', () => {
      expect(only((c) => { c.env.staging.d1_databases[0].database_id = 'prod-d1'; })).toEqual(['env.staging d1 DB uses a production id']);
    });
    it('rejects a staging KV copied from production', () => {
      expect(only((c) => { c.env.staging.kv_namespaces[0].id = 'prodkv'; })).toEqual(['env.staging kv KV_CACHE uses a production id']);
    });
    it('rejects a staging KV preview_id pointing at production', () => {
      expect(only((c) => { c.env.staging.kv_namespaces[0].preview_id = 'prodkv'; })).toEqual(['env.staging kv KV_CACHE uses a production id']);
    });
    it('rejects the all-zero placeholder ids', () => {
      expect(only((c) => {
        c.env.staging.d1_databases[0].database_id = '00000000-0000-0000-0000-000000000000';
        c.env.staging.kv_namespaces[0].id = '00000000000000000000000000000000';
      })).toEqual(['env.staging d1 DB has no real database_id', 'env.staging kv KV_CACHE has no real id']);
    });
    it('rejects the production database_name', () => {
      expect(only((c) => { c.env.staging.d1_databases[0].database_name = 'focusbro-db'; })[0]).toMatch(/production database_name/);
    });
    it('rejects a missing binding (bindings are not inherited)', () => {
      expect(only((c) => { delete c.env.staging.kv_namespaces; })).toEqual(['env.staging is missing the kv binding KV_CACHE']);
    });
    it('rejects a Custom Domain (shadowed by the production wildcard route)', () => {
      expect(only((c) => { c.env.staging.routes = [{ pattern: 'staging.focusbro.net', custom_domain: true }]; }).join('\n')).toMatch(/Custom Domain/);
    });
    it('rejects a production host in the staging routes', () => {
      expect(only((c) => { c.env.staging.routes.push({ pattern: 'focusbro.net/*', zone_name: 'focusbro.net' }); })).toEqual(['env.staging route focusbro.net/* is not a staging host']);
    });
    it('rejects the wrong worker name, ENV or origin', () => {
      expect(only((c) => { c.env.staging.name = 'focusbro'; c.env.staging.vars = { ENV: 'production', API_ORIGIN: 'https://focusbro.net' }; })).toHaveLength(3);
    });
    it('rejects the live Stripe price on staging', () => {
      expect(only((c) => { c.env.staging.vars.PRO_PRICE_ID = 'price_live'; })).toEqual(['env.staging carries the production Stripe price id']);
    });
    it('rejects workers.dev / preview URLs enabled for staging', () => {
      expect(only((c) => { c.env.staging.workers_dev = true; c.env.staging.preview_urls = true; })).toHaveLength(2);
    });
    it('rejects a shared R2 bucket other than the read-only AUDIO one', () => {
      expect(only((c) => {
        c.env.production.r2_buckets.push({ binding: 'UPLOADS', bucket_name: 'focusbro-uploads' });
        c.env.staging.r2_buckets.push({ binding: 'UPLOADS', bucket_name: 'focusbro-uploads' });
      })).toEqual(['env.staging r2 UPLOADS shares the production bucket']);
    });
  });
});
