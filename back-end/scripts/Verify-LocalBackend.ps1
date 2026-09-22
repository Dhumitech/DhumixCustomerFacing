[CmdletBinding()]
param(
    [ValidateSet('controlled', 'bright_data')]
    [string]$ExpectedExecutorDriver = 'bright_data'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$backendRoot = Split-Path -Parent $PSScriptRoot
$environmentPath = Join-Path $backendRoot '.env'
$script:failureCount = 0
$script:warningCount = 0

function Write-Pass {
    param(
        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [string]$Detail
    )

    Write-Host "[PASS] $Name - $Detail" -ForegroundColor Green
}

function Write-Failure {
    param(
        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [string]$Detail
    )

    $script:failureCount += 1
    Write-Host "[FAIL] $Name - $Detail" -ForegroundColor Red
}

function Write-WarningResult {
    param(
        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [string]$Detail
    )

    $script:warningCount += 1
    Write-Host "[WARN] $Name - $Detail" -ForegroundColor Yellow
}

function Get-DotEnvValue {
    param(
        [Parameter(Mandatory)]
        [string]$Path,

        [Parameter(Mandatory)]
        [string]$Name
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }

    $escapedName = [Regex]::Escape($Name)
    $matchingLine = Get-Content -LiteralPath $Path |
        Where-Object { $_ -match "^\s*$escapedName\s*=" } |
        Select-Object -Last 1

    if ($null -eq $matchingLine) {
        return $null
    }

    $value = ($matchingLine -split '=', 2)[1].Trim()

    if (
        $value.Length -ge 2 -and
        (($value.StartsWith('"') -and $value.EndsWith('"')) -or
         ($value.StartsWith("'") -and $value.EndsWith("'")))
    ) {
        return $value.Substring(1, $value.Length - 2)
    }

    return $value
}

function Test-ListeningPort {
    param(
        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [int]$Port
    )

    $listeners = @(
        Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalPort -eq $Port }
    )

    if ($listeners.Count -eq 0) {
        Write-Failure $Name "port $Port is not listening"
        return
    }

    $processIds = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
    Write-Pass $Name "port $Port; listener PID(s)=$($processIds -join ',')"
}

function Assert-SingleNodeRuntime {
    param(
        [Parameter(Mandatory)]
        [object[]]$Processes,

        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [string]$CommandPattern
    )

    # cmd.exe/npm wrappers are intentionally excluded. Only real Node runtimes
    # count, so one wrapper plus one node.exe is correctly treated as one service.
    $matches = @(
        $Processes |
            Where-Object {
                $_.Name -in @('node.exe', 'node') -and
                $_.CommandLine -match $CommandPattern
            }
    )

    if ($matches.Count -eq 0) {
        Write-Failure $Name 'no actual Node runtime was found'
        return $null
    }

    if ($matches.Count -gt 1) {
        $identities = @(
            $matches |
                ForEach-Object {
                    "PID=$($_.ProcessId), parent=$($_.ParentProcessId)"
                }
        )
        Write-Failure $Name "duplicate actual Node runtimes detected: $($identities -join '; ')"
        return $null
    }

    $runtime = $matches[0]
    Write-Pass $Name "exactly one actual Node runtime; PID=$($runtime.ProcessId), parent=$($runtime.ParentProcessId)"
    return $runtime
}

function Test-EnvironmentFreshness {
    param(
        [AllowNull()]
        [object]$Process,

        [Parameter(Mandatory)]
        [System.IO.FileInfo]$EnvironmentFile,

        [Parameter(Mandatory)]
        [string]$Name
    )

    if ($null -eq $Process) {
        return
    }

    if ($EnvironmentFile.LastWriteTime -gt $Process.CreationDate) {
        Write-Failure $Name ".env changed after PID=$($Process.ProcessId) started; restart this process"
        return
    }

    Write-Pass $Name "PID=$($Process.ProcessId) started after the current .env was last changed"
}

function Test-DockerContainer {
    param(
        [Parameter(Mandatory)]
        [string]$ContainerName,

        [switch]$RequireHealthy
    )

    $stateJson = & docker inspect --format '{{json .State}}' $ContainerName 2>$null

    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($stateJson -join ''))) {
        Write-Failure "Container $ContainerName" 'container was not found'
        return
    }

    $state = ($stateJson -join '') | ConvertFrom-Json

    if (-not $state.Running) {
        Write-Failure "Container $ContainerName" "running=false; status=$($state.Status)"
        return
    }

    $healthStatus = $null
    $healthProperty = $state.PSObject.Properties['Health']
    if ($null -ne $healthProperty -and $null -ne $healthProperty.Value) {
        $healthStatus = $healthProperty.Value.Status
    }

    if ($RequireHealthy -and $healthStatus -ne 'healthy') {
        Write-Failure "Container $ContainerName" "running=true but health=$healthStatus"
        return
    }

    $detail = 'running=true'
    if ($null -ne $healthStatus) {
        $detail += "; health=$healthStatus"
    }
    Write-Pass "Container $ContainerName" $detail
}

Write-Host 'Dhumi local backend verification' -ForegroundColor Cyan
Write-Host 'This script is read-only and does not submit a Run or call Bright Data.' -ForegroundColor Cyan
Write-Host ''

