# M8 offline Marketplace release matrix

This folder proves the Marketplace backend through M7 without calling a
Bright Data endpoint or enabling customer-paid execution.

## Safety boundary

- `back-end/.env` must contain exactly `RUN_EXECUTOR_DRIVER=controlled`.
- Outbox Dispatcher and Job Manager must be stopped.
- The M7 adapter must remain `disabled`, `provider_http_enabled=false`, without
  a Provider Mapping, Template version or public Template pointer.
- The proof creates rollback-only fixture Runs. It leaves no fixture Run,
  Artifact, usage event, cost hold or outbox event.
- Payment entitlement and billable admission are deferred to `MPayment`; M8
  does not invent or simulate that missing product authority.

## Clean-chain proof

This creates and later deletes only a uniquely named disposable PostgreSQL 18
container. It replays all migrations and proves the M7/M8 database boundary:

```powershell
Set-Location 'D:\BrightDataCustomerFacing\back-end'
& '.\tests\privileged\marketplace-offline-matrix\Invoke-MarketplaceOfflineMatrixCleanDatabaseProof.ps1'
```

## Local test/dev matrix

First stop Outbox Dispatcher and Job Manager. Keep PostgreSQL and Docker
dependencies running. Then run:

```powershell
Set-Location 'D:\BrightDataCustomerFacing\back-end'
& '.\tests\privileged\marketplace-offline-matrix\Invoke-MarketplaceOfflineMatrix.ps1' `
  -Target Both `
  -FullRegression
```

The launcher prompts once for the local PostgreSQL administrator password. It
applies forward-only migrations to the selected persistent databases and runs
only non-mutating release-state verification against them. It then invokes the
clean-chain launcher above for the M2-M8 lifecycle proofs. This prevents a
bootstrap proof from colliding with legitimate catalogue, sample, Run or usage
history in `dhumi_test` or `dhumi_dev`.

The complete matrix runs the following gates:

1. Persistent migration/customer-disabled boundary verification, followed by
   isolated M2-M8 catalogue, sample, preview, download, enquiry, adapter,
   Run/Attempt/cost/usage/artifact and rollback proofs.
2. Generic durable-execution fencing, reconciliation, usage finalization and
   cancellation/retry race proofs against `dhumi_test`.
3. Duplicate delivery, crash fencing, expired leases, reconciliation and
   cancellation/retry races.
4. Authentication, scope and Tenant-concealment API contracts.
5. Catalogue/sample/filter/normalizer/executor unit contracts.
6. Private Azurite bytes, checksums and signed-link expiry.
7. Service Bus duplicate/DLQ behavior and Redis lease ownership.
8. Worker crash/recovery/shutdown behavior.
9. TypeScript, production build and optional full baseline regression.

The persistent verifier does not insert, update or delete application rows.
It accepts that the review-first LinkedIn Posts draft may be absent from a
persistent database; when present, it must remain an unpublished Marketplace
draft. Commercial execution remains rejected unless the M7 fixture adapter is
unique, disabled, provider-HTTP-off, unmapped and unreachable from a public
Template pointer.

The default launcher does not reuse or delete the development Service Bus SQL
volume. It creates a separate `dhumi-marketplace-m8` Compose project on ports
`15672`, `15300` and `16380`, refuses a pre-existing project, and removes only
that disposable project's containers, network and volume in `finally`. The
Service Bus health check is bounded; startup failure returns
`M8_SERVICE_BUS_NOT_READY` before the longer queue tests run.

## Evidence currently executable without local database credentials

`Invoke-MarketplaceOfflineMatrixCleanDatabaseProof.ps1` is the credential-free
database-chain proof. The `Both` matrix is the formal local activation proof
and requires the administrator password so its test/dev result cannot be
claimed from source inspection alone.
