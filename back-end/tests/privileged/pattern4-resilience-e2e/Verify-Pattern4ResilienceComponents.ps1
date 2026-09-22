[CmdletBinding()]
param(
    [Parameter()]
    [switch]$FullRegression
)

$ErrorActionPreference = 'Stop'
$backendRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$oldServiceBusFlag = $env:RUN_SERVICE_BUS_EMULATOR_TESTS

function Assert-ChildSuccess([string]$message) {
    if ($LASTEXITCODE -ne 0) {
        throw $message
    }
}

Push-Location $backendRoot
try {
    & npm run infra:pattern3:up
    Assert-ChildSuccess 'Pattern 3 Azurite startup failed.'

    & npm run infra:pattern4:up
    Assert-ChildSuccess 'Pattern 4 emulator startup failed.'

    & npm run typecheck
    Assert-ChildSuccess 'TypeScript validation failed.'

    & node node_modules/vitest/vitest.mjs run `
        tests/unit/job-command.test.ts `
        tests/unit/job-manager-service.test.ts `
        tests/unit/job-manager-subscription.test.ts `
        tests/unit/outbox-dispatcher-loop.test.ts `
        tests/unit/dead-letter-recovery-service.test.ts `
        tests/unit/pattern4-reconciliation-migration.test.ts
    Assert-ChildSuccess 'Focused Pattern 4 resilience suite failed.'

    $env:RUN_SERVICE_BUS_EMULATOR_TESTS = 'true'
    & node node_modules/vitest/vitest.mjs run tests/integration/servicebus-execution-queue.test.ts
    Assert-ChildSuccess 'Real Service Bus emulator resilience proof failed.'

    if ($FullRegression) {
        & npm test
        Assert-ChildSuccess 'Full regression suite failed.'

        & npm run build
        Assert-ChildSuccess 'Production build failed.'
    }
}
finally {
    if ($null -eq $oldServiceBusFlag) {
        Remove-Item Env:RUN_SERVICE_BUS_EMULATOR_TESTS -ErrorAction SilentlyContinue
    }
    else {
        $env:RUN_SERVICE_BUS_EMULATOR_TESTS = $oldServiceBusFlag
    }
    Pop-Location
}

Write-Host 'Pattern 4 component and emulator resilience verification passed.'
if (-not $FullRegression) {
    Write-Host 'Run again with -FullRegression before formal Pattern 4 closure.'
}
