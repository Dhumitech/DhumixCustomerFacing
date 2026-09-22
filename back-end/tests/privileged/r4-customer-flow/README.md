# R4 no-mock customer-flow regression

This suite exercises the running Dhumi Customer API and frontend with real
`dhumi_dev` data while reusing an already completed Run. It does not submit,
cancel or retry a Run and refuses to start if the Outbox Dispatcher or Job
Manager is running. The intended Bright Data call count is therefore zero.

The suite verifies:

- frontend and platform availability;
- anonymous denial, sign-in, refresh rotation and logout;
- workspace, published Amazon Products v4 catalogue and Service reads;
- existing Run list, detail and safe lifecycle events;
- normalized and raw result authorization, exact byte count and SHA-256;
- usage summary and exactly one usage event for the evidence Run;
- disposable API-key create, authenticate, list, revoke and rejected reuse;
- the Run ID set is unchanged by the regression.

Cancel and retry are deliberately not invoked against a completed production-like
Run. They require an explicitly prepared non-billable fixture; creating such a
fixture while `RUN_EXECUTOR_DRIVER=bright_data` would violate this suite's
zero-provider-call boundary.

Run from the backend directory:

```powershell
& '.\tests\privileged\r4-customer-flow\Invoke-R4CustomerFlow.ps1'
```

The wrapper reads the existing ignored credential file without printing its
contents. The returned disposable API-key secret remains only in process memory
and is revoked before the suite exits.
