# Database refactor review scripts

Private local records mentioned below are excluded from Git. Checkout guidance is in [refactor status](../../../docs/runbooks/refactor-status.md).

**Current state: 0070–0075 applied and checked only in 127.0.0.1:5432/dhumi_test: 25 tables, 279 stored columns and 75 migration entries; zero SECURITY DEFINER functions.** Read [public checkout status](../../../docs/runbooks/refactor-status.md) first. All 75 checksums, 113 preservation, 29 connection/read, 36 rollback workflow and four compiled API checks pass. Both packages pass typecheck/build/tests (1,153 backend, 79 frontend). Private .env still needs owner-provided OTP_SECRET and EMAIL_FROM for normal startup. Existing identities/passwords are unchanged; temporary processes are stopped. Next is the separate at-most-three password-bearing identity consolidation. Earlier counts and readiness states below are dated boundaries.

## 0075 applied boundary

[Canonical applied SQL](../migrations/0075_naming.sql) equals the [draft](0075_naming.draft.sql); the [manifest](0075_naming.manifest.json) pins immutable qualification and actual application. [Review-0075.ps1](Review-0075.ps1) defaults to offline review; application was exactly one SQL body plus an atomic checksum ledger row. Do not rerun it or preparatory generators, old preflights or committing fixture helpers on applied main. The original qualified SQL/receipt remain unchanged. Existing capabilities/logins stay until the separate backend/grant/bootstrap identity refactor is qualified; cluster retirement and full historical clean-clone replay remain pending.

**0070 applied and checked on 6 October 2026.** Scope is only `localhost:5432/dhumi_test`,
the first table phase (43 → 32). Later table migrations and identity consolidation
remain separate. Existing login identities/passwords and private env files stay
unchanged. Revoking the retired janitor's schema grant in this database is part
of Target §9's 0070, not cluster role retirement.

## Dated 0073 applied boundary

[Canonical SQL](../migrations/0073_catalogue_execution_contract.sql) equals [draft](0073_catalogue_execution_contract.draft.sql); [manifest](0073_catalogue_execution_contract.manifest.json) pins exact qualification. [Review-0073.ps1](Review-0073.ps1) defaults to offline review: no credential read, database connection or SQL execution. [Test-0073-Offline.ps1](Test-0073-Offline.ps1) passes 39 fake-client checks. Actual PostgreSQL qualification uses only the isolated restored cluster (private local record: `../../tests/privileged/refactor-0073/README.md`).

The owner explicitly approved application and backend tests. The unchanged bounded launcher/runner committed only 0073 in one body+ledger transaction after immediate source/evidence/dump/key, fixed-target, idle and row/schema/history checks. Manifest now pins the latest application receipt. SQL's review-only header and old qualification JSON are immutable dated evidence; applied bytes must never be rewritten. Default launcher remains offline; do not replay qualification/apply helpers against contracted main. Existing credentials/identities stay; 0074/0075, ongoing runtime and live provider/email/storage/deployment remain separate.

## Earlier authoritative files

The following descriptions are dated preceding boundaries; they do not replace the current 0075 applied state above.

Latest boundary: 0072 applied and checked (private local record: `../../../API-Design-Skill/NewRefactor/Context/After Refactor Context/Last touched Folders and apth/7-10/0072-0073-Backend/0072-Application/README.md`), following direct owner approval. [Canonical SQL](../migrations/0072_catalogue_execution_expand.sql) remains byte-identical to the approved [draft](0072_catalogue_execution_expand.draft.sql). [Manifest](0072_catalogue_execution_expand.manifest.json) reports applied state and pins the application receipt. The dataset operator (private local record: `0072-dataset-operator.mjs`) recognizes applied state, retains all scope/hash/ledger/write gates and verifies the empty main binding set without a write. 0073 audit (private local record: `../../../API-Design-Skill/NewRefactor/Context/After Refactor Context/Last touched Folders and apth/7-10/0072-0073-Backend/0072-Application/0073-Readiness.md`) is the dated initial gap analysis, superseded by the final 0073 handoff. Earlier qualification (private local record: `../../../API-Design-Skill/NewRefactor/Context/After Refactor Context/Last touched Folders and apth/7-10/0072-0073-Backend/0072-Expansion-Qualification/README.md`) retains its immutable structured receipt and old operator hash. Do not replay old qualification helpers against the applied database.

- [../migrations/0070_archive.sql](../migrations/0070_archive.sql) is the **only
  migration body** to inspect. It retains the draft's gates, backfills, helper
  replacements, dependency/row/RLS assertions and eleven RESTRICT table drops.
