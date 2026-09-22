# Amazon Products customer live E2E

This package proves one production-shaped local customer Run for the single
published operation `amazon.products.collect_by_url`.

The customer-facing path is unchanged:

```text
Customer API
  -> PostgreSQL Run and committed jobs.execute outbox event
  -> Outbox Dispatcher
  -> Azure Service Bus emulator
  -> Job Manager with the bright_data executor
  -> real Bright Data /datasets/v3/scrape submission
  -> PostgreSQL state/events/usage metadata
  -> Azurite raw and normalized result objects
  -> authorized Dhumi result response and signed download
```

Local substitutions are limited to Azurite, the Service Bus emulator, local
Redis and the non-production environment-backed provider secret adapter. The
executor, repositories, transactions, serializers, normalizer, public APIs and
worker lifecycle are the normal application components.

## Provider request budget

- operation: `amazon.products.collect_by_url`
- billable scrape submissions: exactly one
- targets in that submission: exactly six
- automatic submission retries: zero
- asynchronous progress/download reads: only for the snapshot returned by the
  one authorized submission

Do not retry a Run after provider egress. A resumed test must reuse the original
Run ID.

The first customer Run in this package failed before provider egress because a
published mapping copied authenticated ciphertext without preserving its
encryption lineage. That failed Run is retained as defect evidence. After
migration `0042_provider_mapping_aad_lineage`, one replacement Run is permitted
only with the explicit `--replace-proven-pre-egress-run=<run_id>` argument. The
runner verifies the old public Run is `failed`, `SERVICE_UNAVAILABLE` and not
retryable before allocating the replacement idempotency key. Reusing the flag
cannot allocate further Runs.

Before starting the replacement Run, apply migration `0042` and run:

```powershell
& '.\tests\privileged\amazon-products-customer-live-e2e\Invoke-ProviderMappingAadLineageDatabaseProof.ps1' -Target Both
```
