[CmdletBinding()]
param(
    [Parameter()]
    [ValidateRange(1024, 65535)]
    [int]$Port = 55443
)

$ErrorActionPreference = 'Stop'
$backendRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$containerName = 'dhumi-backend-release-closure-clean-proof'
$databaseName = 'dhumi_backend_release_closure_proof'
$passwordBytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(36)
$password = [Convert]::ToBase64String($passwordBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$oldPgPassword = $env:PGPASSWORD

function Invoke-Psql {
    param(
        [Parameter(Mandatory)]
        [string]$Database,
        [Parameter(Mandatory)]
        [string[]]$Arguments
    )

    & psql -X -h 127.0.0.1 -p $Port -U postgres -d $Database `
        --pset=pager=off -v ON_ERROR_STOP=1 @Arguments
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
    docker rm -f $containerName 2>$null | Out-Null
    docker run --name $containerName `
        -e "POSTGRES_PASSWORD=$password" `
        -p "${Port}:5432" `
        -d postgres:18 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not start the disposable PostgreSQL 18 container.'
    }

    $env:PGPASSWORD = $password
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        $probe = & psql -X -h 127.0.0.1 -p $Port -U postgres -d postgres `
            --tuples-only --no-align --command 'SELECT 1;' 2>$null
        if ($LASTEXITCODE -eq 0 -and ($probe -join '').Trim() -eq '1') {
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
            throw 'Clean Backend Release Closure migration replay failed.'
        }

        Invoke-Psql -Database $databaseName -Arguments @(
            '--file', '.\tests\integration\0032_provider_poll_checkpoint.sql'
        )
        Invoke-Psql -Database $databaseName -Arguments @(
            '--file', '.\tests\integration\0025_usage_finalization.sql'
        )
        Invoke-Psql -Database $databaseName -Arguments @(
            '--set', 'keep_fixture=1',
            '--file', '.\tests\integration\0029_amazon_controlled_publication.sql'
        )
        Invoke-Psql -Database $databaseName -Arguments @(
            '--file', '.\tests\integration\0030_provider_mapping_aad_lineage.sql'
        )
        Invoke-Psql -Database $databaseName -Arguments @(
            '--set', 'keep_fixture=1',
            '--file', '.\tests\integration\0031_amazon_products_input_contract_v4.sql'
        )
        Invoke-Psql -Database $databaseName -Arguments @(
            '--set', 'expected_published=true',
            '--file', '.\tests\privileged\backend-release-closure\verify-amazon-products-input-v4.sql'
        )

        $version = & psql -X -h 127.0.0.1 -p $Port -U postgres `
            -d $databaseName --tuples-only --no-align -v ON_ERROR_STOP=1 `
            --command "SELECT version FROM app.schema_migrations WHERE version = '0043_amazon_products_input_contract_v4';"
        if ($LASTEXITCODE -ne 0 -or ($version -join '').Trim() -ne '0043_amazon_products_input_contract_v4') {
            throw 'Amazon products input-contract v4 migration was not ledgered in the clean proof database.'
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
    docker rm -f $containerName 2>$null | Out-Null
}

Write-Host 'Backend Release Closure clean PostgreSQL proof passed.'
