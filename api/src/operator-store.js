// ════════════════════════════════════════════════════════════
// FOCUSBRO — D1 OPERATOR STORE  (Contender track, issue #10, Phase C)
// ════════════════════════════════════════════════════════════
// A THIN adapter, nothing more. It satisfies the `OperatorStore` port from
// `@latimer-woods-tech/operator` over Cloudflare D1 (SQLite), so FocusBro mounts
// the shared operator platform — operator identity, the operator→client
// hierarchy, white-label — instead of hand-rolling a parallel one. The Warden's
// operator UNBLOCK (issue #10, 2026-08-08) is explicit: "Do NOT hand-roll
// billing/hierarchy; thin adapters come out." This is that adapter.
//
// WHAT IT IMPLEMENTS (Phase C slice 1): the identity + hierarchy half of the
// port — `operators` and `operator_clients`. That is exactly what
// `OperatorIdentityService` (the only service FocusBro mounts this slice) calls.
//
// WHAT IT DOES NOT: the money half (price books, the rev-share ledger, payouts)
// is Phase D — tiers & billing, founder-gated on Stripe live-mode. Those port
// methods deliberately reject with a clear, typed "not enabled here" error
// rather than silently persisting money rows this app is not cleared to move.
// Shipping untested money persistence would be padding; a gate that rejects is
// honest and is covered by a proof-of-rejection test.
//
// The port owns id generation and row materialization (the reference
// `InMemoryOperatorStore` assigns the uuid + timestamps, the service passes a
// `New*` row without an id), so this adapter mirrors that: it mints the uuid via
// Web Crypto, stamps ISO timestamps, and maps snake_case D1 columns ⇄ the
// camelCase domain objects the services expect. Duplicate slug / connect-account
// / (operator, external-org) collisions surface as the same `ValidationError`
// the in-memory reference throws, so callers reject identically on either store.
// ════════════════════════════════════════════════════════════

import { ValidationError } from '@latimer-woods-tech/errors';

const nowIso = () => new Date().toISOString();

