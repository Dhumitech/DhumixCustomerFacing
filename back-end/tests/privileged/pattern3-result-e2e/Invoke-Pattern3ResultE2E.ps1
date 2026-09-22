[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Prepare', 'Inspect', 'Cleanup', 'Automated', 'Http')]
    [string]$Action,

    [Parameter()]
    [string]$DatabaseUrl = 'postgresql://postgres@localhost:5432/dhumi_test',

    [Parameter()]
    [string]$BaseUrl = '',

    [Parameter()]
    [switch]$SkipInfrastructureStart,

    [Parameter()]
    [string]$ManifestPath = (Join-Path ([System.IO.Path]::GetTempPath()) 'dhumi-pattern3-result-e2e.json')
)

$ErrorActionPreference = 'Stop'

if ($DatabaseUrl -match '(?i)://[^/@\s]+:[^/@\s]+@' -or
    $DatabaseUrl -match '(?i)(^|\s)password\s*=') {
    throw 'DatabaseUrl must not contain a password.'
}

$backEnd = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$passwordPointer = [IntPtr]::Zero
$plainPassword = $null
$saved = @{}
$environmentNames = @(
    'PGPASSWORD',
    'PRIVILEGED_TEST_DATABASE_URL',
    'PATTERN3_FIXTURE_MANIFEST_PATH',
    'PATTERN3_BASE_URL',
    'RUN_DATABASE_INTEGRATION_TESTS',
    'RUN_PATTERN3_RESULT_E2E_TESTS'
)
foreach ($name in $environmentNames) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

try {
    $securePassword = Read-Host 'PostgreSQL password (held only by the Pattern 3 child process)' -AsSecureString
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)

    $env:PGPASSWORD = $plainPassword
    $env:PRIVILEGED_TEST_DATABASE_URL = $DatabaseUrl
    $env:PATTERN3_FIXTURE_MANIFEST_PATH = [System.IO.Path]::GetFullPath($ManifestPath)
    if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
        Remove-Item Env:PATTERN3_BASE_URL -ErrorAction SilentlyContinue
    }
    else {
        $env:PATTERN3_BASE_URL = $BaseUrl
    }

    Push-Location $backEnd
    try {
        if (-not $SkipInfrastructureStart -and $Action -in @('Prepare', 'Automated', 'Http')) {
            & npm run infra:pattern3:up
            if ($LASTEXITCODE -ne 0) {
                throw 'Azurite startup failed.'
            }
        }

        if ($Action -eq 'Automated') {
            $env:RUN_DATABASE_INTEGRATION_TESTS = 'true'
            $env:RUN_PATTERN3_RESULT_E2E_TESTS = 'true'
            & node --env-file-if-exists=.env.test node_modules/vitest/vitest.mjs run `
                tests/privileged/pattern3-result-e2e/pattern3-result-e2e.test.ts `
                --config vitest.privileged.config.ts `
                --reporter=verbose
            if ($LASTEXITCODE -ne 0) {
                throw 'Pattern 3 automated E2E test failed.'
            }
        }
        else {
            & node --env-file-if-exists=.env.test --import tsx `
                tests/privileged/pattern3-result-e2e/fixtureCli.ts `
                $Action.ToLowerInvariant()
            if ($LASTEXITCODE -ne 0) {
                throw "Pattern 3 $Action action failed."
            }
        }
    }
    finally {
        Pop-Location
    }
}
finally {
    foreach ($name in $environmentNames) {
        if ($null -eq $saved[$name]) {
            Remove-Item "Env:$name" -ErrorAction SilentlyContinue
        }
        else {
            [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process')
        }
    }
    $plainPassword = $null
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
}
