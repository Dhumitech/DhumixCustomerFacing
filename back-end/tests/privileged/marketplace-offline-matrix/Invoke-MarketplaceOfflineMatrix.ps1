[CmdletBinding()]
param(
    [Parameter()]
    [ValidateSet('Test', 'Dev', 'Both')]
    [string]$Target = 'Both',

    [Parameter()]
    [switch]$SkipInfrastructureStart,

    [Parameter()]
    [switch]$FullRegression
)

$ErrorActionPreference = 'Stop'
$backendRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$databaseUrls = [ordered]@{}
$m8ComposeProject = 'dhumi-marketplace-m8'
$m8AmqpPort = 15672
$m8HttpPort = 15300
$m8RedisPort = 16380
$createdM8Infrastructure = $false

if ($Target -in @('Test', 'Both')) {
    $databaseUrls['dhumi_test'] = 'postgresql://postgres@localhost:5432/dhumi_test'
}
if ($Target -in @('Dev', 'Both')) {
    $databaseUrls['dhumi_dev'] = 'postgresql://postgres@localhost:5432/dhumi_dev'
}

function Assert-ChildSuccess([string]$message) {
    if ($LASTEXITCODE -ne 0) {
        throw $message
    }
}

function Invoke-PsqlFile([string]$databaseUrl, [string]$file, [string]$failure) {
    & psql -X "--dbname=$databaseUrl" --pset=pager=off -v ON_ERROR_STOP=1 -f $file
    Assert-ChildSuccess $failure
}

function Wait-ServiceBusEmulatorReady([int]$HealthPort) {
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$HealthPort"
            if ($response.StatusCode -eq 200) {
                return
            }
        }
        catch {
            # The emulator returns 503 while its SQL-backed message store is
            # starting. Retry is bounded and happens before any queue test.
        }
        Start-Sleep -Seconds 1
    }
    throw 'M8_SERVICE_BUS_NOT_READY: emulator health did not reach HTTP 200. Inspect its container and SQL dependency before retrying.'
}

if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    throw 'psql was not found on PATH.'
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'docker was not found on PATH.'
}

$envFile = Join-Path $backendRoot '.env'
if (-not (Test-Path -LiteralPath $envFile)) {
    throw 'M8_CONTROLLED_EXECUTOR_REQUIRED: back-end/.env was not found.'
}
$executorLines = @(
    Get-Content -LiteralPath $envFile |
        Where-Object { $_ -match '^\s*RUN_EXECUTOR_DRIVER\s*=' }
)
if ($executorLines.Count -ne 1) {
    throw 'M8_CONTROLLED_EXECUTOR_REQUIRED: .env must contain exactly one RUN_EXECUTOR_DRIVER assignment.'
}
$configuredExecutor = ($executorLines[0] -split '=', 2)[1].Trim().Trim('"').Trim("'")
if ($configuredExecutor -cne 'controlled') {
    throw "M8_CONTROLLED_EXECUTOR_REQUIRED: .env configures '$configuredExecutor', expected 'controlled'."
}

$activeWorkers = @(
    Get-CimInstance Win32_Process -ErrorAction Stop |
        Where-Object {
            $_.Name -eq 'node.exe' -and
            $_.CommandLine -match '(?i)(?:src|dist)[\\/]+worker[\\/]+(?:outboxDispatcher|jobManager)\.(?:ts|js)'
        }
)
if ($activeWorkers.Count -gt 0) {
    $activeWorkers | Select-Object ProcessId, CommandLine | Format-Table -AutoSize
    throw 'M8_EXECUTION_WORKERS_MUST_BE_STOPPED: stop both execution workers before running this offline matrix.'
}

