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
    throw 'Pattern 6 database proof may run only against dhumi_test.'
}
if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    throw 'psql was not found on PATH.'
}

$oldPgPassword = $env:PGPASSWORD
$passwordPointer = [IntPtr]::Zero
$plainPassword = $null

try {
    $securePassword = Read-Host 'PostgreSQL administrator password (held only by proof child processes)' -AsSecureString
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    $env:PGPASSWORD = $plainPassword

    Push-Location $backendRoot
    try {
        $databaseArgument = "--dbname=$DatabaseUrl"
        & psql -X $databaseArgument --pset=pager=off -v ON_ERROR_STOP=1 `
            -f '.\tests\integration\0022_provider_execution_boundary.sql'
        if ($LASTEXITCODE -ne 0) {
            throw 'Pattern 6 fenced normalization database proof failed.'
        }

        & psql -X $databaseArgument --pset=pager=off -v ON_ERROR_STOP=1 `
            -f '.\tests\integration\0023_amazon_operation_definitions.sql'
        if ($LASTEXITCODE -ne 0) {
            throw 'Pattern 6 catalogue and security database proof failed.'
        }

        & npm run typecheck
        if ($LASTEXITCODE -ne 0) {
            throw 'Pattern 6 TypeScript validation failed.'
        }

        & node node_modules/vitest/vitest.mjs run `
            tests/unit/amazon-operation-definitions.test.ts `
            tests/unit/amazon-operation-serializer.test.ts `
            tests/unit/amazon-result-normalizer.test.ts `
            tests/unit/pattern6-amazon-definitions-migration.test.ts `
            tests/unit/amazon-catalogue-model.test.ts `
            tests/unit/brightdata-run-executor.test.ts
        if ($LASTEXITCODE -ne 0) {
            throw 'Pattern 6 focused regression failed.'
        }

        & npm run infra:pattern3:up
        if ($LASTEXITCODE -ne 0) {
            throw 'Pattern 6 Azurite startup failed.'
        }
        $oldAzuriteFlag = $env:RUN_AZURITE_INTEGRATION_TESTS
        try {
            $env:RUN_AZURITE_INTEGRATION_TESTS = 'true'
            & node --env-file-if-exists=.env.test node_modules/vitest/vitest.mjs run `
                tests/integration/pattern5-provider-result-storage.test.ts
            if ($LASTEXITCODE -ne 0) {
                throw 'Pattern 6 provider-to-normalized-storage E2E failed.'
            }
        }
        finally {
            if ($null -eq $oldAzuriteFlag) {
                Remove-Item Env:RUN_AZURITE_INTEGRATION_TESTS -ErrorAction SilentlyContinue
            }
            else {
                $env:RUN_AZURITE_INTEGRATION_TESTS = $oldAzuriteFlag
            }
        }

        & npm run build
        if ($LASTEXITCODE -ne 0) {
            throw 'Pattern 6 production build failed.'
        }

        if ($FullRegression) {
            Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
            & npm test
            if ($LASTEXITCODE -ne 0) {
                throw 'Full regression suite failed.'
            }
        }
    }
    finally {
        Pop-Location
    }
}
finally {
    if ($null -eq $oldPgPassword) {
        Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
    }
    else {
        $env:PGPASSWORD = $oldPgPassword
    }

    $plainPassword = $null
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
}

Write-Host 'Pattern 6 all-operation database and storage proof passed.'
if (-not $FullRegression) {
    Write-Host 'Run again with -FullRegression before formal Pattern 6 closure.'
}
