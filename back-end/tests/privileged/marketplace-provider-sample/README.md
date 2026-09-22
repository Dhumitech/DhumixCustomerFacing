# LinkedIn Posts provider-sample activation

This activates migrations `0057`-`0059` and promotes the exact retained M9 five-record
evidence into immutable Marketplace sample version 3. It performs no provider
HTTP request and makes zero Bright Data calls.

Version 3 is required because immutable historical synthetic sample version 2
already records a completed expiry, Azurite deletion and audit proof. Migration
`0059` preserves that evidence rather than updating or deleting it.

Migration `0058` keeps PostgreSQL authoritative for the qualification
`completed_at` timestamp and exact 30-day expiry. This avoids losing
microseconds when timestamps cross the JavaScript `Date` boundary.

Prerequisites:

- `.env` contains exactly `RUN_EXECUTOR_DRIVER=controlled`;
- `.env` targets `DATABASE_NAME=dhumi_dev`;
- Customer API, Outbox Dispatcher and Job Manager are stopped;
- PostgreSQL and Azurite remain running;
- exact packet `2e1560c3-ca8b-40a0-b578-c9e71ecf27cd`, its raw evidence, its
  byte-identical metadata evidence, and the disabled M10 candidate exist.

Run from `D:\BrightDataCustomerFacing\back-end`:

```powershell
& '.\tests\privileged\marketplace-provider-sample\Activate-LinkedInPostsProviderSample.ps1' `
  -Target Both
```

The script prompts once for the PostgreSQL administrator password, migrates
`dhumi_test` and `dhumi_dev`, copies only retained private evidence, verifies
PostgreSQL and storage integrity through the operator, and confirms that paid
customer execution remains disabled.

The operation is replay-safe after an interrupted activation: migrations are
checksum-ledgered, the object write is immutable/checksum-checked, and an
identical sample promotion returns the existing sample. Persistent verification
reports each failed invariant separately instead of collapsing missing joined
state into an empty result.

The formal partnership agreement is not fabricated. Database state explicitly
records `formal_agreement_pending_local_demo`. Pre-purchase preview, filtering
and limited sample downloads remain masked. Future unmasked purchased output
requires the separate MPayment entitlement boundary.
