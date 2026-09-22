[CmdletBinding()]
param(
    [Parameter()]
    [string]$DatabaseUrl = 'postgresql://postgres@localhost:5432/dhumi_test'
)

$ErrorActionPreference = 'Stop'

if ($DatabaseUrl -match '(?i)://[^/@\s]+:[^/@\s]+@' -or
    $DatabaseUrl -match '(?i)(^|\s)password\s*=') {
    throw 'DatabaseUrl must not contain a password.'
}

$backEnd = Split-Path -Parent $PSScriptRoot
$passwordPointer = [IntPtr]::Zero
$plainPassword = $null
$oldPgPassword = $env:PGPASSWORD
$oldPrivilegedUrl = $env:PRIVILEGED_TEST_DATABASE_URL
$oldPrivilegedFlag = $env:RUN_CREATE_SERVICE_PRIVILEGED_TESTS
$oldDatabaseFlag = $env:RUN_DATABASE_INTEGRATION_TESTS

try {
    $securePassword = Read-Host 'PostgreSQL password (held only by the privileged test child process)' -AsSecureString
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)

    $env:PGPASSWORD = $plainPassword
    $env:PRIVILEGED_TEST_DATABASE_URL = $DatabaseUrl
    $env:RUN_CREATE_SERVICE_PRIVILEGED_TESTS = 'true'
    $env:RUN_DATABASE_INTEGRATION_TESTS = 'true'

    Push-Location $backEnd
    try {
        & node --env-file-if-exists=.env.test node_modules/vitest/vitest.mjs run `
            --config vitest.privileged.config.ts `
            --reporter=verbose
        if ($LASTEXITCODE -ne 0) {
            throw 'Privileged create-Service PostgreSQL tests failed.'
        }
    }
    finally {
        Pop-Location
    }
}
finally {
    if ($null -eq $oldPgPassword) { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
    else { $env:PGPASSWORD = $oldPgPassword }
    if ($null -eq $oldPrivilegedUrl) { Remove-Item Env:PRIVILEGED_TEST_DATABASE_URL -ErrorAction SilentlyContinue }
    else { $env:PRIVILEGED_TEST_DATABASE_URL = $oldPrivilegedUrl }
    if ($null -eq $oldPrivilegedFlag) { Remove-Item Env:RUN_CREATE_SERVICE_PRIVILEGED_TESTS -ErrorAction SilentlyContinue }
    else { $env:RUN_CREATE_SERVICE_PRIVILEGED_TESTS = $oldPrivilegedFlag }
    if ($null -eq $oldDatabaseFlag) { Remove-Item Env:RUN_DATABASE_INTEGRATION_TESTS -ErrorAction SilentlyContinue }
    else { $env:RUN_DATABASE_INTEGRATION_TESTS = $oldDatabaseFlag }

    $plainPassword = $null
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
}
