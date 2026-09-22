[CmdletBinding()]
param(
    [Parameter()]
    [ValidateSet('Dev', 'Both')]
    [string]$Target = 'Both'
)

$ErrorActionPreference = 'Stop'
$backendRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$workspaceRoot = (Resolve-Path (Join-Path $backendRoot '..')).Path
$environmentFile = Join-Path $backendRoot '.env'
$migrateScript = Join-Path $backendRoot 'scripts\migrate.ps1'
$faqFile = Join-Path $workspaceRoot `
    'Checkpoints\DatasetMarket\Marketplace Dataset API\Brief\Dataset marketplace FAQs.md'
$searchFile = Join-Path $workspaceRoot `
    'Checkpoints\DatasetMarket\Marketplace Dataset API\Apis\Search dataset (sync, Elasticsearch).md'
$candidateId = 'f60af142-3f00-4b0f-b159-86b41ff74b7f'
$migrationVersion = '0063_linkedin_people_contact_contract'
$databaseUrls = [ordered]@{}
if ($Target -eq 'Both') {
    $databaseUrls['dhumi_test'] = 'postgresql://postgres@localhost:5432/dhumi_test'
}
$databaseUrls['dhumi_dev'] = 'postgresql://postgres@localhost:5432/dhumi_dev'

if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    throw 'psql was not found on PATH.'
}
foreach ($requiredFile in @($environmentFile, $faqFile, $searchFile)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Required local evidence file was not found: $requiredFile"
    }
}
$executorAssignments = @(
    Get-Content -LiteralPath $environmentFile |
        Where-Object { $_ -match '^\s*RUN_EXECUTOR_DRIVER\s*=' }
)
if ($executorAssignments.Count -ne 1 -or
    $executorAssignments[0] -notmatch '^\s*RUN_EXECUTOR_DRIVER\s*=\s*controlled\s*$') {
    throw 'Contact-contract activation requires exactly RUN_EXECUTOR_DRIVER=controlled.'
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
    throw 'Stop the Outbox Dispatcher and Job Manager before contact-contract activation.'
}

$expectedFaqChecksum = (Get-FileHash -LiteralPath $faqFile -Algorithm SHA256).Hash.ToLowerInvariant()
$expectedSearchChecksum = (Get-FileHash -LiteralPath $searchFile -Algorithm SHA256).Hash.ToLowerInvariant()
$passwordPointer = [IntPtr]::Zero
$plainPassword = $null
$oldPgPassword = $env:PGPASSWORD

