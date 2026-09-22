[CmdletBinding()]
param(
    [ValidateSet('Test', 'Dev', 'Both')]
    [string]$Target = 'Both'
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
            --command "SELECT version FROM app.schema_migrations WHERE version = '0042_provider_mapping_aad_lineage';").Trim()
        if ($LASTEXITCODE -ne 0 -or $version -ne '0042_provider_mapping_aad_lineage') {
            throw "PROVIDER_MAPPING_AAD_LINEAGE_MIGRATION_NOT_ACTIVE: migration 0042 is not ledgered on $database."
        }

        Write-Host "Running rollback-only Provider Mapping AAD lineage proof on $database..."
        & psql -X -h localhost -p 5432 -U postgres -d $database `
            --pset=pager=off -v ON_ERROR_STOP=1 `
            --file '.\tests\integration\0030_provider_mapping_aad_lineage.sql'
        if ($LASTEXITCODE -ne 0) {
            throw "Provider Mapping AAD lineage proof failed for $database."
        }
        Write-Host "Provider Mapping AAD lineage proof passed on $database."
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
