# Pattern 7 Live Qualification Proof

This folder proves the private qualification infrastructure and records
separately authorized live evidence. The deterministic proof makes no Bright
Data request; the dated live-discovery evidence records the confirmed
read-only call. It reuses the existing operator LOGIN and adds no database
identity.

## 1. Apply Pattern 7 migrations 0033–0036

```powershell
Set-Location 'D:\BrightDataCustomerFacing\back-end'
& '.\tests\privileged\pattern7-live-qualification\Apply-Pattern7Migration.ps1' -Target Both
```

## 2. Run the rollback-only database state-machine proof

```powershell
& '.\tests\privileged\pattern7-live-qualification\Invoke-Pattern7DatabaseProof.ps1'
```

The proof creates synthetic encrypted-looking bytes inside a transaction and
rolls everything back. It proves import, review, qualification, evidence and a
disabled mapping while verifying that the Template, adapter and credential are
not published/enabled/activated.

## 3. Deterministic source and Azurite proof

```powershell
npx vitest run `
  tests/unit/amazon-qualification-service.test.ts `
  tests/unit/pattern7-qualification-migration.test.ts `
  tests/unit/pattern7-qualification-audit-rls-migration.test.ts `
  tests/unit/pattern7-qualification-template-version-rls-migration.test.ts `
  tests/unit/pattern7-qualification-source-guard.test.ts `
  tests/unit/qualification-environment.test.ts

$env:RUN_AZURITE_INTEGRATION_TESTS = 'true'
try {
  node --env-file-if-exists=.env.test node_modules/vitest/vitest.mjs run `
    tests/integration/pattern7-qualification-evidence-storage.test.ts
}
finally {
  Remove-Item Env:RUN_AZURITE_INTEGRATION_TESTS -ErrorAction SilentlyContinue
}
```

## Live-call boundary

Do not run `operator:amazon-qualification discover` or `qualify` merely to
complete this local proof. `discover` requires `--confirm-live`; `qualify`
requires `--confirm-billable`. Every qualification POST may consume Bright
Data capacity or credits and must be authorized separately, one operation at a
time.

The `inputs/` directory contains reviewed candidate inputs for live
qualification. Adding or validating a file is not authorization to send it to
Bright Data. Every use still requires the private command's separate
`--confirm-billable` gate, an explicit `--execution-mode scrape` or
`--execution-mode trigger`, and explicit operator approval. The endpoint mode
is persisted with the qualification; acceptance refuses a mapping whose
private execution policy names a different endpoint.
