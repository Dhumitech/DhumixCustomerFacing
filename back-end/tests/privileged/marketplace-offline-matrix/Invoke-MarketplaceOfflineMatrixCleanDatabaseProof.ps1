[CmdletBinding()]
param(
    [Parameter()]
    [ValidateRange(1024, 65535)]
    [int]$Port = 55453
)

$ErrorActionPreference = 'Stop'
$backendRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$containerName = 'dhumi-marketplace-m8-clean-postgres-proof'
$databaseName = 'dhumi_marketplace_m8_proof'
$passwordBytes = New-Object byte[] 36
$passwordGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $passwordGenerator.GetBytes($passwordBytes)
}
finally {
    $passwordGenerator.Dispose()
}
$password = [Convert]::ToBase64String($passwordBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$oldPgPassword = $env:PGPASSWORD

function Invoke-Psql {
    param(
        [Parameter(Mandatory)] [string]$Database,
        [Parameter(Mandatory)] [string[]]$Arguments
    )
    & psql -X -h 127.0.0.1 -p $Port -U postgres -d $Database `
        -v ON_ERROR_STOP=1 @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "psql failed for database $Database."
    }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'docker was not found on PATH.'
}
if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    throw 'psql was not found on PATH.'
}

try {
    $existing = docker ps -a --filter "name=^/${containerName}$" --format '{{.Names}}'
    if ($existing -contains $containerName) {
        throw "Disposable proof container already exists: $containerName"
    }

    docker run --name $containerName -e "POSTGRES_PASSWORD=$password" `
        -p "${Port}:5432" -d postgres:18 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not start the disposable PostgreSQL 18 container.'
    }

    $env:PGPASSWORD = $password
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        # Windows PowerShell 5.1 promotes native stderr to an ErrorRecord. PostgreSQL
        # is expected to reject a few connections while the disposable container
        # starts, so keep only this readiness probe non-terminating and retain the
        # native exit code for the actual readiness decision.
        $probeErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $probe = & psql -X -h 127.0.0.1 -p $Port -U postgres -d postgres `
                --tuples-only --no-align --command 'SELECT 1;' 2>$null
            $probeExitCode = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $probeErrorActionPreference
        }
        if ($probeExitCode -eq 0 -and ($probe -join '').Trim() -eq '1') {
            $ready = $true
            break
        }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) {
        throw 'Disposable PostgreSQL did not become ready.'
    }

    Push-Location $backendRoot
    try {
        Invoke-Psql -Database postgres -Arguments @(
            '--command',
            'CREATE ROLE dhumi_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;'
        )
        Invoke-Psql -Database postgres -Arguments @(
            '--file', '.\scripts\bootstrap\0001_cluster_roles.sql'
        )
        Invoke-Psql -Database postgres -Arguments @(
            '--command',
            "CREATE DATABASE $databaseName OWNER dhumi_owner TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'PG_UNICODE_FAST';"
        )
        Invoke-Psql -Database postgres -Arguments @(
            '--command',
            "REVOKE ALL ON DATABASE $databaseName FROM PUBLIC; GRANT CONNECT ON DATABASE $databaseName TO dhumi_customer_api, dhumi_identity, dhumi_admission, dhumi_job_manager, dhumi_result_recorder, dhumi_outbox_dispatcher, dhumi_envelope_janitor, dhumi_operator;"
        )
        Invoke-Psql -Database $databaseName -Arguments @(
            '--set', "target_database=$databaseName",
            '--set', 'owner_role=dhumi_owner',
            '--set', 'app_schema=app',
            '--file', '.\scripts\bootstrap\0003_prepare_app_schema.sql'
        )

        & '.\scripts\migrate.ps1' `
            -DatabaseUrl "postgresql://postgres@127.0.0.1:${Port}/$databaseName"
        if ($LASTEXITCODE -ne 0) {
            throw 'Clean M8 migration replay failed.'
        }

        Invoke-Psql -Database $databaseName -Arguments @(
            "--set=expected_database=$databaseName",
            '--file',
            '.\tests\privileged\marketplace-offline-matrix\Verify-MarketplacePersistentState.sql'
        )

        foreach ($proof in @(
            '.\tests\integration\0034_marketplace_catalogue_import.sql',
            '.\tests\integration\0035_marketplace_sample_ingestion.sql',
            '.\tests\integration\0036_marketplace_sample_preview.sql',
            '.\tests\integration\0037_marketplace_sample_download_authorization.sql',
            '.\tests\integration\0038_marketplace_expert_enquiries.sql',
            '.\tests\integration\0039_marketplace_filter_adapter_fixture.sql',
            '.\tests\integration\0040_marketplace_offline_release_matrix.sql'
        )) {
            Invoke-Psql -Database $databaseName -Arguments @('--file', $proof)
        }

        $leftovers = & psql -X -h 127.0.0.1 -p $Port -U postgres -d $databaseName `
            --tuples-only --no-align -v ON_ERROR_STOP=1 `
            --command "SELECT count(*) FROM app.runs WHERE id = '7e000000-0000-4000-8000-00000000000d';"
        if ($LASTEXITCODE -ne 0 -or ($leftovers -join '').Trim() -ne '0') {
            throw 'M8 rollback cleanup verification failed.'
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
    $password = $null

    $resolved = docker ps -a --filter "name=^/${containerName}$" --format '{{.Names}}' 2>$null
    if ($resolved -contains $containerName) {
        docker rm -f $containerName | Out-Null
    }
}

Write-Host 'M8 clean PostgreSQL matrix passed and its fixture was rolled back.'
Write-Host 'Bright Data calls: 0.'
