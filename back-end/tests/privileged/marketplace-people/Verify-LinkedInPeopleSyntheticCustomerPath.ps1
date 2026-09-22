[CmdletBinding()]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$ApiBaseUrl = 'http://127.0.0.1:3000',

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$CredentialFile = '..\Checkpoints\Amazon Scrapper\Amazon\LoginCred.md',

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$DatabaseName = 'dhumi_dev'
)

$ErrorActionPreference = 'Stop'
$backendRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).Path
$resolvedCredentialFile = (Resolve-Path -LiteralPath (Join-Path $backendRoot $CredentialFile)).Path
$driverAssignments = @(
    Get-Content -LiteralPath (Join-Path $backendRoot '.env') |
        Where-Object { $_ -match '^\s*RUN_EXECUTOR_DRIVER\s*=' }
)

if ($driverAssignments.Count -ne 1 -or $driverAssignments[0] -ne 'RUN_EXECUTOR_DRIVER=controlled') {
    throw 'Fail-closed preflight: exactly RUN_EXECUTOR_DRIVER=controlled is required.'
}

$actualWorkers = @(
    Get-CimInstance Win32_Process |
        Where-Object {
            $_.Name -eq 'node.exe' -and
            $_.CommandLine -match '(?i)src[\\/]worker[\\/](jobManager|outboxDispatcher)\.ts'
        }
)
if ($actualWorkers.Count -gt 0) {
    $actualWorkers | Select-Object ProcessId, CommandLine | Format-Table -AutoSize
    throw 'Fail-closed preflight: Outbox Dispatcher or Job Manager is running.'
}

$apiConnection = Test-NetConnection -ComputerName 127.0.0.1 -Port 3000 -WarningAction SilentlyContinue
if (-not $apiConnection.TcpTestSucceeded) {
    throw 'Customer API is not listening on 127.0.0.1:3000.'
}

$securePassword = Read-Host 'PostgreSQL administrator password (held only by the verification child process)' -AsSecureString
$passwordPointer = [IntPtr]::Zero
$environmentNames = @(
    'M3_CUSTOMER_API_BASE_URL',
    'M3_CUSTOMER_CREDENTIAL_FILE',
    'M3_CUSTOMER_DATABASE_NAME',
    'M3_CUSTOMER_DATABASE_PASSWORD',
    'MARKETPLACE_SAMPLE_TEMPLATE_SLUG',
    'MARKETPLACE_SAMPLE_TEMPLATE_VERSION',
    'MARKETPLACE_SAMPLE_VERSION',
    'MARKETPLACE_SAMPLE_RECORD_COUNT',
    'MARKETPLACE_SAMPLE_FIELD_COUNT',
    'MARKETPLACE_SAMPLE_MASKED_FIELD_COUNT',
    'MARKETPLACE_SAMPLE_VERIFICATION_LABEL'
)
$previousValues = @{}
foreach ($name in $environmentNames) {
    $previousValues[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

Push-Location $backendRoot
try {
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $env:M3_CUSTOMER_DATABASE_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    $env:M3_CUSTOMER_API_BASE_URL = $ApiBaseUrl
    $env:M3_CUSTOMER_CREDENTIAL_FILE = $resolvedCredentialFile
    $env:M3_CUSTOMER_DATABASE_NAME = $DatabaseName
    $env:MARKETPLACE_SAMPLE_TEMPLATE_SLUG = 'linkedin-people'
    $env:MARKETPLACE_SAMPLE_TEMPLATE_VERSION = '1'
    $env:MARKETPLACE_SAMPLE_VERSION = '1'
    $env:MARKETPLACE_SAMPLE_RECORD_COUNT = '5'
    $env:MARKETPLACE_SAMPLE_FIELD_COUNT = '42'
    $env:MARKETPLACE_SAMPLE_MASKED_FIELD_COUNT = '12'
    $env:MARKETPLACE_SAMPLE_VERIFICATION_LABEL = 'LinkedIn People synthetic sample'

    Write-Host 'Running LinkedIn People synthetic-sample v1 customer-path verification.'
    Write-Host 'Expected provider metadata/sample fields: 46/42'
    Write-Host 'Expected records/masked fields: 5/12'
    Write-Host 'Provider-capable workers: 0'
    Write-Host 'Bright Data calls authorized: 0'

    & node --env-file-if-exists=.env --import tsx `
        '.\tests\privileged\marketplace-provider-sample-customer-path\linkedin-posts-provider-sample-customer-path.ts'
    if ($LASTEXITCODE -ne 0) {
        throw "LinkedIn People synthetic-sample customer-path verification failed with exit code $LASTEXITCODE."
    }
}
finally {
    foreach ($name in $environmentNames) {
        $previousValue = $previousValues[$name]
        if ($null -eq $previousValue) {
            Remove-Item "Env:$name" -ErrorAction SilentlyContinue
        }
        else {
            [Environment]::SetEnvironmentVariable($name, $previousValue, 'Process')
        }
    }
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
    Pop-Location
}
