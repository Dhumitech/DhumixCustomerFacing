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
$migration = Join-Path $PSScriptRoot 'migrations\0021_run_cancellation.sql'

if (-not (Test-Path -LiteralPath $migration)) {
    throw "Migration 0021 is missing: $migration"
}

$expectedChecksum = (
    Get-FileHash -Algorithm SHA256 -LiteralPath $migration
).Hash.ToLowerInvariant()
$passwordPointer = [IntPtr]::Zero
$plainPassword = $null
$oldPgPassword = $env:PGPASSWORD

function Assert-ChildSuccess {
    param([Parameter(Mandatory)][string]$Message)
    if ($LASTEXITCODE -ne 0) {
        throw $Message
    }
}

function Assert-CancelRunDatabase {
    param([Parameter(Mandatory)][string]$Database)

    $ledgerSql = @"
SET ROLE dhumi_owner;
SELECT count(*)::text || '|' || COALESCE(max(checksum), '')
FROM app.schema_migrations
WHERE version = '0021_run_cancellation';
RESET ROLE;
"@
    $ledgerResult = (
        & psql -X -qAt -h localhost -U postgres -d $Database `
            -v ON_ERROR_STOP=1 -c $ledgerSql |
            Out-String
    ).Trim()
    Assert-ChildSuccess "$Database migration-ledger verification failed."

    $expectedLedger = "1|$expectedChecksum"
    if ($ledgerResult -ne $expectedLedger) {
        throw "$Database has an incorrect 0021 ledger entry. Expected '$expectedLedger'; received '$ledgerResult'."
    }

    $surfaceSql = @"
SET ROLE dhumi_owner;
SELECT
  (
    SELECT count(*)
    FROM pg_constraint
    WHERE connamespace = 'app'::regnamespace
      AND conname IN (
        'idempotency_records_run_cancel_semantics_check',
        'outbox_events_jobs_cancel_shape_check',
        'run_events_cancellation_requested_shape_check'
      )
  )::text || '|' ||
  (to_regclass('app.outbox_events_one_jobs_cancel_per_run_idx') IS NOT NULL)::text || '|' ||
  (to_regclass('app.run_events_one_cancellation_requested_per_run_idx') IS NOT NULL)::text || '|' ||
  (to_regprocedure('app.lock_run_for_cancellation(uuid)') IS NOT NULL)::text || '|' ||
  (
    SELECT prosecdef
    FROM pg_proc
    WHERE oid = to_regprocedure('app.lock_run_for_cancellation(uuid)')
  )::text || '|' ||
  has_function_privilege(
    'dhumi_admission',
    'app.lock_run_for_cancellation(uuid)',
    'EXECUTE'
  )::text || '|' ||
  (NOT has_function_privilege(
    'dhumi_admission',
    'app.transition_run(uuid,bigint,text,text,text,uuid,text,boolean,jsonb)',
    'EXECUTE'
  ))::text || '|' ||
  (NOT has_table_privilege('dhumi_admission', 'app.runs', 'UPDATE'))::text || '|' ||
  (NOT has_table_privilege(
    'dhumi_admission',
    'app.provider_cost_holds',
    'UPDATE'
  ))::text || '|' ||
  (NOT has_column_privilege(
    'dhumi_admission',
    'app.outbox_events',
    'claimed_at',
    'UPDATE'
  ))::text || '|' ||
  (NOT has_column_privilege(
    'dhumi_admission',
    'app.outbox_events',
    'published_at',
    'UPDATE'
  ))::text;
RESET ROLE;
"@
    $surfaceResult = (
        & psql -X -qAt -h localhost -U postgres -d $Database `
            -v ON_ERROR_STOP=1 -c $surfaceSql |
            Out-String
    ).Trim()
    Assert-ChildSuccess "$Database cancellation-surface verification failed."

    $expectedSurface = '3|true|true|true|true|true|true|true|true|true|true'
    if ($surfaceResult -ne $expectedSurface) {
        throw "$Database has an incomplete cancellation surface: '$surfaceResult'."
    }

    Write-Host `
        "$Database - PASS: ledger, source checksum, constraints, indexes and least privilege verified." `
        -ForegroundColor Green
}

try {
    $securePassword = Read-Host `
        'PostgreSQL postgres password (held only by child processes)' `
        -AsSecureString
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR(
        $securePassword
    )
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
        $passwordPointer
    )
    $env:PGPASSWORD = $plainPassword

    Push-Location $backEnd
    try {
        Write-Host 'Preflight-verifying immutable migration 0021 on dhumi_test...' `
            -ForegroundColor Cyan
        Assert-CancelRunDatabase -Database 'dhumi_test'

        Write-Host 'Applying migration 0021 to dhumi_dev...' `
            -ForegroundColor Cyan
        & (Join-Path $PSScriptRoot 'migrate.ps1') -DatabaseUrl $DevDatabaseUrl
        Assert-ChildSuccess 'Migration 0021 failed on dhumi_dev.'

        Write-Host 'Verifying both configured databases independently...' `
            -ForegroundColor Cyan
        Assert-CancelRunDatabase -Database 'dhumi_test'
        Assert-CancelRunDatabase -Database 'dhumi_dev'

        Write-Host `
            'FINAL PASS - migration 0021 is correctly applied to dhumi_test and dhumi_dev.' `
            -ForegroundColor Green
    }
    finally {
        Pop-Location
    }
}
finally {
    if ($null -eq $oldPgPassword) {
        Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
    }
    else {
        $env:PGPASSWORD = $oldPgPassword
    }

    $plainPassword = $null
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
}
