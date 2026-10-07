<# Default is offline review. No credential read, database connection or SQL execution.
Apply selects exactly the qualified 0075 body and one ledger entry in one transaction.
It requires owner authorization, exact SQL/qualification hashes, source/evidence/backup pins.
Existing identities stay in place. Only localhost:5432/dhumi_test can be selected. #>
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
$sqlPath=Join-Path $backendRoot 'scripts\migrations\0075_naming.sql'
$draftPath=Join-Path $PSScriptRoot '0075_naming.draft.sql'
$manifest=Get-Content -LiteralPath (Join-Path $PSScriptRoot '0075_naming.manifest.json') -Raw | ConvertFrom-Json
$hash=(Get-FileHash -LiteralPath $sqlPath -Algorithm SHA256).Hash.ToLowerInvariant()
if($hash -cne $manifest.sqlSha256 -or $hash -cne (Get-FileHash -LiteralPath $draftPath -Algorithm SHA256).Hash.ToLowerInvariant()){throw 'Canonical SQL, draft and manifest must match exactly.'}
Write-Host "0075 REVIEW: $sqlPath"
Write-Host "SQL SHA-256: $hash"
Write-Host "Status: $($manifest.status); 25 tables; 282 -> 279 stored columns. Apply selects only this qualified migration."
if(-not $Apply){Write-Host 'REVIEW ONLY: no credential read, connection, SQL execution or ledger write.';return}
if(-not $ReviewedSqlSha256 -or $hash -cne $ReviewedSqlSha256.ToLowerInvariant()){throw 'ReviewedSqlSha256 must match the exact SQL reviewed by the owner.'}
if(-not $OwnerApproved){throw 'Owner authorization is required to apply 0075.'}
if($manifest.status -cne 'READY_FOR_APPLICATION'){throw '0075 qualification is not ready.'}
function PinnedPath([string]$RelativePath){
 $path=[IO.Path]::GetFullPath((Join-Path $repoRoot $RelativePath))
 if(-not $path.StartsWith($repoRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Qualification path escapes the project.'}
 return $path
}
function Assert-Pin($Pin){
 if($Pin.sha256 -cnotmatch '^[0-9a-f]{64}$' -or (Get-FileHash -LiteralPath (PinnedPath $Pin.path) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Pin.sha256){throw "Qualified file is absent or changed: $($Pin.path)"}
}
$qualified=$manifest.postgresQualification
if(-not $ReviewedQualificationSha256 -or $ReviewedQualificationSha256.ToLowerInvariant() -cne $qualified.sha256){throw 'Supply the exact reviewed qualification SHA-256.'}
Assert-Pin $qualified
$receipt=Get-Content -LiteralPath (PinnedPath $qualified.path) -Raw | ConvertFrom-Json
if($receipt.status -cne 'PASSED' -or $receipt.sqlSha256 -cne $hash -or $receipt.target -cne '127.0.0.1:5432/dhumi_test' -or
 -not $receipt.mainUnchanged -or -not $receipt.backendQualified -or -not $receipt.populatedContractionQualified -or -not $receipt.concurrencyQualified -or -not $receipt.backupRestoreVerified -or -not $receipt.packagesQualified){throw 'Qualification does not cover the exact SQL and required checks.'}
if(@($receipt.pendingBeforeApplication).Count -ne 0){throw ('Application blocked: '+($receipt.pendingBeforeApplication -join '; '))}
if(@($receipt.sourcePins).Count -eq 0 -or @($receipt.evidencePins).Count -eq 0){throw 'Source and evidence pins are required.'}
foreach($pin in $receipt.sourcePins){Assert-Pin $pin}
foreach($pin in $receipt.evidencePins){Assert-Pin $pin}
foreach($pin in @($receipt.backup.dump,$receipt.backup.keyFile)){Assert-Pin $pin}
if($AdminUser -like 'dhumi_test_*_login'){throw 'A runtime login cannot apply a migration.'}
$savedOptions=$env:PGOPTIONS
try{
 $env:PGOPTIONS="-c dhumi.refactor_apply=0075 -c dhumi.backup_restore_verified=yes -c dhumi.backend_qualified=yes -c dhumi.reviewed_sql_sha256=$hash -c dhumi.owner_approved=yes"
 & (Join-Path $backendRoot 'scripts\migrate.ps1') -DatabaseUrl "postgresql://${AdminUser}@localhost:5432/dhumi_test" -Reviewed0075Sha256 $hash -PromptForPassword -PsqlPath $PsqlPath
}finally{if($null -eq $savedOptions){Remove-Item Env:PGOPTIONS -ErrorAction SilentlyContinue}else{$env:PGOPTIONS=$savedOptions}}
