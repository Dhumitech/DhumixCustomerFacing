[CmdletBinding()]
param(
    [ValidateSet('Test', 'Dev', 'Both')]
    [string]$Target = 'Dev',

    [ValidateSet('Published', 'MigratedOnly')]
    [string]$ExpectedState = 'Published'
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    throw 'psql was not found on PATH.'
}

$backendRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$securePassword = Read-Host 'PostgreSQL administrator password (held only by verification child processes)' -AsSecureString
$passwordPointer = [IntPtr]::Zero
$plainPassword = $null
$previousPassword = $env:PGPASSWORD

try {
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    $env:PGPASSWORD = $plainPassword

    $databases = switch ($Target) {
        'Test' { @('dhumi_test') }
        'Dev' { @('dhumi_dev') }
        default { @('dhumi_test', 'dhumi_dev') }
    }

    Push-Location $backendRoot
    try {
        foreach ($database in $databases) {
            Write-Host "Verifying Amazon products input-contract v4 on $database..."

            $expectedPublished = if ($ExpectedState -eq 'Published') { 'true' } else { 'false' }
            & psql -X `
                -h localhost `
                -p 5432 `
                -U postgres `
                -d $database `
                -v ON_ERROR_STOP=1 `
                -v expected_published=$expectedPublished `
                --pset=pager=off `
                --file '.\tests\privileged\backend-release-closure\verify-amazon-products-input-v4.sql'

            if ($LASTEXITCODE -ne 0) {
                throw "Amazon products input-contract v4 verification failed for $database."
            }
        }
    }
    finally {
        Pop-Location
    }
}
finally {
    if ($null -eq $previousPassword) {
        Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
    }
    else {
        $env:PGPASSWORD = $previousPassword
    }
    $plainPassword = $null
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
}

Write-Host 'Verification completed. Bright Data calls: 0.'
