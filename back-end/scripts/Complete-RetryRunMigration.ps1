[CmdletBinding()]
param(
    [Parameter()]
    [string]$DevDatabaseUrl = 'postgresql://postgres@localhost:5432/dhumi_dev'
)

$ErrorActionPreference = 'Stop'

if ($DevDatabaseUrl -ne 'postgresql://postgres@localhost:5432/dhumi_dev') {
    throw 'This completion script may target only local dhumi_dev.'
}
if ($DevDatabaseUrl -match '(?i)://[^/@\s]+:[^/@\s]+@' -or
    $DevDatabaseUrl -match '(?i)(^|\s)password\s*=') {
    throw 'DevDatabaseUrl must not contain a password.'
}
if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    throw 'psql was not found on PATH.'
}

$backEnd = Split-Path -Parent $PSScriptRoot
$retryMigration = Join-Path $PSScriptRoot 'migrations\0022_run_retry.sql'
$rlsMigration = Join-Path $PSScriptRoot 'migrations\0023_run_retry_owner_rls.sql'
$lineageMigration = Join-Path $PSScriptRoot 'migrations\0024_run_retry_idempotency_lineage.sql'
foreach ($migration in @($retryMigration, $rlsMigration, $lineageMigration)) {
    if (-not (Test-Path -LiteralPath $migration)) {
        throw "Required retry migration is missing: $migration"
    }
}
$expectedRetryChecksum = (
    Get-FileHash -Algorithm SHA256 -LiteralPath $retryMigration
).Hash.ToLowerInvariant()
$expectedRlsChecksum = (
    Get-FileHash -Algorithm SHA256 -LiteralPath $rlsMigration
).Hash.ToLowerInvariant()
$expectedLineageChecksum = (
    Get-FileHash -Algorithm SHA256 -LiteralPath $lineageMigration
).Hash.ToLowerInvariant()
$passwordPointer = [IntPtr]::Zero
$plainPassword = $null
$oldPgPassword = $env:PGPASSWORD

function Assert-ChildSuccess {
    param([Parameter(Mandatory)][string]$Message)
    if ($LASTEXITCODE -ne 0) { throw $Message }
}

function Assert-RetryRunDatabase {
    param([Parameter(Mandatory)][string]$Database)

    $retryLedgerSql = @"
SET ROLE dhumi_owner;
SELECT count(*)::text || '|' || COALESCE(max(checksum), '')
FROM app.schema_migrations
WHERE version = '0022_run_retry';
RESET ROLE;
"@
    $retryLedgerResult = (
        & psql -X -qAt -h localhost -U postgres -d $Database `
            -v ON_ERROR_STOP=1 -c $retryLedgerSql | Out-String
    ).Trim()
    Assert-ChildSuccess "$Database migration 0022 ledger verification failed."
    $expectedRetryLedger = "1|$expectedRetryChecksum"
    if ($retryLedgerResult -ne $expectedRetryLedger) {
        throw "$Database has an incorrect 0022 ledger entry. Expected '$expectedRetryLedger'; received '$retryLedgerResult'."
    }

    $rlsLedgerSql = @"
SET ROLE dhumi_owner;
SELECT count(*)::text || '|' || COALESCE(max(checksum), '')
FROM app.schema_migrations
WHERE version = '0023_run_retry_owner_rls';
RESET ROLE;
"@
    $rlsLedgerResult = (
        & psql -X -qAt -h localhost -U postgres -d $Database `
            -v ON_ERROR_STOP=1 -c $rlsLedgerSql | Out-String
    ).Trim()
    Assert-ChildSuccess "$Database migration 0023 ledger verification failed."
    $expectedRlsLedger = "1|$expectedRlsChecksum"
    if ($rlsLedgerResult -ne $expectedRlsLedger) {
        throw "$Database has an incorrect 0023 ledger entry. Expected '$expectedRlsLedger'; received '$rlsLedgerResult'."
    }

    $lineageLedgerSql = @"
SET ROLE dhumi_owner;
SELECT count(*)::text || '|' || COALESCE(max(checksum), '')
FROM app.schema_migrations
WHERE version = '0024_run_retry_idempotency_lineage';
RESET ROLE;
"@
    $lineageLedgerResult = (
        & psql -X -qAt -h localhost -U postgres -d $Database `
            -v ON_ERROR_STOP=1 -c $lineageLedgerSql | Out-String
    ).Trim()
    Assert-ChildSuccess "$Database migration 0024 ledger verification failed."
    $expectedLineageLedger = "1|$expectedLineageChecksum"
    if ($lineageLedgerResult -ne $expectedLineageLedger) {
        throw "$Database has an incorrect 0024 ledger entry. Expected '$expectedLineageLedger'; received '$lineageLedgerResult'."
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
  (NOT has_table_privilege('dhumi_admission', 'app.runs', 'UPDATE'))::text || '|' ||
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
    $surfaceResult = (
        & psql -X -qAt -h localhost -U postgres -d $Database `
            -v ON_ERROR_STOP=1 -c $surfaceSql | Out-String
    ).Trim()
    Assert-ChildSuccess "$Database retry-surface verification failed."
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
        & psql -X -qAt -h localhost -U postgres -d $Database `
            -v ON_ERROR_STOP=1 -c $policySql | Out-String
    ).Trim()
    Assert-ChildSuccess "$Database retry owner-policy verification failed."

    if ($surfaceResult -ne '2|true|true|true|true|true|true|true|true|true|true|true|true|true' -or
        $policyResult -ne 'true') {
        throw "$Database has an incomplete retry surface: '$surfaceResult'."
    }

    Write-Host "$Database - PASS: ledger, source checksum, constraints, trigger and least privilege verified." -ForegroundColor Green
}

try {
    $securePassword = Read-Host 'PostgreSQL postgres password (held only by child processes)' -AsSecureString
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    $env:PGPASSWORD = $plainPassword

    Push-Location $backEnd
    try {
        Write-Host 'Preflight-verifying immutable retry migrations on dhumi_test...' -ForegroundColor Cyan
        Assert-RetryRunDatabase -Database 'dhumi_test'

        Write-Host 'Applying retry migrations to dhumi_dev...' -ForegroundColor Cyan
        & (Join-Path $PSScriptRoot 'migrate.ps1') -DatabaseUrl $DevDatabaseUrl
        Assert-ChildSuccess 'Retry migrations failed on dhumi_dev.'

        Write-Host 'Verifying both configured databases independently...' -ForegroundColor Cyan
        Assert-RetryRunDatabase -Database 'dhumi_test'
        Assert-RetryRunDatabase -Database 'dhumi_dev'
        Write-Host 'FINAL PASS - migrations 0022, 0023 and 0024 are correctly applied to dhumi_test and dhumi_dev.' -ForegroundColor Green
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
