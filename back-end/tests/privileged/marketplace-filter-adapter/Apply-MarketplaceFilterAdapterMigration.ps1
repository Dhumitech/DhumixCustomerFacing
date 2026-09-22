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

            $proof = & psql -X "--dbname=$($entry.Value)" `
                --tuples-only --no-align --quiet --set=ON_ERROR_STOP=1 `
                --command @"
SET ROLE dhumi_owner;
SELECT concat_ws('|',
  migration.version,
  adapter.state,
  adapter.capability_metadata->>'transport',
  adapter.capability_metadata->>'provider_http_enabled',
  adapter.capability_metadata->>'customer_visible'
)
FROM app.schema_migrations AS migration
CROSS JOIN app.adapter_versions AS adapter
JOIN app.adapter_definitions AS definition
  ON definition.id = adapter.adapter_definition_id
WHERE migration.version = '0052_marketplace_filter_adapter_fixture'
  AND definition.code = 'bright_data.marketplace.filter'
  AND adapter.semantic_version = '1.0.0-m7-fixture';
RESET ROLE;
"@
            if ($LASTEXITCODE -ne 0 -or ($proof -join "`n") -notmatch '0052_marketplace_filter_adapter_fixture\|disabled\|fixture\|false\|false') {
                throw "M7 migration proof failed for $($entry.Key)."
            }
            Write-Host "[PASS] M7 migration 0052 is ledgered and customer-disabled on $($entry.Key)."
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

Write-Host 'M7 fixture-adapter migration activation completed. Bright Data calls: 0.'
