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
$packetId = '2e1560c3-ca8b-40a0-b578-c9e71ecf27cd'
$migrationVersions = @(
    '0057_linkedin_posts_provider_sample',
    '0058_marketplace_provider_sample_timestamp_authority',
    '0059_linkedin_posts_provider_sample_version_3'
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
$executorAssignments = @(
    Get-Content -LiteralPath $environmentFile |
        Where-Object { $_ -match '^\s*RUN_EXECUTOR_DRIVER\s*=' }
)
if ($executorAssignments.Count -ne 1 -or
    $executorAssignments[0] -notmatch '^\s*RUN_EXECUTOR_DRIVER\s*=\s*controlled\s*$') {
    throw 'Provider-sample activation requires exactly RUN_EXECUTOR_DRIVER=controlled.'
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
                throw "Required provider-sample migrations were not ledgered on $($entry.Key)."
            }
            Write-Host "[PASS] Provider-sample migrations 0057-0059 are ledgered on $($entry.Key)."
        }

        Write-Host 'Promoting the exact retained five-record evidence into immutable sample version 3...'
        & npm.cmd run operator:marketplace-sample -- promote-qualified-sample `
            --packet-id $packetId `
            --sample-version 3 `
            --actor marketplace.provider-sample.local
        if ($LASTEXITCODE -ne 0) {
            throw 'The provider-sample operator failed.'
        }

        $proof = & psql -X --dbname='postgresql://postgres@localhost:5432/dhumi_dev' `
            --tuples-only --no-align --quiet --set=ON_ERROR_STOP=1 `
            --command @"
WITH target_sample AS (
  SELECT sample.*
  FROM app.marketplace_sample_versions AS sample
  WHERE sample.qualification_packet_id = '$packetId'::uuid
), selected_preview AS (
  SELECT preview.*
  FROM app.resolve_marketplace_sample_preview(
    'linkedin-posts', statement_timestamp()
  ) AS preview
), release_boundary AS (
  SELECT
    export_candidate.state AS export_candidate_state,
    mapping.state AS mapping_state,
    adapter.state AS adapter_state,
    adapter.capability_metadata->>'customer_execution_enabled'
      AS customer_execution_enabled
  FROM app.marketplace_export_candidates AS export_candidate
  LEFT JOIN app.provider_mappings AS mapping
    ON mapping.id = export_candidate.provider_mapping_id
  LEFT JOIN app.adapter_versions AS adapter
    ON adapter.id = export_candidate.adapter_version_id
  WHERE export_candidate.marketplace_qualification_packet_id = '$packetId'::uuid
)
SELECT jsonb_build_object(
  'database', current_database(),
  'sample_count', (SELECT count(*) FROM target_sample),
  'source_kind', (SELECT sample.source_kind FROM target_sample AS sample LIMIT 1),
  'sample_state', (SELECT sample.state FROM target_sample AS sample LIMIT 1),
  'governance_state',
    (SELECT sample.governance_state FROM target_sample AS sample LIMIT 1),
  'sample_version', (SELECT sample.sample_version FROM target_sample AS sample LIMIT 1),
  'record_count', (SELECT sample.record_count FROM target_sample AS sample LIMIT 1),
  'byte_count', (SELECT sample.byte_count FROM target_sample AS sample LIMIT 1),
  'checksum',
    (SELECT encode(sample.checksum, 'hex') FROM target_sample AS sample LIMIT 1),
  'metadata_checksum',
    (SELECT encode(sample.source_metadata_checksum, 'hex')
     FROM target_sample AS sample LIMIT 1),
  'field_count',
    (SELECT jsonb_array_length(sample.field_dictionary)
     FROM target_sample AS sample LIMIT 1),
  'masked_non_filterable_field_count',
    (SELECT count(*)
     FROM target_sample AS sample
     CROSS JOIN LATERAL jsonb_array_elements(sample.field_dictionary) AS field
     WHERE field->>'sample_visibility' = 'masked'
       AND field->'allowed_operators' = '[]'::jsonb),
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
  'release_boundary_count', (SELECT count(*) FROM release_boundary),
  'export_candidate_state',
    (SELECT boundary.export_candidate_state FROM release_boundary AS boundary LIMIT 1),
  'mapping_state',
    (SELECT boundary.mapping_state FROM release_boundary AS boundary LIMIT 1),
  'adapter_state',
    (SELECT boundary.adapter_state FROM release_boundary AS boundary LIMIT 1),
  'customer_execution_enabled',
    (SELECT boundary.customer_execution_enabled FROM release_boundary AS boundary LIMIT 1),
  'audit_count',
    (SELECT count(*)
     FROM app.audit_events AS audit
     JOIN target_sample AS sample ON sample.id = audit.target_id
     WHERE audit.action = 'marketplace.provider_sample.promote'
       AND audit.outcome = 'completed')
);
"@
        if ($LASTEXITCODE -ne 0) {
            throw 'Persistent provider-sample proof query failed.'
        }
        $proofJson = (($proof -join "`n").Trim())
        if ([string]::IsNullOrWhiteSpace($proofJson)) {
            throw 'Persistent provider-sample proof returned no diagnostic document.'
        }
        try {
            $proofState = $proofJson | ConvertFrom-Json -ErrorAction Stop
        }
        catch {
            throw "Persistent provider-sample proof returned invalid JSON: $proofJson"
        }
        $expectedProof = [ordered]@{
            database = 'dhumi_dev'
            sample_count = 1
            source_kind = 'provider_qualification'
            sample_state = 'validated_provider_sample'
            governance_state = 'formal_agreement_pending_local_demo'
            sample_version = 3
            record_count = 5
            byte_count = 25858
            checksum = 'd5a9c6c3403959349925d0574195e12e511ab2e861d421938e53b4a6738f6c95'
            metadata_checksum = '039685f485ab09f0a6f9503517a2aa34957920c0f2faf827684c0b600512499b'
            field_count = 37
            masked_non_filterable_field_count = 11
            retention_exact = $true
            rights_reference_absent = $true
            preview_count = 1
            preview_sample_version = 3
            preview_record_count = 5
            release_boundary_count = 1
            export_candidate_state = 'disabled_candidate'
            mapping_state = 'disabled'
            adapter_state = 'disabled'
            customer_execution_enabled = 'false'
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
        if ($proofFailures.Count -gt 0) {
            Write-Host 'Persistent provider-sample diagnostic state:'
            Write-Host ($proofState | ConvertTo-Json -Depth 5)
            throw "Persistent provider-sample proof failed: $($proofFailures -join '; ')"
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

Write-Host '[PASS] Real LinkedIn Posts sample version 3 is active for the local pre-purchase demo.'
Write-Host '[PASS] All 37 verified fields are retained; 11 PII-bearing fields are masked and not filterable.'
Write-Host '[PASS] Formal agreement reference remains explicitly pending.'
Write-Host '[PASS] M10 and customer paid execution remain disabled.'
Write-Host 'Bright Data calls: 0.'
