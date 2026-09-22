# Dhumi customer live E2E: one billable call

This isolated Postman suite exercises the production-shaped customer Run path
with exactly one `amazon.products.collect_by_url` input.

## Provider budget

```text
Bright Data scrape submissions: 1
Amazon product links:            1
Automatic provider retries:      0
Target:                          https://www.amazon.com/dp/B07YYKF9HW
```

The authenticated Run request is the only request capable of provider egress.
The anonymous Run request must stop at `401` and cannot enqueue work.

## Generate the Postman files

```powershell
Set-Location 'D:\BrightDataCustomerFacing\back-end'
node '.\tests\privileged\postman-customer-live-one-call\buildFixture.mjs'
```

Import the generated collection and environment into Postman, or run them
locally with Postman CLI. Do not run this collection without explicit billable
authorization and a Job Manager intentionally started with
`RUN_EXECUTOR_DRIVER=bright_data`.

The collection proves signup, sign-in, Tenant resolution, API-key scoping,
anonymous denial, authenticated Run admission, durable progress, safe events,
separate authorized normalized and raw result downloads, exact bytes and
checksums for both representations, usage attribution, key revocation and
logout.

## Verified execution

The one authorized billable execution completed on 2026-09-02 using the
earlier generated collection. Its historical counts below predate the added
raw-download verification requests:

```text
Run:                  9598817e-977e-478d-9f3e-e055b82baa57
Provider submissions: 1
Inputs:               1
Postman requests:     24
Assertions:           58 passed, 0 failed
Final state:          ready / COMPLETED
Usage:                1 record
```

See
[`evidence/2026-09-02_POSTMAN-CUSTOMER-LIVE-ONE-CALL-001.md`](evidence/2026-09-02_POSTMAN-CUSTOMER-LIVE-ONE-CALL-001.md)
for the redacted evidence. The raw Postman JSON report remains under the
Git-ignored `.runtime` directory because it contains session material and a
short-lived signed URL.
