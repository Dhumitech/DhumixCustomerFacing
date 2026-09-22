# M3 Marketplace synthetic-sample lifecycle

This phase is operational with synthetic fixtures while the non-secret MOU
reference is pending. It supports private ingestion, internal inspection and
30-day expiry/deletion evidence. It cannot ingest or publish provider data and
makes zero Bright Data calls.

Migration `0065_marketplace_fixture_current_schema` restores the legacy M3
recorder against the post-`0057` schema by writing the explicit two-field
synthetic dictionary and governance state. The original 16-argument operator
contract and immutable replay behavior are retained. The rollback-only clean
PostgreSQL proof replays every migration through `0065` and tests those fields.
This is a fixture-path proof, not permission to publish real provider data.
The old recorder only accepts the reviewed two-field synthetic metadata hash;
it fails closed if the approved candidate has since moved to a different
provider metadata version. Such a candidate needs a new governed sample path,
not a relabeled M3 fixture.

The accepted `DM-007` policy is enforced as
`linkedin-posts-sample-30d-v1`: `expires_at` must be exactly 30 days after
`collected_at`. Migration `0047` fails closed if an earlier local fixture does
not satisfy that policy; it never silently rewrites an immutable sample.

```powershell
Set-Location 'D:\BrightDataCustomerFacing\back-end'
& '.\tests\privileged\marketplace-sample\Invoke-MarketplaceSampleCleanDatabaseProof.ps1'
```

Migration activation for the existing local databases is separate and prompts
once for the PostgreSQL administrator password:

```powershell
& '.\tests\privileged\marketplace-sample\Apply-MarketplaceSampleMigration.ps1' -Target Both
```

After applying the migrations, these private operator actions are available:

```powershell
$collectedAt = [DateTimeOffset]::UtcNow
$expiresAt = $collectedAt.AddDays(30)
$collectedIso = $collectedAt.ToString("yyyy-MM-ddTHH:mm:ss.fff'Z'")
$expiresIso = $expiresAt.ToString("yyyy-MM-ddTHH:mm:ss.fff'Z'")

npm.cmd run operator:marketplace-sample -- ingest-fixture `
  --sample-file 'D:\BrightDataCustomerFacing\back-end\tests\fixtures\marketplace-samples\linkedin-posts-v1.json' `
  --metadata-file 'D:\BrightDataCustomerFacing\back-end\tests\fixtures\marketplace-catalogue\linkedin-posts-metadata.json' `
  --sample-version 1 `
  --schema-version 1 `
  --masking-policy-version linkedin-posts-provider-mask-preservation-v1 `
  --retention-policy-version linkedin-posts-sample-30d-v1 `
  --provenance-reference fixture://marketplace-samples/linkedin-posts-v1 `
  --collected-at $collectedIso `
  --expires-at $expiresIso `
  --actor m3.local.fixture
```

Inspect an unexpired fixture without exposing its private object key:

```powershell
npm.cmd run operator:marketplace-sample -- inspect-fixture `
  --metadata-file 'D:\BrightDataCustomerFacing\back-end\tests\fixtures\marketplace-catalogue\linkedin-posts-metadata.json' `
  --sample-version 1 `
  --as-of ([DateTimeOffset]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fff'Z'"))
```

Run the idempotent expiry/deletion pass:

```powershell
npm.cmd run operator:marketplace-sample -- expire-fixtures `
  --as-of ([DateTimeOffset]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fff'Z'")) `
  --limit 100 `
  --actor m3.local.expiry
```

Do not ingest real provider sample bytes with this operator. The M3 database
contract accepts only synthetic fixtures and cannot publish them to customers.
The MOU reference remains a release gate for provider-sourced samples.
