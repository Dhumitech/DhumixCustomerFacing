[CmdletBinding()]
param(
    [ValidateSet('Test', 'Dev', 'Both')]
    [string]$Target = 'Test'
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    throw 'psql was not found on PATH.'
}

$securePassword = Read-Host 'PostgreSQL administrator password (held only by proof child processes)' -AsSecureString
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
        $version = (& psql -X -h localhost -p 5432 -U postgres -d $database `
            -v ON_ERROR_STOP=1 --tuples-only --no-align `
            --command "SELECT version FROM app.schema_migrations WHERE version = '0038_usage_read_surface';").Trim()
        if ($LASTEXITCODE -ne 0 -or $version -ne '0038_usage_read_surface') {
            throw "PATTERN8_USAGE_READ_MIGRATION_NOT_ACTIVE: migration 0038 is not ledgered on $database."
        }

        Write-Host "Running rollback-only Pattern 8B usage-read proof on $database..."
        & psql -X -h localhost -p 5432 -U postgres -d $database `
            --pset=pager=off -v ON_ERROR_STOP=1 `
            --file '.\tests\integration\0026_usage_read_surface.sql'
        if ($LASTEXITCODE -ne 0) {
            throw "Pattern 8B usage-read database proof failed for $database."
        }
        Write-Host "Pattern 8B rollback-only usage-read proof passed on $database."
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
