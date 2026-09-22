[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$backendRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
. (Join-Path $backendRoot 'scripts\Invoke-SampleDownloadCleanupMaintenance.ps1')
function Assert-Maintenance { param([bool]$Condition, [string]$Message); if (-not $Condition) { throw $Message } }
$now = [DateTimeOffset]::UtcNow
$state = [pscustomobject]@{ status = 'succeeded'; installedAt = $now.AddHours(-2).ToString('o'); startedAt = $now.AddMinutes(-1).ToString('o'); completedAt = $now.ToString('o') }
Assert-Maintenance ($null -eq (Get-MaintenanceHealthCode $state $now)) 'A recent success must be healthy.'
$state.completedAt = $now.AddMinutes(-21).ToString('o')
Assert-Maintenance ((Get-MaintenanceHealthCode $state $now) -eq 'cleanup_missed_run') 'Missed runs must alert.'
$state.status = 'failed'
Assert-Maintenance ((Get-MaintenanceHealthCode $state $now) -eq 'cleanup_failed') 'Failure must alert.'
$state.status = 'running'; $state.startedAt = $now.AddMinutes(-12).ToString('o')
Assert-Maintenance ((Get-MaintenanceHealthCode $state $now) -eq 'cleanup_stalled') 'Stalled worker must alert.'
$state.status = 'pending'; $state.installedAt = $now.ToString('o')
Assert-Maintenance ($null -eq (Get-MaintenanceHealthCode $state $now)) 'Installation has a bounded startup grace.'
$summaryText = '{"msg":"Generated sample-download cleanup completed","pages":1,"examined":3,"deleted":1,"absent":0,"protected":2,"untracked":0,"ignored":0,"failures":0,"complete":true,"providerCalls":0,"objectKey":"must-not-be-retained"}'
$summary = Get-ValidatedCleanupSummary $summaryText
Assert-Maintenance ($summary.deleted -eq 1 -and -not $summary.Contains('objectKey')) 'Only safe counters may persist.'
$rejected = $false
try { Get-ValidatedCleanupSummary ($summaryText.Replace('"providerCalls":0', '"providerCalls":1')) | Out-Null } catch { $rejected = $true }
Assert-Maintenance $rejected 'Nonzero provider calls must be rejected.'
$privateProofDirectory = Join-Path $backendRoot ('.runtime\maintenance-lock-proof-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($privateProofDirectory)
$StateDirectory = $privateProofDirectory
$statePath = Join-Path $StateDirectory 'status.json'
Write-MaintenanceState ([ordered]@{ status = 'pending' })
Write-MaintenanceState ([ordered]@{ status = 'succeeded' })
Assert-Maintenance ((Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json).status -eq 'succeeded') 'Status creation and atomic replacement must work on Windows PowerShell 5.1.'
$lockPath = Join-Path $privateProofDirectory 'cleanup.lock'
$first = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
try {
    $rejected = $false
    try { $second = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None'); $second.Dispose() } catch [IO.IOException] { $rejected = $true }
    Assert-Maintenance $rejected 'Parallel invocations must be fenced.'
    & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -NonInteractive -File (Join-Path $backendRoot 'scripts\Invoke-SampleDownloadCleanupMaintenance.ps1') -Mode Cleanup -StateDirectory $privateProofDirectory
    Assert-Maintenance ($LASTEXITCODE -eq 1) 'A separate wrapper process must refuse the held lock before starting any worker.'
} finally { $first.Dispose() }
$retry = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None'); $retry.Dispose()
Write-MaintenanceState ([ordered]@{ status = 'succeeded'; installedAt = $now.AddHours(-2).ToString('o'); completedAt = $now.AddMinutes(-21).ToString('o') })
& (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -NonInteractive -File (Join-Path $backendRoot 'scripts\Invoke-SampleDownloadCleanupMaintenance.ps1') -Mode Watchdog -StateDirectory $privateProofDirectory
Assert-Maintenance ($LASTEXITCODE -eq 1) 'The real watchdog must detect a missed run without invoking cleanup/provider execution.'
$alertPath = Join-Path $privateProofDirectory ('alerts-' + [DateTime]::UtcNow.ToString('yyyyMMdd') + '.jsonl')
$alerts = @(Get-Content -LiteralPath $alertPath | ForEach-Object { $_ | ConvertFrom-Json })
Assert-Maintenance ($alerts.code -contains 'cleanup_overlap_prevented') 'The overlap refusal must persist a local alert.'
Assert-Maintenance ($alerts.code -contains 'cleanup_missed_run') 'Missed-run detection must persist a local alert.'
Write-Host '[PASS] Maintenance health, missed/stalled/failure detection, safe summary and overlap fencing. Provider calls: 0.'
