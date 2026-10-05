# PII inventory

| Data | Location | Purpose | Removal |
|---|---|---|---|
| Account email and profile fields | D1 `users` | Authentication and account recovery | Account lifecycle controls |
| User-selected cloud snapshot | D1 `user_data_snapshots`, KV `user:{id}:latest` | Optional multi-device sync | `POST /privacy/delete` removes synced copies |
| Sync device/action metadata | D1 `sync_logs`, `audit_logs` | Reliability and security operations | Operational retention policy |
| Mobile number, consent wording, quiet hours, `phone_verified_at`; pending code hash (never the code) in `phone_verifications` | D1 `users`, `phone_verifications` | Text check-ins only, and only to a number confirmed by a one-time code; one confirmed number per account; STOP revokes | Account deletion; a pending code expires or is deleted on success or lockout |
| Words (titles, schedule, time zone, tone), check-in answers and notes | D1 `commitments`, check-in rows | The person's own check-ins | Account deletion |
| What a linked coach can read (FBQ-21) | `GET /api/coach/clients/:id` (coach.js) | Active and kept word TITLES (free text), recurrence and local time, time zone, delivered / kept / snoozed counts, the nudge and answer cues, and notes only with note sharing on. The coach's configured voice and opening line shape the client's messages (coach-onboarding.js). Stated in the privacy policy, Coaches section | Account deletion; note sharing off at any time; the client ends the link themselves with `DELETE /api/coach/links/:id` (coach.js) from the "Stop sharing with my coach" action on `/me/` (FBQ-10 R4); the coach's own `DELETE /api/coach/clients/:id` also ends it |
| Pro purchase status, amount, currency, Stripe references, `refund_checked_at` / `refunded_at` | D1 `pro_purchases` | One-time Pro; a full refund or lost dispute revokes it | Account deletion keeps the unlinked receipt for tax records |

FocusBro does not upload browser-local focus data unless the user chooses cloud sync.
