# Pattern 4 Postman E2E

This local-only fixture publishes the controlled Pattern 4 Template required
to prove the public API through the real Dispatcher, Service Bus emulator, Job
Manager, Redis lease, PostgreSQL fencing and Pattern 3 Azurite result boundary.

It does not call Bright Data. The separate Postman folder named
`Billable Bright Data Canary - Auth and Validation` performs the explicitly
confirmed live provider qualification.

Prepare the durable execution fixture:

```powershell
Set-Location 'D:\BrightDataCustomerFacing\back-end'
& '.\tests\privileged\pattern4-postman-e2e\Initialize-Pattern4PostmanFixture.ps1'
```

Enter the PostgreSQL administrator password at the hidden `psql` prompt. The
password is not written to a file or child environment variable.

Then keep these processes running:

```powershell
npm run infra:pattern3:up
npm run infra:pattern4:up
npm run dev
npm run worker:outbox
npm run worker:jobs
```

In Postman, select the `brightdatacall` collection and run the
`Pattern 4 - Durable Execution E2E` folder with the Desktop Agent.

Copy the `p4_run_id` value from the Postman environment and inspect the real
PostgreSQL evidence after the folder passes:

```powershell
& '.\tests\privileged\pattern4-postman-e2e\Inspect-Pattern4PostmanEvidence.ps1' `
  -RunId '<p4_run_id>'
```

The inspection prints the Run, fenced Attempt, safe events, published outbox
event, Artifact metadata and signed-download authorization audit. Result bytes
are not stored in PostgreSQL; request P4 10 proves the exact bytes through the
signed Azurite URL.

That folder performs fourteen assertions covering authentication, Tenant
ownership, catalogue publication, Service creation, Run admission,
idempotency, durable completion, safe lifecycle events, result authorization,
exact Azurite bytes, missing authentication and cross-Tenant invisibility.

Do not run the collection root when you only intend to test Pattern 4. The
separate `Billable Bright Data Canary - Auth and Validation` folder contains
request `04 - Execute one authenticated Amazon Bright Data canary`, which has
an explicit billable-confirmation header and can incur a Bright Data charge.
It proves authenticated private provider egress and response redaction. It
does not replace the Pattern 4 durable execution proof and does not yet attach
the provider response to a Dhumi Run; that integration belongs to Pattern 5.
