[CmdletBinding()]
param(
    [ValidateSet('Prepare', 'Install', 'Inspect', 'Remove')]
    [string]$Action = 'Install',
    [ValidatePattern('^[a-zA-Z_][a-zA-Z0-9_]{0,62}$')]
    [string]$ExpectedDatabase = 'dhumi_dev'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$backendRoot = Split-Path -Parent $PSScriptRoot
$stateDirectory = Join-Path $backendRoot '.runtime\sample-download-cleanup-maintenance'
$runnerPath = Join-Path $PSScriptRoot 'Invoke-SampleDownloadCleanupMaintenance.ps1'
$nodePath = ''
$powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$conhostPath = Join-Path $env:SystemRoot 'System32\conhost.exe'
$taskNames = @('Dhumi-SampleDownloadCleanup', 'Dhumi-SampleDownloadCleanup-Watchdog')
$description = 'Dhumi generated sample-download retention v1; no provider execution.'

foreach ($taskName in $taskNames) {
    $existing = Get-ScheduledTask -TaskPath '\' -TaskName $taskName -ErrorAction SilentlyContinue
    if ($null -ne $existing -and ($existing.Description -ne $description -or $existing.Actions.Arguments -notlike ('*' + $runnerPath + '*'))) {
        throw "A different task owns $taskName. No task was modified."
    }
}
if ($Action -eq 'Inspect') {
    foreach ($taskName in $taskNames) {
        $task = Get-ScheduledTask -TaskPath '\' -TaskName $taskName -ErrorAction Stop
        $info = $task | Get-ScheduledTaskInfo
        [pscustomobject]@{ TaskName = $taskName; State = $task.State; Overlap = $task.Settings.MultipleInstances; LastRunTime = $info.LastRunTime; LastTaskResult = $info.LastTaskResult; NextRunTime = $info.NextRunTime }
    }
    return
}
if ($Action -eq 'Remove') {
    foreach ($taskName in $taskNames) {
        $task = Get-ScheduledTask -TaskPath '\' -TaskName $taskName -ErrorAction SilentlyContinue
        if ($null -ne $task) {
            if ($task.State -eq 'Running') { throw 'Let the maintenance job finish before removing its schedule.' }
            $task | Unregister-ScheduledTask -Confirm:$false
        }
    }
    Write-Host 'Schedules removed. Retained private profile, status and alert evidence; no storage object deleted.'
    return
}

$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
if ($Action -eq 'Prepare' -or -not (Test-Path -LiteralPath (Join-Path $stateDirectory 'configuration.dpapi'))) {
    [void][IO.Directory]::CreateDirectory($stateDirectory)
    # Profile/state are accessible only to this user, local administrators and SYSTEM.
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($identity.User)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($identity.User, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        [void]$acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $stateDirectory -AclObject $acl
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $nodePath
    $start.Arguments = '"' + (Join-Path $PSScriptRoot 'sample-download-cleanup-profile.mjs') + '" "' + (Join-Path $backendRoot '.env') + '" ' + $ExpectedDatabase
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($start)
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(10000)) { $process.Kill(); throw 'Private profile preparation timed out.' }
        if ($process.ExitCode -ne 0) { throw 'Private profile preparation failed. No configuration values logged.' }
        $secureProfile = ConvertTo-SecureString -String $stdout.Result -AsPlainText -Force
        $protectedProfile = ConvertFrom-SecureString $secureProfile
        [IO.File]::WriteAllText((Join-Path $stateDirectory 'configuration.dpapi'), $protectedProfile, [Text.UTF8Encoding]::new($false))
        $statusPath = Join-Path $stateDirectory 'status.json'
        if (-not (Test-Path -LiteralPath $statusPath)) {
            $initialState = [ordered]@{ installedAt = [DateTimeOffset]::UtcNow.ToString('o'); status = 'pending'; startedAt = $null; completedAt = $null; failureCode = $null; summary = $null }
            [IO.File]::WriteAllText($statusPath, ($initialState | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        }
    }
    finally { $process.Dispose() }
    Write-Host '[PASS] Minimal operator/storage profile protected using current-user Windows DPAPI; provider secrets excluded.'
}
if ($Action -eq 'Prepare') { return }

# Verify local error-event delivery before claiming the schedule has alerts.
& $powerShellPath -NoProfile -NonInteractive -File $runnerPath -Mode AlertTest
if ($LASTEXITCODE -ne 0) { throw 'Local alert-delivery self-test failed. Schedule was not installed.' }
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$registered = @()
try {
    for ($index = 0; $index -lt $taskNames.Count; $index++) {
        $mode = 'Cleanup'; $intervalMinutes = 15
        if ($index -eq 1) { $mode = 'Watchdog'; $intervalMinutes = 5 }
        # conhost --headless: -WindowStyle Hidden alone still flashes a console window on every run.
        $arguments = '--headless "' + $powerShellPath + '" -NoProfile -NonInteractive -WindowStyle Hidden -File "' + $runnerPath + '" -Mode ' + $mode + ' -ExpectedDatabase ' + $ExpectedDatabase + ' -NodePath "' + $nodePath + '"'
        $taskAction = New-ScheduledTaskAction -Execute $conhostPath -Argument $arguments -WorkingDirectory $backendRoot
        $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $intervalMinutes)
        $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 12)
        $task = New-ScheduledTask -Action $taskAction -Trigger $trigger -Settings $settings -Principal $principal -Description $description
        Register-ScheduledTask -TaskName $taskNames[$index] -TaskPath '\' -InputObject $task -Force | Out-Null
        $registered += $taskNames[$index]
    }
}
catch {
    # Do not leave an unmonitored deleting schedule if watchdog registration fails.
    foreach ($taskName in $registered) { Disable-ScheduledTask -TaskPath '\' -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null }
    throw 'Could not register both Windows maintenance tasks. Any partially registered schedule was disabled. Run this installer from an authorized Windows session.'
}
Write-Host '[PASS] Cleanup every 15 minutes; watchdog every 5 minutes; IgnoreNew overlap policy; limited current-user interactive tasks.'
Write-Host 'Local failure alerts: Windows PowerShell log, source PowerShell, event 1001; private alerts/status under .runtime.'
Write-Host 'Requires this user to remain signed in and PostgreSQL/Azurite to be available. No provider worker was started.'