try {
    $securePassword = Read-Host `
        'PostgreSQL administrator password (held only by migration/proof child processes)' `
        -AsSecureString
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
                throw "Migration 0063 was not ledgered on $($entry.Key)."
            }
            Write-Host "[PASS] Migration 0063 is ledgered on $($entry.Key)."
        }

        $before = & psql -X --dbname='postgresql://postgres@localhost:5432/dhumi_dev' `
            --tuples-only --no-align --quiet --set=ON_ERROR_STOP=1 --command @"
SELECT concat_ws('|',
  (SELECT count(*) FROM app.services),
  (SELECT count(*) FROM app.runs),
  (SELECT count(*) FROM app.outbox_events),
  (SELECT count(*) FROM app.marketplace_contact_contract_packets),
  COALESCE((SELECT current_public_version_id::text FROM app.service_templates
    WHERE slug = 'linkedin-people'), '<null>')
);
"@
        if ($LASTEXITCODE -ne 0) {
            throw 'Could not capture the pre-registration database boundary.'
        }

        Write-Host 'Registering retained official contact-choice evidence locally...'
        Write-Host 'Network provider calls: 0; Search/Filter/purchase/export POSTs: 0.'
        & npm.cmd run operator:marketplace-contact-contract -- `
            --candidate-id $candidateId `
            --faq-file $faqFile `
            --search-file $searchFile `
            --actor marketplace.people.contact.local `
            --evidence-reference checkpoint://dataset-market/linkedin-people/contact-contract-v1 `
            --confirm-offline-evidence
        if ($LASTEXITCODE -ne 0) {
            throw 'The LinkedIn People contact-contract operator failed.'
        }

        $after = & psql -X --dbname='postgresql://postgres@localhost:5432/dhumi_dev' `
            --tuples-only --no-align --quiet --set=ON_ERROR_STOP=1 --command @"
WITH packet AS (
  SELECT contract.*
  FROM app.marketplace_contact_contract_packets AS contract
  WHERE contract.catalog_candidate_id = '$candidateId'::uuid
    AND contract.contract_version = 1
)
SELECT jsonb_build_object(
  'services', (SELECT count(*) FROM app.services),
  'runs', (SELECT count(*) FROM app.runs),
  'outbox', (SELECT count(*) FROM app.outbox_events),
  'packet_count', (SELECT count(*) FROM packet),
  'all_packet_count', (SELECT count(*) FROM app.marketplace_contact_contract_packets),
  'mode_count', (SELECT count(*) FROM app.marketplace_contact_mode_contracts AS mode
    JOIN packet ON packet.id = mode.packet_id),
  'disabled_fulfillment_modes', (
    SELECT count(*) FROM app.marketplace_contact_mode_contracts AS mode
    JOIN packet ON packet.id = mode.packet_id
    WHERE mode.fulfillment_state = 'not_enabled'
  ),
  'available_preview_modes', (
    SELECT count(*) FROM app.marketplace_contact_mode_contracts AS mode
    JOIN packet ON packet.id = mode.packet_id
    WHERE mode.preview_state = 'available'
  ),
  'governance_state', (SELECT governance_state FROM packet),
  'fulfillment_state', (SELECT fulfillment_state FROM packet),
  'provider_calls', (SELECT provider_calls FROM packet),
  'faq_checksum', (SELECT encode(faq_checksum, 'hex') FROM packet),
  'search_checksum', (SELECT encode(search_checksum, 'hex') FROM packet),
  'provider_reference_encrypted', (
    SELECT octet_length(provider_resource_ciphertext) >= 32
      AND octet_length(provider_resource_fingerprint) = 32 FROM packet
  ),
  'audit_count', (SELECT count(*) FROM app.audit_events AS audit
    JOIN packet ON packet.id = audit.target_id
    WHERE audit.action = 'provider.contact_contract.register'
      AND audit.outcome = 'completed'),
  'public_pointer', (SELECT current_public_version_id FROM app.service_templates
    WHERE slug = 'linkedin-people')
);
"@
        if ($LASTEXITCODE -ne 0) {
            throw 'Could not verify the contact-contract database boundary.'
        }
        $beforeParts = (($before -join "`n").Trim()) -split '\|'
        $proof = (($after -join "`n").Trim()) | ConvertFrom-Json
        if ($beforeParts.Count -ne 5 -or
            [int64]$proof.services -ne [int64]$beforeParts[0] -or
            [int64]$proof.runs -ne [int64]$beforeParts[1] -or
            [int64]$proof.outbox -ne [int64]$beforeParts[2] -or
            [int64]$proof.all_packet_count -notin @([int64]$beforeParts[3], [int64]$beforeParts[3] + 1) -or
            [int64]$proof.packet_count -ne 1 -or
            [int64]$proof.mode_count -ne 3 -or
            [int64]$proof.disabled_fulfillment_modes -ne 3 -or
            [int64]$proof.available_preview_modes -ne 1 -or
            $proof.governance_state -ne 'fulfillment_evidence_pending' -or
            $proof.fulfillment_state -ne 'not_enabled' -or
            [int64]$proof.provider_calls -ne 0 -or
            $proof.faq_checksum -ne $expectedFaqChecksum -or
            $proof.search_checksum -ne $expectedSearchChecksum -or
            $proof.provider_reference_encrypted -ne $true -or
            [int64]$proof.audit_count -ne 1 -or
            $null -ne $proof.public_pointer) {
            throw "Persistent contact-contract proof failed: $($after -join '')"
        }

        Write-Host '[PASS] Priority 3A contact choices are private, immutable and database-backed.'
        Write-Host '[PASS] Standard preview remains available; both contact modes remain disabled.'
        Write-Host '[PASS] Services, Runs, outbox and public Template pointer are unchanged.'
        Write-Host 'Bright Data calls: 0.'
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
