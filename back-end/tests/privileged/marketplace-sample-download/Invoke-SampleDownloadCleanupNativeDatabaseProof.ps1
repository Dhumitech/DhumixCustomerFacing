[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)] [int]$Port = 55464
)

$ErrorActionPreference = 'Stop'
$backendRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtimeRoot = Join-Path $backendRoot '.runtime'
$proofRoot = Join-Path $runtimeRoot ('sample-download-cleanup-' + [Guid]::NewGuid().ToString('N'))
$dataRoot = Join-Path $proofRoot 'pgdata'
$databaseName = 'dhumi_download_cleanup_proof'
$started = $false
$priorPgPassword = $env:PGPASSWORD
$priorPgService = $env:PGSERVICE

function Invoke-ProofPsql {
    param([string]$Database, [string[]]$Arguments)
    & psql -X -h 127.0.0.1 -p $Port -U postgres -w -d $Database `
        --pset=pager=off -v ON_ERROR_STOP=1 @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Disposable PostgreSQL proof failed for $Database." }
}

foreach ($command in @('initdb', 'pg_ctl', 'psql')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "$command is required on PATH." }
}
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
    throw "Proof port $Port is already in use. No existing process was stopped."
}

New-Item -ItemType Directory -Path $proofRoot -Force | Out-Null
try {
    Remove-Item Env:PGPASSWORD, Env:PGSERVICE -ErrorAction SilentlyContinue
    # Trust is confined to a new ephemeral loopback-only test cluster, not the
    # workstation's PostgreSQL service, dhumi_dev or dhumi_test.
    & initdb -D $dataRoot -U postgres --auth=trust --encoding=UTF8 --no-locale
    if ($LASTEXITCODE -ne 0) { throw 'Disposable initdb failed.' }
    & pg_ctl -D $dataRoot -l (Join-Path $proofRoot 'postgres.log') `
        -o "-h 127.0.0.1 -p $Port" -w start
    if ($LASTEXITCODE -ne 0) { throw 'Disposable PostgreSQL startup failed.' }
    $started = $true
    Push-Location $backendRoot
    try {
        Invoke-ProofPsql postgres @('--command',
            'CREATE ROLE dhumi_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;')
        Invoke-ProofPsql postgres @('--file', '.\scripts\bootstrap\0001_cluster_roles.sql')
        Invoke-ProofPsql postgres @('--command',
            "CREATE DATABASE $databaseName OWNER dhumi_owner TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'PG_UNICODE_FAST';")
        Invoke-ProofPsql postgres @('--command',
            "REVOKE ALL ON DATABASE $databaseName FROM PUBLIC; GRANT CONNECT ON DATABASE $databaseName TO dhumi_customer_api, dhumi_identity, dhumi_admission, dhumi_job_manager, dhumi_result_recorder, dhumi_outbox_dispatcher, dhumi_envelope_janitor, dhumi_operator;")
        Invoke-ProofPsql $databaseName @('--set', "target_database=$databaseName", '--set', 'owner_role=dhumi_owner',
            '--set', 'app_schema=app', '--file', '.\scripts\bootstrap\0003_prepare_app_schema.sql')
        & '.\scripts\migrate.ps1' -DatabaseUrl "postgresql://postgres@127.0.0.1:${Port}/$databaseName"
        Invoke-ProofPsql $databaseName @('--file', '.\tests\integration\0037_marketplace_sample_download_authorization.sql')
    }
    finally { Pop-Location }
}
finally {
    if ($started) {
        & pg_ctl -D $dataRoot -m fast -w stop
        if ($LASTEXITCODE -ne 0) { Write-Warning 'Disposable cluster shutdown failed; inspect the retained proof directory.' }
    }
    if ($null -eq $priorPgPassword) { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
    else { $env:PGPASSWORD = $priorPgPassword }
    if ($null -eq $priorPgService) { Remove-Item Env:PGSERVICE -ErrorAction SilentlyContinue }
    else { $env:PGSERVICE = $priorPgService }
    # Leave evidence recoverable inside ignored .runtime; never recursively
    # delete a computed directory or touch the existing local database service.
}
Write-Host 'PASS: all forward-only migrations and download-cleanup database assertions passed.'
Write-Host 'Existing dev/test databases were not touched. Bright Data calls: 0.'
