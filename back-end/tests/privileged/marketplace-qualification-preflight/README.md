# M9 Marketplace qualification preflight

This folder contains offline-only M9 activation and proof paths.

- `Invoke-MarketplaceQualificationPreflightCleanDatabaseProof.ps1` replays all
  migrations in disposable PostgreSQL 18 and runs the rollback-only database,
  authorization, isolation and one-submission fencing proof.
- `Apply-MarketplaceQualificationPreflightMigration.ps1` applies migration
  `0054_marketplace_qualification_preflight` to `dhumi_test`, `dhumi_dev`, or
  both. It refuses to run unless `.env` contains exactly
  `RUN_EXECUTOR_DRIVER=controlled`, then verifies that the M7 adapter remains
  disabled, provider HTTP remains off, no provider mapping or Template points
  to it, and no packet is authorized or consumed.

The `operator:marketplace-qualification-preflight` command can prepare an
immutable packet and record a separately supplied, exact authorization. It
cannot claim the packet or call Bright Data. The claim function is a protected
database gate for a future, separately reviewed live M9 operator.

No script in this folder calls a Bright Data endpoint.
