# Privileged test selection during the refactor

Private local records mentioned below are excluded from Git. Checkout guidance is in [refactor status](../../../docs/runbooks/refactor-status.md).

## Current 0075 application and test selection

0075 is applied and verified only in `127.0.0.1:5432/dhumi_test`: **25 tables,
279 stored columns, 75 migrations, zero SECURITY DEFINER functions**. Read the
[public checkout status](../../../docs/runbooks/refactor-status.md).
Root packages typecheck/build/tests pass; actual retained-login, main rollback
workflows and compiled API checks pass. No fixture rows persist. Existing
identities/passwords remain; normal startup still needs OTP_SECRET/EMAIL_FROM.

The new organizations-0075-database.test.ts and vitest.0075-qualification.config.ts
select the schema-compatible organization harness only. Committing fixtures
were restricted to the separately created same-named cluster on port 65475,
which is now stopped. Other refactor-0075 helpers are dated preparation,
qualification/application or verification tools, not automatic test entry points.
Do not rerun migration generators, old preflights or apply helpers against
applied main. Old 0071–0074 qualification fixtures target their dated schema;
never repoint them to main or enable them from the default package suite.

New database setup/execution, process activation, provider traffic and identity
retirement require their own task scope. Original history remains immutable.

## Dated 0071 application status (7 October 2026)

0071 is applied and checked only in `127.0.0.1:5432/dhumi_test`: 35 tables/71
migrations. Read the application record (private local record: `../../../API-Design-Skill/NewRefactor/Context/After Refactor Context/Last touched Folders and apth/7-10/0071-Organizations/PostgreSQL-Application/README.md`).
The organization qualification harness is explicitly opt-in and hard-bound to
isolated loopback port 65471; it passed 40 actual retained-login/concurrency cases
before application. Its isolated server is now stopped. Main post-checks use
rollback-only fixtures and verified all eight existing logins. Do not repoint the
isolated committing-fixture harness to main, run obsolete 32-table preflights,
or treat historical harnesses below as authorization to touch another database,
restart runtime, call providers or retire identities.

## Historical 0069/0070 harness notes

These harnesses were written for the original migration chain through `0069`.
They can apply SQL, create/drop databases or containers, load private environment
files, start processes, or contact providers. Their presence does not authorize execution.

The 0070 source cleanup retires Marketplace imports, People activation/contact
contracts, qualification/export, Filter execution and Amazon qualification/release.
Their harnesses and dated evidence remain as migration history; their npm commands
and runtime services have been removed. Do not execute those harnesses in this
checkout or use old `Both`/development targets for the refactor. Customer API-key
proofs are also historical after customer-key removal.

Retained Marketplace preview/query/download/enquiry/cleanup and Posts fixtures
still need populated 0070 tests under actual database roles, RLS and transaction
locks. Existing historical proofs do not establish that compatibility. Prepare
and review the matching 0070 harness before any database execution.

The owner has limited future database work to `dhumi_test`. The current source
cleanup authorizes offline checks only. Original migrations remain immutable;
neither a rollback rehearsal nor an old activation command is authorized here.
Application startup must wait for the matching reviewed schema.
