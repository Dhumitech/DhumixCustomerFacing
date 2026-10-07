# 0070 retired-feature archive

Private local records mentioned below are excluded from Git. Checkout guidance is in [refactor status](../runbooks/refactor-status.md).

## Latest state — 0070 applied in dhumi_test

On 6 October 2026, the owner authorized application. The reviewed canonical
`back-end/scripts/migrations/0070_archive.sql` committed atomically with one
ledger entry. Database: 32 tables, 70 matching migration checksums. Populated
rollback qualification, existing-role/RLS/lock checks and retained journeys passed
before and after application. Runtime activation and later phases remain pending.
See the application/recovery receipt (private local record: `../../API-Design-Skill/NewRefactor/Context/After Refactor Context/Last touched Folders and apth/6-10/0070-Application.md`).

Private recovery material is in
`Checkpoints/Database-Exports/2026-10-06-before-0070-1791306808679`: a custom-format
dump, CurrentUser DPAPI encrypted key holder, verified restore instructions and
sanitized receipts. All row digests, RLS and function definitions matched after
restore; all 25 encrypted envelopes decrypted. Four pre-existing orphan Attempts
required restoring that table's data last with trigger suppression in the
isolated restore only. Live rows were preserved. There were no stored-object
references to restore. The temporary instance was stopped.

No source archive tag/commit was created, and the owner's source ZIP completion
is unverified. Preserve the frozen Before capture and matching pre-0070 source
with the dump. Recovery requires compatible pre-0070 code and owner-authorized
database restore; do not execute reversed SQL. Existing identities/passwords
and private env bytes were preserved. The janitor schema grant was revoked only
in dhumi_test. No other deployed database or cluster role was changed.

## Earlier offline source delivery (historical)

6 October 2026: the 0070 compatibility batch removes customer-key routes,
controllers, services and helpers, secret-response encryption/recovery, the
envelope janitor entry point/configuration/npm script, their feature-specific
tests, and the frontend API Keys page/client/navigation. Browser sessions remain
the customer authentication path. Bright Data provider credentials and the
durable Run/queue foundation remain supported.

Historical decisions are retained with superseded status:
[0004](../decisions/0004-response-envelope-port.md),
[0005](../decisions/0005-idempotency-tombstone-retention.md),
[0006](../decisions/0006-envelope-destruction-worker.md) and
[0007](../decisions/0007-dhumi-api-key-format.md).

Recovery material: the pre-refactor capture and SHA-256 manifest are in
Before (private local record: `../../API-Design-Skill/NewRefactor/Context/Before Refactor Conext/README.md`).
The execution rules (private local record: `../../API-Design-Skill/NewRefactor/Context/README.md`) govern
any recovery: restore only explicitly selected files into the root application,
record their hashes, and review the code/schema/contract dependencies together.
Historical snapshots are not an application build root.

No archive tag or committed snapshot was created by this batch. The owner's
separate ZIP location/completion, PostgreSQL dump filenames, private encryption
key backup and object-storage restore are not verified. These are pending archive
qualification, not completed backup evidence. The context tree is Git-ignored,
so collaborators need its separately distributed capture or a qualified archive.

The 0070 SQL remains a review draft outside the active migration chain. No
database change or role retirement has been applied. Existing PostgreSQL
identities and private environment credentials stay intact. Migrations 0001–0069
and their historical schema tests remain for replay; the retained role-membership
guard still rejects extra privileges, including legacy janitor membership.

Returning API keys requires a separately approved feature, a forward migration,
its authentication/replay contract and qualification. Do not restore this feature
into a database whose matching schema has already been removed.

## Remaining backend archive cleanup — 6 October 2026

Removed Marketplace catalogue imports, People metadata/contact/synthetic promotion,
qualification/export, the unused Filter executor and Amazon qualification/release
source, configuration, nine npm commands and feature-specific tests. Empty
activation/billing/quota placeholders are removed. ADRs [0010](../decisions/0010-marketplace-normalized-field-projection.md)
and [0011](../decisions/0011-marketplace-filter-fixture-adapter.md) are superseded.

Preserved catalogue, stored sample preview/query/downloads/enquiries/cleanup and
Posts fixture ingestion/inspection/expiry. Scraper draft onboarding still uses
the existing operator identity. Its configuration is now `operatorEnvironment.ts`;
fixture storage configuration is `marketplaceSampleEnvironment.ts`. Neither retained
command needs the retired qualification/release loader. Existing Amazon/shared
engine identity bytes remain pinned.

The shared `qualificationEvidenceReader.ts` moves byte-for-byte into
`services/marketplaceSample`; its historical qualification object-key rules and
integrity checks remain. It is not wired into a new promotion workflow. Promotion
from qualification packets is retired; the Target's Run-artifact replacement stays
deferred. Stored samples continue through the retained customer path.

Original 0001–0069 SQL and static migration-history tests stay. Mixed tests lose
only retired runtime assertions; the Filter digest test verifies the recorded
historical digest rather than reading removed implementation files. Old privileged
harnesses are explicitly [historical](../../back-end/tests/privileged/README.md),
not current 0070 qualification commands.

No SQL, data backfill, role/password change or provider/process activation occurred.
The draft already specifies metadata contact/count backfills and replacement
retained SQL helpers; populated real-role/RLS/lock, restore and cutover qualification
remain pending. The default review launcher still conservatively flags retained
legacy secret redaction; that guard is preserved and the apply gate remains blocked.
