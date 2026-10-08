# Duplicate signup correction — 8 October 2026

The owner requests an explicit existing-account error and password-help contact.
This supersedes the previous generic duplicate-email signup response. New signup
requests disclose registered-email existence by design; sign-in/password-reset
responses remain generic. Existing IP/email rate limits and password hashing apply.

- Keep the database unique email constraint and atomic user/legal/audit writes.
- A fresh duplicate request returns `409 ACCOUNT_ALREADY_EXISTS`, never changes
  the existing password or legal evidence, and records its rejection for replay.
- Concurrent requests with distinct keys create exactly one user; the loser gets
  the same duplicate error. Successful same-key retries retain `202`. Historical
  completed accepted receipts keep their recorded response; no history is rewritten.
- Show a themed alert in the signup dialog with a Sign in action and a clickable
  `dhumitechnologies@gmail.com` support link. Preserve the entered email when
  switching to sign-in, clear passwords, and never treat the rejection as login.
- Share password-help copy with the existing sign-in/reset UI. Support is a mailto
  link only; this change sends no email and implements no manual password reset.
- Update the OpenAPI error code and regenerate the client. No migration, roles,
  credentials, organization behavior, provider traffic or host SQL is changed.

Regression checks must cover duplicate persistence/replay, service-to-HTTP mapping,
signup alert, distinct idempotency conflict and actual Docker demo duplicate/signup
concurrency. Use synthetic QA accounts for mutation checks, never the owner's
account; inspect the reported account read-only. Rebuild/restart the local API after
qualification so localhost:5173 uses the correction.
