# FocusBro D1 migrations

`migrations/` is the canonical, append-only schema history for FocusBro. Apply
files with Wrangler; never run `api/schema.sql` against a populated database.

## Safe workflow

1. Add the next sequential `NNNN_description.sql` file with a `-- ROLLBACK:`
   comment. Use expand → migrate → contract; do not edit an applied migration.
2. Apply it to an empty local D1 and inspect it:

   ```bash
   npx wrangler d1 migrations apply focusbro-db --local --env production
   npx wrangler d1 migrations list focusbro-db --local --env production
   ```

3. Check the remote ledger before a production application:

   ```bash
   npx wrangler d1 migrations list focusbro-db --remote --env production
   ```

4. Apply only reviewed, tested migrations to production:

   ```bash
   npx wrangler d1 migrations apply focusbro-db --remote --env production
   ```

Cloudflare records applied filenames in `d1_migrations` and captures a backup
before a remote apply. A failed migration is rolled back by D1; do not bypass
the migration command with ad-hoc production DDL.

## Production baseline

Before this directory existed, the Worker created the deployed schema on cold
starts. On 2026-07-26 that schema was inventoried and matched by
`0000_production_schema_baseline.sql`, followed by the two historic migrations.
The existing production database must have those three exact filenames entered
in its `d1_migrations` ledger only after a schema comparison proves it already
contains their effects. This is a one-time baseline operation, not a migration
to replay against live user data.
