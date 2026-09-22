<#
.SYNOPSIS
    Removes accumulated test identities from dhumi_test.

.DESCRIPTION
    The integration suite creates a fresh random identity per case, so it grows
    dhumi_test by roughly nine identities per run. Those rows cannot be removed
    by the application: dhumi_identity holds no DELETE grant on any table, by
    design. This script therefore runs as an administrative principal.

    It refuses to run against any database other than dhumi_test, and deletes
    only rows whose email matches a known test prefix.

.PARAMETER PsqlPath
    Path to psql.exe. Defaults to the PostgreSQL 18 install location.

.PARAMETER Principal
    Administrative role with DELETE on the app schema, typically the migration
    principal. You will be prompted for its password.

.EXAMPLE
    .\scripts\smoke\Reset-TestData.ps1 -Principal postgres
#>
[CmdletBinding()]
param(
    [string]$PsqlPath = 'C:\Program Files\PostgreSQL\18\bin\psql.exe',
    [Parameter(Mandatory = $true)][string]$Principal
)

$ErrorActionPreference = 'Stop'
$backEnd = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$sql = Join-Path $PSScriptRoot 'reset-test-data.sql'

if (-not (Test-Path $PsqlPath)) {
    throw "psql not found at $PsqlPath. Pass -PsqlPath."
}

Write-Host 'Removing test identities from dhumi_test.'
Write-Host 'Runtime fixtures (runtime-tenant-*) are kept: they replay by design.'
Write-Host ''

& $PsqlPath -X -W --host=localhost --port=5432 --username=$Principal `
    --dbname=dhumi_test --set=ON_ERROR_STOP=on --file=$sql

if ($LASTEXITCODE -ne 0) {
    throw "Reset failed with exit code $LASTEXITCODE."
}

Write-Host ''
Write-Host 'Done. Re-run the database audit if you need a fresh baseline.'
