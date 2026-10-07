# Refactor checkout status — 8 October 2026

The existing root `back-end/` and `front-end/` are the application. The local
context, frozen snapshots, database dumps, credentials and qualification logs
are private and excluded from Git. Do not create a second application from them.

The owner-authorized local `dhumi_test` database is applied through
[`0075_naming`](../../back-end/scripts/migrations/0075_naming.sql): **25 application
tables, 279 stored columns, 75 migration entries and zero SECURITY DEFINER
functions**. Migrations `0001`–`0075` retain their reviewed bytes. This statement
describes that database; cloning the repository does not provision a database.

The backend uses physical organization names and `app.organization_id` context.
Existing browser sessions, organization authorization, CSRF, transaction locks,
idempotent responses, Run starters/cancellation, Attempt fences and immutable
provider bindings remain supported. Persisted queue v1 `tenant_id`, storage
keys, fingerprint/AAD bytes and internal `tenantId` interfaces keep compatibility.
The canonical HTTP contract has 38 operations; regenerate clients from
[`back-end/contracts/openapi.yaml`](../../back-end/contracts/openapi.yaml).

Fresh local checks passed: all eight existing runtime logins and seven pool
factories, 113 retained-data assertions across 20 existing organizations, 36
rollback-only workflow assertions and four rebuilt compiled API assertions.
The default backend suite passed 1,153 tests; 101 historical database/emulator
tests were explicitly skipped. Retained data, application source and credentials
were unchanged by those checks; the temporary API is stopped.

Two findings remain: four legacy Attempt rows have no parent Run, and the owner's
normal private environment needs `OTP_SECRET` and `EMAIL_FROM`. Smoke values
were child-only and were not written into `.env`. There is no retained
Run/Service/Marketplace data; those write paths used rolled-back fixtures.

Existing runtime identities/passwords remain. The separate next identity phase
is at most three password-bearing logins with matching backend/bootstrap and
explicit grants. Legacy role retirement, full historical clean-clone/bootstrap,
live provider/mail/broker/storage and deployment qualification are pending.
No `dhumi_dev`, `dhumi_shared` or external environment was migrated by this work.

## Offline checks in a checkout

Use the existing lockfiles and Node.js 24. In each root package, run
`npm ci`, `npm run typecheck`, `npm test` and `npm run build`. Do not load a real
`.env` or enable the optional database/emulator suites for an offline run.
PowerShell-specific migration launcher tests require `pwsh` on Windows.

For the 8 October branch publication, a checkout containing only tracked files
passed both packages' typecheck/build and default tests: **1,153 backend tests
and 80 frontend tests**, with 101 optional backend database/emulator tests
skipped. It reused the installed locked dependencies and contained no private
environment or evidence files. The upstream price-analysis page and the
organization routes are both preserved. Unit signup requests now use explicit
dummy legal metadata, and dependency hashes use canonical LF line endings.

The unit-test qualification summary is a historical declaration fixture,
not a database execution receipt. Review launchers still require the full local
qualification/evidence/backup pins before application. Do not replay applied SQL,
run old bootstrap against the owner's database, or run a generic migration chain.
The final identity/bootstrap clean-install path is not qualified yet.
