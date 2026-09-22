[CmdletBinding()]
param(
    [Parameter()]
    [ValidateSet('Dev', 'Both')]
    [string]$Target = 'Both'
)

$ErrorActionPreference = 'Stop'
$backendRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$environmentFile = Join-Path $backendRoot '.env'
$migrateScript = Join-Path $backendRoot 'scripts\migrate.ps1'
$candidateId = 'f60af142-3f00-4b0f-b159-86b41ff74b7f'
$migrationVersion = '0060_linkedin_people_metadata_observation'
$databaseUrls = [ordered]@{}
if ($Target -eq 'Both') {
    $databaseUrls['dhumi_test'] = 'postgresql://postgres@localhost:5432/dhumi_test'
}
$databaseUrls['dhumi_dev'] = 'postgresql://postgres@localhost:5432/dhumi_dev'

if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    throw 'psql was not found on PATH.'
}
if (-not (Test-Path -LiteralPath $environmentFile)) {
    throw '.env was not found.'
}
$executorAssignments = @(
    Get-Content -LiteralPath $environmentFile |
        Where-Object { $_ -match '^\s*RUN_EXECUTOR_DRIVER\s*=' }
)
if ($executorAssignments.Count -ne 1 -or
    $executorAssignments[0] -notmatch '^\s*RUN_EXECUTOR_DRIVER\s*=\s*controlled\s*$') {
    throw 'LinkedIn People metadata capture requires exactly RUN_EXECUTOR_DRIVER=controlled.'
}
$databaseAssignments = @(
    Get-Content -LiteralPath $environmentFile |
        Where-Object { $_ -match '^\s*DATABASE_NAME\s*=' }
)
if ($databaseAssignments.Count -ne 1 -or
    $databaseAssignments[0] -notmatch '^\s*DATABASE_NAME\s*=\s*dhumi_dev\s*$') {
    throw 'The operator .env must target DATABASE_NAME=dhumi_dev.'
}
$providerWorkers = @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -eq 'node.exe' -and
            $_.CommandLine -match '(?i)src[\\/]worker[\\/](jobManager|outboxDispatcher)\.ts'
        }
)
if ($providerWorkers.Count -gt 0) {
    $providerWorkers | Select-Object ProcessId, CommandLine | Format-Table -AutoSize
    throw 'Stop the Outbox Dispatcher and Job Manager before metadata capture.'
}

$passwordPointer = [IntPtr]::Zero
$plainPassword = $null
$oldPgPassword = $env:PGPASSWORD

