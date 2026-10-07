# Pattern 4 Resilience Closure Harness

This folder activates and verifies the resilience implementation added after
the successful Pattern 4 authenticated happy-path proof.

It does not call Bright Data and cannot incur a provider charge. It uses the
controlled synthetic executor, PostgreSQL, the local Service Bus emulator,
Redis and Pattern 3 Azurite.

## 1. Apply migration 0030

Stop the Outbox Dispatcher and Job Manager before migration. Then run:

```powershell
Set-Location 'D:\BrightDataCustomerFacing\back-end'
& '.\tests\privileged\pattern4-resilience-e2e\Apply-Pattern4ResilienceMigration.ps1' `
  -Target Both
```

The administrator password is read once as a secure prompt, held only in the
current process for child `psql` calls, and cleared afterward. The accepted
migration runner verifies checksums and never edits migrations `0001`–`0029`.

## 2. Bootstrap the restricted operator LOGIN

Do this once per database if the operator LOGIN does not already exist:

```powershell
& psql `
  -h localhost -p 5432 -U postgres -W -d dhumi_test `
  -v ON_ERROR_STOP=1 `
  -v target_database=dhumi_test `
  -v operator_login_role=dhumi_test_operator_login `
  -f '.\scripts\bootstrap\0007_operator_runtime_role.sql'

& psql `
  -h localhost -p 5432 -U postgres -W -d dhumi_dev `
  -v ON_ERROR_STOP=1 `
  -v target_database=dhumi_dev `
  -v operator_login_role=dhumi_dev_operator_login `
  -f '.\scripts\bootstrap\0007_operator_runtime_role.sql'
```

Each command first asks for the PostgreSQL administrator password and then asks
twice for a new environment-specific operator password. Put those operator
passwords only in the ignored `.env.test` and `.env` files. Never put them in
an example file or commit them.

After setting the dev LOGIN password, store the same value in the ignored
`.env` file without displaying it:

```powershell
& '.\tests\privileged\pattern4-resilience-e2e\Set-Pattern4DevOperatorEnvironment.ps1'
```

## 3. Inspect readiness

```powershell
& '.\tests\privileged\pattern4-resilience-e2e\Inspect-Pattern4ResilienceReadiness.ps1' `
  -Target Test
```

The output must show migration `0030`, all three reconciliation/recovery
functions, and the restricted Dispatcher, Job Manager and operator LOGIN role
memberships.

## 4. Run component and emulator proofs

Keep the Dispatcher and Job Manager stopped so they cannot consume the test
messages. Then run:

```powershell
& '.\tests\privileged\pattern4-resilience-e2e\Verify-Pattern4ResilienceComponents.ps1' `
  -FullRegression
```

This proves strict command parsing, duplicate/terminal behavior, cancellation
races, durable reconciliation decisions, Redis fail-closed behavior, graceful
draining, controlled DLQ recovery, real Service Bus duplicate detection/DLQ
settlement, the full credential-free regression suite and the production build.

## 5. Restart and run final E2E

After `0030` and the operator configuration are ready, start:

```powershell
npm run worker:outbox
npm run worker:jobs
```

The existing authenticated Postman happy-path folder can then be rerun. The
formal closure matrix proves:

- duplicate delivery;
- Dispatcher and worker restart recovery;
- expired submission-lease reconciliation;
- cancellation during execution;
- retry lineage through the worker; and
- restricted operator DLQ recovery.

The matrix passed on 29 August 2026. Its durable record is
the private local record `evidence/2026-08-29_P4-RESILIENCE-001.md` (excluded from Git).
This evidence is not permission to replace the worker boundary with a mock or
to call Bright Data from the public API route.

## 6. Run the real-database resilience matrix

First put the test operator password in the ignored `.env.test` file as
`DATABASE_OPERATOR_PASSWORD`. Put the separate dev operator password in the
ignored `.env` file. Never add either value to an example file.

Stop the Outbox Dispatcher and Job Manager before running the matrix. The
matrix owns the emulator messages and fails closed if either external worker is
still active. The public API may remain running.

```powershell
Set-Location 'D:\BrightDataCustomerFacing\back-end'
& '.\tests\privileged\pattern4-resilience-e2e\Invoke-Pattern4ResilienceDatabaseMatrix.ps1' `
  -FullRegression
```

The administrator password is held only for child PostgreSQL test processes.
The matrix is rollback-safe and non-billable. It proves, against `dhumi_test`:

- duplicate dispatch and stale fencing safety;
- dispatcher/worker recovery and expired leases;
- cancellation races and retry lineage;
- durable reconciliation and exact-event DLQ recovery;
- restricted operator LOGIN isolation;
- real Service Bus duplicate detection and DLQ settlement;
- real Redis lease ownership and token checks;
- graceful worker shutdown behavior;
- the full credential-free regression suite; and
- the production TypeScript build.

After it passes, restart `worker:outbox` and `worker:jobs` for normal local
development.

The 29 August 2026 closure run passed all seven scenarios and the clean
baseline regression with 538 passed and 113 environment-gated skipped tests.
