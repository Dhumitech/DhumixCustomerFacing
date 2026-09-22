# Public API contracts

This directory contains the publication-safe customer API contract required by
the backend and its automated tests.

- [openapi.yaml](openapi.yaml) is the canonical current public Dhumi HTTP contract:
  27 operations (the original 23 plus four Marketplace sample/enquiry operations).
  Generate clients and contract tests from this file.
- `public-api.md` documents stable public error codes and provider-error
  isolation behavior used by contract verification.

The ignored `Project Specs/03_API/openapi.yaml` is an earlier 23-operation
snapshot, not current HTTP authority. Architecture/context documents supplement
this contract; they cannot silently override its paths, auth, payloads or
statuses. Resolve implementation/contract discrepancies explicitly before
changing public behavior. This clarification adds no API operation.

These files must never contain Bright Data credentials, protected provider
identifiers, database credentials, signed result URLs, or private qualification
evidence.
