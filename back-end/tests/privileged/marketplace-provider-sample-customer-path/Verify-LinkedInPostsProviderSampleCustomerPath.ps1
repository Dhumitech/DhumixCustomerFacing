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
$driverLine = Get-Content -LiteralPath (Join-Path $backendRoot '.env') |
    Where-Object { $_ -match '^RUN_EXECUTOR_DRIVER=' } |
    Select-Object -First 1

if ($driverLine -ne 'RUN_EXECUTOR_DRIVER=controlled') {
    throw 'Fail-closed preflight: RUN_EXECUTOR_DRIVER must equal controlled.'
}

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
    throw 'Fail-closed preflight: Outbox Dispatcher or Job Manager is running.'
}

$apiConnection = Test-NetConnection -ComputerName 127.0.0.1 -Port 3000 -WarningAction SilentlyContinue
if (-not $apiConnection.TcpTestSucceeded) {
    throw 'Customer API is not listening on 127.0.0.1:3000.'
}

$securePassword = Read-Host 'PostgreSQL administrator password (held only by the verification child process)' -AsSecureString
$passwordPointer = [IntPtr]::Zero
$previousApiBaseUrl = $env:M3_CUSTOMER_API_BASE_URL
$previousCredentialFile = $env:M3_CUSTOMER_CREDENTIAL_FILE
$previousDatabaseName = $env:M3_CUSTOMER_DATABASE_NAME
$previousDatabasePassword = $env:M3_CUSTOMER_DATABASE_PASSWORD

Push-Location $backendRoot
try {
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $env:M3_CUSTOMER_DATABASE_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    $env:M3_CUSTOMER_API_BASE_URL = $ApiBaseUrl
    $env:M3_CUSTOMER_CREDENTIAL_FILE = $resolvedCredentialFile
    $env:M3_CUSTOMER_DATABASE_NAME = $DatabaseName

    Write-Host 'Running LinkedIn Posts provider-sample v3 customer-path verification.'
    Write-Host 'Expected sample version: 3'
    Write-Host 'Expected records/fields/masked fields: 5/37/11'
    Write-Host 'Provider-capable workers: 0'
    Write-Host 'Bright Data calls authorized: 0'

    & node --env-file-if-exists=.env --import tsx `
        '.\tests\privileged\marketplace-provider-sample-customer-path\linkedin-posts-provider-sample-customer-path.ts'
    if ($LASTEXITCODE -ne 0) {
        throw "LinkedIn Posts provider-sample customer-path verification failed with exit code $LASTEXITCODE."
    }
}
finally {
    if ($null -eq $previousApiBaseUrl) { Remove-Item Env:M3_CUSTOMER_API_BASE_URL -ErrorAction SilentlyContinue } else { $env:M3_CUSTOMER_API_BASE_URL = $previousApiBaseUrl }
    if ($null -eq $previousCredentialFile) { Remove-Item Env:M3_CUSTOMER_CREDENTIAL_FILE -ErrorAction SilentlyContinue } else { $env:M3_CUSTOMER_CREDENTIAL_FILE = $previousCredentialFile }
    if ($null -eq $previousDatabaseName) { Remove-Item Env:M3_CUSTOMER_DATABASE_NAME -ErrorAction SilentlyContinue } else { $env:M3_CUSTOMER_DATABASE_NAME = $previousDatabaseName }
    if ($null -eq $previousDatabasePassword) { Remove-Item Env:M3_CUSTOMER_DATABASE_PASSWORD -ErrorAction SilentlyContinue } else { $env:M3_CUSTOMER_DATABASE_PASSWORD = $previousDatabasePassword }
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
    Pop-Location
}
