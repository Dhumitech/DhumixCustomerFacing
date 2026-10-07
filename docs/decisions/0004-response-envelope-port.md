# ADR 0004 - Versioned response-envelope port

- **Status:** Superseded / archived by the 0070 refactor (6 October 2026)
- **Date:** 23 August 2026
- **Applies to:** `POST /v1/keys`
- **Numbering note:** This repository decision is unrelated to
  `Project Specs/docs/adr/0004-*`; the two decision directories have independent
  numbering.

## Refactor status

This is a historical decision. Customer API keys and their encrypted secret-response
recovery are removed from the application in the 0070 compatibility batch. Browser
sessions remain the customer authentication path; the Bright Data provider key is
unchanged. Database application and cluster role retirement remain pending. See
[the archive record](../archive/README.md). The original decision below is retained
for recovery and migration-history review, not active implementation.

## Context

ADR-0006 requires the successful one-time API-key response to remain exactly
recoverable for ten minutes without storing plaintext. The application needs a
stable boundary that works with a demo-local implementation now and a managed
KMS implementation after deployment authority DP-14 is resolved.

The browser access-token secret is not suitable envelope material. Reusing it
would couple session signing, CSRF derivation and encrypted-response recovery to
one rotation and compromise boundary.

## Decision

Introduce an application-owned response-envelope port with two operations:

```text
seal(plaintext, authenticatedContext)
  -> ciphertext + keyReference

open(ciphertext, keyReference, authenticatedContext)
  -> plaintext or an authenticated failure
```

The authenticated context binds at least the Tenant, operation, idempotency
record and created API-key identifiers. It is never caller-selected after the
trusted operation context has been established.

The demo/local adapter uses AES-256-GCM from `node:crypto`, requires its own
validated 256-bit configuration secret, and uses the versioned key reference
`local:v1`. It must not use the access-token secret. Nonce, authentication tag
and ciphertext serialization are versioned and authenticated; malformed,
unknown-version or wrong-context envelopes fail closed.

The production adapter will retain the same port and use the approved managed
KMS key identifier and version in `keyReference`. Selecting the cloud product,
workload identity and key lifecycle remains part of DP-14. Local AES is demo
and test infrastructure, not proof of production KMS readiness.

The ten-minute recovery duration remains an operation constant backed by the
database clock, not a freely adjustable environment value.

## Consequences

- Plaintext exists only in bounded application memory during creation/replay.
- No plaintext, local root key, KMS reference or ciphertext enters logs/audit.
- Local and production adapters share one service contract without leaking
  provider-specific APIs into controllers or repositories.
- The local root secret requires independent generation, storage and rotation.
- The complete KMS sequencing must prepare recoverable material without holding
  a PostgreSQL transaction across an uncontrolled network call.
