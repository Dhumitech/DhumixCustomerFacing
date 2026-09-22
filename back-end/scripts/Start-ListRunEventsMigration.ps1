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
$migration = Join-Path `
    $PSScriptRoot `
    'migrations\0025_run_event_list_read_surface.sql'
$proof = Join-Path `
    $backEnd `
    'tests\integration\0018_run_event_list_read_surface.sql'
foreach ($requiredFile in @($migration, $proof)) {
    if (-not (Test-Path -LiteralPath $requiredFile)) {
        throw "Required List-Run-events file is missing: $requiredFile"
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
    $securePassword = Read-Host `
        'PostgreSQL postgres password (held only by child processes)' `
        -AsSecureString
    $passwordPointer = `
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $plainPassword = `
        [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    $env:PGPASSWORD = $plainPassword

    Push-Location $backEnd
    try {
        Write-Host `
            'Running rollback-only migration 0025 proof against dhumi_test...' `
            -ForegroundColor Cyan
        & psql -X -h localhost -U postgres -d dhumi_test `
            -v ON_ERROR_STOP=1 `
            -f $proof
        Assert-ChildSuccess `
            'List-Run-events proof failed. Migration 0025 was not applied.'

        Write-Host 'Applying migration 0025 to dhumi_test...' -ForegroundColor Cyan
        & (Join-Path $PSScriptRoot 'migrate.ps1') `
            -DatabaseUrl $TestDatabaseUrl
        Assert-ChildSuccess 'Migration 0025 failed on dhumi_test.'

        $expectedChecksum = (
            Get-FileHash -Algorithm SHA256 -LiteralPath $migration
        ).Hash.ToLowerInvariant()
        $ledgerSql = @"
SET ROLE dhumi_owner;
SELECT count(*)::text || '|' || COALESCE(max(checksum), '')
FROM app.schema_migrations
WHERE version = '0025_run_event_list_read_surface';
RESET ROLE;
"@
        $ledgerResult = (
            & psql -X -qAt -h localhost -U postgres -d dhumi_test `
                -v ON_ERROR_STOP=1 -c $ledgerSql |
                Out-String
        ).Trim()
        Assert-ChildSuccess 'dhumi_test migration-ledger verification failed.'
        if ($ledgerResult -ne "1|$expectedChecksum") {
            throw "dhumi_test has an incorrect 0025 ledger entry: '$ledgerResult'."
        }

        $surfaceSql = @"
SET ROLE dhumi_owner;
SELECT
  (NOT has_table_privilege('dhumi_customer_api', 'app.run_events', 'SELECT'))::text || '|' ||
  has_column_privilege('dhumi_customer_api', 'app.run_events', 'id', 'SELECT')::text || '|' ||
  has_column_privilege('dhumi_customer_api', 'app.run_events', 'tenant_id', 'SELECT')::text || '|' ||
  has_column_privilege('dhumi_customer_api', 'app.run_events', 'run_id', 'SELECT')::text || '|' ||
  has_column_privilege('dhumi_customer_api', 'app.run_events', 'sequence', 'SELECT')::text || '|' ||
  has_column_privilege('dhumi_customer_api', 'app.run_events', 'event_type', 'SELECT')::text || '|' ||
  has_column_privilege('dhumi_customer_api', 'app.run_events', 'occurred_at', 'SELECT')::text || '|' ||
  (NOT has_column_privilege('dhumi_customer_api', 'app.run_events', 'source', 'SELECT'))::text || '|' ||
  (NOT has_column_privilege('dhumi_customer_api', 'app.run_events', 'attempt_id', 'SELECT'))::text || '|' ||
  (NOT has_column_privilege('dhumi_customer_api', 'app.run_events', 'event_idempotency_key', 'SELECT'))::text || '|' ||
  (NOT has_column_privilege('dhumi_customer_api', 'app.run_events', 'safe_payload', 'SELECT'))::text || '|' ||
  (NOT has_column_privilege('dhumi_customer_api', 'app.run_events', 'evidence_reference', 'SELECT'))::text || '|' ||
  (NOT has_column_privilege('dhumi_customer_api', 'app.run_events', 'recorded_at', 'SELECT'))::text || '|' ||
  (NOT has_table_privilege('dhumi_customer_api', 'app.run_events', 'INSERT'))::text || '|' ||
  (NOT has_table_privilege('dhumi_customer_api', 'app.run_events', 'UPDATE'))::text || '|' ||
  (NOT has_table_privilege('dhumi_customer_api', 'app.run_events', 'DELETE'))::text || '|' ||
  (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'app.run_events'::regclass)::text || '|' ||
  (to_regclass('app.run_events_run_id_sequence_key') IS NOT NULL)::text || '|' ||
  (EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'app.run_events'::regclass
      AND tgname = 'run_events_immutable'
      AND NOT tgisinternal
  ))::text;
RESET ROLE;
"@
        $surfaceResult = (
            & psql -X -qAt -h localhost -U postgres -d dhumi_test `
                -v ON_ERROR_STOP=1 -c $surfaceSql |
                Out-String
        ).Trim()
        Assert-ChildSuccess 'dhumi_test Run-event surface verification failed.'
        $expectedSurface = (@('true') * 19) -join '|'
        if ($surfaceResult -ne $expectedSurface) {
            throw "dhumi_test has an incomplete Run-event surface: '$surfaceResult'."
        }

        Write-Host `
            'PASS - proof rolled back and migration 0025 is verified on dhumi_test.' `
            -ForegroundColor Green
        Write-Host `
            'Next: npm run test:database, then .\scripts\Complete-ListRunEventsMigration.ps1' `
            -ForegroundColor Cyan
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
