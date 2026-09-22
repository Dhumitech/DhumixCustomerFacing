[CmdletBinding()]
param(
    [Parameter()]
    [string]$TestDatabaseUrl = 'postgresql://postgres@localhost:5432/dhumi_test'
)

$ErrorActionPreference = 'Stop'

if ($TestDatabaseUrl -ne 'postgresql://postgres@localhost:5432/dhumi_test') {
    throw 'This correction script may target only local dhumi_test.'
}
if ($TestDatabaseUrl -match '(?i)://[^/@\s]+:[^/@\s]+@' -or
    $TestDatabaseUrl -match '(?i)(^|\s)password\s*=') {
    throw 'TestDatabaseUrl must not contain a password.'
}
if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    throw 'psql was not found on PATH.'
}

$backEnd = Split-Path -Parent $PSScriptRoot
$migration = Join-Path $PSScriptRoot 'migrations\0024_run_retry_idempotency_lineage.sql'
$proof = Join-Path $backEnd 'tests\integration\0017_run_retry_idempotency_lineage.sql'
foreach ($requiredFile in @($migration, $proof)) {
    if (-not (Test-Path -LiteralPath $requiredFile)) {
        throw "Required retry idempotency file is missing: $requiredFile"
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
        Write-Host 'Running rollback-only migration 0024 proof against dhumi_test...' -ForegroundColor Cyan
        & psql -X -h localhost -U postgres -d dhumi_test `
            -v ON_ERROR_STOP=1 -f $proof
        Assert-ChildSuccess 'Retry idempotency proof failed. Migration 0024 was not ledgered.'

        Write-Host 'Applying migration 0024 to dhumi_test...' -ForegroundColor Cyan
        & (Join-Path $PSScriptRoot 'migrate.ps1') -DatabaseUrl $TestDatabaseUrl
        Assert-ChildSuccess 'Migration 0024 failed on dhumi_test.'

        $expectedChecksum = (
            Get-FileHash -Algorithm SHA256 -LiteralPath $migration
        ).Hash.ToLowerInvariant()
        $verifySql = @"
SET ROLE dhumi_owner;
SELECT
  (SELECT count(*)::text || '|' || COALESCE(max(checksum), '')
   FROM app.schema_migrations
   WHERE version = '0024_run_retry_idempotency_lineage') || '|' ||
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
        $result = (
            & psql -X -qAt -h localhost -U postgres -d dhumi_test `
                -v ON_ERROR_STOP=1 -c $verifySql | Out-String
        ).Trim()
        Assert-ChildSuccess 'dhumi_test migration 0024 verification failed.'
        if ($result -ne "1|$expectedChecksum|true|true|true|true") {
            throw "dhumi_test has an incorrect 0024 surface: '$result'."
        }

        Write-Host 'PASS - migration 0024 is ledgered and narrow retry claim lineage access is verified on dhumi_test.' -ForegroundColor Green
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
