[CmdletBinding()]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$ApiBaseUrl = 'http://127.0.0.1:3000',

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$FrontendUrl = 'http://localhost:5173',

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$CredentialFile = '..\Checkpoints\Amazon Scrapper\Amazon\LoginCred.md',

    [Parameter()]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string]$EvidenceRunId = '58592829-9700-4d09-b97e-d9e89ba776fc'
)

$ErrorActionPreference = 'Stop'
$backendRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).Path
$resolvedCredentialFile = (Resolve-Path -LiteralPath (Join-Path $backendRoot $CredentialFile)).Path

$actualWorkers = @(
    Get-CimInstance Win32_Process |
        Where-Object {
            $_.Name -eq 'node.exe' -and
            $_.CommandLine -match '(?i)src[\\/]worker[\\/](jobManager|outboxDispatcher)\.ts'
        }
)

if ($actualWorkers.Count -gt 0) {
    $actualWorkers |
        Select-Object ProcessId, CommandLine |
        Format-Table -AutoSize

    throw 'R4 zero-provider-call preflight failed: Outbox Dispatcher or Job Manager is running.'
}

Push-Location $backendRoot
$previousApiBaseUrl = $env:R4_API_BASE_URL
$previousFrontendUrl = $env:R4_FRONTEND_URL
$previousCredentialFile = $env:R4_CREDENTIAL_FILE
$previousRunId = $env:R4_RUN_ID

try {
    $env:R4_API_BASE_URL = $ApiBaseUrl
    $env:R4_FRONTEND_URL = $FrontendUrl
    $env:R4_CREDENTIAL_FILE = $resolvedCredentialFile
    $env:R4_RUN_ID = $EvidenceRunId

    Write-Host 'Running R4 no-mock customer-flow regression.'
    Write-Host 'Provider-capable worker processes: 0'
    Write-Host 'Run creation, cancellation and retry requests: disabled by this suite'
    Write-Host 'Bright Data calls authorized by this suite: 0'

    & node --env-file-if-exists=.env --import tsx '.\tests\privileged\r4-customer-flow\r4-customer-flow.ts'
    if ($LASTEXITCODE -ne 0) {
        throw "R4 customer-flow regression failed with exit code $LASTEXITCODE."
    }
}
finally {
    if ($null -eq $previousApiBaseUrl) { Remove-Item Env:R4_API_BASE_URL -ErrorAction SilentlyContinue } else { $env:R4_API_BASE_URL = $previousApiBaseUrl }
    if ($null -eq $previousFrontendUrl) { Remove-Item Env:R4_FRONTEND_URL -ErrorAction SilentlyContinue } else { $env:R4_FRONTEND_URL = $previousFrontendUrl }
    if ($null -eq $previousCredentialFile) { Remove-Item Env:R4_CREDENTIAL_FILE -ErrorAction SilentlyContinue } else { $env:R4_CREDENTIAL_FILE = $previousCredentialFile }
    if ($null -eq $previousRunId) { Remove-Item Env:R4_RUN_ID -ErrorAction SilentlyContinue } else { $env:R4_RUN_ID = $previousRunId }
    Pop-Location
}
