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
$fixtureFile = Join-Path $backendRoot 'tests\fixtures\marketplace-people\linkedin-people-synthetic-v1.json'
$migrationVersions = @(
    '0060_linkedin_people_metadata_observation',
    '0061_linkedin_people_synthetic_preview',
    '0062_linkedin_people_sample_timestamp_authority'
)
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
if (-not (Test-Path -LiteralPath $fixtureFile)) {
    throw 'The governed LinkedIn People synthetic fixture was not found.'
}
$executorAssignments = @(
    Get-Content -LiteralPath $environmentFile |
        Where-Object { $_ -match '^\s*RUN_EXECUTOR_DRIVER\s*=' }
)
if ($executorAssignments.Count -ne 1 -or
    $executorAssignments[0] -notmatch '^\s*RUN_EXECUTOR_DRIVER\s*=\s*controlled\s*$') {
    throw 'LinkedIn People preview activation requires exactly RUN_EXECUTOR_DRIVER=controlled.'
}
$databaseAssignments = @(
    Get-Content -LiteralPath $environmentFile |
        Where-Object { $_ -match '^\s*DATABASE_NAME\s*=' }
)
if ($databaseAssignments.Count -ne 1 -or
    $databaseAssignments[0] -notmatch '^\s*DATABASE_NAME\s*=\s*dhumi_dev\s*$') {
    throw 'The operator .env must target DATABASE_NAME=dhumi_dev.'
}

$actualNodeRuntimes = @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -eq 'node.exe' -and
            $_.CommandLine -match '(?i)(src|dist)[\\/](server\.(ts|js)|worker[\\/](jobManager|outboxDispatcher)\.(ts|js))'
        }
)
if ($actualNodeRuntimes.Count -gt 0) {
    $actualNodeRuntimes |
        Select-Object ProcessId, CommandLine |
        Format-Table -AutoSize
    throw 'Stop the Customer API, Outbox Dispatcher and Job Manager before activation.'
}

$azurite = Test-NetConnection 127.0.0.1 -Port 10000 -WarningAction SilentlyContinue
if (-not $azurite.TcpTestSucceeded) {
    throw 'Azurite is not reachable on 127.0.0.1:10000.'
}

$passwordPointer = [IntPtr]::Zero
$plainPassword = $null
$oldPgPassword = $env:PGPASSWORD