- [Review-0070.ps1](Review-0070.ps1) defaults to offline review, prints that file's
  SHA-256 and scans the existing backend/contract. It neither reads `.env` nor
  connects by default. Only eight exact envelope-redaction literals inside the
  known logger array are exempted; unknown references and SQL still block.
- [../migrate.ps1](../migrate.ps1) owns the transaction and **one final ledger
  INSERT**, with the reviewed canonical file's checksum. The launcher delegates
  to its bounded 0070 path, which never applies earlier/later migrations. An
  already-applied matching checksum is skipped; a mismatch is rejected. The
  generic chain command refuses the refactor boundary before any connection.
- [0070_archive.draft.sql](0070_archive.draft.sql) is a retired-path refusal
  stub. It contains no migration body and must not be used for application.
  Prior live/rollback receipts describe the previous draft bytes, not the
  revised canonical migration.
- Inspect-DhumiTest.sql (private local record: `Inspect-DhumiTest.sql`) remains the unchanged read-only
  inspection script. It is not an apply command.

## Offline verification

From this folder:

```powershell
.\Review-0070.ps1
.\Test-0070-Offline.ps1
```

[Test-0070-Offline.ps1](Test-0070-Offline.ps1) uses temporary script copies, a
fake psql child and a dummy secure-string prompt. It tests guarded refusal,
redaction/reference classification, exact transaction/ledger arguments,
already-applied handling and environment restoration. It uses no real password,
database connection or private env file. It does not prove PostgreSQL writes.

## Application evidence and remaining boundaries

The owner authorized application with "Please apply the migration and do proper
checks". The exact canonical checksum was applied atomically with one ledger row.
Backup restore, all 25 protected-envelope decryptions, 34 populated rollback checks
under existing roles, 33 post-application rollback checks and 149 preservation,
ledger/RLS/credential checks passed. Backend/frontend typechecks, builds and
924/71 tests passed. The database contains 32 tables and 70 applied migrations.
See the application record (private local record: `../../../API-Design-Skill/NewRefactor/Context/After Refactor Context/Last touched Folders and apth/6-10/0070-Application.md`)
for recovery instructions and exact limits. The queue emulator was offline;
six queue protocol/dispatcher/worker files match the frozen baseline byte-for-byte,
with no unpublished job commands or connected runtime logins. No broker traffic
or runtime activation was performed. No stored-object references existed, so a
real-object restore was not applicable. Existing orphan Attempt data was preserved.
The four launcher attestations remain prerequisites for any separate application;
the flags themselves are not proof. Later migrations/identities remain pending.

An eventual `-Apply` requires the **canonical** SQL hash the owner actually
reviewed and all four existing attestations. It securely prompts for an existing
administrator password in memory and fixes host/port/database. Application is
never part of the default review or offline regression commands above.

`scope_kind` remains for existing signup/tenant idempotency writers. Its removal
belongs to their later matching cutover. Historical sample UUIDs, legacy helper
signatures and later phase work retain the draft's existing boundaries.

## 0071 fixture cleanup — applied and checked on 7 October 2026

0071_fixture_cleanup.draft.sql (private local record: `0071_fixture_cleanup.draft.sql`) is the exact
reviewed test-data cleanup that was applied to **127.0.0.1:5432/dhumi_test**.
It is **not migration 0071**. Its fixed UUID manifest (private local record: `0071_fixture_cleanup.targets.psql`),
preflight (private local record: `0071_fixture_cleanup.preflight.sql`) and
catalog fingerprint (private local record: `0071_fixture_cleanup.schema.sql`) remain byte-identical.
The script header records its earlier preparation state; the dated
qualification (private local record: `../../../API-Design-Skill/NewRefactor/Context/After Refactor Context/Last touched Folders and apth/7-10/0071-Test-Fixture-Cleanup-Qualification.md`)
and application report (private local record: `../../../API-Design-Skill/NewRefactor/Context/After Refactor Context/Last touched Folders and apth/7-10/0071-Test-Fixture-Cleanup-Application.md`)
give the later verified status for those exact hashes.

Exactly **1,025 disposable organizations / 5,498 rows** were deleted in one
transaction: 770 signup replay records, 770 outbox records, 1,138 audit records,
770 legal acceptances, 1,025 access rows and 1,025 organizations. There are now
**10,192 organizations** (9,751 active; 441 suspended), **10,962 users**,
**32 tables and 70 applied migrations**. Creator and active-owner blockers are zero.

