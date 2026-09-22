# Marketplace Filter fixture adapter

Recorded: 2026-09-12. Decision: implement M7 as a customer-disabled fixture
adapter in the existing Job Manager; do not activate provider transport.

## Evidence

The checked-in Bright Data documentation establishes these provider facts:

- JSON-mode Filter is `POST /datasets/filter` with exactly `dataset_id`,
  `records_limit` and `filter`, and returns `snapshot_id`.
- A matching Filter result is charged at the Marketplace rate; zero matches
  return HTTP `422` and are not charged.
- Snapshot metadata exposes only `scheduled`, `building`, `ready` and `failed`
  lifecycle states, plus optional Dataset size, file size and cost.
- Snapshot content is read through
  `GET /datasets/snapshots/{snapshot_id}/download`; M7 pins
  `format=json&compress=false` so exact provider bytes can be retained.
- Filter groups support at most three nesting levels. Operators and field
  types must be checked against Dataset metadata.
- The reviewed Marketplace Snapshot API set contains no provider cancellation
  endpoint. Dhumi therefore stops its own polling when cancellation is
  requested and does not invent a provider request.

Sources:

- `Project Specs/08_References/Bright_Data_Local_Docs/Marketplace Dataset API/Apis/Filter dataset (BETA).md`
- `Project Specs/08_References/Bright_Data_Local_Docs/Marketplace Dataset API/Apis/Dataset API filter syntax.md`
- `Project Specs/08_References/Bright_Data_Local_Docs/Marketplace Dataset API/Apis/Get snapshot metadata.md`
- `Project Specs/08_References/Bright_Data_Local_Docs/Marketplace Dataset API/Apis/Snapshot content.md`

## Decision

1. Register `bright_data.marketplace.filter` version
   `1.0.0-m7-fixture` in state `disabled` with
   `provider_http_enabled=false` and `automatic_submission_retries=0`.
2. Create no provider mapping, public Template pointer, entitlement, Service,
   Run, outbox event, public API route or database LOGIN in M7.
3. Permit the M7 executor to accept only a client marked `fixture`. The real
   HTTP client exists as a contract boundary but is not composed into the
   running Job Manager.
4. Route existing provider Runs by their immutable adapter identity. Amazon
   continues to use its existing executor; an uncomposed Marketplace adapter
   fails closed with a safe service-unavailable result.
5. Serialize only the documented JSON request. Treat Dataset and Snapshot IDs
   as bounded opaque provider strings because the provider schemas publish no
   identifier regex. Validate the mapping-owned record ceiling, reviewed field
   names, operator compatibility and three-level nesting before secret access
   or transport. Filter arrays accept only the primitive item types allowed by
   the provider schema; null checks use only the documented no-value operators.
6. Submit once. A transport failure or malformed success after submission is
   ambiguous and enters reconciliation; recovery may use only a previously
   protected Snapshot reference and may never repeat the Filter POST.
7. Encrypt and fingerprint a returned Snapshot reference immediately, using
   the existing mapping/attempt AAD lineage. Persist the poll deadline, next
   poll, last status and consecutive failures.
8. Store exact raw JSON before running the accepted DM-008 selected-field
   projection. Usage is based on the normalized record count.
9. Record terminal provider metadata once. Convert the documented numeric USD
   cost to integer micros and settle only the existing Bright Data Marketplace
   USD cost hold. HTTP `422` finalizes it at zero; known pre-execution
   rejections release it.
10. Use Dhumi-side cancellation only. No provider cancel call is claimed.

## Artifact identity

The adapter digest is SHA-256 over these files in this exact order, using their
raw bytes without separators:

1. `marketplaceFilterRequest.ts`
2. `marketplaceFilterClient.ts`
3. `marketplaceResultNormalizer.ts`
4. `marketplaceRunExecutor.ts`
5. `marketplaceExecutionPlanRepository.ts`
6. `providerRunExecutorRouter.ts`

Recorded digest:
`a5545e0016e38071abf59bf01a3520ebb529d7e1f14f367f10dde9b9e534e2ab`.

## Verification and activation boundary

The focused M7/DM-008 suite passes 63 checks. The complete backend unit suite
passes 701 checks; the default suite passes 872 with 127 privileged tests
skipped; typecheck and build pass. All tests use fixtures and make zero Bright
Data calls.

Migration `0052` replayed successfully with the full migration chain on a
disposable PostgreSQL 18 database. The rollback-only structural proof passed
and the proof container was removed. Forward-only activation subsequently
passed on `dhumi_test` and `dhumi_dev`; both proofs confirmed the adapter is
ledgered and customer-disabled. No provider call was made.
