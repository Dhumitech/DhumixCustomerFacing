[CmdletBinding()]
param(
    [Parameter()]
    [string]$TestDatabaseUrl = 'postgresql://postgres@localhost:5432/dhumi_test'
)

$ErrorActionPreference = 'Stop'

if ($TestDatabaseUrl -ne 'postgresql://postgres@localhost:5432/dhumi_test') {
    throw 'This proof-and-start script may target only local dhumi_test.'
}
if ($TestDatabaseUrl -match '(?i)://[^/@\s]+:[^/@\s]+@' -or
    $TestDatabaseUrl -match '(?i)(^|\s)password\s*=') {
    throw 'TestDatabaseUrl must not contain a password.'
}
if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    throw 'psql was not found on PATH.'
}

$backEnd = Split-Path -Parent $PSScriptRoot
$migration = Join-Path $PSScriptRoot 'migrations\0022_run_retry.sql'
$rlsMigration = Join-Path $PSScriptRoot 'migrations\0023_run_retry_owner_rls.sql'
$lineageMigration = Join-Path $PSScriptRoot 'migrations\0024_run_retry_idempotency_lineage.sql'
$proof = Join-Path $backEnd 'tests\integration\0015_run_retry.sql'
$rlsProof = Join-Path $backEnd 'tests\integration\0016_run_retry_owner_rls.sql'
$lineageProof = Join-Path $backEnd 'tests\integration\0017_run_retry_idempotency_lineage.sql'
foreach ($requiredFile in @($migration, $rlsMigration, $lineageMigration, $proof, $rlsProof, $lineageProof)) {
    if (-not (Test-Path -LiteralPath $requiredFile)) {
        throw "Required retry file is missing: $requiredFile"
    }
}

$passwordPointer = [IntPtr]::Zero
$plainPassword = $null
$oldPgPassword = $env:PGPASSWORD

function Assert-ChildSuccess {
    param([Parameter(Mandatory)][string]$Message)
    if ($LASTEXITCODE -ne 0) { throw $Message }
}

try {
    $securePassword = Read-Host 'PostgreSQL postgres password (held only by child processes)' -AsSecureString
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    $env:PGPASSWORD = $plainPassword

    Push-Location $backEnd
    try {
        Write-Host 'Running rollback-only migration 0022 proof against dhumi_test...' -ForegroundColor Cyan
        & psql -X -h localhost -U postgres -d dhumi_test `
            -v ON_ERROR_STOP=1 -f $proof
        Assert-ChildSuccess 'Retry migration proof failed. Migration 0022 was not ledgered.'

        Write-Host 'Running rollback-only migration 0023 proof against dhumi_test...' -ForegroundColor Cyan
        & psql -X -h localhost -U postgres -d dhumi_test `
            -v ON_ERROR_STOP=1 -f $rlsProof
        Assert-ChildSuccess 'Retry RLS proof failed. Migration 0023 was not ledgered.'

        Write-Host 'Running rollback-only migration 0024 proof against dhumi_test...' -ForegroundColor Cyan
        & psql -X -h localhost -U postgres -d dhumi_test `
            -v ON_ERROR_STOP=1 -f $lineageProof
        Assert-ChildSuccess 'Retry idempotency proof failed. Migration 0024 was not ledgered.'

        Write-Host 'Applying retry migrations to dhumi_test...' -ForegroundColor Cyan
        & (Join-Path $PSScriptRoot 'migrate.ps1') -DatabaseUrl $TestDatabaseUrl
        Assert-ChildSuccess 'Retry migrations failed on dhumi_test.'

        $expectedChecksum = (
            Get-FileHash -Algorithm SHA256 -LiteralPath $migration
        ).Hash.ToLowerInvariant()
        $ledgerSql = @"
SET ROLE dhumi_owner;
SELECT count(*)::text || '|' || COALESCE(max(checksum), '')
FROM app.schema_migrations
WHERE version = '0022_run_retry';
RESET ROLE;
"@
        $ledgerResult = (
            & psql -X -qAt -h localhost -U postgres -d dhumi_test `
                -v ON_ERROR_STOP=1 -c $ledgerSql | Out-String
        ).Trim()
        Assert-ChildSuccess 'dhumi_test migration-ledger verification failed.'
        if ($ledgerResult -ne "1|$expectedChecksum") {
            throw "dhumi_test has an incorrect 0022 ledger entry: '$ledgerResult'."
        }

        $expectedRlsChecksum = (
            Get-FileHash -Algorithm SHA256 -LiteralPath $rlsMigration
        ).Hash.ToLowerInvariant()
        $rlsLedgerSql = @"
SET ROLE dhumi_owner;
SELECT count(*)::text || '|' || COALESCE(max(checksum), '')
FROM app.schema_migrations
WHERE version = '0023_run_retry_owner_rls';
RESET ROLE;
"@
        $rlsLedgerResult = (
            & psql -X -qAt -h localhost -U postgres -d dhumi_test `
                -v ON_ERROR_STOP=1 -c $rlsLedgerSql | Out-String
        ).Trim()
        Assert-ChildSuccess 'dhumi_test migration 0023 ledger verification failed.'
        if ($rlsLedgerResult -ne "1|$expectedRlsChecksum") {
            throw "dhumi_test has an incorrect 0023 ledger entry: '$rlsLedgerResult'."
        }

        $expectedLineageChecksum = (
            Get-FileHash -Algorithm SHA256 -LiteralPath $lineageMigration
        ).Hash.ToLowerInvariant()
        $lineageLedgerSql = @"
SET ROLE dhumi_owner;
SELECT count(*)::text || '|' || COALESCE(max(checksum), '')
FROM app.schema_migrations
WHERE version = '0024_run_retry_idempotency_lineage';
RESET ROLE;
"@
        $lineageLedgerResult = (
            & psql -X -qAt -h localhost -U postgres -d dhumi_test `
                -v ON_ERROR_STOP=1 -c $lineageLedgerSql | Out-String
        ).Trim()
        Assert-ChildSuccess 'dhumi_test migration 0024 ledger verification failed.'
        if ($lineageLedgerResult -ne "1|$expectedLineageChecksum") {
            throw "dhumi_test has an incorrect 0024 ledger entry: '$lineageLedgerResult'."
        }

        $surfaceSql = @"
SET ROLE dhumi_owner;
SELECT
  (SELECT count(*) FROM pg_constraint
    WHERE connamespace = 'app'::regnamespace
      AND conname IN (
        'idempotency_records_run_retry_semantics_check',
        'runs_retry_not_self_check'
      ))::text || '|' ||
  (to_regprocedure('app.lock_run_for_retry(uuid)') IS NOT NULL)::text || '|' ||
  (to_regprocedure('app.validate_run_retry_lineage()') IS NOT NULL)::text || '|' ||
  (EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'app.runs'::regclass
      AND tgname = 'runs_validate_retry_lineage'
      AND NOT tgisinternal))::text || '|' ||
  has_function_privilege('dhumi_admission', 'app.lock_run_for_retry(uuid)', 'EXECUTE')::text || '|' ||
  (NOT has_function_privilege('dhumi_customer_api', 'app.lock_run_for_retry(uuid)', 'EXECUTE'))::text || '|' ||
  has_column_privilege('dhumi_admission', 'app.runs', 'retry_of_run_id', 'INSERT')::text || '|' ||
  (NOT has_column_privilege('dhumi_admission', 'app.runs', 'validated_input', 'SELECT'))::text || '|' ||
  (NOT has_column_privilege('dhumi_admission', 'app.run_attempts', 'state', 'SELECT'))::text || '|' ||
  (NOT has_table_privilege('dhumi_admission', 'app.runs', 'UPDATE'))::text;
