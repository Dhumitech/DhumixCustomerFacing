[CmdletBinding()]
param(
    [Parameter()]
    [string]$Database = 'dhumi_test',

    [Parameter()]
    [string]$HostName = 'localhost',

    [Parameter()]
    [string]$User = 'postgres'
)

$ErrorActionPreference = 'Stop'

if ($Database -ne 'dhumi_test') {
    throw 'The Amazon contract rollback proof may run only against dhumi_test.'
}

if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    throw 'psql was not found on PATH.'
}

$backEnd = Split-Path -Parent $PSScriptRoot
$fixture = Join-Path $backEnd 'tests\integration\0019_amazon_contract_foundation.sql'
if (-not (Test-Path -LiteralPath $fixture)) {
    throw "Rollback-only proof is missing: $fixture"
}

$passwordPointer = [IntPtr]::Zero
$plainPassword = $null
$oldPgPassword = $env:PGPASSWORD

try {
    $securePassword = Read-Host `
        'PostgreSQL password (held only by the rollback-only proof)' `
        -AsSecureString
    $passwordPointer = `
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $plainPassword = `
        [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    $env:PGPASSWORD = $plainPassword

    Push-Location $backEnd
    try {
        & psql -X -h $HostName -U $User -d $Database `
            -v ON_ERROR_STOP=1 `
            -f $fixture
        if ($LASTEXITCODE -ne 0) {
            throw 'Amazon contract rollback proof failed.'
        }
        Write-Host `
            'PASS - migrations 0026-0028 were proved and rolled back.' `
            -ForegroundColor Green
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
