<#
Default: inspect migrations/0070_archive.sql locally; no connection or password read.
Scope: FIRST table phase 0070 (43 -> 32), not all 0070--0075, not role consolidation.
Owner requested a script to review BEFORE execution. Later -Apply requires
the exact reviewed SQL SHA-256 and Target section 4/9 attestations:
verified test dump/keys/restore, matching backend, stopped processes, queues.
Password is prompted securely for explicit application, memory only.
The launcher never reads .env or writes credentials into any file.

Review command: .\Review-0070.ps1
Future application: -Apply -ReviewedSqlSha256 <reviewed hash>
 -BackupRestoreVerified -MatchingBackendReady -ProcessesStopped
 -QueueCompatibilityVerified. This is a WRITE command, not a connection test.
Source scanning is conservative; it complements backend tests, not proves them.
#>
[CmdletBinding()]
param(
 [switch]$Apply,
 [ValidatePattern('^[A-Fa-f0-9]{64}$')][string]$ReviewedSqlSha256,
 [switch]$BackupRestoreVerified,
 [switch]$MatchingBackendReady,
 [switch]$ProcessesStopped,
 [switch]$QueueCompatibilityVerified,
 [ValidatePattern('^[A-Za-z_][A-Za-z0-9_]*$')][string]$AdminUser='postgres',
 [string]$PsqlPath
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$backendRoot=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$sqlPath=Join-Path $backendRoot 'scripts\migrations\0070_archive.sql'
$migratePath=Join-Path $backendRoot 'scripts\migrate.ps1'
$actualHash=(Get-FileHash -LiteralPath $sqlPath -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "REVIEW MIGRATION (not applied): $sqlPath"
Write-Host "SHA-256: $actualHash"
Write-Host 'Scope: localhost:5432/dhumi_test, FIRST 0070 phase only (43 -> 32 tables).'
Write-Host 'Existing identities remain; SQL write qualification/later phases pending.'
$missingStarterWriters=@()
foreach($name in @('createRunRepository.ts','retryRunRepository.ts')) {
 $path=Join-Path $backendRoot "src\services\admission\$name"
 if(-not(Test-Path -LiteralPath $path)) {
  $missingStarterWriters+=$name
  continue
 }
 $source=Get-Content -LiteralPath $path -Raw
 $inserts=[regex]::Matches($source,'(?is)INSERT\s+INTO\s+app\.runs\s*\(([^)]*)\)')
 if($inserts.Count -eq 0 -or @($inserts | Where-Object {
  $_.Groups[1].Value -notmatch '\bcreated_by_user_id\b'
 }).Count -gt 0) { $missingStarterWriters+=$name }
}
$obsoleteNames=@(
 'marketplace_export_candidates',
 'marketplace_qualification_poll_checkpoints',
 'marketplace_qualification_packets',
 'marketplace_contact_mode_contracts',
 'marketplace_contact_contract_packets',
 'marketplace_catalog_metadata_observations',
 'catalog_import_candidate_observations',
 'provider_qualification_attempts',
 'catalog_candidates',
 'catalog_imports',
 'platform_api_keys',
 'actor_api_key_id',
 'created_by_api_key_id',
 'response_envelope_ciphertext',
 'response_envelope_key_reference',
 'response_envelope_recoverable_until',
 'response_envelope_destroyed_at',
 'accept_amazon_provider_qualification',
 'accept_amazon_provider_qualification_v2',
 'accept_amazon_provider_qualification_v3',
 'authorize_marketplace_qualification_packet',
 'begin_amazon_provider_qualification',
 'begin_amazon_provider_qualification_v2',
 'begin_amazon_provider_qualification_v3',
 'begin_amazon_scraper_catalog_import',
 'begin_amazon_scraper_catalog_import_v2',
 'begin_marketplace_catalog_import',
 'claim_marketplace_qualification_submission',
 'complete_amazon_provider_qualification',
 'complete_amazon_scraper_catalog_import',
 'complete_marketplace_catalog_import',
 'complete_marketplace_qualification_failure',
 'complete_marketplace_qualification_success',
 'destroy_due_response_envelopes',
 'fail_amazon_scraper_catalog_import',
 'fail_marketplace_catalog_import',
 'prepare_marketplace_qualification_packet',
 'publish_qualified_amazon_operation_v1',
 'record_linkedin_people_contact_contract',
 'record_linkedin_people_metadata_observation',
 'record_linkedin_people_synthetic_sample_v1',
 'record_linkedin_people_synthetic_sample_v2',
 'record_marketplace_provider_sample_v1',
 'record_marketplace_provider_sample_v2',
 'record_marketplace_qualification_poll_checkpoint',
 'record_marketplace_qualification_snapshot_reference',
 'record_marketplace_qualification_submission_start',
 'register_marketplace_export_candidate_v1',
 'reject_amazon_provider_qualification',
 'resolve_amazon_qualification_acceptance_plan',
 'resolve_amazon_qualification_acceptance_plan_v2',
 'resolve_amazon_qualification_acceptance_plan_v3',
 'resolve_amazon_qualification_candidate',
 'resolve_amazon_qualification_candidate_v2',
 'resolve_linkedin_people_contact_contract_candidate',
 'resolve_linkedin_people_metadata_candidate',
 'resolve_linkedin_people_synthetic_sample_source',
 'resolve_marketplace_export_candidate_source',
 'resolve_marketplace_provider_sample_source',
 'resolve_marketplace_qualification_context',
 'review_amazon_scraper_catalog_candidate',
 'review_marketplace_catalog_candidate'
)
$pattern='(?<![A-Za-z0-9_])('+(($obsoleteNames | ForEach-Object {
 [regex]::Escape($_)
}) -join '|')+')(?![A-Za-z0-9_])'
# Exempt only the exact secret-redaction literals inside logger.ts's redact.paths
# array. SQL elsewhere in that file, other files and unknown references still block.
# If the known structure changes, scan the whole file rather than guessing.
$redactionBlock='(?ms)^[ \t]*redact: \{\s*\r?\n[ \t]*paths: \[(?<paths>.*?)^[ \t]*\],[ \t]*\r?\n[ \t]*censor: REDACTED,[ \t]*\r?\n[ \t]*\},'
$redactionLine='(?m)^[ \t]*"(?:\*\.){0,3}response_envelope_(?:ciphertext|key_reference)",[ \t]*\r?$'
$loggerPath=Join-Path $backendRoot 'src\config\logger.ts'
$redactionReferences=0
$blockedFiles=@(foreach($file in Get-ChildItem -LiteralPath (Join-Path $backendRoot 'src') -Recurse -File -Filter '*.ts') {
 $source=Get-Content -LiteralPath $file.FullName -Raw
 if($file.FullName -eq $loggerPath) {
  $blocks=[regex]::Matches($source,$redactionBlock)
  if($blocks.Count -eq 1) {
   $paths=$blocks[0].Groups['paths']
   $redactionReferences=[regex]::Matches($paths.Value,$redactionLine).Count
   $scannedPaths=[regex]::Replace($paths.Value,$redactionLine,'')
   $source=$source.Remove($paths.Index,$paths.Length).Insert($paths.Index,$scannedPaths)
  }
 }
 if([regex]::IsMatch($source,$pattern)) { $file }
})
$contract=Join-Path $backendRoot 'contracts\openapi.yaml'
$keysStillInContract=[regex]::IsMatch((Get-Content -LiteralPath $contract -Raw),'(?m)^\s*/v1/keys(?:/|:)')
Write-Host "Run writers missing starter: $($missingStarterWriters.Count)"
Write-Host "Runtime files still naming archived SQL: $($blockedFiles.Count)"
foreach($file in $blockedFiles) { Write-Host "Blocked: $($file.FullName)" }
Write-Host "Retained redaction entries (not SQL dependencies): $redactionReferences"
Write-Host "API-key contract entries remain: $keysStillInContract"
if(-not $Apply) {
 Write-Host 'REVIEW ONLY: no database connection, SQL execution or password read.'
 return
}
if([string]::IsNullOrWhiteSpace($ReviewedSqlSha256) -or
 $actualHash -ne $ReviewedSqlSha256.ToLowerInvariant()) {
 throw 'ReviewedSqlSha256 must match the exact SQL file you inspected.'
}
if(-not($BackupRestoreVerified -and $MatchingBackendReady -and
 $ProcessesStopped -and $QueueCompatibilityVerified)) {
 throw 'All four backup/restore and cutover attestations are required by Target sections 4/9.'
}
if($missingStarterWriters.Count -gt 0 -or $blockedFiles.Count -gt 0 -or $keysStillInContract) {
 throw 'Backend not ready for 0070. Complete and qualify the matching cutover first.'
}
if($AdminUser -like 'dhumi_test_*_login') {
 throw 'Use an authorized migration administrator, not a runtime identity.'
}
if([string]::IsNullOrWhiteSpace($PsqlPath)) {
 $client=Get-Command psql -ErrorAction SilentlyContinue
 if($null -ne $client) { $PsqlPath=$client.Source }
 else { $PsqlPath=Join-Path $env:ProgramFiles 'PostgreSQL\18\bin\psql.exe' }
}
if(-not(Test-Path -LiteralPath $PsqlPath -PathType Leaf)) {
 throw 'Installed psql client not found; supply its path.'
}
$passwordPointer=[IntPtr]::Zero
$plainPassword=$null
$securePassword=$null
$previousPassword=$env:PGPASSWORD
$previousOptions=$env:PGOPTIONS
$previousSsl=$env:PGSSLMODE
try {
 $securePassword=Read-Host 'PostgreSQL admin password for dhumi_test (memory only)' -AsSecureString
 $passwordPointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
 $plainPassword=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
 if([string]::IsNullOrWhiteSpace($plainPassword)) { throw 'Password must not be empty.' }
 $env:PGPASSWORD=$plainPassword
 $env:PGSSLMODE='disable'
 $env:PGOPTIONS="-c dhumi.refactor_apply=0070 -c dhumi.backup_restore_verified=yes -c dhumi.matching_backend_ready=yes -c dhumi.processes_stopped=yes -c dhumi.queue_compatibility_verified=yes -c dhumi.reviewed_sql_sha256=$actualHash"
 if((Get-FileHash -LiteralPath $sqlPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $actualHash) {
  throw 'SQL changed after review; inspect its new hash before application.'
 }
 # One runner owns both the transaction and its final ledger entry. It selects
 # only 0070, verifies its exact hash/target/gates, and checks an existing entry.
 & $migratePath -DatabaseUrl "postgresql://${AdminUser}@localhost:5432/dhumi_test" `
  -Reviewed0070Sha256 $actualHash -PsqlPath $PsqlPath
 Write-Host '0070 runner completed for dhumi_test. Qualify before advancing to 0071.'
}
finally {
 if($null -eq $previousPassword) { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
 else { $env:PGPASSWORD=$previousPassword }
 if($null -eq $previousOptions) { Remove-Item Env:PGOPTIONS -ErrorAction SilentlyContinue }
 else { $env:PGOPTIONS=$previousOptions }
 if($null -eq $previousSsl) { Remove-Item Env:PGSSLMODE -ErrorAction SilentlyContinue }
 else { $env:PGSSLMODE=$previousSsl }
 $plainPassword=$null
 if($passwordPointer -ne [IntPtr]::Zero) {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
 }
 if($null -ne $securePassword) { $securePassword.Dispose(); $securePassword=$null }
}
