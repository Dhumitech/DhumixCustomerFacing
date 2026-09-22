[CmdletBinding()]
param(
    [Parameter()]
    [ValidateSet('Test', 'Dev', 'Both')]
    [string]$Target = 'Both'
)

$ErrorActionPreference = 'Stop'
$backendRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$migrateScript = Join-Path $backendRoot 'scripts\migrate.ps1'
$databaseUrls = [ordered]@{}

if ($Target -in @('Test', 'Both')) {
    $databaseUrls['dhumi_test'] = 'postgresql://postgres@localhost:5432/dhumi_test'
}
if ($Target -in @('Dev', 'Both')) {
    $databaseUrls['dhumi_dev'] = 'postgresql://postgres@localhost:5432/dhumi_dev'
}

if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    throw 'psql was not found on PATH.'
}

$passwordPointer = [IntPtr]::Zero
$plainPassword = $null
$oldPgPassword = $env:PGPASSWORD

try {
    $securePassword = Read-Host 'PostgreSQL administrator password (held only by migration child processes)' -AsSecureString
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    $env:PGPASSWORD = $plainPassword

    Push-Location $backendRoot
    try {
        foreach ($entry in $databaseUrls.GetEnumerator()) {
            Write-Host "Applying forward-only migrations to $($entry.Key)..."
            & $migrateScript -DatabaseUrl $entry.Value
            if ($LASTEXITCODE -ne 0) {
                throw "Migration failed for $($entry.Key)."
            }

            $versions = & psql -X "--dbname=$($entry.Value)" `
                --tuples-only --no-align --quiet --set=ON_ERROR_STOP=1 `
                --command "SET ROLE dhumi_owner; SELECT version FROM app.schema_migrations WHERE version IN ('0046_marketplace_sample_ingestion', '0047_marketplace_sample_retention_policy', '0048_marketplace_sample_fixture_lifecycle', '0065_marketplace_fixture_current_schema') ORDER BY version; RESET ROLE;"
            $versionText = $versions -join "`n"
            if (
                $LASTEXITCODE -ne 0 -or
                $versionText -notmatch '0046_marketplace_sample_ingestion' -or
                $versionText -notmatch '0047_marketplace_sample_retention_policy' -or
                $versionText -notmatch '0048_marketplace_sample_fixture_lifecycle' -or
                $versionText -notmatch '0065_marketplace_fixture_current_schema'
            ) {
                throw "M3 lifecycle and compatibility migration 0065 were not all recorded for $($entry.Key)."
            }

            Write-Host "M3 migrations 0046 through 0048 and compatibility migration 0065 are ledgered on $($entry.Key)."
        }
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

Write-Host 'M3 fixture lifecycle migration activation completed. Bright Data calls: 0.'
