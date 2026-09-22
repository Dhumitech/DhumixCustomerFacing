# Pattern 8B Usage Read Proof

This folder proves the customer-safe informational usage read surface without
calling Bright Data or creating another database identity.

From `D:\BrightDataCustomerFacing\back-end`:

```powershell
& '.\tests\privileged\pattern8-usage-reads\Invoke-Pattern8UsageReadsCleanDatabaseProof.ps1'
```

After the clean proof passes, activate migration `0038` on the real local test
and development databases:

```powershell
& '.\tests\privileged\pattern8-usage-reads\Apply-Pattern8UsageReadsMigration.ps1' -Target Both
```

Then run the rollback-only proof against the activated databases:

```powershell
& '.\tests\privileged\pattern8-usage-reads\Invoke-Pattern8UsageReadsDatabaseProof.ps1' -Target Both
```

The proof verifies the half-open time window, summary aggregation, exact
microsecond keyset pagination, Tenant isolation, direct-table denial, safe
function result fields and missing-Tenant failure. It creates no billable call
and leaves no fixture rows because the proof transaction is rolled back.

Recorded evidence:

- `evidence/2026-08-31_P8-USAGE-READS-CLEAN-001.md`
- `evidence/2026-08-31_P8-USAGE-READS-REAL-002.md`

Migration `0038` is ledgered and the rollback-only proof passes on both
`dhumi_test` and `dhumi_dev`.
