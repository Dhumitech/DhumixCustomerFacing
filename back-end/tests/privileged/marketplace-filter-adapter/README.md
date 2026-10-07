# M7 Marketplace Filter adapter proof

**HISTORICAL — original migration chain through 0069.** The 0070 source cleanup
removes the qualification/import/export/release operators used by this harness.
Commands and database targets below are historical receipts, not current instructions.
Do not run this harness against the refactoring checkout or use it to qualify 0070.
Retained customer sample journeys require a separately reviewed 0070 proof.
See [privileged test boundaries](../README.md).


This folder contains two non-provider activation/proof paths:

- `Invoke-MarketplaceFilterAdapterCleanDatabaseProof.ps1` replays every
  migration in a disposable PostgreSQL 18 database and runs the rollback-only
  M7 structural/security proof. It uses no Bright Data credential or endpoint.
- `Apply-MarketplaceFilterAdapterMigration.ps1` applies pending forward-only
  migrations to `dhumi_test`, `dhumi_dev`, or both after securely prompting for
  the local PostgreSQL administrator password.

The M7 adapter version is deliberately `disabled`, fixture-only and has no
provider mapping, public Template pointer or customer execution route.
