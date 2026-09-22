[CmdletBinding()]
param(
    [Parameter()]
    [ValidateRange(1024, 65535)]
    [int]$Port = 55437
)

$ErrorActionPreference = 'Stop'
$backendRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$containerName = 'dhumi-pattern6-clean-postgres-proof'
$databaseName = 'dhumi_pattern6_proof'
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
            throw 'Clean Pattern 6 migration replay failed.'
        }

        Invoke-Psql -Database $databaseName -Arguments @(
            '--file', '.\tests\integration\0022_provider_execution_boundary.sql'
        )
        Invoke-Psql -Database $databaseName -Arguments @(
            '--file', '.\tests\integration\0023_amazon_operation_definitions.sql'
        )

        $counts = & psql -X -h 127.0.0.1 -p $Port -U postgres `
            -d $databaseName --tuples-only --no-align -v ON_ERROR_STOP=1 `
            --command "SELECT (SELECT count(*) FROM app.service_templates WHERE slug LIKE 'amazon-%') || ':' || (SELECT count(*) FROM app.service_template_versions AS version JOIN app.service_templates AS template ON template.id = version.service_template_id WHERE template.slug LIKE 'amazon-%') || ':' || (SELECT count(*) FROM app.provider_mappings AS mapping JOIN app.service_template_versions AS version ON version.id = mapping.service_template_version_id JOIN app.service_templates AS template ON template.id = version.service_template_id WHERE template.slug LIKE 'amazon-%');"
        if ($LASTEXITCODE -ne 0 -or ($counts -join '').Trim() -ne '13:13:0') {
            throw "Unexpected Pattern 6 counts: $($counts -join '')"
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

Write-Host 'Pattern 6 clean PostgreSQL proof passed: 13 draft Templates, 13 versions, 0 provider mappings.'
