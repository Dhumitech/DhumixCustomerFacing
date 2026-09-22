# Standard LinkedIn People metadata activation

This operator-only proof applies migration `0060`, captures one exact metadata
document for the already approved standard LinkedIn People M2 candidate, stores
the bytes privately in the configured result container and records an immutable
database observation plus audit event.

It requires `RUN_EXECUTOR_DRIVER=controlled` and stopped provider-capable
workers. It makes exactly one provider request:

```text
GET /datasets/{protected_standard_people_id}/metadata
```

It makes no Dataset list, Search, Filter, purchase, export or customer Run
request. The public Template pointer remains unchanged.

Run from `back-end`:

```powershell
& '.\tests\privileged\marketplace-people\Activate-LinkedInPeopleMetadata.ps1' -Target Both
```

## Offline synthetic preview activation

After the exact metadata observation exists, activate the governed five-record
synthetic preview with:

```powershell
& '.\tests\privileged\marketplace-people\Activate-LinkedInPeopleSyntheticPreview.ps1' -Target Both
```

This second script makes zero provider calls. It requires the Customer API,
Outbox Dispatcher and Job Manager to be stopped, requires exactly
`RUN_EXECUTOR_DRIVER=controlled`, applies migrations `0061` and `0062`, writes the immutable
synthetic sample to private object storage and proves that Services, Runs,
Attempts and outbox counts did not change.

Migration `0062` keeps the exact provider-observation timestamp inside
PostgreSQL. This avoids losing sub-millisecond precision through JavaScript and
preserves the exact 30-day retention boundary.

The preview retains the 42 active fields derived from the exact 46-field
metadata document. Twelve recursively PII-marked fields are masked and cannot
be filtered before purchase. The four provider-inactive fields are excluded.
Contact enrichment, paid export and public publication remain disabled.

After activation, start only the Customer API and run the authenticated
customer-path proof (keep both workers stopped):

```powershell
& '.\tests\privileged\marketplace-people\Verify-LinkedInPeopleSyntheticCustomerPath.ps1'
```

It proves anonymous denial, authenticated catalogue/detail/preview access,
local visible-field filtering, masked-field filter/sort rejection, exact JSON
and CSV downloads, Tenant-owned download authorization/audit persistence and
the absence of any Service, Run, Attempt or outbox side effect. Provider calls
authorized by this proof: zero.

## Offline contact-choice contract activation

After Priority 2 is complete, register the three documented LinkedIn People
contact choices through the database-backed Priority 3A boundary:

```powershell
& '.\tests\privileged\marketplace-people\Activate-LinkedInPeopleContactContract.ps1' -Target Both
```

This guarded script requires `RUN_EXECUTOR_DRIVER=controlled` and stopped
Outbox Dispatcher and Job Manager processes. It applies migration `0063`, stores
the exact retained Marketplace FAQ, Dataset Search contract and canonical
manifest bytes in private object storage, and records their hashes, sizes,
lineage and encrypted contact-enriched provider reference in PostgreSQL.

The customer-safe database projection contains exactly:

```text
standard                 preview=available    fulfillment=not_enabled
enriched_when_available  preview=not_enabled  fulfillment=not_enabled
contacts_only            preview=not_enabled  fulfillment=not_enabled
```

The script verifies immutability, forced RLS, customer-role denial of private
tables, safe catalogue projection, idempotent replay, audit persistence and no
changes to public Template pointers, Services, Runs, Attempts or outbox work.
It makes zero Bright Data calls. It does not close `DM-010` or enable contact
fulfillment.
