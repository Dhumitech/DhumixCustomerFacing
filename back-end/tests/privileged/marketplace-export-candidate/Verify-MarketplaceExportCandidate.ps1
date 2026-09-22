[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Test', 'Dev')]
    [string]$Target,

    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$')]
    [string]$MappingId,

    [Parameter()]
    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$')]
    [string]$PacketId = '2e1560c3-ca8b-40a0-b578-c9e71ecf27cd'
)

$ErrorActionPreference = 'Stop'
$MappingId = $MappingId.ToLowerInvariant()
$PacketId = $PacketId.ToLowerInvariant()
$databaseName = if ($Target -eq 'Test') { 'dhumi_test' } else { 'dhumi_dev' }
$databaseUrl = "postgresql://postgres@localhost:5432/$databaseName"

if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    throw 'psql was not found on PATH.'
}

$passwordPointer = [IntPtr]::Zero
$plainPassword = $null
$oldPgPassword = $env:PGPASSWORD

try {
    $securePassword = Read-Host 'PostgreSQL administrator password (held only by verification child processes)' -AsSecureString
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    $env:PGPASSWORD = $plainPassword

    $proof = & psql -X "--dbname=$databaseUrl" --pset=pager=off `
        --tuples-only --no-align --quiet --set=ON_ERROR_STOP=1 `
        --command @"
SELECT concat_ws('|',
  candidate.marketplace_qualification_packet_id,
  candidate.provider_mapping_id,
  candidate.state,
  mapping.state,
  mapping.provider_resource_aad_mapping_id = mapping.id,
  adapter.state,
  adapter.capability_metadata->>'provider_http_enabled',
  adapter.capability_metadata->>'customer_execution_enabled',
  template.slug,
  version.version,
  version.availability_state,
  version.effective_at IS NULL,
  version.published_at IS NULL,
  template.current_public_version_id IS NULL,
  NOT EXISTS (
    SELECT 1 FROM app.service_versions AS service_version
    WHERE service_version.service_template_version_id = version.id
  ),
  NOT EXISTS (
    SELECT 1 FROM app.runs AS run
    WHERE run.service_template_version_id = version.id
  ),
  (
    SELECT count(*) = 1 FROM app.audit_events AS audit
    WHERE audit.action = 'provider.marketplace_export_candidate.register'
      AND audit.target_id = mapping.id
      AND audit.outcome = 'registered'
  )
)
FROM app.marketplace_export_candidates AS candidate
JOIN app.provider_mappings AS mapping
  ON mapping.id = candidate.provider_mapping_id
JOIN app.adapter_versions AS adapter
  ON adapter.id = candidate.adapter_version_id
JOIN app.service_template_versions AS version
  ON version.id = candidate.service_template_version_id
JOIN app.service_templates AS template
  ON template.id = version.service_template_id
WHERE candidate.marketplace_qualification_packet_id = '$PacketId'::uuid
  AND candidate.provider_mapping_id = '$MappingId'::uuid;
"@
    if ($LASTEXITCODE -ne 0) {
        throw "M10 verification query failed on $databaseName."
    }
    $proofLine = (($proof -join "`n").Trim())
    $expected = "$PacketId|$MappingId|disabled_candidate|disabled|t|disabled|false|false|linkedin-posts|2|coming_soon|t|t|t|t|t|t"
    if ($proofLine -ne $expected) {
        throw "M10 persistent candidate proof failed on ${databaseName}: $proofLine"
    }

    Write-Host "[PASS] M10 disabled export candidate verified on $databaseName."
    Write-Host "Packet: $PacketId"
    Write-Host "Mapping: $MappingId"
    Write-Host 'Customer execution: disabled'
    Write-Host 'Public Template pointer: unchanged'
    Write-Host 'Services/Runs created: 0'
    Write-Host 'Bright Data calls: 0'
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
