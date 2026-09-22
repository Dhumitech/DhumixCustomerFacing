# M9 Marketplace qualification execution

This folder contains the offline activation and clean-database proof for the
protected Marketplace qualification runner.

- `Invoke-MarketplaceQualificationExecutionCleanDatabaseProof.ps1` replays
  every migration in disposable PostgreSQL 18, executes the rollback-only M9
  authorization, one-submission fencing, poll-checkpoint, terminal-evidence and
  isolation proof, and verifies that no fixture survives the rollback.
- `Apply-MarketplaceQualificationExecutionMigration.ps1` applies migration
  `0055_marketplace_qualification_execution` to `dhumi_test`, `dhumi_dev`, or
  both. It refuses to run unless `.env` contains exactly
  `RUN_EXECUTOR_DRIVER=controlled`. It verifies that no Marketplace adapter,
  Template or provider mapping has been enabled and that no packet has been
  authorized, claimed or executed.

Neither script calls Bright Data.

The separate `operator:marketplace-qualification execute` command is capable
of one live provider qualification only after all of the following are true:

1. the exact packet has a current authorization recorded through the protected
   preflight operator;
2. the operator supplies that exact packet ID and request fingerprint;
3. `--confirm-exact-authorized-packet` is present;
4. the process is deliberately launched while the normal customer executor
   remains `controlled`.

The live operator records submission start before its one provider POST and
never automatically retries that POST. A live invocation requires separate,
explicit user authorization because the Marketplace Filter API can be billed.
The execution service accepts only one-to-five records and enforces a
proportional ceiling of 2,500 USD micros per requested record. The strict
wrapper derives and verifies that exact packet ceiling; the provider Filter
request itself has a record limit but no monetary-cap parameter.

On 13 September 2026, an explicitly authorized five-record LinkedIn Posts
packet completed through exactly one provider POST and zero automatic retries.
It returned five records, reported zero cost, and produced private raw and
normalized evidence whose checksums were independently verified. This evidence
does not enable a customer route or authorize another provider call.
