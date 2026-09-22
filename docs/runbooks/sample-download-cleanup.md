# Generated Marketplace sample-download maintenance

Scope: generated private JSON/CSV download copies only. No Bright Data calls,
no provider workers, no source sample/Run-result deletion and no audit-row
deletion. Policy: [decision 0012](../decisions/0012-generated-sample-download-retention.md).

## 1. Verify the database change safely

With PostgreSQL 18 binaries on PATH, this creates a new loopback-only test
cluster on port 55464, replays all migrations, runs rollback-only SQL assertions
and shuts down that cluster. It never connects to `dhumi_dev`/`dhumi_test` or
starts Docker, the portal, API or provider workers. Evidence is retained under
ignored `back-end/.runtime/`; the trust-authenticated test cluster must not be
restarted or exposed as a real application database.

```powershell
Set-Location 'D:\BrightDataCustomerFacing\back-end'
& '.\tests\privileged\marketplace-sample-download\Invoke-SampleDownloadCleanupNativeDatabaseProof.ps1'
```

The existing Docker-based M5 clean proof also uses the expanded SQL assertions
and requires migration 0064.

## 2. Apply migration 0064 before deploying the updated API

Review pending migrations first. These commands use the normal forward-only
runner (all pending migrations, not just 0064) and securely prompt for the
administrator password. They do not restart workers or submit provider work.

```powershell
.\scripts\migrate.ps1 -DatabaseUrl 'postgresql://postgres@localhost:5432/dhumi_test' -PromptForPassword
.\scripts\migrate.ps1 -DatabaseUrl 'postgresql://postgres@localhost:5432/dhumi_dev' -PromptForPassword
```

Confirm `0064_marketplace_sample_download_cleanup` is in `app.schema_migrations`
with the SHA-256 of its checked-in SQL. Do not change an already applied migration.
Deploy/restart only the updated API through its normal launcher when appropriate.

## 3. Run the bounded private cleanup job

Requirements: verified operator login, PostgreSQL and private loopback Azurite.
The existing ignored `.env` supplies `DATABASE_*`, `DATABASE_OPERATOR_*` and
`RESULT_STORAGE_*`. No Bright Data token/reference key, Service Bus or Redis
settings are required. `NODE_ENV=production` is deliberately rejected until
the production storage composition is available.

```powershell
npm.cmd run operator:marketplace-download-cleanup -- --expected-database dhumi_dev --confirm-delete-generated-objects
```

This is a deleting operation: confirmed failed/abandoned copies and copies whose
signed links expired more than one hour ago are removed from active storage.
Azure soft-delete/version history, if configured later, may still retain them.
This command does not remove source samples, raw/normalized results, database
records or download audits. The customer-facing endpoint remains unchanged.

Defaults: 100 listed objects per page, at most 1,000 pages. Optional bounds:

```powershell
npm.cmd run operator:marketplace-download-cleanup -- --expected-database dhumi_dev --page-size 100 --max-pages 2000 --confirm-delete-generated-objects
```

Summary fields: `pages`, `examined`, `deleted`, `absent`, `protected`, `untracked`,
`ignored`, `failures`, `complete`, `providerCalls: 0`.
Exit 1 requires review (including incomplete scans). Do not weaken the object/
database integrity checks to silence a failure. Never add unconditional deletes.

## 4. Schedule retention enforcement

Use an approved maintenance scheduler every 15 minutes; prevent overlapping
runs. Provision the private job with only operator/storage configuration, not
provider secrets or worker composition. Alert on missed runs, exit 1, unknown
objects, repeated failures and scan-budget exhaustion. Increase a verified
bounded scan budget when inventory grows; a successful complete scan is required
for the retention policy to be enforced across the whole generated prefix.

### Windows local-demo schedule

The checked-in installer registers two limited, current-user Windows tasks:

| Task | Interval | Function |
| --- | --- | --- |
| `Dhumi-SampleDownloadCleanup` | 15 minutes | Runs bounded generated-object cleanup |
| `Dhumi-SampleDownloadCleanup-Watchdog` | 5 minutes | Alerts on failed, stalled or missed cleanup |

