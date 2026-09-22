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
    throw '.env was not found. M9 activation requires RUN_EXECUTOR_DRIVER=controlled.'
}

$executorAssignments = @(
    Get-Content -LiteralPath $environmentFile |
        Where-Object { $_ -match '^\s*RUN_EXECUTOR_DRIVER\s*=' }
)
if ($executorAssignments.Count -ne 1 -or $executorAssignments[0] -notmatch '^\s*RUN_EXECUTOR_DRIVER\s*=\s*controlled\s*$') {
    throw 'M9 offline activation is allowed only when .env contains exactly RUN_EXECUTOR_DRIVER=controlled.'
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
  adapter.capability_metadata->>'can_execute',
  (SELECT count(*) FROM app.provider_mappings AS mapping
    WHERE mapping.adapter_version_id = adapter.id),
  (SELECT count(*) FROM app.service_template_versions AS template_version
    WHERE template_version.adapter_version_id = adapter.id),
  (SELECT count(*) FROM app.marketplace_qualification_packets AS packet
    WHERE packet.authorization_state <> 'not_authorized'),
  (SELECT count(*) FROM app.marketplace_qualification_packets AS packet
    WHERE packet.provider_submission_count <> 0
       OR packet.execution_state <> 'not_started'
       OR packet.provider_snapshot_ciphertext IS NOT NULL
       OR packet.raw_object_key IS NOT NULL
       OR packet.normalized_object_key IS NOT NULL),
  (SELECT count(*) FROM app.marketplace_qualification_poll_checkpoints)
)
FROM app.schema_migrations AS migration
CROSS JOIN app.adapter_versions AS adapter
JOIN app.adapter_definitions AS definition
  ON definition.id = adapter.adapter_definition_id
WHERE migration.version = '0055_marketplace_qualification_execution'
  AND definition.code = 'bright_data.marketplace.filter'
  AND adapter.semantic_version = '1.0.0-m7-fixture';
RESET ROLE;
"@
            if ($LASTEXITCODE -ne 0) {
                throw "M9 activation proof query failed for $($entry.Key)."
            }
            $proofLine = (($proof -join "`n").Trim())
            if ($proofLine -ne '0055_marketplace_qualification_execution|disabled|false|false|0|0|0|0|0') {
                throw "M9 fail-closed execution activation proof failed for $($entry.Key): $proofLine"
            }
            Write-Host "[PASS] M9 migration 0055 is ledgered and fail-closed on $($entry.Key)."
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

Write-Host 'M9 qualification-execution migration activation completed.'
Write-Host 'All packets remain not authorized, unclaimed and unexecuted.'
Write-Host 'Bright Data calls: 0.'
