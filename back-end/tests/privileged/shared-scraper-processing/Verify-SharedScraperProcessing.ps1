[CmdletBinding()]
param(
    [int]$Port = 54390,
    [string]$PostgreSqlBin = (Split-Path (Get-Command psql.exe -ErrorAction Stop).Source)
)
$ErrorActionPreference = 'Stop'
if ($Port -lt 1024 -or $Port -gt 65535 -or $Port -in 3000, 5173, 5432, 5672, 6380, 10000) {
    throw 'Use an unused non-operational port for the disposable PostgreSQL instance.'
}
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $Port already has a listener. No existing service will be stopped."
}
$taskRoot = Join-Path ([IO.Path]::GetTempPath()) ('dhumi-shared-scraper-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskRoot | Out-Null
$dataPath = Join-Path $taskRoot 'data'
$psql = Join-Path $PostgreSqlBin 'psql.exe'
$initdb = Join-Path $PostgreSqlBin 'initdb.exe'
$pgCtl = Join-Path $PostgreSqlBin 'pg_ctl.exe'
$backendRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$databaseName = 'dhumi_shared_scraper_verification'
$adminUrl = "postgresql://dhumi_disposable_admin@127.0.0.1:$Port/postgres"
$databaseUrl = "postgresql://dhumi_disposable_admin@127.0.0.1:$Port/$databaseName"
$started = $false
try {
    Write-Host "Disposable PostgreSQL proof only. Port: $Port. Provider calls: 0."
    Write-Host 'Temporary trust authentication is confined to this new loopback-only, synthetic test cluster.'
    & $initdb -D $dataPath -U dhumi_disposable_admin --auth=trust --encoding=UTF8 --locale-provider=builtin --builtin-locale=PG_UNICODE_FAST --data-checksums
    if ($LASTEXITCODE -ne 0) { throw 'Disposable PostgreSQL initialization failed.' }
    & $pgCtl -D $dataPath -l (Join-Path $taskRoot 'postgres.log') -o "-p $Port -h localhost" -w -t 30 start
    if ($LASTEXITCODE -ne 0) { throw 'Disposable PostgreSQL startup failed.' }
    $started = $true
    & $psql -X --dbname=$adminUrl --no-password --set=ON_ERROR_STOP=1 --command 'CREATE ROLE dhumi_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;'
    if ($LASTEXITCODE -ne 0) { throw 'Disposable owner bootstrap failed.' }
    & $psql -X --dbname=$adminUrl --no-password --set=ON_ERROR_STOP=1 --file (Join-Path $backendRoot 'scripts\bootstrap\0001_cluster_roles.sql')
    if ($LASTEXITCODE -ne 0) { throw 'Disposable capability bootstrap failed.' }
    & $psql -X --dbname=$adminUrl --no-password --set=ON_ERROR_STOP=1 --set=target_database=$databaseName --set=owner_role=dhumi_owner --file (Join-Path $backendRoot 'scripts\bootstrap\0002_create_database.sql')
    if ($LASTEXITCODE -ne 0) { throw 'Disposable database bootstrap failed.' }
    & $psql -X --dbname=$databaseUrl --no-password --set=ON_ERROR_STOP=1 --set=target_database=$databaseName --set=owner_role=dhumi_owner --set=app_schema=app --file (Join-Path $backendRoot 'scripts\bootstrap\0003_prepare_app_schema.sql')
    if ($LASTEXITCODE -ne 0) { throw 'Disposable schema bootstrap failed.' }
    & (Join-Path $backendRoot 'scripts\migrate.ps1') -DatabaseUrl $databaseUrl
    & $psql -X --dbname=$databaseUrl --no-password --pset=pager=off --set=ON_ERROR_STOP=1 --file (Join-Path $backendRoot 'tests\integration\0046_shared_scraper_processing.sql')
    if ($LASTEXITCODE -ne 0) { throw 'Shared scraper database proof failed.' }
    & $psql -X --dbname=$databaseUrl --no-password --pset=pager=off --set=ON_ERROR_STOP=1 --file (Join-Path $backendRoot 'tests\integration\0047_shared_scraper_draft_registration.sql')
    if ($LASTEXITCODE -ne 0) { throw 'Shared scraper draft registration proof failed.' }
    Write-Host '[PASS] Fresh bootstrap, all forward migrations, guarded readers and private draft registration.'
    Write-Host 'Operational databases, workers and provider credentials were not used. Bright Data calls: 0.'
}
finally {
    # Exact newly created cluster only. No operational database/port is stopped.
    if ($started -or (Test-Path -LiteralPath (Join-Path $dataPath 'postmaster.pid'))) {
        & $pgCtl -D $dataPath -m fast -w -t 30 stop
        if ($LASTEXITCODE -ne 0) { Write-Warning "Could not stop disposable cluster at $dataPath. Inspect it before retrying." }
    }
    Write-Host "Stopped test-cluster evidence retained at: $taskRoot"
}