Provision and register on each developer machine (not on production compute):

```powershell
Set-Location 'D:\BrightDataCustomerFacing\back-end'
powershell.exe -NoProfile -NonInteractive -File .\scripts\Register-SampleDownloadCleanupSchedule.ps1 -Action Install -ExpectedDatabase dhumi_dev
```

Only provisioning reads the existing ignored `.env`. It selects an explicit
operator/storage allowlist and encrypts it using current-user Windows DPAPI in
ignored `.runtime/sample-download-cleanup-maintenance/configuration.dpapi`.
The directory ACL permits only the current user, SYSTEM and administrators.
The cleanup child starts with a cleared environment plus essential Windows
variables and that allowlist: no Bright Data tokens, API/admission credentials,
`NODE_OPTIONS`, full `.env` loading or provider worker configuration. Do not copy
the protected profile between users/machines. After local credential/config
rotation, refresh it with `-Action Prepare` and verify a manual run.

Each task uses `MultipleInstances=IgnoreNew`, a hidden launcher and
`StartWhenAvailable`. Cleanup also takes an exclusive file lock shared by
scheduled/manual **wrapper** invocations. The raw npm operator command above
does not take that wrapper lock; do not run it alongside the installed schedule.
The cleanup child has a ten-minute timeout with termination limited to that
child process tree. Unverified objects remain protected; failed/incomplete
scans, ignored/untracked objects or missing summaries yield exit 1.

Failure alerts are local: fixed safe codes in daily private `alerts-*.jsonl`
and Windows **Windows PowerShell** log, source **PowerShell**, error event
**1001**. Installation verifies actual event delivery. The watchdog detects
failed status, a worker running over 11 minutes, unreadable status, or no
successful/pending run for over 20 minutes. It never loads credentials or
starts the cleanup/provider worker. Synthetic drill events are clearly marked
by codes such as `alert_delivery_self_test`; drill fixture state is separate
from the live maintenance status. These are durable local error signals, not
email/SMS/remote notifications. Event 1001 payload is in the event's Data/
Properties; its rendered Message can be blank with the built-in source.

Verify registration and the last run:

```powershell
powershell.exe -NoProfile -NonInteractive -File .\scripts\Register-SampleDownloadCleanupSchedule.ps1 -Action Inspect
powershell.exe -NoProfile -NonInteractive -File .\scripts\Invoke-SampleDownloadCleanupMaintenance.ps1 -Mode Status
```

Run a deliberate immediate cleanup/health check through Task Scheduler:

```powershell
Start-ScheduledTask -TaskPath '\' -TaskName 'Dhumi-SampleDownloadCleanup'
Start-ScheduledTask -TaskPath '\' -TaskName 'Dhumi-SampleDownloadCleanup-Watchdog'
```

Read only these local maintenance error payloads (no source sample data):

```powershell
Get-WinEvent -FilterHashtable @{ LogName='Windows PowerShell'; Id=1001 } -MaxEvents 50 |
    ForEach-Object { [pscustomobject]@{ Time=$_.TimeCreated; Alert=($_.Properties | ForEach-Object { $_.Value }) -join ' ' } } |
    Where-Object { $_.Alert -like 'Dhumi sample-download cleanup alert:*' }
```

These are interactive-token tasks: the registered user must remain signed in,
the computer awake and PostgreSQL/Azurite available. Nothing runs or alerts
while the machine is off or the user is signed out. Missed work is retried when
available; do not claim a hard deletion deadline during those outages. For
production, use approved managed compute/identity and independent centralized
monitoring/notification routing. Merely deploying the API does not install any
schedule; the documented Windows schedule was explicitly activated locally.

The implementation follows Microsoft's documented
[IgnoreNew task policy](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-multipleinstancespolicy-settingstype-element)
and [Windows DPAPI encryption without an explicit key](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/convertfrom-securestring).
The timing/grace limits are Dhumi local policy choices, not Microsoft or ISO
requirements. Job logging is pinned to `info` so a quieter API logging setting
cannot suppress completion evidence.

