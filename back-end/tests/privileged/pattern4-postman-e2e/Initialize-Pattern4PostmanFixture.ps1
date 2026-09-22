[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$backendRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$seedPath = Join-Path $PSScriptRoot 'seed-local-fixture.sql'

Push-Location $backendRoot
try {
    & psql `
        -h localhost `
        -p 5432 `
        -U postgres `
        -W `
        -d dhumi_dev `
        -v ON_ERROR_STOP=1 `
        -f $seedPath

    if ($LASTEXITCODE -ne 0) {
        throw 'Pattern 4 local Postman fixture setup failed.'
    }

    Write-Host 'Pattern 4 local Template is published and ready for the Postman folder.'
}
finally {
    Pop-Location
}
