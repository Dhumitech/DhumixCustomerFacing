[CmdletBinding()]
param(
    [Parameter()]
    [ValidateSet('Test', 'Dev', 'Both')]
    [string]$Target = 'Both'
)

$ErrorActionPreference = 'Stop'
$backendRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$migrateScript = Join-Path $backendRoot 'scripts\migrate.ps1'
$migrationDirectory = Join-Path $backendRoot 'scripts\migrations'
$requiredMigrations = [ordered]@{
    '0066_shared_scraper_processing' = Join-Path $migrationDirectory '0066_shared_scraper_processing.sql'
    '0067_shared_scraper_draft_registration' = Join-Path $migrationDirectory '0067_shared_scraper_draft_registration.sql'
    '0068_shared_scraper_release_identity' = Join-Path $migrationDirectory '0068_shared_scraper_release_identity.sql'
    '0069_shared_scraper_commercial_capacity' = Join-Path $migrationDirectory '0069_shared_scraper_commercial_capacity.sql'
}
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
if (-not (Test-Path -LiteralPath $migrateScript -PathType Leaf)) {
    throw "Migration runner was not found: $migrateScript"
}
foreach ($entry in $requiredMigrations.GetEnumerator()) {
    if (-not (Test-Path -LiteralPath $entry.Value -PathType Leaf)) {
        throw "Required migration was not found: $($entry.Value)"
    }
}

# This activation script is intentionally bounded to 0069. A later migration
# needs its own reviewed activation plan instead of being applied implicitly.
$laterMigrations = Get-ChildItem -LiteralPath $migrationDirectory -Filter '*.sql' |
    Where-Object { $_.BaseName -match '^(\d{4})_' -and [int]$Matches[1] -gt 69 }
if ($laterMigrations.Count -gt 0) {
    throw "Migrations newer than 0069 exist. Review them separately before using this bounded activation script: $($laterMigrations.Name -join ', ')"
}

$expectedChecksums = @{}
foreach ($entry in $requiredMigrations.GetEnumerator()) {
    $expectedChecksums[$entry.Key] = (Get-FileHash -LiteralPath $entry.Value -Algorithm SHA256).Hash.ToLowerInvariant()
}

$passwordPointer = [IntPtr]::Zero
$plainPassword = $null
$previousPassword = $env:PGPASSWORD

try {
    $securePassword = Read-Host 'PostgreSQL administrator password (held only by migration child processes)' -AsSecureString
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    $env:PGPASSWORD = $plainPassword

    Push-Location $backendRoot
    try {
        foreach ($entry in $databaseUrls.GetEnumerator()) {
            $databaseName = $entry.Key
            $databaseUrl = $entry.Value
            Write-Host "Checking database identity for $databaseName..."
            $actualDatabase = (& psql -X "--dbname=$databaseUrl" --no-password `
                --tuples-only --no-align --quiet --set=ON_ERROR_STOP=1 `
                --command 'SELECT current_database();') -join "`n"
            if ($LASTEXITCODE -ne 0 -or $actualDatabase.Trim() -ne $databaseName) {
                throw "Database mismatch: expected $databaseName, received '$($actualDatabase.Trim())'."
            }

            Write-Host "Applying pending forward-only migrations through 0069 to $databaseName..."
            & $migrateScript -DatabaseUrl $databaseUrl
            if ($LASTEXITCODE -ne 0) {
                throw "Shared scraper migration activation failed for $databaseName."
            }

            foreach ($migration in $requiredMigrations.GetEnumerator()) {
                $ledgerChecksum = (& psql -X "--dbname=$databaseUrl" --no-password `
                    --tuples-only --no-align --quiet --set=ON_ERROR_STOP=1 `
                    --command "SELECT checksum FROM app.schema_migrations WHERE version = '$($migration.Key)';") -join "`n"
                if ($LASTEXITCODE -ne 0 -or $ledgerChecksum.Trim() -ne $expectedChecksums[$migration.Key]) {
                    throw "Migration ledger verification failed for $($migration.Key) on $databaseName."
                }
            }

            $surfaceProof = (& psql -X "--dbname=$databaseUrl" --no-password `
                --tuples-only --no-align --quiet --set=ON_ERROR_STOP=1 `
                --command @'
SELECT concat_ws('|',
  to_regprocedure('app.resolve_provider_executor_identity(uuid,uuid,uuid)') IS NOT NULL,
  to_regprocedure('app.stage_shared_scraper_operation_v1(jsonb,text,text,text)') IS NOT NULL,
  to_regprocedure('app.resolve_shared_scraper_admission_contract(uuid,uuid)') IS NOT NULL,
  to_regprocedure('app.resolve_shared_scraper_execution_plan(uuid,uuid,uuid,text,uuid)') IS NOT NULL,
  to_regprocedure('app.require_shared_scraper_run_capacity(text,uuid,uuid,integer)') IS NOT NULL,
  EXISTS (
    SELECT 1 FROM app.adapter_versions AS adapter
    JOIN app.adapter_definitions AS definition ON definition.id = adapter.adapter_definition_id
    WHERE definition.code = 'bright_data.scraper_library.shared'
      AND adapter.semantic_version = '1.0.0-shared-scraper-processing'
      AND adapter.state = 'disabled'
      AND encode(adapter.code_artifact_digest, 'hex') = '007f1a56c59ec83ff8d6c4e359cc7b6121edf4a6c9d93ad7565d86b178bbca7f'
  ),
  EXISTS (
    SELECT 1 FROM app.adapter_versions AS adapter
    JOIN app.adapter_definitions AS definition ON definition.id = adapter.adapter_definition_id
    WHERE definition.code = 'bright_data.scraper_library.shared'
      AND adapter.semantic_version = '1.1.0-shared-scraper-release'
      AND adapter.state = 'enabled'
      AND encode(adapter.code_artifact_digest, 'hex') = '94cc1cb6132f65b60101964647087d967dbd57dae7c3a51610b184151928846a'
  )
);
'@) -join "`n"
            if ($LASTEXITCODE -ne 0 -or $surfaceProof.Trim() -ne 't|t|t|t|t|t|t') {
                throw "Shared scraper database-surface verification failed on ${databaseName}: $($surfaceProof.Trim())"
            }

            Write-Host "[PASS] Migrations 0066-0069 and exact runtime identities verified on $databaseName."
        }
    }
    finally {
        Pop-Location
    }
}
finally {
    if ($null -eq $previousPassword) {
        Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
    }
    else {
        $env:PGPASSWORD = $previousPassword
    }
    $plainPassword = $null
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
}

Write-Host ''
Write-Host 'SUCCESS: shared scraper migrations 0066-0069 are activated and verified.'
Write-Host 'No scraper was published, no feature flag was changed, and no Bright Data call was made.'
