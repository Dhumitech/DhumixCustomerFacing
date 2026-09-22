[CmdletBinding()]
param(
    [ValidateSet('Test', 'Dev', 'Both')]
    [string]$Target = 'Both'
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    throw 'psql was not found on PATH.'
}

$securePassword = Read-Host 'PostgreSQL administrator password (held only by migration child processes)' -AsSecureString
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

    foreach ($database in $databases) {
        Write-Host "Applying forward-only migrations to $database..."
        $env:DATABASE_URL = "postgresql://postgres@localhost:5432/$database"
        & '.\scripts\migrate.ps1'
        if ($LASTEXITCODE -ne 0) {
            throw "Backend Release Closure migration sequence failed for $database."
        }

        $version = (& psql -X -h localhost -p 5432 -U postgres -d $database `
            -v ON_ERROR_STOP=1 --tuples-only --no-align `
            --command "SELECT version FROM app.schema_migrations WHERE version = '0043_amazon_products_input_contract_v4';").Trim()
        if ($LASTEXITCODE -ne 0 -or $version -ne '0043_amazon_products_input_contract_v4') {
            throw "Migration 0043 was not recorded for $database."
        }
        Write-Host "Migration 0043 is ledgered on $database."
    }
}
finally {
    Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
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
