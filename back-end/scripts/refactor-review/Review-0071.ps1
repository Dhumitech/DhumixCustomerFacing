<#
Default: local review only. No connection or credential read.
Apply: exact SQL + qualification receipt hashes, actual backup hashes and
source pins, resolved pending items, owner authorization, stopped processes
and queue compatibility. Uses existing migrate.ps1's single transaction.
Only localhost:5432/dhumi_test. Existing identities/passwords remain unchanged.
#>
[CmdletBinding()]
param(
 [switch]$Apply,
 [ValidatePattern('^[A-Fa-f0-9]{64}$')][string]$ReviewedSqlSha256,
 [ValidatePattern('^[A-Fa-f0-9]{64}$')][string]$ReviewedQualificationSha256,
 [switch]$OwnerApproved,
 [switch]$ProcessesStopped,
 [switch]$QueueCompatibilityVerified,
 [ValidatePattern('^[A-Za-z_][A-Za-z0-9_]*$')][string]$AdminUser='postgres',
 [string]$PsqlPath
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$backendRoot=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$repoRoot=Split-Path $backendRoot -Parent
$sqlPath=Join-Path $backendRoot 'scripts\migrations\0071_organizations.sql'
$draftPath=Join-Path $PSScriptRoot '0071_organizations.draft.sql'
$manifestPath=Join-Path $PSScriptRoot '0071_organizations.manifest.json'
$manifest=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$hash=(Get-FileHash -LiteralPath $sqlPath -Algorithm SHA256).Hash.ToLowerInvariant()
if($hash -cne $manifest.draftSha256 -or $hash -cne (Get-FileHash -LiteralPath $draftPath -Algorithm SHA256).Hash.ToLowerInvariant()) {
 throw 'Canonical SQL, draft and manifest must have identical reviewed SHA-256 values.'
}
Write-Host "0071 REVIEW: $sqlPath"
Write-Host "SQL SHA-256: $hash"
Write-Host 'Scope: localhost:5432/dhumi_test; 32 -> 35 tables; existing logins unchanged.'
if(-not $Apply) {
 Write-Host 'REVIEW ONLY: no database connection, credential read, SQL execution or ledger write.'
 return
}
if(-not $ReviewedSqlSha256 -or $hash -cne $ReviewedSqlSha256.ToLowerInvariant()) { throw 'ReviewedSqlSha256 must match the exact SQL reviewed by the owner.' }
if(-not $OwnerApproved -or -not $ProcessesStopped -or -not $QueueCompatibilityVerified) { throw 'Owner authorization and stopped-process/queue cutover checks are required.' }
if(-not $manifest.PSObject.Properties['postgresQualification']) { throw 'PostgreSQL qualification receipt has not been recorded.' }
$qualification=$manifest.postgresQualification
if(-not $ReviewedQualificationSha256 -or $ReviewedQualificationSha256.ToLowerInvariant() -cne $qualification.sha256) { throw 'Review the exact qualification receipt and supply its SHA-256.' }
function PinnedPath([string]$RelativePath) {
 $path=[IO.Path]::GetFullPath((Join-Path $repoRoot $RelativePath))
 if(-not $path.StartsWith($repoRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Qualification path escapes the project.' }
 return $path
}
$receiptPath=PinnedPath $qualification.path
if((Get-FileHash -LiteralPath $receiptPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $qualification.sha256) { throw 'Qualification receipt changed after review.' }
$receipt=Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
if($receipt.status -cne 'PASSED' -or $receipt.draftSha256 -cne $hash -or -not $receipt.mainUnchanged -or -not $receipt.writePathQualified) { throw 'Qualification does not cover these migration bytes.' }
if(@($receipt.pendingBeforeApplication).Count -ne 0) { throw ('Application remains blocked: '+($receipt.pendingBeforeApplication -join '; ')) }
foreach($pin in $receipt.sourcePins) {
 if((Get-FileHash -LiteralPath (PinnedPath $pin.path) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin.sha256) { throw "Source changed after qualification: $($pin.path)" }
}
foreach($evidence in $receipt.evidencePins) {
 if((Get-FileHash -LiteralPath (PinnedPath $evidence.path) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $evidence.sha256) { throw "Evidence changed after qualification: $($evidence.path)" }
}
foreach($backup in @($receipt.backup.dump,$receipt.backup.keyFile)) {
 if((Get-FileHash -LiteralPath (PinnedPath $backup.path) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $backup.sha256) { throw 'Required dump/key backup changed or is missing.' }
}
if($AdminUser -like 'dhumi_test_*_login') { throw 'A runtime login cannot apply a migration.' }
$savedOptions=$env:PGOPTIONS
try {
 $env:PGOPTIONS="-c dhumi.refactor_apply=0071 -c dhumi.backup_restore_verified=yes -c dhumi.matching_backend_ready=yes -c dhumi.processes_stopped=yes -c dhumi.queue_compatibility_verified=yes -c dhumi.reviewed_sql_sha256=$hash -c dhumi.owner_approved=yes -c dhumi.organization_privileges_qualified=yes -c dhumi.write_path_qualified=yes"
 & (Join-Path $backendRoot 'scripts\migrate.ps1') -DatabaseUrl "postgresql://${AdminUser}@localhost:5432/dhumi_test" -Reviewed0071Sha256 $hash -PromptForPassword -PsqlPath $PsqlPath
} finally {
 if($null -eq $savedOptions) { Remove-Item Env:PGOPTIONS -ErrorAction SilentlyContinue } else { $env:PGOPTIONS=$savedOptions }
}