try {
    $securePassword = Read-Host 'PostgreSQL administrator password (held only by migration and proof child processes)' -AsSecureString
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    $env:PGPASSWORD = $plainPassword

    Push-Location $backendRoot
    try {
        $before = & psql -X --dbname='postgresql://postgres@localhost:5432/dhumi_dev' `
            --tuples-only --no-align --quiet --set=ON_ERROR_STOP=1 `
            --command @"
SELECT jsonb_build_object(
  'services', (SELECT count(*) FROM app.services),
  'runs', (SELECT count(*) FROM app.runs),
  'attempts', (SELECT count(*) FROM app.run_attempts),
  'outbox', (SELECT count(*) FROM app.outbox_events)
);
"@
        if ($LASTEXITCODE -ne 0) {
            throw 'Could not capture the pre-activation execution-state boundary.'
        }
        $beforeJson = (($before -join "`n").Trim())
        try {
            $beforeState = $beforeJson | ConvertFrom-Json -ErrorAction Stop
        }
        catch {
            throw "Pre-activation execution-state boundary returned invalid JSON: $beforeJson"
        }

        foreach ($entry in $databaseUrls.GetEnumerator()) {
            Write-Host "Applying forward-only migrations to $($entry.Key)..."
            & $migrateScript -DatabaseUrl $entry.Value
            if ($LASTEXITCODE -ne 0) {
                throw "Migration failed for $($entry.Key)."
            }
            $ledger = & psql -X "--dbname=$($entry.Value)" --tuples-only --no-align `
                --quiet --set=ON_ERROR_STOP=1 `
                --command "SELECT version FROM app.schema_migrations WHERE version = ANY (ARRAY['$($migrationVersions -join "','")']::text[]) ORDER BY version;"
            $ledgeredVersions = @(($ledger -join "`n").Trim() -split "`n" | Where-Object { $_ })
            if ($LASTEXITCODE -ne 0 -or
                ($ledgeredVersions -join '|') -ne ($migrationVersions -join '|')) {
                throw "Required LinkedIn People migrations were not ledgered on $($entry.Key)."
            }
            Write-Host "[PASS] LinkedIn People migrations 0060-0062 are ledgered on $($entry.Key)."
        }

        Write-Host 'Ingesting the five-record metadata-derived synthetic sample...'
        $operatorOutput = & npm.cmd run operator:marketplace-people-sample -- `
            --sample-file $fixtureFile `
            --sample-version 1 `
            --actor marketplace.linkedin-people.synthetic.local
        $operatorOutput | Write-Output
        if ($LASTEXITCODE -ne 0) {
            throw 'The LinkedIn People sample operator failed.'
        }

        $proof = & psql -X --dbname='postgresql://postgres@localhost:5432/dhumi_dev' `
            --tuples-only --no-align --quiet --set=ON_ERROR_STOP=1 `
            --command @"
WITH source AS (
  SELECT * FROM app.resolve_linkedin_people_synthetic_sample_source()
), target_sample AS (
  SELECT sample.*
  FROM app.marketplace_sample_versions AS sample
  JOIN source ON source.template_version_id = sample.service_template_version_id
  WHERE sample.sample_version = 1
), selected_preview AS (
  SELECT preview.*
  FROM app.resolve_marketplace_sample_preview(
    'linkedin-people', statement_timestamp()
  ) AS preview
), release_boundary AS (
  SELECT
    template.state AS template_state,
    template.current_public_version_id,
    version.availability_state,
    version.effective_at,
    version.published_at,
    adapter.state AS adapter_state
  FROM source
  JOIN app.service_template_versions AS version
    ON version.id = source.template_version_id
  JOIN app.service_templates AS template
    ON template.id = version.service_template_id
  JOIN app.adapter_versions AS adapter
    ON adapter.id = version.adapter_version_id
)
SELECT jsonb_build_object(
  'database', current_database(),
  'source_count', (SELECT count(*) FROM source),
  'metadata_checksum',
    (SELECT encode(source.metadata_checksum, 'hex') FROM source LIMIT 1),
  'metadata_bytes', (SELECT source.metadata_byte_count FROM source LIMIT 1),
  'metadata_fields', (SELECT source.metadata_field_count FROM source LIMIT 1),
  'sample_count', (SELECT count(*) FROM target_sample),
  'source_kind', (SELECT sample.source_kind FROM target_sample AS sample LIMIT 1),
  'sample_state', (SELECT sample.state FROM target_sample AS sample LIMIT 1),
  'governance_state',
    (SELECT sample.governance_state FROM target_sample AS sample LIMIT 1),
  'sample_version', (SELECT sample.sample_version FROM target_sample AS sample LIMIT 1),
  'record_count', (SELECT sample.record_count FROM target_sample AS sample LIMIT 1),
  'field_count',
    (SELECT jsonb_array_length(sample.field_dictionary)
     FROM target_sample AS sample LIMIT 1),
  'masked_field_count',
    (SELECT count(*)
     FROM target_sample AS sample
     CROSS JOIN LATERAL jsonb_array_elements(sample.field_dictionary) AS item(field)
     WHERE item.field->>'sample_visibility' = 'masked'),
  'masked_filterable_count',
    (SELECT count(*)
     FROM target_sample AS sample
     CROSS JOIN LATERAL jsonb_array_elements(sample.field_dictionary) AS item(field)
     WHERE item.field->>'sample_visibility' = 'masked'
       AND item.field->'allowed_operators' <> '[]'::jsonb),
  'retention_exact', COALESCE(
    (SELECT sample.expires_at = sample.collected_at + interval '720 hours'
     FROM target_sample AS sample LIMIT 1), false),
  'rights_reference_absent', COALESCE(
    (SELECT sample.rights_evidence_reference IS NULL
     FROM target_sample AS sample LIMIT 1), false),
  'preview_count', (SELECT count(*) FROM selected_preview),
  'preview_sample_version',
    (SELECT preview.sample_version FROM selected_preview AS preview LIMIT 1),
  'preview_record_count',
    (SELECT preview.sample_record_count FROM selected_preview AS preview LIMIT 1),
  'preview_field_count',
    (SELECT jsonb_array_length(preview.fields) FROM selected_preview AS preview LIMIT 1),
  'post_purchase_leak_count',
    (SELECT count(*)
     FROM selected_preview AS preview
     CROSS JOIN LATERAL jsonb_array_elements(preview.fields) AS item(field)
     WHERE item.field ? 'post_purchase_visibility'),
  'template_state',
    (SELECT boundary.template_state FROM release_boundary AS boundary LIMIT 1),
  'public_pointer_absent', COALESCE(
    (SELECT boundary.current_public_version_id IS NULL
     FROM release_boundary AS boundary LIMIT 1), false),
  'availability_state',
    (SELECT boundary.availability_state FROM release_boundary AS boundary LIMIT 1),
  'effective_at_absent', COALESCE(
    (SELECT boundary.effective_at IS NULL FROM release_boundary AS boundary LIMIT 1), false),
  'published_at_absent', COALESCE(
    (SELECT boundary.published_at IS NULL FROM release_boundary AS boundary LIMIT 1), false),
  'adapter_state',
    (SELECT boundary.adapter_state FROM release_boundary AS boundary LIMIT 1),
  'audit_count',
    (SELECT count(*)
     FROM app.audit_events AS audit
     JOIN target_sample AS sample ON sample.id = audit.target_id
     WHERE audit.action = 'marketplace.sample_fixture.ingest'
       AND audit.outcome = 'completed'
       AND audit.safe_diff->>'provider_calls' = '0'
       AND audit.safe_diff->>'contact_enrichment_enabled' = 'false'
       AND audit.safe_diff->>'customer_execution_enabled' = 'false'),
  'execution_state', jsonb_build_object(
    'services', (SELECT count(*) FROM app.services),
    'runs', (SELECT count(*) FROM app.runs),
    'attempts', (SELECT count(*) FROM app.run_attempts),
    'outbox', (SELECT count(*) FROM app.outbox_events)
  )
);
"@
        if ($LASTEXITCODE -ne 0) {
            throw 'Persistent LinkedIn People preview proof query failed.'
        }
        $proofJson = (($proof -join "`n").Trim())
        if ([string]::IsNullOrWhiteSpace($proofJson)) {
            throw 'Persistent LinkedIn People preview proof returned no diagnostic document.'
        }
        try {
            $proofState = $proofJson | ConvertFrom-Json -ErrorAction Stop
        }
        catch {
            throw "Persistent LinkedIn People preview proof returned invalid JSON: $proofJson"
        }
        $expectedProof = [ordered]@{
            database = 'dhumi_dev'
            source_count = 1
            metadata_checksum = '9b3b7be895b1e063363e46e205c1f9e46864011e6ee76e666ac8a27e0d7a86eb'
            metadata_bytes = 32401
            metadata_fields = 46
            sample_count = 1
            source_kind = 'synthetic_fixture'
            sample_state = 'validated_fixture'
            governance_state = 'synthetic_fixture'
            sample_version = 1
            record_count = 5
            field_count = 42
            masked_field_count = 12
            masked_filterable_count = 0
            retention_exact = $true
            rights_reference_absent = $true
            preview_count = 1
            preview_sample_version = 1
            preview_record_count = 5
            preview_field_count = 42
            post_purchase_leak_count = 0
            template_state = 'draft'
            public_pointer_absent = $true
            availability_state = 'coming_soon'
            effective_at_absent = $true
            published_at_absent = $true
            adapter_state = 'disabled'
            audit_count = 1
        }
        $proofFailures = @()
        foreach ($entry in $expectedProof.GetEnumerator()) {
            $actualValue = $proofState.($entry.Key)
            if ($actualValue -ne $entry.Value) {
                $displayValue = if ($null -eq $actualValue) { '<null>' } else { "$actualValue" }
                $proofFailures += "$($entry.Key): expected '$($entry.Value)', actual '$displayValue'"
            }
        }
        foreach ($executionCounter in @('services', 'runs', 'attempts', 'outbox')) {
            $beforeValue = $beforeState.($executionCounter)
            $afterValue = $proofState.execution_state.($executionCounter)
            if ($afterValue -ne $beforeValue) {
                $proofFailures += "${executionCounter} changed: before '$beforeValue', after '$afterValue'"
            }
        }
        if ($proofFailures.Count -gt 0) {
            Write-Host 'Persistent LinkedIn People preview diagnostic state:'
            Write-Host ($proofState | ConvertTo-Json -Depth 6)
            throw "Persistent LinkedIn People preview proof failed: $($proofFailures -join '; ')"
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

Write-Host '[PASS] LinkedIn People synthetic sample v1 is active for the local pre-purchase preview.'
Write-Host '[PASS] Provider metadata: 46 fields; preview: 42 active fields; 12 masked and non-filterable.'
Write-Host '[PASS] Five synthetic records are retained for exactly 30 days.'
Write-Host '[PASS] Contact enrichment, customer execution and public publication remain disabled.'
Write-Host '[PASS] Services, Runs, Attempts and outbox counts are unchanged.'
Write-Host 'Bright Data calls: 0.'