Fresh qualified backup/isolated restore proof and six rollback/refusal cases
preceded application. All script/backup hashes, live row/catalog drift gates and
idle runtime checks passed again. Every unselected row, user/session/token,
schema/function/RLS/FK/immutable guard/ACL/default/sequence and ledger baseline
matched afterwards. Existing identities/passwords and private env remain.

**81/81 compatible database tests passed across 19 files**, with no failures or
skips. Their new fixtures were removed by exact primary keys in child-first
order, with FK checks enabled and only the two history guards temporarily
disabled/restored in that transaction. The complete post-cleanup baseline
matched again. Three post-test history/FK rejection probes also passed and
rolled back. Application source, tests, packages and migrations were not edited.

Keep the four SQL files as frozen execution evidence. They default to read-only
preview and contain no credentials. **Do not rerun the old preview/apply commands
as a next-step operation:** their fixed pre-cleanup UUID/count/digest gates now
intentionally reject the changed database. They are not the future 0071 migration.
The owner-approved cleanup is complete; the next separate work is the matching
0071 organization migration/backend batch. Runtime activation and identity
consolidation remain pending.

## 0071 organizations — applied and verified on 7 October 2026

[0071_organizations.draft.sql](0071_organizations.draft.sql) and
[canonical SQL](../migrations/0071_organizations.sql) have identical reviewed
bytes, SHA-256 `af85bea48d8bb0e4c77ba9d301a23977ecfc33b5fe77ded0469c207e13e17bd9`. They represent one applied migration; never execute the draft as another application. The body
refuses execution by default and contains no transaction COMMIT or ledger write.
[0071_organizations.manifest.json](0071_organizations.manifest.json) records its
exact SHA-256, field changes, dated qualification and current `APPLIED_VERIFIED_MAIN_DHUMI_TEST` application receipt. The SQL's dated review-only header is historical; the database ledger and application receipt establish its applied status. Applied SQL bytes remain immutable.
This is distinct from the already-applied fixture cleanup above.

Applied intermediate schema: **32 → 35 tables**, adding invitations,
verification challenges and two-column selected-template access. Remove 20
planned identity/legal/organization fields; backfill proven creators, admin
roles, session reasons and state-specific token ends; preserve extra token and
suspension history as 467 audit facts. Final 25-table naming/schema is later.
Existing identities/passwords and private env remain unchanged.

Read-only source inspection, all 70 applied SQL checksums, 28 static checks and
the actual default refusal passed; full data/catalog/ledger baseline matched.
The exact mutation body, checksum-bound ledger insertion and forced-failure
rollback passed before application. The dated PostgreSQL qualification (private local record: `../../../API-Design-Skill/NewRefactor/Context/After Refactor Context/Last touched Folders and apth/7-10/0071-Organizations/PostgreSQL-Qualification/README.md`)
records fresh dump/key restore and 40 actual retained-login/backend/RLS/race cases.
[Review-0071.ps1](Review-0071.ps1) defaults to local review and validates exact
SQL/qualification/source/evidence/backup hashes before any application prompt.
The owner's editable invitation-resend lifetime is implemented and qualified
(seven days by default, no shortening, Target's 202). The owner approved “Apply reviewed 0071”; fresh stopped-process/queue/source checks preceded its atomic application through the unchanged reviewed launcher and runner. Existing
identities/private env/0001–0070 are unchanged. Runtime and real email/release
gates remain separate. Earlier evidence is retained under its dated scope.

The current application handoff (private local record: `../../../API-Design-Skill/NewRefactor/Context/After Refactor Context/Last touched Folders and apth/7-10/0071-Organizations/PostgreSQL-Application/README.md`) records **35 tables, 71 ledger entries**, all prior 70 checksums, retained data, eight existing login checks and 20 rollback-only main backend assertions passing. No synthetic rows persist. The isolated qualification server is stopped and recovery data retained. Do not run historical helpers that expect 32 tables/70 entries against the applied schema. Next is existing backend preparation for 0072/0073; those migrations remain unapplied.

The dedicated 7-10 handoff (private local record: `../../../API-Design-Skill/NewRefactor/Context/After Refactor Context/Last touched Folders and apth/7-10/0071-Organizations/README.md`)
holds the field manifest, exact root backend dependency map, proposed privilege
matrix, historical-clock treatment, operator audit dependency and verification.
Application code remains in the existing root packages; After holds records only.