$environmentNames = @(
    'PGPASSWORD',
    'RUN_EXECUTOR_DRIVER',
    'RUN_AZURITE_INTEGRATION_TESTS',
    'RUN_SERVICE_BUS_EMULATOR_TESTS',
    'RUN_REDIS_INTEGRATION_TESTS',
    'SERVICE_BUS_TEST_CONNECTION_STRING',
    'REDIS_TEST_URL',
    'PATTERN4_SERVICEBUS_AMQP_PORT',
    'PATTERN4_SERVICEBUS_HTTP_PORT',
    'PATTERN4_REDIS_PORT',
    'PRIVILEGED_TEST_DATABASE_URL',
    'RUN_DATABASE_INTEGRATION_TESTS',
    'RUN_CANCEL_RUN_PRIVILEGED_TESTS',
    'RUN_RETRY_RUN_PRIVILEGED_TESTS'
)
$oldEnvironment = @{}
foreach ($name in $environmentNames) {
    $oldEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

$passwordPointer = [IntPtr]::Zero
$plainPassword = $null

try {
    $securePassword = Read-Host 'PostgreSQL administrator password (held only by M8 child processes)' -AsSecureString
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)

    $env:PGPASSWORD = $plainPassword
    $env:RUN_EXECUTOR_DRIVER = 'controlled'

    Push-Location $backendRoot
    try {
        if (-not $SkipInfrastructureStart) {
            & npm.cmd run infra:pattern3:up
            Assert-ChildSuccess 'M8 Azurite startup failed.'

            $existingM8Containers = @(
                docker ps -a --filter "label=com.docker.compose.project=$m8ComposeProject" `
                    --format '{{.Names}}'
            )
            Assert-ChildSuccess 'M8 could not inspect Docker Compose project state.'
            if ($existingM8Containers.Count -gt 0) {
                throw "M8_DISPOSABLE_INFRASTRUCTURE_EXISTS: remove or inspect project '$m8ComposeProject' before retrying."
            }
            foreach ($port in @($m8AmqpPort, $m8HttpPort, $m8RedisPort)) {
                if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
                    throw "M8_DISPOSABLE_PORT_IN_USE: loopback port $port is already occupied."
                }
            }

            $env:PATTERN4_SERVICEBUS_AMQP_PORT = $m8AmqpPort.ToString()
            $env:PATTERN4_SERVICEBUS_HTTP_PORT = $m8HttpPort.ToString()
            $env:PATTERN4_REDIS_PORT = $m8RedisPort.ToString()
            & docker compose --project-name $m8ComposeProject --env-file .env.pattern4 `
                -f compose.pattern4.yml up -d
            Assert-ChildSuccess 'M8 disposable Redis and Service Bus emulator startup failed.'
            $createdM8Infrastructure = $true

            $env:SERVICE_BUS_TEST_CONNECTION_STRING = "Endpoint=sb://localhost:${m8AmqpPort};SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;"
            $env:REDIS_TEST_URL = "redis://127.0.0.1:${m8RedisPort}"
            Wait-ServiceBusEmulatorReady $m8HttpPort
        }
        else {
            Wait-ServiceBusEmulatorReady 5300
        }

        Write-Host 'Gate 1/8: persistent release-state verification and isolated clean transition proofs'
        foreach ($entry in $databaseUrls.GetEnumerator()) {
            & '.\scripts\migrate.ps1' -DatabaseUrl $entry.Value
            Assert-ChildSuccess "Migration failed for $($entry.Key)."

            & psql -X "--dbname=$($entry.Value)" --pset=pager=off `
                -v ON_ERROR_STOP=1 "--set=expected_database=$($entry.Key)" `
                -f '.\tests\privileged\marketplace-offline-matrix\Verify-MarketplacePersistentState.sql'
            Assert-ChildSuccess "M8_COMMERCIAL_EXECUTION_DEFERRED: persistent-state verification failed for $($entry.Key)."
            Write-Host "[PASS] $($entry.Key): migration ledger and customer-disabled boundary"
        }

        & '.\tests\privileged\marketplace-offline-matrix\Invoke-MarketplaceOfflineMatrixCleanDatabaseProof.ps1'
        Assert-ChildSuccess 'M8 isolated clean PostgreSQL transition proof failed.'
        Write-Host '[PASS] disposable PostgreSQL: M2-M8 transition proofs and rollback cleanup'

        if ($databaseUrls.Contains('dhumi_test')) {
            Write-Host 'Gate 2/8: generic fencing, reconciliation and exactly-once usage'
            Invoke-PsqlFile $databaseUrls['dhumi_test'] `
                '.\tests\integration\0020_durable_execution_fencing.sql' `
                'M8 duplicate/crash/lease fencing proof failed.'
            Invoke-PsqlFile $databaseUrls['dhumi_test'] `
                '.\tests\integration\0021_durable_execution_reconciliation.sql' `
                'M8 reconciliation/DLQ database proof failed.'
            Invoke-PsqlFile $databaseUrls['dhumi_test'] `
                '.\tests\integration\0025_usage_finalization.sql' `
                'M8 exactly-once usage database proof failed.'

            $env:PRIVILEGED_TEST_DATABASE_URL = $databaseUrls['dhumi_test']
            $env:RUN_DATABASE_INTEGRATION_TESTS = 'true'
            $env:RUN_CANCEL_RUN_PRIVILEGED_TESTS = 'true'
            $env:RUN_RETRY_RUN_PRIVILEGED_TESTS = 'true'
            & node --env-file-if-exists=.env.test node_modules/vitest/vitest.mjs run `
                tests/privileged/cancel-run-concurrency-database.test.ts `
                tests/privileged/retry-run-concurrency-database.test.ts `
                --config vitest.privileged.config.ts `
                --no-file-parallelism
            Assert-ChildSuccess 'M8 cancellation/retry database race matrix failed.'
        }
        else {
            Write-Host 'Gate 2/8: skipped because Target does not include Test'
        }

        Write-Host 'Gate 3/8: authentication, scope, concealment and customer API contracts'
        & node node_modules/vitest/vitest.mjs run `
            tests/contract/list-catalog-templates.test.ts `
            tests/contract/get-catalog-template.test.ts `
            tests/contract/create-run.test.ts `
            tests/contract/get-run-result.test.ts
        Assert-ChildSuccess 'M8 customer API authorization contract suite failed.'

        Write-Host 'Gate 4/8: Marketplace catalogue, sample, filtering and executor unit matrix'
        & node node_modules/vitest/vitest.mjs run `
            tests/unit/marketplace-catalogue-service.test.ts `
            tests/unit/marketplace-catalogue-migration.test.ts `
            tests/unit/marketplace-catalogue-source-guard.test.ts `
            tests/unit/marketplace-dataset-catalogue-client.test.ts `
            tests/unit/marketplace-preview-service.test.ts `
            tests/unit/marketplace-preview-migration.test.ts `
            tests/unit/marketplace-sample-service.test.ts `
            tests/unit/marketplace-sample-migration.test.ts `
            tests/unit/marketplace-sample-lifecycle-migration.test.ts `
            tests/unit/marketplace-sample-retention-migration.test.ts `
            tests/unit/marketplace-sample-source-guard.test.ts `
            tests/unit/marketplace-sample-download-service.test.ts `
            tests/unit/marketplace-sample-download-migration.test.ts `
            tests/unit/marketplace-expert-enquiry-service.test.ts `
            tests/unit/marketplace-expert-enquiry-migration.test.ts `
            tests/unit/marketplace-filter-request.test.ts `
            tests/unit/marketplace-filter-client.test.ts `
            tests/unit/marketplace-filter-adapter-migration.test.ts `
            tests/unit/marketplace-result-normalizer.test.ts `
            tests/unit/marketplace-run-executor.test.ts `
            tests/unit/provider-run-executor-router.test.ts `
            tests/unit/marketplace-offline-matrix.test.ts
        Assert-ChildSuccess 'M8 focused Marketplace unit matrix failed.'

        Write-Host 'Gate 5/8: private storage, exact bytes, checksums and signed-link expiry'
        $env:RUN_AZURITE_INTEGRATION_TESTS = 'true'
        & node --env-file-if-exists=.env.test node_modules/vitest/vitest.mjs run `
            tests/integration/azurite-result-storage.test.ts `
            tests/integration/azurite-marketplace-sample-storage.test.ts `
            tests/integration/azurite-marketplace-sample-download.test.ts
        Assert-ChildSuccess 'M8 Azurite storage and signed-link matrix failed.'

        Write-Host 'Gate 6/8: duplicate delivery, DLQ settlement and Redis lease ownership'
        $env:RUN_SERVICE_BUS_EMULATOR_TESTS = 'true'
        & node --env-file-if-exists=.env.test node_modules/vitest/vitest.mjs run `
            tests/integration/servicebus-execution-queue.test.ts
        Assert-ChildSuccess 'M8 Service Bus duplicate/DLQ matrix failed.'
        $env:RUN_REDIS_INTEGRATION_TESTS = 'true'
        & node --env-file-if-exists=.env.test node_modules/vitest/vitest.mjs run `
            tests/integration/redis-capacity-lease.test.ts
        Assert-ChildSuccess 'M8 Redis lease matrix failed.'

        Write-Host 'Gate 7/8: worker crash, retry, cancellation and shutdown behavior'
        & node node_modules/vitest/vitest.mjs run `
            tests/unit/job-command.test.ts `
            tests/unit/job-manager-service.test.ts `
            tests/unit/job-manager-subscription.test.ts `
            tests/unit/outbox-dispatcher-loop.test.ts `
            tests/unit/dead-letter-recovery-service.test.ts `
            tests/unit/pattern4-reconciliation-migration.test.ts
        Assert-ChildSuccess 'M8 worker resilience suite failed.'

        Write-Host 'Gate 8/8: TypeScript and production build'
        & npm.cmd run typecheck
        Assert-ChildSuccess 'M8 TypeScript validation failed.'
        & npm.cmd run build
        Assert-ChildSuccess 'M8 production build failed.'

        if ($FullRegression) {
            foreach ($name in $environmentNames) {
                Remove-Item "Env:$name" -ErrorAction SilentlyContinue
            }
            & npm.cmd test
            Assert-ChildSuccess 'M8 full baseline regression failed.'
        }
    }
    finally {
        Pop-Location
    }
}
finally {
    if ($createdM8Infrastructure) {
        Push-Location $backendRoot
        try {
            & docker compose --project-name $m8ComposeProject --env-file .env.pattern4 `
                -f compose.pattern4.yml down --volumes --remove-orphans
        }
        finally {
            Pop-Location
        }
    }

    foreach ($name in $environmentNames) {
        $oldValue = $oldEnvironment[$name]
        if ($null -eq $oldValue) {
            Remove-Item "Env:$name" -ErrorAction SilentlyContinue
        }
        else {
            [Environment]::SetEnvironmentVariable($name, $oldValue, 'Process')
        }
    }

    $plainPassword = $null
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
}

Write-Host 'M8 offline security, database, storage and resilience matrix passed.'
Write-Host 'Commercial execution and entitlement remain fail-closed for MPayment.'
Write-Host 'Bright Data calls: 0.'
if (-not $FullRegression) {
    Write-Host 'Run with -FullRegression before formal M8 closure.'
}
