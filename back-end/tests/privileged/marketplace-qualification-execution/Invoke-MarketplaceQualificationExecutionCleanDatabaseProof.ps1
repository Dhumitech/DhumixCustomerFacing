[CmdletBinding()]
param(
    [Parameter()]
    [ValidateRange(1024, 65535)]
    [int]$Port = 55455
)

$ErrorActionPreference = 'Stop'
$backendRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$containerName = 'dhumi-marketplace-m9-execution-clean-postgres-proof'
$databaseName = 'dhumi_marketplace_m9_execution_proof'
$passwordBytes = New-Object byte[] 36
$generator = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $generator.GetBytes($passwordBytes) } finally { $generator.Dispose() }
$password = [Convert]::ToBase64String($passwordBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$oldPgPassword = $env:PGPASSWORD

function Invoke-Psql {
    param(
        [Parameter(Mandatory)] [string]$Database,
        [Parameter(Mandatory)] [string[]]$Arguments
    )
    & psql -X -h 127.0.0.1 -p $Port -U postgres -d $Database `
        -v ON_ERROR_STOP=1 @Arguments
    if ($LASTEXITCODE -ne 0) { throw "psql failed for database $Database." }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'docker was not found on PATH.' }
if (-not (Get-Command psql -ErrorAction SilentlyContinue)) { throw 'psql was not found on PATH.' }

try {
    $existing = docker ps -a --filter "name=^/${containerName}$" --format '{{.Names}}'
    if ($existing -contains $containerName) {
        throw "Disposable proof container already exists: $containerName"
    }
    docker run --name $containerName -e "POSTGRES_PASSWORD=$password" `
        -p "${Port}:5432" -d postgres:18 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not start the disposable PostgreSQL 18 container.' }

    $env:PGPASSWORD = $password
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        $savedPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $probe = & psql -X -h 127.0.0.1 -p $Port -U postgres -d postgres `
                --tuples-only --no-align --command 'SELECT 1;' 2>$null
            $probeExitCode = $LASTEXITCODE
        }
        finally { $ErrorActionPreference = $savedPreference }
        if ($probeExitCode -eq 0 -and ($probe -join '').Trim() -eq '1') {
            $ready = $true
            break
        }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) { throw 'Disposable PostgreSQL did not become ready.' }

    Push-Location $backendRoot
    try {
        Invoke-Psql -Database postgres -Arguments @(
            '--command',
            'CREATE ROLE dhumi_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;'
        )
        Invoke-Psql -Database postgres -Arguments @('--file', '.\scripts\bootstrap\0001_cluster_roles.sql')
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
        if ($LASTEXITCODE -ne 0) { throw 'Clean M9 execution migration replay failed.' }

        Invoke-Psql -Database $databaseName -Arguments @(
            '--file', '.\tests\integration\0041_marketplace_qualification_preflight.sql'
        )

        $leftovers = & psql -X -h 127.0.0.1 -p $Port -U postgres -d $databaseName `
            --tuples-only --no-align -v ON_ERROR_STOP=1 `
            --command "SELECT concat_ws('|', (SELECT count(*) FROM app.marketplace_qualification_packets WHERE id IN ('81000000-0000-4000-8000-000000000020','81000000-0000-4000-8000-000000000030','81000000-0000-4000-8000-000000000040')), (SELECT count(*) FROM app.marketplace_qualification_poll_checkpoints WHERE marketplace_qualification_packet_id IN ('81000000-0000-4000-8000-000000000020','81000000-0000-4000-8000-000000000030','81000000-0000-4000-8000-000000000040')));"
        if ($LASTEXITCODE -ne 0 -or ($leftovers -join '').Trim() -ne '0|0') {
            throw 'M9 execution rollback cleanup verification failed.'
        }
    }
    finally { Pop-Location }
}
finally {
    if ($null -eq $oldPgPassword) { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
    else { $env:PGPASSWORD = $oldPgPassword }
    $password = $null
    $resolved = docker ps -a --filter "name=^/${containerName}$" --format '{{.Names}}' 2>$null
    if ($resolved -contains $containerName) { docker rm -f $containerName | Out-Null }
}

Write-Host 'M9 clean PostgreSQL execution proof passed and its fixtures were rolled back.'
Write-Host 'Bright Data calls: 0.'
