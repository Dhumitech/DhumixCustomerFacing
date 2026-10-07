# LinkedIn Posts provider-sample v3 customer-path proof

**HISTORICAL — original migration chain through 0069.** The 0070 source cleanup
removes the qualification/import/export/release operators used by this harness.
Commands and database targets below are historical receipts, not current instructions.
Do not run this harness against the refactoring checkout or use it to qualify 0070.
Retained customer sample journeys require a separately reviewed 0070 proof.
See [privileged test boundaries](../README.md).


This privileged local proof verifies the active provider sample through the
normal authenticated Customer API. It makes no provider request.

Preconditions:

- `RUN_EXECUTOR_DRIVER=controlled`;
- Customer API listening on `127.0.0.1:3000`;
- PostgreSQL and Azurite running;
- Outbox Dispatcher and Job Manager stopped;
- migrations `0057`–`0059` activated and provider sample v3 promoted;
- ignored local customer credential file present.

Run from `back-end`:

```powershell
& '.\tests\privileged\marketplace-provider-sample-customer-path\Verify-LinkedInPostsProviderSampleCustomerPath.ps1'
```

The runner securely prompts for the PostgreSQL administrator password and keeps
it only in the verification child process. It proves:

- anonymous sample reads return `401`;
- authenticated catalogue/detail retain customer-visible preview Template v1
  while selecting LinkedIn Posts sample v3; private M10 Template v2 remains
  outside the customer catalogue;
- five records, 37 fields and 11 masked fields are visible through the governed
  metadata boundary;
- masked values remain exact `***` and cannot be filtered or sorted;
- local stored-sample filtering works;
- bounded JSON and CSV signed downloads return exact checksum-matching bytes;
- public responses contain no `object_key`;
- two download authorizations and two audits are persisted;
- Service, Run, Attempt, outbox, qualification, export-candidate and sample
  counts remain unchanged;
- Bright Data calls are zero.

The proof writes the two expected audited sample-download authorizations and
their private ephemeral objects. It does not create or mutate customer Services
or Runs and does not activate M10.
