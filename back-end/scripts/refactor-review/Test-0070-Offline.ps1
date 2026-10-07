<#
Offline regression checks for the 0070 launcher/runner. No installed psql,
private env file, real password prompt or database is used. All -Apply checks
run against temporary script copies with a fake psql child and dummy password.
This proves control flow/arguments, not PostgreSQL writes, RLS or restore.
#>
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$backendRoot=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$tempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$fixtureRoot=Join-Path $tempRoot ('dhumi-0070-offline-'+[guid]::NewGuid().ToString('N'))
$script:checks=0
$offlineState=@{Prompts=0;AllowDummyPrompt=$false}
function Assert-Offline([bool]$Condition,[string]$Message) {
 if(-not $Condition) { throw "FAILED: $Message" }
 $script:checks++
}
function Expect-Refusal([scriptblock]$Action,[string]$MessagePattern) {
 $failure=$null
 try { & $Action } catch { $failure=$_.Exception.Message }
 Assert-Offline ($null -ne $failure -and $failure -match $MessagePattern) "Expected refusal: $MessagePattern; observed: $failure"
}
function Read-Host {
 param([string]$Prompt,[switch]$AsSecureString)
 $offlineState.Prompts++
 if(-not $offlineState.AllowDummyPrompt -or -not $AsSecureString) { throw 'Unexpected password prompt' }
 ConvertTo-SecureString 'offline-dummy-password-no-database' -AsPlainText -Force
}
$savedEnvironment=@{}
foreach($name in @('PGPASSWORD','PGOPTIONS','PGSSLMODE','DHUMI_OFFLINE_TRACE','DHUMI_OFFLINE_MODE','DHUMI_OFFLINE_HASH')) {
 $savedEnvironment[$name]=[Environment]::GetEnvironmentVariable($name,'Process')
}
try {
 foreach($folder in @('scripts\refactor-review','scripts\migrations','src\services\admission','src\config','contracts')) {
  [void](New-Item -ItemType Directory -Path (Join-Path $fixtureRoot $folder) -Force)
 }
 foreach($relative in @('scripts\refactor-review\Review-0070.ps1','scripts\migrate.ps1','scripts\migrations\0070_archive.sql','src\config\logger.ts')) {
  Copy-Item -LiteralPath (Join-Path $backendRoot $relative) -Destination (Join-Path $fixtureRoot $relative)
 }
 foreach($writer in @('createRunRepository.ts','retryRunRepository.ts')) {
  Set-Content -LiteralPath (Join-Path $fixtureRoot "src\services\admission\$writer") -Value 'INSERT INTO app.runs (id, created_by_user_id) VALUES ($1, $2)' -Encoding utf8
 }
 $contract=Join-Path $fixtureRoot 'contracts\openapi.yaml'
 Set-Content -LiteralPath $contract -Value 'paths: {}' -Encoding utf8
 $review=Join-Path $fixtureRoot 'scripts\refactor-review\Review-0070.ps1'
 $runner=Join-Path $fixtureRoot 'scripts\migrate.ps1'
 $sql=Join-Path $fixtureRoot 'scripts\migrations\0070_archive.sql'
 $hash=(Get-FileHash -LiteralPath $sql -Algorithm SHA256).Hash.ToLowerInvariant()
 $source=Get-Content -LiteralPath $sql -Raw
 Assert-Offline ($source -notmatch '(?m)^\s*(BEGIN|COMMIT|ROLLBACK)\s*;|^\s*\\') 'Plain migration has no transaction wrapper or psql meta-command'
 Assert-Offline ($source -notmatch '(?is)INSERT\s+INTO\s+app\.schema_migrations') 'SQL does not own the ledger insert'
 Assert-Offline ($source -match 'REVOKE USAGE ON SCHEMA app FROM dhumi_envelope_janitor;') 'Janitor schema grant is revoked'
 Assert-Offline ($source -notmatch '(?im)^\s*(?:CREATE|ALTER|DROP)\s+(?:ROLE|USER|DATABASE)\b') 'No identity/password/database operation'
 Assert-Offline ([regex]::Matches($source,'(?im)^DROP TABLE app\.').Count -eq 11) 'Exactly eleven archive tables'
 $fakePsql=Join-Path $fixtureRoot 'fake-psql.ps1'
 @'
$commandIndex=[array]::IndexOf($args,'--command')
$command=if($commandIndex -ge 0) { $args[$commandIndex+1] } else { '' }
# Only sanitized command/argument structure is recorded. Never log environment values.
$entry=@{arguments=@($args);passwordPresent=(-not [string]::IsNullOrWhiteSpace($env:PGPASSWORD))}
Add-Content -LiteralPath $env:DHUMI_OFFLINE_TRACE -Value ($entry | ConvertTo-Json -Compress -Depth 4) -Encoding utf8
$global:LASTEXITCODE=0
if($command -match 'to_regclass') {
 if($env:DHUMI_OFFLINE_MODE -eq 'no-ledger') { 'f' } else { 't' }
} elseif($command -match 'SELECT checksum') {
 if($env:DHUMI_OFFLINE_MODE -eq 'applied') { $env:DHUMI_OFFLINE_HASH }
 elseif($env:DHUMI_OFFLINE_MODE -eq 'mismatch') { '0'*64 }
} elseif($args -contains '--single-transaction') {
 if($env:DHUMI_OFFLINE_MODE -eq 'failure') { $global:LASTEXITCODE=1 }
}
'@ | Set-Content -LiteralPath $fakePsql -Encoding utf8
 $trace=Join-Path $fixtureRoot 'fake-calls.jsonl'
 $env:DHUMI_OFFLINE_TRACE=$trace
 $env:DHUMI_OFFLINE_HASH=$hash
 $env:DHUMI_OFFLINE_MODE='pending'
 $apply=@{Apply=$true;ReviewedSqlSha256=$hash;BackupRestoreVerified=$true;MatchingBackendReady=$true;ProcessesStopped=$true;QueueCompatibilityVerified=$true;PsqlPath=$fakePsql}
 & $review 6>$null
 Assert-Offline ($offlineState.Prompts -eq 0 -and -not(Test-Path -LiteralPath $trace)) 'Default review never prompts or invokes a client'
 Expect-Refusal { & $review -Apply -ReviewedSqlSha256 ('0'*64) 6>$null } 'must match the exact SQL'
 Expect-Refusal { & $review -Apply -ReviewedSqlSha256 $hash 6>$null } 'All four'
 Assert-Offline ($offlineState.Prompts -eq 0 -and -not(Test-Path -LiteralPath $trace)) 'Bad hash/missing attestations stop before credentials or client'
 # Real logger includes the eight permitted redaction entries and should pass.
 # Adding actual SQL in the SAME logger must still block.
 $logger=Join-Path $fixtureRoot 'src\config\logger.ts'
 $loggerBefore=Get-Content -LiteralPath $logger -Raw
 Add-Content -LiteralPath $logger -Value 'const query = "SELECT response_envelope_ciphertext FROM app.idempotency_records";'
 Expect-Refusal { & $review @apply 6>$null } 'Backend not ready'
 Set-Content -LiteralPath $logger -Value $loggerBefore -NoNewline -Encoding utf8
 Set-Content -LiteralPath $logger -Value ($loggerBefore.Replace('censor: REDACTED','censor: "[REDACTED]"')) -NoNewline -Encoding utf8
 Expect-Refusal { & $review @apply 6>$null } 'Backend not ready'
 Set-Content -LiteralPath $logger -Value $loggerBefore -NoNewline -Encoding utf8
 # The same literal outside the known redaction block or in another file blocks.
 Add-Content -LiteralPath $logger -Value 'const unknown = "response_envelope_key_reference";'
 Expect-Refusal { & $review @apply 6>$null } 'Backend not ready'
 Set-Content -LiteralPath $logger -Value $loggerBefore -NoNewline -Encoding utf8
 $unknown=Join-Path $fixtureRoot 'src\unknown.ts'
 Set-Content -LiteralPath $unknown -Value 'const paths = ["response_envelope_ciphertext"];'
 Expect-Refusal { & $review @apply 6>$null } 'Backend not ready'
 Remove-Item -LiteralPath $unknown
 $retry=Join-Path $fixtureRoot 'src\services\admission\retryRunRepository.ts'
 Set-Content -LiteralPath $retry -Value 'INSERT INTO app.runs (id) VALUES ($1)'
 Expect-Refusal { & $review @apply 6>$null } 'Backend not ready'
 Set-Content -LiteralPath $retry -Value 'INSERT INTO app.runs (id, created_by_user_id) VALUES ($1, $2)'
 Set-Content -LiteralPath $contract -Value "paths:`n  /v1/keys: {}"
 Expect-Refusal { & $review @apply 6>$null } 'Backend not ready'
 Set-Content -LiteralPath $contract -Value 'paths: {}'
 Assert-Offline ($offlineState.Prompts -eq 0 -and -not(Test-Path -LiteralPath $trace)) 'All source/contract failures stop before credentials or client'
 Expect-Refusal { & $runner -DatabaseUrl 'postgresql://postgres@localhost:5432/dhumi_test' -PsqlPath $fakePsql } 'Refactor migrations require'
 Expect-Refusal { & $runner -DatabaseUrl 'postgresql://postgres@localhost:5432/dhumi_dev' -Reviewed0070Sha256 $hash -PsqlPath $fakePsql } 'restricted'
 Expect-Refusal { & $runner -DatabaseUrl 'postgresql://postgres@remote:5432/dhumi_test' -Reviewed0070Sha256 $hash -PsqlPath $fakePsql } 'restricted'
 Expect-Refusal { & $runner -DatabaseUrl 'postgresql://dhumi_test_admission_login@localhost:5432/dhumi_test' -Reviewed0070Sha256 $hash -PsqlPath $fakePsql } 'runtime identity'
 $env:PGOPTIONS=''
 Expect-Refusal { & $runner -DatabaseUrl 'postgresql://postgres@localhost:5432/dhumi_test' -Reviewed0070Sha256 $hash -PsqlPath $fakePsql } 'exact review'
 Assert-Offline (-not(Test-Path -LiteralPath $trace)) 'Direct runner failures invoke no client'
 # Future and historical files are decoys: the reviewed path must run ONLY 0070.
 Set-Content -LiteralPath (Join-Path $fixtureRoot 'scripts\migrations\0001_decoy.sql') -Value 'DECOY;'
 Set-Content -LiteralPath (Join-Path $fixtureRoot 'scripts\migrations\0071_decoy.sql') -Value 'DECOY;'
 $offlineState.AllowDummyPrompt=$true
 $env:PGPASSWORD='offline-prior-dummy'
 $env:PGOPTIONS='offline-prior-options'
 $env:PGSSLMODE='offline-prior-ssl'
 & $review @apply 6>$null
 $calls=@(Get-Content -LiteralPath $trace | ForEach-Object { $_ | ConvertFrom-Json })
 $writes=@($calls | Where-Object { $_.arguments -contains '--single-transaction' })
 Assert-Offline ($calls.Count -eq 3 -and $writes.Count -eq 1) 'Two ledger reads and exactly one transactional apply invocation'
 Assert-Offline (@($writes[0].arguments | Where-Object { $_ -like '--file=*' }).Count -eq 1 -and $writes[0].arguments -contains "--file=$sql") 'Only canonical 0070 file is passed'
 $ledgerCommand=$writes[0].arguments[[array]::IndexOf($writes[0].arguments,'--command')+1]
 Assert-Offline ($ledgerCommand -match "VALUES \('0070_archive', '$hash'\)") 'One runner-owned ledger entry contains the exact reviewed checksum'
 Assert-Offline ($writes[0].passwordPresent -and $writes[0].arguments -contains '--no-password') 'Dummy prompt supplied memory-only password; no child prompt'
 Assert-Offline ($env:PGPASSWORD -ceq 'offline-prior-dummy' -and $env:PGOPTIONS -ceq 'offline-prior-options' -and $env:PGSSLMODE -ceq 'offline-prior-ssl') 'Environment restored after success'
 Remove-Item -LiteralPath $trace
 $env:DHUMI_OFFLINE_MODE='applied'
 & $review @apply 6>$null
 $calls=@(Get-Content -LiteralPath $trace | ForEach-Object { $_ | ConvertFrom-Json })
 Assert-Offline ($calls.Count -eq 2 -and @($calls | Where-Object { $_.arguments -contains '--single-transaction' }).Count -eq 0) 'Matching applied checksum is skipped without writes'
 Remove-Item -LiteralPath $trace
 $env:DHUMI_OFFLINE_MODE='mismatch'
 Expect-Refusal { & $review @apply 6>$null } 'checksum changed after application'
 $calls=@(Get-Content -LiteralPath $trace | ForEach-Object { $_ | ConvertFrom-Json })
 Assert-Offline ($calls.Count -eq 2) 'Applied checksum mismatch stops before writes'
 Remove-Item -LiteralPath $trace
 $env:DHUMI_OFFLINE_MODE='no-ledger'
 Expect-Refusal { & $review @apply 6>$null } 'existing migration ledger'
 $calls=@(Get-Content -LiteralPath $trace | ForEach-Object { $_ | ConvertFrom-Json })
 Assert-Offline ($calls.Count -eq 1) 'Missing ledger stops after one read without bootstrap writes'
 Remove-Item -LiteralPath $trace
 $env:DHUMI_OFFLINE_MODE='failure'
 Expect-Refusal { & $review @apply 6>$null } 'Migration failed'
 Assert-Offline ($env:PGPASSWORD -ceq 'offline-prior-dummy' -and $env:PGOPTIONS -ceq 'offline-prior-options' -and $env:PGSSLMODE -ceq 'offline-prior-ssl') 'Environment restored after failed child'
 Write-Host "PASSED: $($script:checks) offline checks; fake client only, no database connection."
}
finally {
 foreach($name in $savedEnvironment.Keys) {
  [Environment]::SetEnvironmentVariable($name,$savedEnvironment[$name],'Process')
 }
 # Check the resolved target remains our fresh temp fixture before recursive removal.
 $resolved=[IO.Path]::GetFullPath($fixtureRoot)
 if([IO.Path]::GetDirectoryName($resolved) -ne $tempRoot.TrimEnd('\','/') -or
    [IO.Path]::GetFileName($resolved) -notmatch '^dhumi-0070-offline-[0-9a-f]{32}$') {
  throw 'Unexpected fixture path; refusing cleanup'
 }
 if(Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