RESET ROLE;
"@
        $surfaceResult = (
            & psql -X -qAt -h localhost -U postgres -d dhumi_test `
                -v ON_ERROR_STOP=1 -c $surfaceSql | Out-String
        ).Trim()
        Assert-ChildSuccess 'dhumi_test retry-surface verification failed.'
        if ($surfaceResult -ne '2|true|true|true|true|true|true|true|true|true') {
            throw "dhumi_test has an incomplete retry surface: '$surfaceResult'."
        }

        $policySql = @"
SET ROLE dhumi_owner;
SELECT EXISTS (
  SELECT 1
  FROM pg_policy
  WHERE polrelid = 'app.service_versions'::regclass
    AND polname = 'service_versions_tenant_isolation'
    AND 'dhumi_owner'::regrole::oid = ANY(polroles)
    AND pg_get_expr(polqual, polrelid) =
      '(tenant_id = app.current_tenant_id())'
    AND pg_get_expr(polwithcheck, polrelid) =
      '(tenant_id = app.current_tenant_id())'
)::text;
RESET ROLE;
"@
        $policyResult = (
            & psql -X -qAt -h localhost -U postgres -d dhumi_test `
                -v ON_ERROR_STOP=1 -c $policySql | Out-String
        ).Trim()
        Assert-ChildSuccess 'dhumi_test retry owner-policy verification failed.'
        if ($policyResult -ne 'true') {
            throw "dhumi_test has an incomplete retry owner policy: '$policyResult'."
        }

        $lineageSurfaceSql = @"
SET ROLE dhumi_owner;
SELECT
  has_column_privilege(
    'dhumi_admission',
    'app.idempotency_records',
    'related_resource_id',
    'SELECT'
  )::text || '|' ||
  has_column_privilege(
    'dhumi_admission',
    'app.idempotency_records',
    'related_resource_id',
    'UPDATE'
  )::text || '|' ||
  (NOT has_column_privilege(
    'dhumi_admission',
    'app.idempotency_records',
    'tenant_id',
    'UPDATE'
  ))::text || '|' ||
  (NOT has_table_privilege(
    'dhumi_admission',
    'app.idempotency_records',
    'UPDATE'
  ))::text;
RESET ROLE;
"@
        $lineageSurfaceResult = (
            & psql -X -qAt -h localhost -U postgres -d dhumi_test `
                -v ON_ERROR_STOP=1 -c $lineageSurfaceSql | Out-String
        ).Trim()
        Assert-ChildSuccess 'dhumi_test retry idempotency-surface verification failed.'
        if ($lineageSurfaceResult -ne 'true|true|true|true') {
            throw "dhumi_test has an incomplete retry idempotency surface: '$lineageSurfaceResult'."
        }

        Write-Host 'PASS - proofs rolled back and migrations 0022/0023/0024 are verified on dhumi_test.' -ForegroundColor Green
    }
    finally {
        Pop-Location
    }
}
finally {
    if ($null -eq $oldPgPassword) { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
    else { $env:PGPASSWORD = $oldPgPassword }
    $plainPassword = $null
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
}
