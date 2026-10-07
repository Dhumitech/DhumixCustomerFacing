# ADR 0005 - Permanent API-key creation idempotency tombstones

- **Status:** Superseded / archived by the 0070 refactor (6 October 2026)
- **Date:** 23 August 2026
- **Applies to:** `POST /v1/keys`
- **Numbering note:** This repository decision is unrelated to
  `Project Specs/docs/adr/0005-*`; the two decision directories have independent
  numbering.

## Refactor status

This is a historical decision. Customer API keys and their encrypted secret-response
recovery are removed from the application in the 0070 compatibility batch. Browser
sessions remain the customer authentication path; the Bright Data provider key is
unchanged. Database application and cluster role retirement remain pending. See
[the archive record](../archive/README.md). The original decision below is retained
for recovery and migration-history review, not active implementation.

## Context

After the response envelope is destroyed, deleting the completed idempotency
row would make an old `Idempotency-Key` unknown. Treating that replay as a new
request could create a second active credential, contradicting ADR-0006.

The encrypted secret material does not need permanent retention. The completed
claim identity does.

## Decision

Completed `api_keys.create` idempotency rows are permanent tombstones.

`expires_at` governs the in-progress claim/recovery lifecycle; it does not
authorize deletion of the completed row. After the ten-minute envelope window,
the ciphertext and key reference are destroyed while the request hash,
operation/key identity, created-resource reference, recovery deadline and
destruction time remain.

An exact replay after destruction permanently returns
`409 IDEMPOTENCY_REPLAY_EXPIRED` and creates no second key. A different request
hash permanently returns `409 IDEMPOTENCY_CONFLICT`.

No runtime role receives `DELETE` on `app.idempotency_records`. Any future
retention change is a new security and public-behavior decision, not routine
cleanup.

## Consequences

- One narrow completed tombstone remains per API-key creation request.
- Duplicate credential creation remains impossible after envelope destruction.
- Secret-bearing ciphertext is still removed independently by the envelope
  janitor.
- Operational storage growth must be monitored, but it is not resolved by
  weakening replay safety.
