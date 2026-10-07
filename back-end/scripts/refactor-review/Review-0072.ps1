<#
Default: local review; no private environment, credential prompt or connection.
Apply ONLY the additive 0072 to localhost:5432/dhumi_test after owner approval.
Verifies exact SQL, qualified source/evidence and actual dump/key file hashes.
Existing runtime writers/identities remain; 0073 has a separate cutover.
#>
[CmdletBinding()]
param(
 [switch]$Apply,
 [ValidatePattern('^[A-Fa-f0-9]{64}$')][string]$ReviewedSqlSha256,
 [ValidatePattern('^[A-Fa-f0-9]{64}$')][string]$ReviewedQualificationSha256,
 [switch]$OwnerApproved,
 [ValidatePattern('^[A-Za-z_][A-Za-z0-9_]*$')][string]$AdminUser='postgres',
 [string]$PsqlPath
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$backendRoot=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$repoRoot=Split-Path $backendRoot -Parent
$sqlPath=Join-Path $backendRoot 'scripts\migrations\0072_catalogue_execution_expand.sql'
$draftPath=Join-Path $PSScriptRoot '0072_catalogue_execution_expand.draft.sql'
$manifest=Get-Content -LiteralPath (Join-Path $PSScriptRoot '0072_catalogue_execution_expand.manifest.json') -Raw | ConvertFrom-Json
$hash=(Get-FileHash -LiteralPath $sqlPath -Algorithm SHA256).Hash.ToLowerInvariant()
if($hash -cne $manifest.sqlSha256 -or $hash -cne (Get-FileHash -LiteralPath $draftPath -Algorithm SHA256).Hash.ToLowerInvariant()) {
 throw 'Canonical SQL, draft and manifest must have identical reviewed SHA-256 values.'
}
Write-Host "0072 REVIEW: $sqlPath"
Write-Host "SQL SHA-256: $hash"
Write-Host "Status: $($manifest.status); additive 35 -> 36 tables; old writers and existing identities retained."
if(-not $Apply) {
 Write-Host 'REVIEW ONLY: no database connection, credential read, SQL execution or ledger write.'
 return
}
if(-not $ReviewedSqlSha256 -or $hash -cne $ReviewedSqlSha256.ToLowerInvariant()) { throw 'ReviewedSqlSha256 must match the exact SQL reviewed by the owner.' }
if(-not $OwnerApproved) { throw 'Separate owner approval is required to apply 0072.' }
if($manifest.status -cne 'READY_FOR_OWNER_APPROVAL') { throw '0072 qualification is not ready for application.' }
function PinnedPath([string]$RelativePath) {
 $path=[IO.Path]::GetFullPath((Join-Path $repoRoot $RelativePath))
 if(-not $path.StartsWith($repoRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Qualification path escapes the project.' }
 return $path
}
function Assert-Pin($Pin) {
 if($Pin.sha256 -cnotmatch '^[0-9a-f]{64}$' -or (Get-FileHash -LiteralPath (PinnedPath $Pin.path) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Pin.sha256) { throw "Qualified file is absent or changed: $($Pin.path)" }
}
$qualified=$manifest.postgresQualification
if(-not $ReviewedQualificationSha256 -or $ReviewedQualificationSha256.ToLowerInvariant() -cne $qualified.sha256) { throw 'Review the exact qualification receipt and supply its SHA-256.' }
Assert-Pin $qualified
$receipt=Get-Content -LiteralPath (PinnedPath $qualified.path) -Raw | ConvertFrom-Json
if($receipt.status -cne 'PASSED' -or $receipt.sqlSha256 -cne $hash -or -not $receipt.mainUnchanged -or -not $receipt.oldWritersQualified -or -not $receipt.populatedBackfillsQualified -or -not $receipt.datasetOperatorQualified -or -not $receipt.backupRestoreVerified -or $receipt.target -cne '127.0.0.1:5432/dhumi_test') { throw 'Qualification does not cover these migration bytes and required checks.' }
if(@($receipt.pendingBeforeApplication).Count -ne 0) { throw ('Application remains blocked: '+($receipt.pendingBeforeApplication -join '; ')) }
if(@($receipt.sourcePins).Count -eq 0 -or @($receipt.evidencePins).Count -eq 0) { throw 'Qualified source and evidence pins are required.' }
foreach($pin in $receipt.sourcePins) { Assert-Pin $pin }
foreach($pin in $receipt.evidencePins) { Assert-Pin $pin }
foreach($pin in @($receipt.backup.dump,$receipt.backup.keyFile)) { Assert-Pin $pin }
if($AdminUser -like 'dhumi_test_*_login') { throw 'A runtime login cannot apply a migration.' }
$savedOptions=$env:PGOPTIONS
try {
 $env:PGOPTIONS="-c dhumi.refactor_apply=0072 -c dhumi.backup_restore_verified=yes -c dhumi.old_writers_qualified=yes -c dhumi.reviewed_sql_sha256=$hash -c dhumi.owner_approved=yes"
 & (Join-Path $backendRoot 'scripts\migrate.ps1') -DatabaseUrl "postgresql://${AdminUser}@localhost:5432/dhumi_test" -Reviewed0072Sha256 $hash -PromptForPassword -PsqlPath $PsqlPath
} finally {
 if($null -eq $savedOptions) { Remove-Item Env:PGOPTIONS -ErrorAction SilentlyContinue } else { $env:PGOPTIONS=$savedOptions }
}
