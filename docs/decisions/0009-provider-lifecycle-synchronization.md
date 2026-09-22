# Provider lifecycle synchronization

Recorded: 2026-09-05. Scope: local implementation; live activation pending.

The user requested bounded provider synchronization and explicitly retained
strict failure for mixed valid/error results. Provider lifecycle is determined
by progress/result responses, never by a dashboard success-rate percentage.

## Evidence and decisions

- The local Monitor progress contract enumerates starting, running, ready,
  failed and canceled. Its error reference permits HTTP 200 with status failed.
- Local download references describe both 202 and 409 as not ready. These
  responses retry only reads. HTTP 401 is terminal configuration failure;
  missing/unknown snapshots go through reconciliation with a finite budget.
- A successful submission response without a usable snapshot reference is
  ambiguous. Job Manager finishes the submission Attempt as ambiguous and
  schedules the existing reconciliation command. No automatic submission retry.
- Migration 0044 stores deadline, next poll time, classified private status and
  consecutive read failures on the original submission Attempt. The protected
  snapshot reference continues to use the existing encrypted fields. Updates
  require an active tenant-scoped submission/reconciliation fence.
- The existing configured polling duration is anchored to the original
  submission Attempt start. Recovery cannot restart it. Retry-After is saved
  before waiting. Otherwise exponential read backoff starts at the configured
  interval and caps at 60 seconds. Five consecutive failures is the default
  **Dhumi operational policy**, configurable from 1 to 100, not a provider
  constraint or a load-tested production tuning claim.
- Ready preserves raw bytes before normalization. All-error arrays fail with
  ALL_INPUTS_FAILED and retryable=false: no supplied evidence establishes that
  their provider error codes are safe to retry. Mixed results retain strict
  failure. Valid empty arrays retain the pinned normalizer's existing policy;
  a provider HTTP rejection saying the snapshot is empty is a separate failure.
- Classification runs outside the hash-pinned normalizer. Migration 0040 and
  the normalizer implementation bytes remain unchanged by this fix.
- Processing failures use the existing PROCESSING_FAILED -> public failed
  projection. Both initial execution and reconciliation catch typed terminal
  normalization errors. Raw artifacts remain retained. Failed Runs do not
  fabricate successful-record usage; valid normalized results still use the
  existing atomic, exactly-once usage finalizers.
- PROVIDER_TIMEOUT identifies exhausted polling time. Existing manual retry
  eligibility remains; the worker never automatically repeats a submission.
- The frontend reads only Dhumi state, uses public cancelled (two l's), stops
  terminal polling, displays safe all-input/timeout messages, and offers a GET
  reconnect action. One final events read is allowed to display terminal history.

## Limits and rollout

Exactly-once successful artifact finalization is required; exactly one network
GET across crashes is not promised. A crashed/incomplete download may need a
repeat GET. Existing durable raw artifacts are reused in reconciliation.

The reported live incident was not inspected. Offline regression tests
reproduced an actual defect: a terminal normalization exception escaped both
Job Manager paths, abandoning the message while leaving the Run PROCESSING.

Apply 0044 through the migration runner before starting the changed worker.
Do not restart the live worker as part of offline verification: queued work
can be billable. Existing dev/test databases and live processes were not
changed during implementation. Live retest requires separately bounded
authorization. ZIP/Template v4 and its existing Service pins are unchanged.

Sources: Project Specs/08_References/Bright_Data_Local_Docs/Apis/Monitor progress.md;
Apis/Download snapshot.md; Scraper API/Scrapers library overview/Error codes by
endpoint.md; Project Specs/02_Architecture/04_Failure_Retry_and_Idempotency.md.