try {
    $securePassword = Read-Host 'PostgreSQL administrator password (held only by migration/proof child processes)' -AsSecureString
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
            $ledger = & psql -X "--dbname=$($entry.Value)" --tuples-only --no-align `
                --quiet --set=ON_ERROR_STOP=1 `
                --command "SELECT checksum FROM app.schema_migrations WHERE version = '$migrationVersion';"
            if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($ledger -join "`n").Trim())) {
                throw "Migration 0060 was not ledgered on $($entry.Key)."
            }
            Write-Host "[PASS] Migration 0060 is ledgered on $($entry.Key)."
        }

        $before = & psql -X --dbname='postgresql://postgres@localhost:5432/dhumi_dev' `
            --tuples-only --no-align --quiet --set=ON_ERROR_STOP=1 --command @"
SELECT concat_ws('|',
  (SELECT count(*) FROM app.services),
  (SELECT count(*) FROM app.runs),
  (SELECT count(*) FROM app.outbox_events),
  (SELECT count(*) FROM app.marketplace_catalog_metadata_observations
    WHERE catalog_candidate_id = '$candidateId'::uuid),
  COALESCE((SELECT current_public_version_id::text FROM app.service_templates
    WHERE slug = 'linkedin-people'), '<null>')
);
"@
        if ($LASTEXITCODE -ne 0) {
            throw 'Could not capture the pre-call database boundary.'
        }

        Write-Host 'Calling exactly one read-only provider metadata endpoint...'
        Write-Host 'Provider request: GET /datasets/{protected_standard_people_id}/metadata'
        Write-Host 'Customer links: 0; Search/Filter/purchase/export POSTs: 0.'
        & npm.cmd run operator:marketplace-people-metadata -- `
            --candidate-id $candidateId `
            --actor marketplace.people.metadata.local `
            --evidence-reference checkpoint://dataset-market/linkedin-people/metadata-v1 `
            --confirm-read-only-provider
        if ($LASTEXITCODE -ne 0) {
            throw 'The LinkedIn People metadata operator failed.'
        }

        $after = & psql -X --dbname='postgresql://postgres@localhost:5432/dhumi_dev' `
            --tuples-only --no-align --quiet --set=ON_ERROR_STOP=1 --command @"
WITH latest AS (
  SELECT observation.*
  FROM app.marketplace_catalog_metadata_observations AS observation
  WHERE observation.catalog_candidate_id = '$candidateId'::uuid
  ORDER BY observation.observed_at DESC, observation.id DESC
  LIMIT 1
)
SELECT jsonb_build_object(
  'services', (SELECT count(*) FROM app.services),
  'runs', (SELECT count(*) FROM app.runs),
  'outbox', (SELECT count(*) FROM app.outbox_events),
  'observation_count', (SELECT count(*) FROM app.marketplace_catalog_metadata_observations
    WHERE catalog_candidate_id = '$candidateId'::uuid),
  'latest_observation_id', (SELECT id FROM latest),
  'field_count', (SELECT field_count FROM latest),
  'byte_count', (SELECT byte_count FROM latest),
  'checksum', (SELECT encode(metadata_checksum, 'hex') FROM latest),
  'content_type', (SELECT content_type FROM latest),
  'public_pointer', (SELECT current_public_version_id FROM app.service_templates
    WHERE slug = 'linkedin-people'),
  'audit_count', (SELECT count(*) FROM app.audit_events AS audit
    JOIN latest ON latest.id = audit.target_id
    WHERE audit.action = 'provider.catalog_metadata.capture'
      AND audit.outcome = 'completed')
);
"@
        if ($LASTEXITCODE -ne 0) {
            throw 'Could not verify the post-call database boundary.'
        }
        $beforeParts = (($before -join "`n").Trim()) -split '\|'
        $proof = (($after -join "`n").Trim()) | ConvertFrom-Json
        if ($beforeParts.Count -ne 5 -or
            [int64]$proof.services -ne [int64]$beforeParts[0] -or
            [int64]$proof.runs -ne [int64]$beforeParts[1] -or
            [int64]$proof.outbox -ne [int64]$beforeParts[2] -or
            $null -ne $proof.public_pointer -or
            [int64]$proof.observation_count -lt ([int64]$beforeParts[3] + 1) -or
            [int64]$proof.field_count -lt 1 -or
            [int64]$proof.byte_count -lt 2 -or
            $proof.checksum -notmatch '^[0-9a-f]{64}$' -or
            $proof.content_type -ne 'application/json' -or
            [int64]$proof.audit_count -ne 1) {
            Write-Host ($proof | ConvertTo-Json -Depth 5)
            throw 'LinkedIn People metadata persistence/release-boundary proof failed.'
        }
        Write-Host '[PASS] Exact standard LinkedIn People metadata is privately retained and audited.'
        Write-Host "[PASS] Field count: $($proof.field_count); bytes: $($proof.byte_count); checksum: $($proof.checksum)"
        Write-Host '[PASS] Public pointer, Services, Runs and outbox state are unchanged.'
        Write-Host 'Bright Data calls: exactly 1 read-only metadata GET; billable POSTs: 0.'
    }
    finally {
        Pop-Location
    }
}
finally {
    if ($null -eq $oldPgPassword) {
        Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
    } else {
        $env:PGPASSWORD = $oldPgPassword
    }
    $plainPassword = $null
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
}
