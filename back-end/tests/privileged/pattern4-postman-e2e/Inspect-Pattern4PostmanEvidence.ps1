[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNull()]
    [guid] $RunId
)

$ErrorActionPreference = 'Stop'
$backendRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$inspectionPath = Join-Path $PSScriptRoot 'inspect-evidence.sql'

Push-Location $backendRoot
try {
    & psql `
        -h localhost `
        -p 5432 `
        -U postgres `
        -W `
        -d dhumi_dev `
        -v ON_ERROR_STOP=1 `
        -v "run_id=$RunId" `
        -f $inspectionPath

    if ($LASTEXITCODE -ne 0) {
        throw 'Pattern 4 Postman evidence inspection failed.'
    }
}
finally {
    Pop-Location
}
