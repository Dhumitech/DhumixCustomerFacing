[CmdletBinding()]
param(
    [Parameter()]
    [ValidateSet('Test', 'Dev', 'Both')]
    [string]$Target = 'Both'
)

$ErrorActionPreference = 'Stop'
$backendRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$environmentFile = Join-Path $backendRoot '.env'
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
if (-not (Test-Path -LiteralPath $environmentFile)) {
    throw '.env was not found. M10 activation requires RUN_EXECUTOR_DRIVER=controlled.'
}

$executorAssignments = @(
    Get-Content -LiteralPath $environmentFile |
        Where-Object { $_ -match '^\s*RUN_EXECUTOR_DRIVER\s*=' }
)
if ($executorAssignments.Count -ne 1 -or
    $executorAssignments[0] -notmatch '^\s*RUN_EXECUTOR_DRIVER\s*=\s*controlled\s*$') {
    throw 'M10 offline activation is allowed only when .env contains exactly RUN_EXECUTOR_DRIVER=controlled.'
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
  adapter.capability_metadata->>'provider_http_enabled',
  adapter.capability_metadata->>'customer_execution_enabled',
  adapter.capability_metadata->>'can_publish',
  NOT EXISTS (
    SELECT 1 FROM app.provider_mappings AS mapping
    WHERE mapping.adapter_version_id = adapter.id
      AND mapping.state <> 'disabled'
  ),
  NOT EXISTS (
    SELECT 1 FROM app.service_templates AS template
    JOIN app.service_template_versions AS version
      ON version.id = template.current_public_version_id
    WHERE version.adapter_version_id = adapter.id
  ),
  NOT EXISTS (
    SELECT 1 FROM app.service_versions AS service_version
    JOIN app.service_template_versions AS version
      ON version.id = service_version.service_template_version_id
    WHERE version.adapter_version_id = adapter.id
  ),
  NOT has_table_privilege(
    'dhumi_customer_api', 'app.marketplace_export_candidates', 'SELECT'
  ),
  NOT has_function_privilege(
    'dhumi_customer_api',
    'app.register_marketplace_export_candidate_v1(uuid,uuid,bytea,bytea,text,text,text)',
    'EXECUTE'
  )
)
FROM app.schema_migrations AS migration
CROSS JOIN app.adapter_versions AS adapter
JOIN app.adapter_definitions AS definition
  ON definition.id = adapter.adapter_definition_id
WHERE migration.version = '0056_marketplace_export_candidate'
  AND definition.code = 'bright_data.marketplace.filter'
  AND definition.product_family = 'marketplace_dataset'
  AND adapter.semantic_version = '1.0.0-m10-candidate';
RESET ROLE;
"@
            if ($LASTEXITCODE -ne 0) {
                throw "M10 activation proof query failed for $($entry.Key)."
            }
            $proofLine = (($proof -join "`n").Trim())
            if ($proofLine -ne '0056_marketplace_export_candidate|disabled|false|false|false|t|t|t|t|t') {
                throw "M10 fail-closed migration proof failed for $($entry.Key): $proofLine"
            }
            Write-Host "[PASS] M10 migration 0056 is ledgered and customer-disabled on $($entry.Key)."
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

Write-Host 'M10 export-candidate migration activation completed.'
Write-Host 'No candidate was registered, published or made customer-executable by this script.'
Write-Host 'Bright Data calls: 0.'
