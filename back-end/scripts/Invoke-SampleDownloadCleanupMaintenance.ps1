[CmdletBinding()]
param(
    [ValidateSet('Cleanup', 'Watchdog', 'Status', 'AlertTest')]
    [string]$Mode = 'Cleanup',
    [ValidatePattern('^[a-zA-Z_][a-zA-Z0-9_]{0,62}$')]
    [string]$ExpectedDatabase = 'dhumi_dev',
    [string]$StateDirectory = '',
    [string]$NodePath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$backendRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($StateDirectory)) {
    $StateDirectory = Join-Path $backendRoot '.runtime\sample-download-cleanup-maintenance'
}
$statePath = Join-Path $StateDirectory 'status.json'

function Write-MaintenanceState {
    param([Parameter(Mandatory)]$State)
    $temporaryPath = Join-Path $StateDirectory ('status-' + [guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::WriteAllText($temporaryPath, ($State | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    # Windows PowerShell 5.1 otherwise coerces $null to an invalid empty backup path.
    if (Test-Path -LiteralPath $statePath) { [IO.File]::Replace($temporaryPath, $statePath, [NullString]::Value) }
    else { [IO.File]::Move($temporaryPath, $statePath) }
}

function Write-MaintenanceAlert {
    param([Parameter(Mandatory)][string]$Code)
    # Fixed codes/counters only: no keys, SAS links, provider/sample values or credentials.
    if ($Code -notmatch '^[a-z0-9_]{1,80}$') { throw 'Invalid maintenance alert code.' }
    $record = [ordered]@{ time = [DateTimeOffset]::UtcNow.ToString('o'); service = 'dhumi-sample-download-cleanup'; code = $Code; providerCalls = 0 }
    $alertPath = Join-Path $StateDirectory ('alerts-' + [DateTime]::UtcNow.ToString('yyyyMMdd') + '.jsonl')
    [IO.File]::AppendAllText($alertPath, (($record | ConvertTo-Json -Compress) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    Write-EventLog -LogName 'Windows PowerShell' -Source 'PowerShell' -EntryType Error -EventId 1001 -Message ("Dhumi sample-download cleanup alert: $Code. Inspect the private maintenance status. Bright Data calls: 0.")
}

function Get-MaintenanceHealthCode {
    param([Parameter(Mandatory)]$State, [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow)
    if ($State.status -eq 'failed') { return 'cleanup_failed' }
    if ($State.status -eq 'running') {
        if (($Now - [DateTimeOffset]::Parse($State.startedAt)).TotalMinutes -gt 11) { return 'cleanup_stalled' }
        return $null
    }
    $reference = $State.installedAt
    if ($State.status -eq 'succeeded') { $reference = $State.completedAt }
    if (($Now - [DateTimeOffset]::Parse($reference)).TotalMinutes -gt 20) { return 'cleanup_missed_run' }
    return $null
}

function Get-ValidatedCleanupSummary {
    param([Parameter(Mandatory)][string]$Output)
    $summary = $null
    foreach ($line in ($Output -split '\r?\n')) {
        try { $entry = $line | ConvertFrom-Json -ErrorAction Stop } catch { continue }
        if ($null -eq $entry -or $entry.PSObject.Properties.Name -notcontains 'msg' -or
            $entry.msg -ne 'Generated sample-download cleanup completed') { continue }
        $summary = [ordered]@{}
        foreach ($name in @('pages', 'examined', 'deleted', 'absent', 'protected', 'untracked', 'ignored', 'failures')) {
            if ($entry.PSObject.Properties.Name -notcontains $name -or $entry.$name -isnot [ValueType] -or
                [double]$entry.$name -lt 0 -or [double]$entry.$name -ne [Math]::Floor([double]$entry.$name)) {
                throw 'Cleanup summary is invalid.'
            }
            $summary[$name] = $entry.$name
        }
        if ($entry.complete -isnot [bool] -or $entry.providerCalls -ne 0) { throw 'Cleanup summary is invalid.' }
        $summary.complete = $entry.complete
        $summary.providerCalls = 0
    }
    if ($null -eq $summary) { throw 'Cleanup summary is missing.' }
    return $summary
}

function Invoke-MaintenanceMain {
    if (-not (Test-Path -LiteralPath $StateDirectory -PathType Container)) { throw 'Provision the maintenance configuration first.' }
    if ($Mode -eq 'AlertTest') { Write-MaintenanceAlert 'alert_delivery_self_test'; return 0 }
    if ($Mode -eq 'Status') { Get-Content -LiteralPath $statePath; return 0 }
    if ($Mode -eq 'Watchdog') {
        try { $healthCode = Get-MaintenanceHealthCode (Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json) }
        catch { $healthCode = 'maintenance_status_unreadable' }
        if ($null -ne $healthCode) { Write-MaintenanceAlert $healthCode; return 1 }
        return 0
    }

    # FileShare.None fences scheduled and manual wrapper invocations for the same profile.
    # Task Scheduler also has MultipleInstances=IgnoreNew. The lock has no stale-file expiry.
    $lock = $null
    try { $lock = [IO.File]::Open((Join-Path $StateDirectory 'cleanup.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch [IO.IOException] { Write-MaintenanceAlert 'cleanup_overlap_prevented'; return 1 }
    $state = $null
    $worker = $null
    try {
        $previousState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        $state = [ordered]@{ installedAt = $previousState.installedAt; status = 'running'; startedAt = [DateTimeOffset]::UtcNow.ToString('o'); completedAt = $null; failureCode = $null; summary = $null }
        Write-MaintenanceState $state
        $protectedProfile = Get-Content -LiteralPath (Join-Path $StateDirectory 'configuration.dpapi') -Raw
        $secureProfile = ConvertTo-SecureString $protectedProfile
        $profileJson = [Net.NetworkCredential]::new('', $secureProfile).Password
        $profile = $profileJson | ConvertFrom-Json
        $profileJson = $null
        if ($profile.DATABASE_NAME -ne $ExpectedDatabase -or $profile.RESULT_STORAGE_DRIVER -ne 'azurite' -or
            $profile.NODE_ENV -notin @('development', 'test')) { throw 'Maintenance configuration identity is invalid.' }
        if ([string]::IsNullOrWhiteSpace($NodePath)) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
        $start = [Diagnostics.ProcessStartInfo]::new()
        $start.FileName = $NodePath
        $start.Arguments = '--import tsx src/worker/marketplaceSampleDownloadCleanup.ts --expected-database ' + $ExpectedDatabase + ' --confirm-delete-generated-objects'
        $start.WorkingDirectory = $backendRoot
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $start.EnvironmentVariables.Clear()
        foreach ($name in @('SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA')) {
            $value = [Environment]::GetEnvironmentVariable($name)
            if ($null -ne $value) { $start.EnvironmentVariables[$name] = $value }
        }
        $allowed = @('NODE_ENV','LOG_LEVEL','DATABASE_HOST','DATABASE_PORT','DATABASE_NAME','DATABASE_OPERATOR_USER',
            'DATABASE_OPERATOR_PASSWORD','DATABASE_POOL_MIN','DATABASE_POOL_MAX','DATABASE_CONNECTION_TIMEOUT_MS',
            'DATABASE_IDLE_TIMEOUT_MS','DATABASE_STATEMENT_TIMEOUT_MS','DATABASE_QUERY_TIMEOUT_MS',
            'DATABASE_IDLE_TRANSACTION_TIMEOUT_MS','DATABASE_SSL_MODE','DATABASE_SSL_CA_FILE',
            'RESULT_STORAGE_DRIVER','RESULT_STORAGE_CONNECTION_STRING','RESULT_STORAGE_CONTAINER')
        foreach ($property in $profile.PSObject.Properties) {
            if ($property.Name -notin $allowed) { throw 'Unexpected credential in maintenance profile.' }
            $start.EnvironmentVariables[$property.Name] = [string]$property.Value
        }
        $worker = [Diagnostics.Process]::new()
        $worker.StartInfo = $start
        [void]$worker.Start()
        $stdout = $worker.StandardOutput.ReadToEndAsync()
        $stderr = $worker.StandardError.ReadToEndAsync()
        if (-not $worker.WaitForExit(600000)) {
            # Only the worker we just started and its children are terminated.
            & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $worker.Id /T /F 2>&1 | Out-Null
            [void]$worker.WaitForExit(5000)
            $state.failureCode = 'cleanup_timeout'
            throw 'Cleanup timeout.'
        }
        $summary = Get-ValidatedCleanupSummary $stdout.Result
        $state.summary = $summary
        if ($worker.ExitCode -ne 0 -or -not $summary.complete -or $summary.failures -ne 0 -or $summary.untracked -ne 0 -or $summary.ignored -ne 0) {
            $state.failureCode = 'cleanup_requires_review'
            throw 'Cleanup requires operator review; unverified objects are preserved.'
        }
        $state.status = 'succeeded'
        $state.completedAt = [DateTimeOffset]::UtcNow.ToString('o')
        Write-MaintenanceState $state
        Write-Output ($summary | ConvertTo-Json -Compress)
        return 0
    }
    catch {
        if ($null -ne $state) {
            $state.status = 'failed'
            $state.completedAt = [DateTimeOffset]::UtcNow.ToString('o')
            if ($null -eq $state.failureCode) { $state.failureCode = 'maintenance_failed' }
            Write-MaintenanceState $state
            Write-MaintenanceAlert $state.failureCode
        }
        else { Write-MaintenanceAlert 'maintenance_failed' }
        return 1
    }
    finally {
        if ($null -ne $worker) { $worker.Dispose() }
        if ($null -ne $lock) { $lock.Dispose() }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try { $result = @(Invoke-MaintenanceMain); $exitCode = [int]$result[-1]; $result | Select-Object -SkipLast 1 | Write-Output; exit $exitCode }
    catch { Write-Error 'Sample-download maintenance failed. Inspect local maintenance alerts; no secrets logged.'; exit 1 }
}