/** Parse a JSON text column, tolerating null/empty/malformed → null. */
function parseJson(text) {
  if (text === null || text === undefined || text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Serialize a JSON-able value to a text column, or null. */
function toJson(value) {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/** Map an `operators` D1 row → the camelCase domain object the services expect. */
function rowToOperator(r) {
  if (!r) return null;
  return {
    id: r.id,
    slug: r.slug,
    displayName: r.display_name,
    status: r.status,
    connectAccountId: r.connect_account_id ?? null,
    chargeMode: r.charge_mode,
    whiteLabel: parseJson(r.white_label),
    defaultCurrency: r.default_currency,
    metadata: parseJson(r.metadata),
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
}

/** Map an `operator_clients` D1 row → the camelCase domain object. */
function rowToClient(r) {
  if (!r) return null;
  return {
    id: r.id,
    operatorId: r.operator_id,
    externalOrgId: r.external_org_id ?? null,
    name: r.name,
    status: r.status,
    retailOverride: parseJson(r.retail_override),
    metadata: parseJson(r.metadata),
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
}

/**
 * Map a SQLite UNIQUE-constraint failure back to the `ValidationError` the port
 * promises, so a duplicate rejects the same way it does on the in-memory
 * reference (the service layer never sees a raw driver error).
 */
function mapUniqueViolation(err, fallbackField, fallbackValue) {
  const msg = String(err && err.message ? err.message : err);
  if (!/UNIQUE constraint failed/i.test(msg)) return err;
  if (/connect_account/i.test(msg)) {
    return new ValidationError('Connect account already linked', {
      field: 'connectAccountId',
      value: fallbackValue,
    });
  }
  if (/operator_clients|external_org/i.test(msg)) {
    return new ValidationError('External org already mapped for this operator', {
      field: 'externalOrgId',
      value: fallbackValue,
    });
  }
  if (/slug/i.test(msg)) {
    return new ValidationError('Operator slug already exists', { field: 'slug', value: fallbackValue });
  }
  return new ValidationError('Duplicate key', { field: fallbackField, value: fallbackValue });
}

/** The set of money-surface port methods gated to Phase D on this app. */
function phaseDGate(method) {
  return new ValidationError(
    `operator ${method} is Phase D (tiers & billing) — not enabled in FocusBro yet`,
    { field: 'phase', value: 'D' },
  );
}

/**
 * A `@latimer-woods-tech/operator` `OperatorStore` backed by Cloudflare D1.
 *
 * Construct one per request/Worker with the D1 binding: `new D1OperatorStore(env.DB)`.
 * The identity + hierarchy methods are live; the money methods reject with a
 * typed Phase-D gate until FocusBro's billing phase is cleared.
 */
export class D1OperatorStore {
  /** @param {D1Database} db  the Worker's D1 binding (`env.DB`). */
  constructor(db) {
    if (!db) throw new Error('D1OperatorStore requires a D1 binding');
    this.db = db;
  }

  // ── operators ──────────────────────────────────────────────
  async insertOperator(row) {
    const id = crypto.randomUUID();
    const ts = nowIso();
    const op = {
      id,
      slug: row.slug,
      display_name: row.displayName,
      status: row.status ?? 'pending',
      connect_account_id: row.connectAccountId ?? null,
      charge_mode: row.chargeMode ?? 'direct',
      white_label: toJson(row.whiteLabel ?? null),
      default_currency: row.defaultCurrency ?? 'usd',
      metadata: toJson(row.metadata ?? null),
      created_at: ts,
      updated_at: ts,
    };
    try {
      await this.db
        .prepare(
          `INSERT INTO operators
             (id, slug, display_name, status, connect_account_id, charge_mode,
              white_label, default_currency, metadata, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          op.id, op.slug, op.display_name, op.status, op.connect_account_id, op.charge_mode,
          op.white_label, op.default_currency, op.metadata, op.created_at, op.updated_at,
        )
        .run();
    } catch (err) {
      throw mapUniqueViolation(err, 'slug', row.slug);
    }
    return rowToOperator(op);
  }

  async getOperatorById(id) {
    const r = await this.db.prepare('SELECT * FROM operators WHERE id = ?').bind(id).first();
    return rowToOperator(r);
  }

  async getOperatorBySlug(slug) {
    const r = await this.db.prepare('SELECT * FROM operators WHERE slug = ?').bind(slug).first();
    return rowToOperator(r);
  }

  async updateOperator(id, patch) {
    const current = await this.getOperatorById(id);
    if (current === null) return null;
    // Column allow-list: only these operator fields are ever patched by the
    // service (whiteLabel/status/connectAccountId/chargeMode/currency/metadata/name).
    const cols = [];
    const vals = [];
    const set = (col, val) => { cols.push(`${col} = ?`); vals.push(val); };
    if ('displayName' in patch) set('display_name', patch.displayName);
    if ('status' in patch) set('status', patch.status);
    if ('connectAccountId' in patch) set('connect_account_id', patch.connectAccountId ?? null);
    if ('chargeMode' in patch) set('charge_mode', patch.chargeMode);
    if ('whiteLabel' in patch) set('white_label', toJson(patch.whiteLabel ?? null));
    if ('defaultCurrency' in patch) set('default_currency', patch.defaultCurrency);
    if ('metadata' in patch) set('metadata', toJson(patch.metadata ?? null));
    set('updated_at', nowIso());
    try {
      await this.db
        .prepare(`UPDATE operators SET ${cols.join(', ')} WHERE id = ?`)
        .bind(...vals, id)
        .run();
    } catch (err) {
      throw mapUniqueViolation(err, 'connectAccountId', patch.connectAccountId);
    }
    return this.getOperatorById(id);
  }

  // ── operator_clients (the operator→client hierarchy) ───────
  async insertClient(row) {
    const id = crypto.randomUUID();
    const ts = nowIso();
    const c = {
      id,
      operator_id: row.operatorId,
      external_org_id: row.externalOrgId ?? null,
      name: row.name,
      status: row.status ?? 'active',
      retail_override: toJson(row.retailOverride ?? null),
      metadata: toJson(row.metadata ?? null),
      created_at: ts,
      updated_at: ts,
    };
    try {
      await this.db
        .prepare(
          `INSERT INTO operator_clients
             (id, operator_id, external_org_id, name, status, retail_override, metadata, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          c.id, c.operator_id, c.external_org_id, c.name, c.status,
          c.retail_override, c.metadata, c.created_at, c.updated_at,
        )
        .run();
    } catch (err) {
      throw mapUniqueViolation(err, 'externalOrgId', row.externalOrgId);
    }
    return rowToClient(c);
  }

  async getClientById(id) {
    const r = await this.db.prepare('SELECT * FROM operator_clients WHERE id = ?').bind(id).first();
    return rowToClient(r);
  }

  async listClientsByOperator(operatorId) {
    const res = await this.db
      .prepare('SELECT * FROM operator_clients WHERE operator_id = ? ORDER BY created_at ASC, id ASC')
      .bind(operatorId)
      .all();
    const rows = (res && res.results) || [];
    return rows.map(rowToClient);
  }

  async updateClient(id, patch) {
    const current = await this.getClientById(id);
    if (current === null) return null;
    const cols = [];
    const vals = [];
    const set = (col, val) => { cols.push(`${col} = ?`); vals.push(val); };
    if ('name' in patch) set('name', patch.name);
    if ('status' in patch) set('status', patch.status);
    if ('externalOrgId' in patch) set('external_org_id', patch.externalOrgId ?? null);
    if ('retailOverride' in patch) set('retail_override', toJson(patch.retailOverride ?? null));
    if ('metadata' in patch) set('metadata', toJson(patch.metadata ?? null));
    set('updated_at', nowIso());
    try {
      await this.db
        .prepare(`UPDATE operator_clients SET ${cols.join(', ')} WHERE id = ?`)
        .bind(...vals, id)
        .run();
    } catch (err) {
      throw mapUniqueViolation(err, 'externalOrgId', patch.externalOrgId);
    }
    return this.getClientById(id);
  }

  // ── money surface — Phase D, founder-gated on Stripe live-mode ──
  // These satisfy the port's type surface but reject: FocusBro mounts only
  // OperatorIdentityService this slice, so nothing calls them. A gate that
  // rejects (and is tested to reject) beats untested money code.
  async insertPriceBookEntry() { throw phaseDGate('insertPriceBookEntry'); }
  async listPriceBook() { throw phaseDGate('listPriceBook'); }
  async deactivatePriceBook() { throw phaseDGate('deactivatePriceBook'); }
  async appendLedgerEntry() { throw phaseDGate('appendLedgerEntry'); }
  async sumLedger() { throw phaseDGate('sumLedger'); }
  async listLedger() { throw phaseDGate('listLedger'); }
  async insertPayout() { throw phaseDGate('insertPayout'); }
  async getPayoutById() { throw phaseDGate('getPayoutById'); }
  async updatePayout() { throw phaseDGate('updatePayout'); }
  async listPayoutsByOperator() { throw phaseDGate('listPayoutsByOperator'); }
}
