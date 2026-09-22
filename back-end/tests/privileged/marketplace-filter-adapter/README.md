# M7 Marketplace Filter adapter proof

This folder contains two non-provider activation/proof paths:

- `Invoke-MarketplaceFilterAdapterCleanDatabaseProof.ps1` replays every
  migration in a disposable PostgreSQL 18 database and runs the rollback-only
  M7 structural/security proof. It uses no Bright Data credential or endpoint.
- `Apply-MarketplaceFilterAdapterMigration.ps1` applies pending forward-only
  migrations to `dhumi_test`, `dhumi_dev`, or both after securely prompting for
  the local PostgreSQL administrator password.

The M7 adapter version is deliberately `disabled`, fixture-only and has no
provider mapping, public Template pointer or customer execution route.
