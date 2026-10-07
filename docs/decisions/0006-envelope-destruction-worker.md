# ADR 0006 - Dedicated response-envelope destruction worker

- **Status:** Superseded / archived by the 0070 refactor (6 October 2026)
- **Date:** 23 August 2026
- **Applies to:** API-key response-envelope destruction
- **Numbering note:** This repository decision is unrelated to
  `Project Specs/docs/adr/0006-idempotent-one-time-dhumi-api-key.md`; the two
  decision directories have independent numbering.

## Refactor status

This is a historical decision. Customer API keys and their encrypted secret-response
recovery are removed from the application in the 0070 compatibility batch. Browser
sessions remain the customer authentication path; the Bright Data provider key is
unchanged. Database application and cluster role retirement remain pending. See
[the archive record](../archive/README.md). The original decision below is retained
for recovery and migration-history review, not active implementation.

## Context

The repository has an outbox table and claim functions but no dispatcher
process. An outbox row therefore cannot guarantee cleanup. Request-driven
cleanup also leaves ciphertext indefinitely when a Tenant never returns.

Migration 0007 already provides an index over live envelopes ordered by their
recovery deadline. Destruction is a local PostgreSQL transition with no queue,
provider or other external side effect.

## Decision

Run response-envelope destruction as a separately deployed worker entry point,
consistent with accepted project ADR-0001.

The worker uses a dedicated `dhumi_envelope_janitor` capability and one
environment-specific `NOINHERIT` login. The web process never receives the
janitor credential.

PostgreSQL owns the atomic bounded transition through a `SECURITY INVOKER`
function. Each call locks at most the configured batch size of due live
envelopes with `FOR UPDATE SKIP LOCKED`, clears ciphertext/key reference and
sets the database destruction timestamp in the same statement. Because claim
and destruction are one transaction, persisted claim tokens and a claim TTL are
unnecessary and would create an avoidable crash-between-steps state.

PostgreSQL applies SELECT-policy visibility while validating an UPDATE's new
row. A direct janitor table policy therefore cannot both hide destroyed rows
and transition a live row into that hidden state. Migration 0009 resolves the
conflict with an owner-filtered, security-barrier view: narrow owner policies
admit both sides of the transition on the forced-RLS base table, while the view
exposes only live due envelopes. The janitor receives column-scoped privileges
on that view and no base-table privileges. Request hashes, actor fingerprints,
idempotency keys and Tenant IDs remain inaccessible.

The worker polls sequentially, never overlaps its own batches, retries a failed
batch on the next interval, logs only counts/timing/error correlation and shuts
down on `SIGINT`/`SIGTERM`. Poll interval and batch size are bounded non-secret
runtime configuration. Deployment topology and production scheduling remain
DP-14 concerns.

## Consequences

- Dormant Tenants do not retain encrypted responses indefinitely.
- Multiple janitor instances are safe through row locks and an idempotent
  destroyed state.
- There is no queue, outbox topic, scheduler service or provider dependency.
- A separate cluster-role bootstrap is required before application migration
  0009 because per-database migrations run as `dhumi_owner`, which deliberately
  cannot create login roles.
