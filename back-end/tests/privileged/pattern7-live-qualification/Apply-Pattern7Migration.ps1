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
$pointer = [IntPtr]::Zero
$plainPassword = $null
$previousPassword = $env:PGPASSWORD

try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
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
            throw "Pattern 7 migration failed for $database."
        }
        $versions = @(& psql -X -h localhost -p 5432 -U postgres -d $database `
            -v ON_ERROR_STOP=1 --tuples-only --no-align `
            --command "SELECT version FROM app.schema_migrations WHERE version IN ('0033_amazon_live_qualification_foundation', '0034_amazon_qualification_audit_rls', '0035_amazon_qualification_template_version_rls', '0036_amazon_qualification_execution_mode') ORDER BY version;")
        $versions = @($versions | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
        if (
            $LASTEXITCODE -ne 0 `
            -or $versions.Count -ne 4 `
            -or $versions[0] -ne '0033_amazon_live_qualification_foundation' `
            -or $versions[1] -ne '0034_amazon_qualification_audit_rls' `
            -or $versions[2] -ne '0035_amazon_qualification_template_version_rls' `
            -or $versions[3] -ne '0036_amazon_qualification_execution_mode'
        ) {
            throw "Pattern 7 migrations 0033-0036 were not all recorded for $database."
        }
        Write-Host "Pattern 7 migrations 0033-0036 are ledgered on $database."
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
    if ($pointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}
