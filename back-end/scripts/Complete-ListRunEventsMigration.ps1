[CmdletBinding()]
param(
    [Parameter()]
    [string]$DevelopmentDatabaseUrl = `
        'postgresql://postgres@localhost:5432/dhumi_dev'
)

$ErrorActionPreference = 'Stop'

if ($DevelopmentDatabaseUrl -ne 'postgresql://postgres@localhost:5432/dhumi_dev') {
    throw 'This completion script may target only local dhumi_dev.'
}
if ($DevelopmentDatabaseUrl -match '(?i)://[^/@\s]+:[^/@\s]+@' -or
    $DevelopmentDatabaseUrl -match '(?i)(^|\s)password\s*=') {
    throw 'DevelopmentDatabaseUrl must not contain a password.'
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

function Assert-DatabaseSurface {
    param(
        [Parameter(Mandatory)][string]$Database,
        [Parameter(Mandatory)][string]$ExpectedChecksum
    )

    $ledgerSql = @"
SET ROLE dhumi_owner;
SELECT count(*)::text || '|' || COALESCE(max(checksum), '')
FROM app.schema_migrations
WHERE version = '0025_run_event_list_read_surface';
RESET ROLE;
"@
    $ledgerResult = (
        & psql -X -qAt -h localhost -U postgres -d $Database `
            -v ON_ERROR_STOP=1 -c $ledgerSql |
            Out-String
    ).Trim()
    Assert-ChildSuccess "$Database migration-ledger query failed."
    if ($ledgerResult -ne "1|$ExpectedChecksum") {
        throw "$Database has an incorrect 0025 ledger entry: '$ledgerResult'."
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
        & psql -X -qAt -h localhost -U postgres -d $Database `
            -v ON_ERROR_STOP=1 -c $surfaceSql |
            Out-String
    ).Trim()
    Assert-ChildSuccess "$Database Run-event surface query failed."
    $expectedSurface = (@('true') * 19) -join '|'
    if ($surfaceResult -ne $expectedSurface) {
        throw "$Database has an incomplete Run-event surface: '$surfaceResult'."
    }

    Write-Host `
        "$Database - PASS: ledger, checksum, grants, forced RLS and ordering verified." `
        -ForegroundColor Green
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
        $expectedChecksum = (
            Get-FileHash -Algorithm SHA256 -LiteralPath $migration
        ).Hash.ToLowerInvariant()

        Write-Host 'Preflight-verifying migration 0025 on dhumi_test...' `
            -ForegroundColor Cyan
        Assert-DatabaseSurface `
            -Database 'dhumi_test' `
            -ExpectedChecksum $expectedChecksum

        & npm run test:database
        Assert-ChildSuccess 'Database tests failed. dhumi_dev was not migrated.'

        & psql -X -h localhost -U postgres -d dhumi_test `
            -v ON_ERROR_STOP=1 `
            -f $proof
        Assert-ChildSuccess `
            'Privileged List-Run-events proof failed. dhumi_dev was not migrated.'

        & npm run typecheck
        Assert-ChildSuccess 'Typecheck failed. dhumi_dev was not migrated.'

        & npm test
        Assert-ChildSuccess 'Application tests failed. dhumi_dev was not migrated.'

        & npm run build
        Assert-ChildSuccess 'Build failed. dhumi_dev was not migrated.'

        & npx --yes @redocly/cli lint `
            (Join-Path $PSScriptRoot '..\contracts\openapi.yaml')
        Assert-ChildSuccess 'OpenAPI lint failed. dhumi_dev was not migrated.'

        Write-Host 'Applying migration 0025 to dhumi_dev...' -ForegroundColor Cyan
        & (Join-Path $PSScriptRoot 'migrate.ps1') `
            -DatabaseUrl $DevelopmentDatabaseUrl
        Assert-ChildSuccess 'Migration 0025 failed on dhumi_dev.'

        Write-Host 'Verifying both configured databases independently...' `
            -ForegroundColor Cyan
        foreach ($database in @('dhumi_test', 'dhumi_dev')) {
            Assert-DatabaseSurface `
                -Database $database `
                -ExpectedChecksum $expectedChecksum
        }

        Write-Host `
            'FINAL PASS - migration 0025 is correctly applied to dhumi_test and dhumi_dev.' `
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
