# M10 Marketplace export candidate proof

This proof replays the complete migration chain in a disposable PostgreSQL 18
container and runs the rollback-only M10 integration fixture. It uses protected
fixture bytes and performs no network or Bright Data operation.

```powershell
Set-Location 'D:\BrightDataCustomerFacing\back-end'
& '.\tests\privileged\marketplace-export-candidate\Invoke-MarketplaceExportCandidateCleanDatabaseProof.ps1'
```

The proof verifies the disabled adapter, private Template v2, self-AAD-bound
Provider Mapping, immutable qualification lineage, operator-only privileges,
idempotent replay, unchanged public pointer, and absence of Service/Run/outbox
work.

Apply migration `0056` to the persistent local databases without registering
or publishing a candidate:

```powershell
& '.\tests\privileged\marketplace-export-candidate\Apply-MarketplaceExportCandidateMigration.ps1' -Target Both
```

After the protected operator has registered the exact accepted M9 packet,
verify the resulting disabled candidate by supplying its immutable mapping ID:

```powershell
& '.\tests\privileged\marketplace-export-candidate\Verify-MarketplaceExportCandidate.ps1' `
  -Target Dev `
  -MappingId '<mapping UUID>'
```

All three scripts are offline. They neither call Bright Data nor create a
customer Service, Run, outbox event or execution Attempt.
