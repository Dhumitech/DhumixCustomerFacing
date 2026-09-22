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
    throw 'The M2 database proof may run only against dhumi_test.'
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
        & psql -X "--dbname=$DatabaseUrl" --pset=pager=off -v ON_ERROR_STOP=1 `
            -f '.\tests\integration\0034_marketplace_catalogue_import.sql'
        if ($LASTEXITCODE -ne 0) {
            throw 'M2 rollback-only database proof failed.'
        }

        & npm.cmd run typecheck
        if ($LASTEXITCODE -ne 0) {
            throw 'M2 TypeScript validation failed.'
        }

        & node node_modules/vitest/vitest.mjs run `
            tests/unit/marketplace-dataset-catalogue-client.test.ts `
            tests/unit/marketplace-catalogue-service.test.ts `
            tests/unit/marketplace-catalogue-migration.test.ts
        if ($LASTEXITCODE -ne 0) {
            throw 'M2 focused regression failed.'
        }

        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) {
            throw 'M2 production build failed.'
        }

        if ($FullRegression) {
            Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
            & npm.cmd test
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

Write-Host 'M2 Marketplace catalogue database proof passed. Bright Data calls: 0.'
