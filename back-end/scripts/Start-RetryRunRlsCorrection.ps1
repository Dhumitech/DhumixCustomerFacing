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
$migration = Join-Path $PSScriptRoot 'migrations\0023_run_retry_owner_rls.sql'
$proof = Join-Path $backEnd 'tests\integration\0016_run_retry_owner_rls.sql'
foreach ($requiredFile in @($migration, $proof)) {
    if (-not (Test-Path -LiteralPath $requiredFile)) {
        throw "Required retry correction file is missing: $requiredFile"
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
        Write-Host 'Running rollback-only migration 0023 proof against dhumi_test...' -ForegroundColor Cyan
        & psql -X -h localhost -U postgres -d dhumi_test `
            -v ON_ERROR_STOP=1 -f $proof
        Assert-ChildSuccess 'Retry RLS correction proof failed. Migration 0023 was not ledgered.'

        Write-Host 'Applying migration 0023 to dhumi_test...' -ForegroundColor Cyan
        & (Join-Path $PSScriptRoot 'migrate.ps1') -DatabaseUrl $TestDatabaseUrl
        Assert-ChildSuccess 'Migration 0023 failed on dhumi_test.'

        $expectedChecksum = (
            Get-FileHash -Algorithm SHA256 -LiteralPath $migration
        ).Hash.ToLowerInvariant()
        $verifySql = @"
SET ROLE dhumi_owner;
SELECT
  (SELECT count(*)::text || '|' || COALESCE(max(checksum), '')
   FROM app.schema_migrations
   WHERE version = '0023_run_retry_owner_rls') || '|' ||
  EXISTS (
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
        $result = (
            & psql -X -qAt -h localhost -U postgres -d dhumi_test `
                -v ON_ERROR_STOP=1 -c $verifySql | Out-String
        ).Trim()
        Assert-ChildSuccess 'dhumi_test migration 0023 verification failed.'
        if ($result -ne "1|$expectedChecksum|true") {
            throw "dhumi_test has an incorrect 0023 surface: '$result'."
        }

        Write-Host 'PASS - migration 0023 is ledgered and exact Tenant-scoped owner RLS is verified on dhumi_test.' -ForegroundColor Green
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
