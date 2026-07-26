# PII inventory

| Data | Location | Purpose | Removal |
|---|---|---|---|
| Account email and profile fields | D1 `users` | Authentication and account recovery | Account lifecycle controls |
| User-selected cloud snapshot | D1 `user_data_snapshots`, KV `user:{id}:latest` | Optional multi-device sync | `POST /privacy/delete` removes synced copies |
| Sync device/action metadata | D1 `sync_logs`, `audit_logs` | Reliability and security operations | Operational retention policy |

FocusBro does not upload browser-local focus data unless the user chooses cloud sync.
