# Data retention

FocusBro is browser-first: core timer and wellness data stays in browser storage unless a signed-in Pro user deliberately syncs it.

- Synced snapshots: retain the 30 newest recovery points per account, capped at 10 MiB total. A successful new upload prunes older snapshots.
- Upload quota: 60 validated uploads per account per rolling one-hour KV window.
- Sync cache: the latest snapshot cache expires after one year and is removed immediately by `POST /privacy/delete`.
- Privacy deletion: `POST /privacy/delete` removes all D1 snapshots and the related KV cache/rate keys for the authenticated account.
- Sessions and auth tokens: the cron deletes sessions and password-reset / verification tokens one day after they expire (each is dead the moment it expires; the day is a safety margin past the 5-minute refresh window, not a retention period). At most 500 rows per table per tick.
- Analytics events: **no retention period has been ruled.** The purge is built and OFF; it deletes events older than `ANALYTICS_RETENTION_DAYS` (whole number, 30 or more) once that Worker var is set. Until the founder rules a period, analytics events are kept.
- Operational sync/audit logs: retained under the existing operational database policy; they are not served as product history.

The route intentionally deletes synced data only; browser-local data remains under the user's browser controls.
