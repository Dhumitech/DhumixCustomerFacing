# M2 Marketplace catalogue import

**HISTORICAL — original migration chain through 0069.** The 0070 source cleanup
removes the qualification/import/export/release operators used by this harness.
Commands and database targets below are historical receipts, not current instructions.
Do not run this harness against the refactoring checkout or use it to qualify 0070.
Retained customer sample journeys require a separately reviewed 0070 proof.
See [privileged test boundaries](../README.md).


M2 adds a private, review-first Marketplace Dataset catalogue boundary for the
accepted first-release offers:

- LinkedIn Posts
- LinkedIn People (standard profile data only)

It uses only the documented Dataset list and Dataset metadata contracts. It
does not add a customer route, publish a Template, create a provider execution
mapping, enable the adapter, perform filtering, purchase data or expose a
provider Dataset identifier.

## Prove the migration in a disposable database

```powershell
Set-Location 'D:\BrightDataCustomerFacing\back-end'
& '.\tests\privileged\marketplace-catalogue\Invoke-MarketplaceCatalogueCleanDatabaseProof.ps1'
```

This command makes zero Bright Data requests.

## Apply migration 0045

```powershell
& '.\tests\privileged\marketplace-catalogue\Apply-MarketplaceCatalogueMigration.ps1' -Target Both
```

The password is held only by migration child processes and cleared afterward.

## Run the rollback-only proof

```powershell
& '.\tests\privileged\marketplace-catalogue\Invoke-MarketplaceCatalogueDatabaseProof.ps1' -FullRegression
```

## Fixture-first import

```powershell
npm.cmd run operator:marketplace-catalogue -- import `
  --source fixture `
  --fixture-directory 'D:\BrightDataCustomerFacing\back-end\tests\fixtures\marketplace-catalogue' `
  --actor m2.local.fixture `
  --evidence-reference checkpoint://dataset-market/m2/fixture
```

The fixture import contacts only PostgreSQL and private object storage. Bright
Data requests: zero.

## Provider read boundary

A provider import performs exactly three read-only HTTP requests: one Dataset
list request and one metadata request for each accepted LinkedIn offer. It is
not executed by migration, application startup or a customer request. The
operator rejects it unless `--confirm-read-only-provider` is supplied.

Do not run it without first reviewing the request count, current provider
commercial terms and obtaining explicit authorization.

## Review

```powershell
npm.cmd run operator:marketplace-catalogue -- review `
  --candidate-id '<candidate UUID>' `
  --decision approve `
  --actor '<reviewer identity>'
```

Approval creates only an immutable `coming_soon` draft with pending evidence.
Rejection creates no Template. Neither decision publishes anything.
