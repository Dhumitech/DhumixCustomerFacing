# M5 Marketplace stored-sample download

M5 authorizes only the exact masked projection of Dhumi's governed stored
sample. It produces a bounded JSON or CSV object in private local storage,
returns a short-lived read-only URL, and commits an immutable authorization
audit before disclosing that URL.

It does not call Bright Data, create a Service or Run, publish an outbox event,
record billable usage, purchase data, or enable a full export.

Run the disposable PostgreSQL proof:

```powershell
Set-Location 'D:\BrightDataCustomerFacing\back-end'
& '.\tests\privileged\marketplace-sample-download\Invoke-MarketplaceSampleDownloadCleanDatabaseProof.ps1'
```

Apply migration `0050` only after reviewing the proof:

```powershell
& '.\tests\privileged\marketplace-sample-download\Apply-MarketplaceSampleDownloadMigration.ps1' -Target Both
```

The activation script prompts once for the PostgreSQL administrator password
and holds it only in child-process environment state. Provider calls: zero.

## Generated-download cleanup (migration 0064)

The expanded SQL proof also covers failed/abandoned-object cleanup, preservation
of committed authorizations, expired-object retention and late-completion fencing.
It requires all forward-only migrations through 0064. Source sample fixture
seeding uses the current dictionary/governance schema, not the legacy M3 helper.

For a Docker-free isolated PostgreSQL 18 proof on Windows:

```powershell
& '.\tests\privileged\marketplace-sample-download\Invoke-SampleDownloadCleanupNativeDatabaseProof.ps1'
```

See [the maintenance runbook](../../../../docs/runbooks/sample-download-cleanup.md)
for migration activation, the private cleanup command and its required schedule.
Installing the API does not install a schedule. The local Windows schedule has
an explicit install/inspect/remove script documented in that runbook. Its native
regression does not start workers or issue provider requests:

```powershell
powershell.exe -NoProfile -NonInteractive -File .\tests\privileged\marketplace-sample-download\Test-SampleDownloadCleanupMaintenance.ps1
npm.cmd test -- tests/unit/sample-download-cleanup-profile.test.ts
```

The native proof checks Windows PowerShell 5.1 atomic status-file updates,
cross-process overlap refusal, missed-run alert persistence and health states.
It keeps isolated `.runtime` drill evidence and writes clearly coded local
Windows error events; it does not mutate the live maintenance status or register
tasks. Production scheduler/centralized alert activation is a separate gate.