Rollback (wait until neither task is Running; this removes only owned tasks):

```powershell
powershell.exe -NoProfile -NonInteractive -File .\scripts\Register-SampleDownloadCleanupSchedule.ps1 -Action Remove
```

Private profile/status/alerts are retained; no storage object or database row
is deleted by removal. Without a replacement schedule, periodic retention
enforcement stops. Object deletion itself has no undo operation in this tool;
recoverability depends on separately configured storage protection/backups.

## 5. Run focused regression

```powershell
npm.cmd run typecheck
npm.cmd test -- tests/unit/marketplace-sample-download-service.test.ts tests/unit/marketplace-sample-download-cleanup.test.ts tests/unit/marketplace-sample-download-cleanup-repository.test.ts tests/unit/marketplace-sample-download-cleanup-migration.test.ts tests/unit/azurite-marketplace-sample-download-cleanup.test.ts
npm.cmd run build
powershell.exe -NoProfile -NonInteractive -File .\tests\privileged\marketplace-sample-download\Test-SampleDownloadCleanupMaintenance.ps1
npm.cmd test -- tests/unit/sample-download-cleanup-profile.test.ts
```

With Azurite already running and a private test connection configured, run the
real storage proof (test creates/deletes its own random test container only):

```powershell
$previousFlag = $env:RUN_AZURITE_INTEGRATION_TESTS
try {
    $env:RUN_AZURITE_INTEGRATION_TESTS = 'true'
    node --env-file-if-exists=.env.test node_modules/vitest/vitest.mjs run tests/integration/azurite-marketplace-sample-download.test.ts
    if ($LASTEXITCODE -ne 0) { throw 'Azurite sample-download regression failed.' }
}
finally {
    if ($null -eq $previousFlag) { Remove-Item Env:RUN_AZURITE_INTEGRATION_TESTS -ErrorAction SilentlyContinue }
    else { $env:RUN_AZURITE_INTEGRATION_TESTS = $previousFlag }
}
```

The default suite's skipped integration/privileged tests are not proof of a
working infrastructure-backed production journey. Clean-clone replay, all
required infra tests and cloud-managed storage remain distinct release gates.

## Verification snapshot: 2026-09-17

- Focused cleanup/serialization tests: 45 passed.
- Full backend default suite after schedule work: 993 passed, 129 skipped
  (165 passed files, 32 skipped); additional profile-boundary tests: 5 passed.
- Backend typecheck and production build: passed.
- Production-dependency audit: zero findings; Vitest intentionally unchanged.
- Fresh isolated PostgreSQL 18 replay: all 64 migrations and the expanded
  rollback-only authorization/retention assertions passed; cluster shut down.
- Real Azurite storage proof: 2 tests passed against loopback port 10000;
  exact bytes, signed-link before/after expiry, exact-object deletion,
  repeat deletion, Tenant/checksum rejection and source-object preservation.
  Only the proof's own random test container was created/removed.
- Migration 0064: user-applied successfully on `dhumi_test` and `dhumi_dev`.
  User restarted the Customer API; `/v1/status` returned HTTP 200 operational.
- Windows local schedule: explicitly installed for the current user, 15-minute
  cleanup and 5-minute watchdog, `IgnoreNew` verified in exported task XML.
  Both were explicitly run through Task Scheduler and returned result 0.
  Current status: succeeded, full scan complete, zero failures/untracked objects.
- First actual cleanup: 9 eligible generated download copies deleted,
  no source/Run-result deletion or authorization/audit-row deletion.
  Subsequent scheduled verification found zero remaining generated copies.
- Minimal protected profile/ACL, actual local error-event delivery and native
  PowerShell health/lock/status regression verified; no remote alert route
  or cloud production runner provisioned.
- Bright Data calls: zero. No provider worker started; executor remains controlled.

This is an implementation verification record, not a production release sign-off
or a claim that all infrastructure-backed/clean-clone tests have passed.