if (-not (Test-Path -LiteralPath $environmentPath -PathType Leaf)) {
    Write-Failure 'Executor configuration' '.env was not found'
    $environmentFile = $null
}
else {
    $environmentFile = Get-Item -LiteralPath $environmentPath
    $configuredDriver = Get-DotEnvValue -Path $environmentPath -Name 'RUN_EXECUTOR_DRIVER'

    if ($configuredDriver -ne $ExpectedExecutorDriver) {
        Write-Failure 'Executor configuration' "expected RUN_EXECUTOR_DRIVER=$ExpectedExecutorDriver but found $configuredDriver"
    }
    else {
        Write-Pass 'Executor configuration' "RUN_EXECUTOR_DRIVER=$configuredDriver"
    }
}

try {
    $nodeVersion = (& node --version).Trim()
    if ($nodeVersion -match '^v24\.') {
        Write-Pass 'Node.js runtime' "$nodeVersion satisfies package.json >=24 <25"
    }
    else {
        Write-Failure 'Node.js runtime' "$nodeVersion does not satisfy package.json >=24 <25"
    }
}
catch {
    Write-Failure 'Node.js runtime' $_.Exception.Message
}

$requiredPorts = @(
    @{ Name = 'Customer API'; Port = 3000 },
    @{ Name = 'PostgreSQL'; Port = 5432 },
    @{ Name = 'Service Bus emulator'; Port = 5672 },
    @{ Name = 'Redis'; Port = 6380 },
    @{ Name = 'Azurite'; Port = 10000 }
)

foreach ($requiredPort in $requiredPorts) {
    Test-ListeningPort -Name $requiredPort.Name -Port $requiredPort.Port
}

try {
    $status = Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:3000/v1/status' -TimeoutSec 10

    if ($status.state -ne 'operational') {
        Write-Failure 'Customer API health' "state=$($status.state)"
    }
    else {
        Write-Pass 'Customer API health' 'state=operational'
    }

    $scraperLibrary = @($status.products | Where-Object { $_.family -eq 'scraper_library' })
    if ($scraperLibrary.Count -ne 1 -or $scraperLibrary[0].state -ne 'operational') {
        Write-Failure 'Scraper Library health' 'expected exactly one operational scraper_library status entry'
    }
    else {
        Write-Pass 'Scraper Library health' 'state=operational'
    }
}
catch {
    Write-Failure 'Customer API health' $_.Exception.Message
}

$allProcesses = @(Get-CimInstance Win32_Process)
$apiProcess = Assert-SingleNodeRuntime `
    -Processes $allProcesses `
    -Name 'Customer API process cardinality' `
    -CommandPattern '(?i)(src[\\/]server\.ts|dist[\\/]server\.js)'
$outboxProcess = Assert-SingleNodeRuntime `
    -Processes $allProcesses `
    -Name 'Outbox Dispatcher process cardinality' `
    -CommandPattern '(?i)(src[\\/]worker[\\/]outboxDispatcher\.ts|dist[\\/]worker[\\/]outboxDispatcher\.js)'
$jobManagerProcess = Assert-SingleNodeRuntime `
    -Processes $allProcesses `
    -Name 'Job Manager process cardinality' `
    -CommandPattern '(?i)(src[\\/]worker[\\/]jobManager\.ts|dist[\\/]worker[\\/]jobManager\.js)'

if ($null -ne $environmentFile) {
    Test-EnvironmentFreshness -Process $apiProcess -EnvironmentFile $environmentFile -Name 'Customer API configuration freshness'
    Test-EnvironmentFreshness -Process $outboxProcess -EnvironmentFile $environmentFile -Name 'Outbox Dispatcher configuration freshness'
    Test-EnvironmentFreshness -Process $jobManagerProcess -EnvironmentFile $environmentFile -Name 'Job Manager configuration freshness'
}

try {
    $dockerServerVersion = (& docker version --format '{{.Server.Version}}' 2>$null).Trim()
    if ([string]::IsNullOrWhiteSpace($dockerServerVersion)) {
        Write-Failure 'Docker Engine' 'server version was empty'
    }
    else {
        Write-Pass 'Docker Engine' "server version=$dockerServerVersion"
    }
}
catch {
    Write-Failure 'Docker Engine' $_.Exception.Message
}

Test-DockerContainer -ContainerName 'back-end-azurite-1' -RequireHealthy
Test-DockerContainer -ContainerName 'dhumi-pattern4-redis-1' -RequireHealthy
Test-DockerContainer -ContainerName 'dhumi-pattern4-mssql-1'
Test-DockerContainer -ContainerName 'dhumi-pattern4-servicebus-emulator-1'

try {
    $redisResponse = (& docker exec dhumi-pattern4-redis-1 redis-cli ping 2>$null).Trim()
    if ($LASTEXITCODE -eq 0 -and $redisResponse -eq 'PONG') {
        Write-Pass 'Redis functional check' 'PONG'
    }
    else {
        Write-Failure 'Redis functional check' "expected PONG but received $redisResponse"
    }
}
catch {
    Write-Failure 'Redis functional check' $_.Exception.Message
}

Write-Host ''
if ($script:failureCount -gt 0) {
    Write-Host "NOT READY: $($script:failureCount) verification check(s) failed." -ForegroundColor Red
    Write-Host 'Do not submit a billable Run until every failure is resolved.' -ForegroundColor Red
    exit 1
}

Write-Host 'READY: backend and infrastructure verification passed.' -ForegroundColor Green
if ($script:warningCount -gt 0) {
    Write-Host "Warnings: $($script:warningCount)" -ForegroundColor Yellow
}

if ($ExpectedExecutorDriver -eq 'bright_data') {
    Write-Host 'WARNING: eligible Amazon Runs can create billable Bright Data work.' -ForegroundColor Yellow
}

exit 0
