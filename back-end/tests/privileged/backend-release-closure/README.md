# Backend Release Closure proof

This package proves the controlled one-operation publication boundary without
calling Bright Data or retaining fixture rows.

1. Prove the complete migration chain in disposable PostgreSQL 18:

   ```powershell
   & '.\tests\privileged\backend-release-closure\Invoke-BackendReleaseClosureCleanDatabaseProof.ps1'
   ```

2. Apply the forward-only migration chain through `0043` to test and dev:

   ```powershell
   & '.\tests\privileged\backend-release-closure\Apply-BackendReleaseClosureMigration.ps1' -Target Both
   ```

3. Run the rollback-only proof:

   ```powershell
   & '.\tests\privileged\backend-release-closure\Invoke-BackendReleaseClosureDatabaseProof.ps1' -Target Both
   ```

The clean proof creates a synthetic approved qualification,
rejects publication before acceptance, publishes exactly one immutable v3
Template/Mapping through the restricted operator function, proves idempotent
replay and customer catalogue visibility, verifies that the other 12 Amazon
operations remain draft, then proves the offline v4 contract release. It
asserts that v3 is byte-for-byte unchanged, its existing Service remains
pinned to v3, a newly created Service pins v4, the public pointer selects v4,
and the protected mapping retains its AAD lineage. The disposable database is
then removed.

The real release commands are deliberately separate. Do not run them until the
qualification ID, restricted evidence reference, SHA-256 evidence hash,
reviewer and expiry have been independently approved.

After v3 is published and migration 0043 is active, the offline input-contract
release uses the existing operator identity and makes no Bright Data request:

```powershell
& '.\tests\privileged\backend-release-closure\Publish-AmazonProductsInputV4.ps1' `
  -Target Dev `
  -Reviewer 'project.owner.local'
```

The script hashes migration 0043 as its reviewed contract evidence, reuses the
existing restricted operator LOGIN from `.env`/`.env.test`, and reports that it
makes zero Bright Data calls. Run it once per database only after the migration
application and offline proof succeed.

Verify an activated development release without exposing protected values:

```powershell
& '.\tests\privileged\backend-release-closure\Verify-AmazonProductsInputV4.ps1' `
  -Target Dev `
  -ExpectedState Published
```

For a database where migration 0043 is ledgered but v4 is intentionally not
published, use `-ExpectedState MigratedOnly`. The verifier uses a read-only
transaction and makes zero Bright Data calls.
