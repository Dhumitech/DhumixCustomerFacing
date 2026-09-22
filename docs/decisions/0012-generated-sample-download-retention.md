# Generated Marketplace sample-download cleanup and retention

Recorded: 2026-09-17. Applies only to derived JSON/CSV objects under
`marketplace/sample-downloads/`, not source samples or Run results.

## Problem and evidence

Private storage upload and PostgreSQL authorization are not one transaction.
An upload can succeed and completion/audit can fail. A process crash can skip
the exception handler. Conversely, COMMIT can succeed even though its response
is lost: deleting after every completion exception would destroy a legitimately
authorized download.

Azure supports conditional deletion and ETag concurrency checks. A changed
ETag must fail the delete, not trigger an unconditional retry.
[Microsoft deletion guide](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blob-delete-javascript),
[Microsoft concurrency guide](https://learn.microsoft.com/en-us/azure/storage/blobs/concurrency-manage).

## Decision: generated-download retention v1

| Database state | Deletion eligibility |
| --- | --- |
| `reserved`, request failed and failure transaction confirmed | Immediately |
| `failed` | Immediately |
| `reserved`, abandoned | One hour after database `created_at` |
| `authorized` | One hour after database `download_expires_at` |
| Missing/uncertain database record, unexpected key/receipt | Preserve; operator review |

The one-hour intervals are Dhumi safety-grace policy choices, not Bright Data,
ISO, legal-retention or Azure-mandated limits. They avoid competing with normal
bounded sample generation and leave a buffer after link expiry. Source sample
retention remains governed by its existing 30-day policy.

1. Migration `0064` adds two narrow functions, no table or column. The
   Tenant-scoped failure function locks the row, fails only reservations and
   confirms cleanup permission only after COMMIT. It never fails an authorized
   record. The existing completion function rejects a failed reservation.
2. The exception handler deletes only a newly created authorization's exact
   reserved object, and only after the failure transaction confirms permission.
   A lost/failed database acknowledgement causes no blind deletion or URL
   disclosure. Replays/conflicts do not clean up another in-flight request.
3. Deletion verifies the generated prefix, Tenant/authorization identity,
   stored size/type/name/checksum metadata and evidence class, then uses
   `If-Match` on the current ETag. Missing objects are an idempotent success.
   Changed receipts, changed ETags and unexpected snapshots fail closed.
4. The private cleanup command inventories only generated objects in bounded
   pages. The operator-only database function applies eligibility using
   database time and atomically fences abandoned reservations. Each claim
   transaction must commit before storage deletion starts. Tenant context is
   restored and no new direct table grants are introduced.
5. Repeat inventory on every scheduled execution. Do not mark an authorization
   permanently "cleaned": a delayed upload after a crash must be discoverable
   on the next scan. Authorization, audit and idempotency records remain.
6. Unknown objects, integrity failures, scan-budget exhaustion or database/
   storage uncertainty produce a non-success maintenance result. Private keys,
   sample values, SAS URLs and pagination cursors are not reported.

## Operational enforcement and production boundary

Schedule the one-shot cleanup job every 15 minutes, without overlapping jobs,
with retries on a subsequent scheduled execution and alerts on any nonzero
exit/missed run. A healthy complete scan reclaims eligible objects on the next
scan after their grace period. This is not an exact physical deletion SLA:
storage/database outages, failed scans or a stopped scheduler defer deletion.

No scheduled task is automatically installed by this implementation. Deploy
the schedule explicitly. The current command uses the existing local Azurite
adapter; managed identity, production Blob composition and a production job
runner remain cloud-cutover work. The operator role must stay out of the
customer API deployment.

Azure lifecycle policies can serve as an additional production backstop on
the generated prefix, but are not the precise expiry-based cleanup mechanism.
Soft delete/versioning can retain deleted content and require their own
production retention choices.
[Microsoft lifecycle deletion documentation](https://learn.microsoft.com/en-us/azure/storage/blobs/lifecycle-management-policy-delete),
[Microsoft soft-delete behavior](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blob-delete-javascript).

No provider endpoint, payment, entitlement, Service, Run, Attempt, outbox job
or billable usage is created by cleanup.

## Verification and remaining work

Targeted tests cover cleanup permission, lost acknowledgements, Tenant/key
isolation, receipt integrity, ETag races, pagination, retry and private reports.
The isolated PostgreSQL proof replays all migrations and verifies eligibility,
forced-RLS/function privileges, authorization/audit preservation and late
completion fencing. Azurite tests additionally verify exact deletion and
source-object preservation when the emulator is available.

The M5 cleanup SQL proof seeds a current-schema governed fixture rather than
using the legacy M3 recorder. Migration `0065` separately restores and
qualifies that recorder against mandatory post-`0057` dictionary/governance
columns via the rollback-only M3 clean-PostgreSQL proof. This is still not the
broader clean-clone/application regression.

Vitest remains unchanged by request. Production storage composition and the
broader infrastructure-backed/clean-clone regression are still separate.
The spreadsheet-oriented CSV versus value-preserving JSON customer contract
is now accepted in [decision 0013](0013-marketplace-sample-download-formats.md).
This cleanup implementation does not change either serialization rule.

## Local activation: 2026-09-17

Migration 0064 was applied by the user to test/dev and the updated API was
restarted. Real Azurite deletion/expiry proof passed (2 tests). Windows Task
Scheduler now runs cleanup every 15 minutes and a separate health watchdog
every 5 minutes. `IgnoreNew` plus a shared wrapper file lock prevents overlap;
the scheduled child receives only a current-user DPAPI-protected operator/
storage profile, not provider credentials. Both actual scheduled tasks returned
result 0; the first cleanup removed 9 eligible generated copies. No source
sample/Run-result or authorization/audit record was deleted, and provider calls
were zero. Local error events and private structured alerts are verified.

This is local-demo retention enforcement, not cloud production activation:
interactive user/awake-machine/dependency availability are prerequisites.
Centralized alert routing, managed identity/storage and production maintenance
compute remain release gates. See the runbook for install/verify/rollback.
