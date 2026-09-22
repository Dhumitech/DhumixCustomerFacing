# Pattern 6 all-Amazon operation proof

This folder activates and verifies the complete 13-operation Amazon definition
set without adding a database identity, publishing a customer-visible Template,
or making a billable Bright Data call.

Pattern 6 reuses the existing environment-specific Job Manager LOGIN:

```text
dhumi_<environment>_job_manager_login -> dhumi_job_manager
```

Migration `0032` stages one disabled shared adapter and 13 immutable draft
Template versions. It deliberately creates zero provider mappings because real
protected dataset identifiers and per-operation execution behavior require the
Pattern 7 qualification evidence.

## 1. Apply migration 0032

```powershell
Set-Location 'D:\BrightDataCustomerFacing\back-end'
& '.\tests\privileged\pattern6-operation-definitions\Apply-Pattern6Migration.ps1' -Target Both
```

Enter the PostgreSQL administrator password only at the hidden prompt. The
script clears it after its child processes finish.

An isolated replay that does not touch `dhumi_test` or `dhumi_dev` is also
available:

```powershell
& '.\tests\privileged\pattern6-operation-definitions\Invoke-Pattern6CleanDatabaseProof.ps1'
```

## 2. Run the real-database and local-storage proof

```powershell
& '.\tests\privileged\pattern6-operation-definitions\Invoke-Pattern6DatabaseProof.ps1' -FullRegression
```

The proof validates:

- all 13 operation codes, slugs, strict input schemas and presentation records;
- one shared disabled adapter and 13 draft/unpublished Template versions;
- zero fabricated provider mappings or credentials;
- invisibility through the customer catalogue role;
- reuse of the existing Job Manager with no new role or LOGIN;
- tenant-scoped, fenced normalization-plan resolution only after a durable raw
  Artifact exists;
- strict serialization and Amazon URL-role validation for every operation;
- inline and snapshot bytes through real Azurite raw and normalized objects;
- exact source-digest pinning, TypeScript, build and regression tests.

All database fixture rows are rolled back. The proof contains no real Bright
Data token, dataset identifier or snapshot identifier. Pattern 7 remains the
only owner of live provider qualification and protected mapping activation.
