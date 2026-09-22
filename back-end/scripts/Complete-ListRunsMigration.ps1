[CmdletBinding()]
param(
    [Parameter()]
    [string]$TestDatabaseUrl = 'postgresql://postgres@localhost:5432/dhumi_test',

    [Parameter()]
    [string]$DevelopmentDatabaseUrl = 'postgresql://postgres@localhost:5432/dhumi_dev'
)

$ErrorActionPreference = 'Stop'

foreach ($databaseUrl in @($TestDatabaseUrl, $DevelopmentDatabaseUrl)) {
    if ($databaseUrl -match '(?i)://[^/@\s]+:[^/@\s]+@' -or
        $databaseUrl -match '(?i)(^|\s)password\s*=') {
        throw 'Database URLs must not contain passwords.'
    }
}

if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    throw 'psql was not found on PATH.'
}

$backEnd = Split-Path -Parent $PSScriptRoot
$passwordPointer = [IntPtr]::Zero
$plainPassword = $null
$oldPgPassword = $env:PGPASSWORD

function Assert-ChildSuccess {
    param([Parameter(Mandatory)][string]$Message)
    if ($LASTEXITCODE -ne 0) {
        throw $Message
    }
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
        # Test receives the existing forward-only migration first. Dev cannot
        # advance unless every restricted and privileged proof succeeds.
        & (Join-Path $PSScriptRoot 'migrate.ps1') `
            -DatabaseUrl $TestDatabaseUrl

        & npm run test:database
        Assert-ChildSuccess `
            'Database tests failed. dhumi_dev was not migrated.'

        & psql -X -h localhost -U postgres -d dhumi_test `
            -v ON_ERROR_STOP=1 `
            -f .\tests\integration\0012_run_list_read_surface.sql
        Assert-ChildSuccess `
            'Privileged Run-list proof failed. dhumi_dev was not migrated.'

        & npm run typecheck
        Assert-ChildSuccess `
            'Typecheck failed. dhumi_dev was not migrated.'

        & npm test
        Assert-ChildSuccess `
            'Application tests failed. dhumi_dev was not migrated.'

        & npm run build
        Assert-ChildSuccess `
            'Build failed. dhumi_dev was not migrated.'

        & (Join-Path $PSScriptRoot 'migrate.ps1') `
            -DatabaseUrl $DevelopmentDatabaseUrl

        $version = '0020_run_list_read_surface'
        $migrationPath = Join-Path `
            $PSScriptRoot `
            "migrations\$version.sql"
        $expectedChecksum = (
            Get-FileHash -Algorithm SHA256 -LiteralPath $migrationPath
        ).Hash.ToLowerInvariant()

        foreach ($database in @('dhumi_test', 'dhumi_dev')) {
            $ledgerSql = @"
SET ROLE dhumi_owner;
SELECT count(*)::text || '|' || COALESCE(max(checksum), '')
FROM app.schema_migrations
WHERE version = '$version';
RESET ROLE;
"@
            $ledgerResult = (
                & psql -X -qAt -h localhost -U postgres -d $database `
                    -v ON_ERROR_STOP=1 `
                    -c $ledgerSql |
                    Out-String
            ).Trim()
            Assert-ChildSuccess "$database ledger query failed."

            if ($ledgerResult -ne "1|$expectedChecksum") {
                throw "$database has an incorrect $version ledger entry: '$ledgerResult'."
            }

            $surfaceSql = @"
SET ROLE dhumi_owner;
SELECT
  has_column_privilege(
    'dhumi_customer_api',
    'app.service_versions',
    'id',
    'SELECT'
  )::text || '|' ||
  (NOT has_table_privilege(
    'dhumi_customer_api',
    'app.service_versions',
    'SELECT'
  ))::text || '|' ||
  (NOT has_column_privilege(
    'dhumi_customer_api',
    'app.service_versions',
    'schema_hash',
    'SELECT'
  ))::text || '|' ||
  (to_regclass(
    'app.runs_by_tenant_status_created_id_idx'
  ) IS NOT NULL)::text;
RESET ROLE;
"@
            $surfaceResult = (
                & psql -X -qAt -h localhost -U postgres -d $database `
                    -v ON_ERROR_STOP=1 `
                    -c $surfaceSql |
                    Out-String
            ).Trim()
            Assert-ChildSuccess "$database Run-list surface query failed."

            if ($surfaceResult -ne 'true|true|true|true') {
                throw "$database has an incomplete Run-list surface: '$surfaceResult'."
            }

            Write-Host `
                "$database - PASS: ledger, checksum, least privilege and index verified." `
                -ForegroundColor Green
        }

        Write-Host `
            'FINAL PASS - migration 0020 and Run-list proofs completed.' `
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
