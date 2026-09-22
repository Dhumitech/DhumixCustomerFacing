[CmdletBinding()]
param(
    [Parameter()]
    [string]$DatabaseUrl = 'postgresql://postgres@localhost:5432/dhumi_test',

    [Parameter()]
    [switch]$FullRegression
)

$ErrorActionPreference = 'Stop'
$backendRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path

if ($DatabaseUrl -match '(?i)://[^/@\s]+:[^/@\s]+@' -or
    $DatabaseUrl -match '(?i)(^|\s)password\s*=') {
    throw 'DatabaseUrl must not contain a password.'
}
if ($DatabaseUrl -notmatch '(?i)(?:/|dbname=)dhumi_test(?:\?|$|\s)') {
    throw 'Pattern 4 resilience database matrix may run only against dhumi_test.'
}
if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    throw 'psql was not found on PATH.'
}

$activeWorkers = @(
    Get-CimInstance Win32_Process -ErrorAction Stop |
        Where-Object {
            $_.CommandLine -match 'src[\\/]+worker[\\/]+(?:outboxDispatcher|jobManager)\.ts'
        }
)
if ($activeWorkers.Count -gt 0) {
    throw 'PATTERN4_WORKERS_MUST_BE_STOPPED: stop worker:outbox and worker:jobs before running the controlled matrix.'
}

$environmentNames = @(
    'PGPASSWORD',
    'PRIVILEGED_TEST_DATABASE_URL',
    'RUN_DATABASE_INTEGRATION_TESTS',
    'RUN_CANCEL_RUN_PRIVILEGED_TESTS',
    'RUN_RETRY_RUN_PRIVILEGED_TESTS',
    'RUN_PATTERN4_RESILIENCE_DATABASE_MATRIX',
    'RUN_SERVICE_BUS_EMULATOR_TESTS',
    'RUN_REDIS_INTEGRATION_TESTS'
)
$oldEnvironment = @{}
foreach ($name in $environmentNames) {
    $oldEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

$passwordPointer = [IntPtr]::Zero
$plainPassword = $null

function Assert-ChildSuccess([string]$message) {
    if ($LASTEXITCODE -ne 0) {
        throw $message
    }
}

try {
    $securePassword = Read-Host 'PostgreSQL administrator password (held only by matrix child processes)' -AsSecureString
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)

    $env:PGPASSWORD = $plainPassword
    $env:PRIVILEGED_TEST_DATABASE_URL = $DatabaseUrl
    $env:RUN_DATABASE_INTEGRATION_TESTS = 'true'
    $env:RUN_CANCEL_RUN_PRIVILEGED_TESTS = 'true'
    $env:RUN_RETRY_RUN_PRIVILEGED_TESTS = 'true'
    $env:RUN_PATTERN4_RESILIENCE_DATABASE_MATRIX = 'true'

    Push-Location $backendRoot
    try {
        & npm run infra:pattern3:up
        Assert-ChildSuccess 'Pattern 3 Azurite startup failed.'

        & npm run infra:pattern4:up
        Assert-ChildSuccess 'Pattern 4 emulator startup failed.'

        $databaseArgument = "--dbname=$DatabaseUrl"
        Write-Host 'Scenario 1/7: PostgreSQL duplicate, crash-fence and expired-lease recovery'
        & psql -X $databaseArgument --pset=pager=off -v ON_ERROR_STOP=1 `
            -f '.\tests\integration\0020_durable_execution_fencing.sql'
        Assert-ChildSuccess 'Pattern 4 fencing database proof failed.'

        Write-Host 'Scenario 2/7: PostgreSQL reconciliation and controlled DLQ recovery'
        & psql -X $databaseArgument --pset=pager=off -v ON_ERROR_STOP=1 `
            -f '.\tests\integration\0021_durable_execution_reconciliation.sql'
        Assert-ChildSuccess 'Pattern 4 reconciliation database proof failed.'

        Write-Host 'Scenario 3a/7: restricted operator runtime'
        & node --env-file-if-exists=.env.test node_modules/vitest/vitest.mjs run `
            tests/privileged/pattern4-resilience-e2e/operator-runtime-database.test.ts `
            --config vitest.privileged.config.ts `
            --reporter=verbose
        Assert-ChildSuccess 'Pattern 4 operator database proof failed.'

        Write-Host 'Scenario 3b/7: cancellation races'
        & node --env-file-if-exists=.env.test node_modules/vitest/vitest.mjs run `
            tests/privileged/cancel-run-concurrency-database.test.ts `
            --config vitest.privileged.config.ts `
            --reporter=verbose
        Assert-ChildSuccess 'Pattern 4 cancellation database proof failed.'

        Write-Host 'Scenario 3c/7: retry lineage'
        & node --env-file-if-exists=.env.test node_modules/vitest/vitest.mjs run `
            tests/privileged/retry-run-concurrency-database.test.ts `
            --config vitest.privileged.config.ts `
            --reporter=verbose
        Assert-ChildSuccess 'Pattern 4 retry-lineage database proof failed.'

        $env:RUN_SERVICE_BUS_EMULATOR_TESTS = 'true'
        Write-Host 'Scenario 4/7: Service Bus duplicate delivery and dead-letter settlement'
        & node --env-file-if-exists=.env.test node_modules/vitest/vitest.mjs run `
            tests/integration/servicebus-execution-queue.test.ts
        Assert-ChildSuccess 'Pattern 4 Service Bus proof failed.'

        $env:RUN_REDIS_INTEGRATION_TESTS = 'true'
        Write-Host 'Scenario 5/7: Redis lease ownership and fail-closed token checks'
        & node --env-file-if-exists=.env.test node_modules/vitest/vitest.mjs run `
            tests/integration/redis-capacity-lease.test.ts
        Assert-ChildSuccess 'Pattern 4 Redis proof failed.'

        Write-Host 'Scenario 6/7: focused worker recovery and graceful-shutdown regression'
        & node node_modules/vitest/vitest.mjs run `
            tests/unit/job-command.test.ts `
            tests/unit/job-manager-service.test.ts `
            tests/unit/job-manager-subscription.test.ts `
            tests/unit/outbox-dispatcher-loop.test.ts `
            tests/unit/dead-letter-recovery-service.test.ts `
            tests/unit/pattern4-reconciliation-migration.test.ts `
            tests/unit/pattern4-resilience-database-matrix.test.ts
        Assert-ChildSuccess 'Focused Pattern 4 resilience regression failed.'

        Write-Host 'Scenario 7/7: TypeScript and production build'
        & npm run typecheck
        Assert-ChildSuccess 'TypeScript validation failed.'
        & npm run build
        Assert-ChildSuccess 'Production build failed.'

        if ($FullRegression) {
            # The matrix deliberately enables privileged and emulator-backed
            # tests above. The baseline suite must run in its normal isolated
            # mode and must not inherit the administrator password.
            foreach ($name in $environmentNames) {
                Remove-Item "Env:$name" -ErrorAction SilentlyContinue
            }
            & npm test
            Assert-ChildSuccess 'Full regression suite failed.'
        }
    }
    finally {
        Pop-Location
    }
}
finally {
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

Write-Host 'Pattern 4 real-database resilience matrix passed.'
if (-not $FullRegression) {
    Write-Host 'Run again with -FullRegression before formal Pattern 4 closure.'
}
