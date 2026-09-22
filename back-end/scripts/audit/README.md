# Database Evaluation Pack

This pack checks the current PostgreSQL implementation against the active
requirements in `D:\BrightDataCustomerFacing\Project Specs`. It does not call
Bright Data and it does not create, alter, update, or delete application data.

The checks have two parts:

1. source checks inspect the forward-only migration and integration-test files;
2. live checks connect to PostgreSQL and run one `READ ONLY` transaction.

The scripts intentionally return exit code `2` when a required check fails.
That is a useful result: it means the database is not ready for the next module.

## 1. Open PowerShell

Use a normal PowerShell window. The PostgreSQL server must already be running.
Do not put the PostgreSQL password in a command, file, URL, or environment
variable. These scripts use `psql -W`, which asks for it interactively.

```powershell
$audit = 'D:\BrightDataCustomerFacing\back-end\scripts\audit'
$psql = 'C:\Program Files\PostgreSQL\18\bin\psql.exe'
```

## 2. Test the connection

For the development database:

```powershell
& "$audit\Test-DatabaseConnection.ps1" `
  -PsqlPath $psql `
  -ServerHost localhost `
  -Port 5432 `
  -DatabaseName dhumi_dev `
  -UserName postgres
```

Expected result: one server-identity row followed by
`PASS: database connection succeeded`.

## 3. Check migration source without touching PostgreSQL

```powershell
& "$audit\Test-MigrationSourceAgainstSpec.ps1"
```

This checks current product scope, Run states, immutable records, signup
idempotency, API-key lost-response storage, role boundaries, and required test
signals. It is intentionally stricter than a file-count check.

## 4. Run the full live read-only audit

```powershell
& "$audit\Invoke-DatabaseAudit.ps1" `
  -PsqlPath $psql `
  -ServerHost localhost `
  -Port 5432 `
  -DatabaseName dhumi_dev `
  -UserName postgres
```

Run the same audit against the isolated test database:

```powershell
& "$audit\Invoke-DatabaseAudit.ps1" `
  -PsqlPath $psql `
  -ServerHost localhost `
  -Port 5432 `
  -DatabaseName dhumi_test `
  -UserName postgres
```

Reports are written to:

```text
D:\BrightDataCustomerFacing\back-end\scripts\audit\output
```

The live audit checks:

- connection and PostgreSQL 18 cluster settings;
- database/schema ownership and capability-role safety;
- migration ledger checksums against the local SQL files;
- exact current table scope and forbidden old-product tables;
- `PUBLIC` privileges;
- required RLS and policies;
- composite Tenant foreign keys;
- immutable version/history tables;
- Run-state and transition-graph compatibility;
- Job Manager, outbox, and Integration Boundary privileges;
- plaintext-key absence and encrypted API-key replay storage; and
- signup existing-email and concurrency behavior visible in the function body.

## 5. Run rollback-only database behavior tests

Only use `dhumi_test`. The existing runner applies migrations and executes all
integration fixtures inside transactions that finish with `ROLLBACK`.

```powershell
& 'D:\BrightDataCustomerFacing\back-end\scripts\test-database.ps1' `
  -DatabaseUrl 'postgresql://postgres@localhost:5432/dhumi_test'
```

Do not run that command against `dhumi_dev`. The current test runner still needs
an explicit database-name safety guard before it can be considered misuse-proof.

## Meaning of statuses

- `PASS`: the inspected implementation satisfies that exact check.
- `WARN`: architecture can work, but a hardening or proof gap remains.
- `FAIL`: the current schema/function/privilege does not meet the accepted spec.
- `INFO`: context only; it does not affect the exit result.

A green script does not prove every business rule. Concurrency, transaction
rollback, object-storage ordering, Redis lease release, provider ambiguity, and
application response shaping still require behavioral/integration tests.

