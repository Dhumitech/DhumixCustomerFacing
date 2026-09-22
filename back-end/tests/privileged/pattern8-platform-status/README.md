# Pattern 8 Priority 3 — Platform status proofs

This folder proves the final public API without a Bright Data call, a new
database identity or a Tenant fixture.

Run the disposable PostgreSQL 18 replay first:

```powershell
& '.\tests\privileged\pattern8-platform-status\Invoke-Pattern8PlatformStatusCleanDatabaseProof.ps1'
```

Activate migration `0039` on local test and dev databases:

```powershell
& '.\tests\privileged\pattern8-platform-status\Apply-Pattern8PlatformStatusMigration.ps1' -Target Both
```

Then run the rollback-only state and privilege proof:

```powershell
& '.\tests\privileged\pattern8-platform-status\Invoke-Pattern8PlatformStatusDatabaseProof.ps1' -Target Both
```

Both real-database scripts request the PostgreSQL administrator password
interactively and retain it only for their child processes.
