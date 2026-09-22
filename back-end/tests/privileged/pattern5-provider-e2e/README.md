# Pattern 5 private provider-boundary proof

This folder activates and verifies Pattern 5 without adding another database
identity and without making a billable Bright Data request.

The runtime authority is the existing environment-specific Job Manager LOGIN:

```text
dhumi_<environment>_job_manager_login -> dhumi_job_manager
```

Migration `0031` grants that capability only four narrow, fenced functions. It
does not grant direct access to `app.provider_credentials`.

## 1. Apply migration 0031

```powershell
Set-Location 'D:\BrightDataCustomerFacing\back-end'
& '.\tests\privileged\pattern5-provider-e2e\Apply-Pattern5Migration.ps1' -Target Both
```

Enter the PostgreSQL administrator password only at the hidden prompt. The
script keeps it in the current process for child commands and clears it after
completion.

## 2. Run the rollback-only database/security proof

```powershell
& '.\tests\privileged\pattern5-provider-e2e\Invoke-Pattern5DatabaseProof.ps1' -FullRegression
```

The proof validates:

- no Pattern 5 LOGIN or capability role exists;
- the existing Job Manager has execute-only access to the fenced functions;
- direct `provider_credentials` reads are denied;
- the current Tenant and live fence are mandatory;
- a protected snapshot reference is written once and is idempotent;
- a conflicting reference cannot replace it;
- reconciliation reuses the recorded reference and never performs a second
  provider submission;
- cancellation intent is visible only to the live fenced attempt;
- private `200` and `202` transport fixtures stream exact raw and normalized
  bytes through the real Azurite object-store adapter;
- focused tests, TypeScript, the production build and the full regression pass.

All fixture rows are rolled back. The test contains no real Bright Data token,
dataset identifier or snapshot identifier.

## What this does not prove

This proof does not spend provider credits. A live Bright Data qualification
Run is a separate, explicitly authorized step after the local worker E2E is
green. Azure Key Vault and managed workload identity remain deployment gates.
