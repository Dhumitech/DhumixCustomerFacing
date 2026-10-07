<# Isolated script-copy regression. Fake psql and a dummy password only;
no private env, real database, owner approval or actual migration execution. #>
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$backend=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('dhumi-0073-offline-'+[guid]::NewGuid().ToString('N'))
$state=@{prompts=0;allow=$false}
$script:checks=0
function Check([bool]$ok,[string]$label) { if(-not $ok) { throw "FAILED: $label" }; $script:checks++ }
function Refuse([scriptblock]$action,[string]$pattern) { $failure=$null;try { & $action } catch { $failure=$_.Exception.Message }; Check ($null -ne $failure -and $failure -match $pattern) "Refusal $pattern observed: $failure" }
function Read-Host { param([string]$Prompt,[switch]$AsSecureString);$state.prompts++;if(-not $state.allow -or -not $AsSecureString) { throw 'Unexpected prompt' };ConvertTo-SecureString '0073-offline-dummy-not-real-password' -AsPlainText -Force }
$saved=@{};foreach($name in @('PGPASSWORD','PGOPTIONS','DHUMI_OFFLINE_TRACE','DHUMI_OFFLINE_MODE','DHUMI_OFFLINE_HASH')) { $saved[$name]=[Environment]::GetEnvironmentVariable($name,'Process') }
try {
 $copy=Join-Path $fixture 'back-end';$reviewDir=Join-Path $copy 'scripts\refactor-review';$migrationDir=Join-Path $copy 'scripts\migrations'
 [void](New-Item -ItemType Directory -Path $reviewDir -Force);[void](New-Item -ItemType Directory -Path $migrationDir -Force)
 foreach($relative in @('scripts\refactor-review\Review-0073.ps1','scripts\migrate.ps1','scripts\migrations\0073_catalogue_execution_contract.sql','scripts\refactor-review\0073_catalogue_execution_contract.draft.sql')) { Copy-Item -LiteralPath (Join-Path $backend $relative) -Destination (Join-Path $copy $relative) }
 $review=Join-Path $reviewDir 'Review-0073.ps1';$runner=Join-Path $copy 'scripts\migrate.ps1';$sql=Join-Path $migrationDir '0073_catalogue_execution_contract.sql';$hash=(Get-FileHash -LiteralPath $sql -Algorithm SHA256).Hash.ToLowerInvariant()
 $text=Get-Content -LiteralPath $sql -Raw
 Check ($text -notmatch '(?im)^\s*(COMMIT|ROLLBACK)\s*;|^\s*\\|^\s*(CREATE|ALTER|DROP)\s+(ROLE|USER|DATABASE)\b') 'Plain contraction SQL has no transaction/psql/identity command'
 Check ($text -notmatch '(?is)INSERT\s+INTO\s+app\.schema_migrations') 'Runner alone owns ledger'
 $evidence=Join-Path $fixture 'evidence.txt';Set-Content -LiteralPath $evidence -Value 'offline synthetic evidence'
 $dump=Join-Path $fixture 'dump.fixture';Set-Content -LiteralPath $dump -Value 'offline synthetic dump'
 $keys=Join-Path $fixture 'keys.fixture';Set-Content -LiteralPath $keys -Value 'offline synthetic protected-key fixture'
 function Pin([string]$relative) { @{path=$relative;sha256=(Get-FileHash -LiteralPath (Join-Path $fixture $relative) -Algorithm SHA256).Hash.ToLowerInvariant()} }
 $receipt=@{status='PASSED';sqlSha256=$hash;mainUnchanged=$true;backendQualified=$true;populatedContractionQualified=$true;concurrencyQualified=$true;packagesQualified=$true;backupRestoreVerified=$true;target='127.0.0.1:5432/dhumi_test';pendingBeforeApplication=@();sourcePins=@((Pin 'back-end/scripts/migrate.ps1'));evidencePins=@((Pin 'evidence.txt'));backup=@{dump=(Pin 'dump.fixture');keyFile=(Pin 'keys.fixture')}}
 $receiptPath=Join-Path $fixture 'receipt.json';$manifestPath=Join-Path $reviewDir '0073_catalogue_execution_contract.manifest.json'
 function Write-Receipt { $receipt|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $receiptPath -Encoding utf8;$manifest=@{status='READY_FOR_OWNER_APPROVAL';sqlSha256=$hash;postgresQualification=(Pin 'receipt.json')};$manifest|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $manifestPath -Encoding utf8;$script:receiptHash=$manifest.postgresQualification.sha256 }
 Write-Receipt
 $fake=Join-Path $fixture 'fake-psql.ps1'
 @'
$idx=[array]::IndexOf($args,'--command');$command=if($idx -ge 0){$args[$idx+1]}else{''}
Add-Content -LiteralPath $env:DHUMI_OFFLINE_TRACE -Value (@{arguments=@($args);passwordPresent=(-not [string]::IsNullOrWhiteSpace($env:PGPASSWORD));options=$env:PGOPTIONS}|ConvertTo-Json -Compress -Depth 4)
$global:LASTEXITCODE=0
if($command -match 'to_regclass'){if($env:DHUMI_OFFLINE_MODE -eq 'no-ledger'){'f'}else{'t'}}
elseif($command -match 'SELECT checksum'){if($env:DHUMI_OFFLINE_MODE -eq 'applied'){$env:DHUMI_OFFLINE_HASH}elseif($env:DHUMI_OFFLINE_MODE -eq 'mismatch'){'0'*64}}
elseif($args -contains '--single-transaction'){if($env:DHUMI_OFFLINE_MODE -eq 'failure'){$global:LASTEXITCODE=1}}
'@|Set-Content -LiteralPath $fake -Encoding utf8
 $trace=Join-Path $fixture 'calls.jsonl';$env:DHUMI_OFFLINE_TRACE=$trace;$env:DHUMI_OFFLINE_HASH=$hash;$env:DHUMI_OFFLINE_MODE='pending'
 & $review 6>$null;Check ($state.prompts -eq 0 -and -not(Test-Path -LiteralPath $trace)) 'Default review reads no credentials or client'
 Refuse { & $review -Apply -ReviewedSqlSha256 ('0'*64) 6>$null } 'must match the exact SQL'
 Refuse { & $review -Apply -ReviewedSqlSha256 $hash 6>$null } 'Separate owner approval'
 Refuse { & $review -Apply -OwnerApproved -ReviewedSqlSha256 $hash -ReviewedQualificationSha256 ('0'*64) 6>$null } 'exact reviewed qualification'
 $apply=@{Apply=$true;OwnerApproved=$true;ReviewedSqlSha256=$hash;ReviewedQualificationSha256=$script:receiptHash;PsqlPath=$fake}
 $receipt.pendingBeforeApplication=@('fixture unresolved gate');Write-Receipt;$apply.ReviewedQualificationSha256=$script:receiptHash;Refuse { & $review @apply 6>$null } 'Application blocked'
 $receipt.pendingBeforeApplication=@();Write-Receipt;$apply.ReviewedQualificationSha256=$script:receiptHash
 foreach($flag in @('backendQualified','populatedContractionQualified','concurrencyQualified','packagesQualified','backupRestoreVerified','mainUnchanged')) { $receipt[$flag]=$false;Write-Receipt;$apply.ReviewedQualificationSha256=$script:receiptHash;Refuse { & $review @apply 6>$null } 'Qualification does not cover';$receipt[$flag]=$true }
 Write-Receipt;$apply.ReviewedQualificationSha256=$script:receiptHash
 foreach($file in @($evidence,$dump,$keys)) { $before=[IO.File]::ReadAllBytes($file);Add-Content -LiteralPath $file -Value 'drift';Refuse { & $review @apply 6>$null } 'Qualified file is absent or changed';[IO.File]::WriteAllBytes($file,$before) }
 $receipt.sourcePins=@(@{path='../outside.txt';sha256=('0'*64)});Write-Receipt;$apply.ReviewedQualificationSha256=$script:receiptHash;Refuse { & $review @apply 6>$null } 'escapes the project'
 $receipt.sourcePins=@((Pin 'back-end/scripts/migrate.ps1'));Write-Receipt;$apply.ReviewedQualificationSha256=$script:receiptHash
 Refuse { & $review @apply -AdminUser dhumi_test_admission_login 6>$null } 'runtime login'
 Refuse { & $runner -DatabaseUrl 'postgresql://postgres@localhost:5432/dhumi_test' -PsqlPath $fake } 'phase-specific review launcher'
 foreach($url in @('postgresql://postgres@localhost:5432/dhumi_dev','postgresql://postgres@remote:5432/dhumi_test','postgresql://postgres@localhost:65472/dhumi_test','postgresql://dhumi_test_admission_login@localhost:5432/dhumi_test')) { Refuse { & $runner -DatabaseUrl $url -Reviewed0073Sha256 $hash -PsqlPath $fake } 'restricted|runtime identity' }
 Refuse { & $runner -DatabaseUrl 'postgresql://postgres@localhost:5432/dhumi_test' -Reviewed0071Sha256 $hash -Reviewed0073Sha256 $hash -PsqlPath $fake } 'exactly one'
 $env:PGOPTIONS='';Refuse { & $runner -DatabaseUrl 'postgresql://postgres@localhost:5432/dhumi_test' -Reviewed0073Sha256 $hash -PsqlPath $fake } 'exact review'
 Check ($state.prompts -eq 0 -and -not(Test-Path -LiteralPath $trace)) 'Every refusal occurs before password or database client'
 Set-Content -LiteralPath (Join-Path $migrationDir '0001_decoy.sql') -Value 'DECOY';Set-Content -LiteralPath (Join-Path $migrationDir '0074_decoy.sql') -Value 'DECOY'
 $state.allow=$true;$env:PGPASSWORD='offline-prior';$env:PGOPTIONS='offline-prior-options'
 & $review @apply 6>$null
 $calls=@(Get-Content -LiteralPath $trace|ForEach-Object { $_|ConvertFrom-Json });$writes=@($calls|Where-Object { $_.arguments -contains '--single-transaction' })
 Check ($calls.Count -eq 3 -and $writes.Count -eq 1) 'Exactly two ledger reads and one atomic write invocation'
 Check (@($writes[0].arguments|Where-Object { $_ -like '--file=*' }).Count -eq 1 -and $writes[0].arguments -contains "--file=$sql") 'Only 0073 selected despite historical/later decoys'
 $entry=$writes[0].arguments[[array]::IndexOf($writes[0].arguments,'--command')+1];Check ($entry -match "VALUES \('0073_catalogue_execution_contract', '$hash'\)") 'One exact runner-owned checksum ledger row'
 Check ($calls[0].options -match 'backend_qualified=yes' -and $calls[0].options -match 'owner_approved=yes' -and $calls[0].options -notmatch 'old_writers_qualified') 'Contraction passes qualified backend and owner gates; SQL independently checks idle sessions and backup rows'
 Check ($env:PGPASSWORD -ceq 'offline-prior' -and $env:PGOPTIONS -ceq 'offline-prior-options') 'Environment restored after fake success'
 foreach($mode in @('applied','mismatch','no-ledger','failure')) { Remove-Item -LiteralPath $trace;$env:DHUMI_OFFLINE_MODE=$mode;if($mode -eq 'applied'){ & $review @apply 6>$null; $new=@(Get-Content -LiteralPath $trace|ForEach-Object { $_|ConvertFrom-Json });Check (@($new|Where-Object { $_.arguments -contains '--single-transaction' }).Count -eq 0) 'Same applied checksum skips every write' }else{ Refuse { & $review @apply 6>$null } 'checksum changed|cannot bootstrap|Migration failed' };Check ($env:PGPASSWORD -ceq 'offline-prior' -and $env:PGOPTIONS -ceq 'offline-prior-options') "Environment restored for $mode" }
 Write-Host "PASSED: $script:checks offline 0073 checks; fake client only; no database/private credentials."
} finally {
 foreach($name in $saved.Keys) { if($null -eq $saved[$name]){Remove-Item -LiteralPath ('Env:'+ $name) -ErrorAction SilentlyContinue}else{[Environment]::SetEnvironmentVariable($name,$saved[$name],'Process')} }
 # Resolve and verify the one generated fixture directory before recursive cleanup.
 $resolved=[IO.Path]::GetFullPath($fixture);$temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath());if($resolved.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -like 'dhumi-0073-offline-*' -and (Test-Path -LiteralPath $resolved)) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
