# M4 Marketplace stored-sample preview

M4 exposes only the governed synthetic LinkedIn Posts sample through Dhumi's
authenticated catalogue boundary. LinkedIn People is intentionally absent.
The implementation performs local reads, filtering, projection, sorting and
pagination and never calls a provider.

Run the disposable PostgreSQL proof:

```powershell
Set-Location 'D:\BrightDataCustomerFacing\back-end'
& '.\tests\privileged\marketplace-preview\Invoke-MarketplacePreviewCleanDatabaseProof.ps1'
```

Apply migration `0049` after reviewing the proof:

```powershell
& '.\tests\privileged\marketplace-preview\Apply-MarketplacePreviewMigration.ps1' -Target Both
```

The activation script asks once for the PostgreSQL administrator password and
holds it only in child-process environment state. It makes zero Bright Data
calls.
