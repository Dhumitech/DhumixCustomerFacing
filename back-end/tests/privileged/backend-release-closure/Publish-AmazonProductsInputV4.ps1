[CmdletBinding()]
param(
    [Parameter()]
    [ValidateSet('Test', 'Dev')]
    [string]$Target = 'Dev',

    [Parameter()]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$')]
    [string]$Reviewer = 'project.owner.local'
)

$ErrorActionPreference = 'Stop'
$backendRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$migrationPath = Join-Path $backendRoot 'scripts\migrations\0043_amazon_products_input_contract_v4.sql'
$environmentFile = if ($Target -eq 'Test') { '.env.test' } else { '.env' }
$expectedDatabase = if ($Target -eq 'Test') { 'dhumi_test' } else { 'dhumi_dev' }
$expectedNodeEnvironment = if ($Target -eq 'Test') { 'test' } else { 'development' }
$previousConfirmation = $env:AMAZON_RELEASE_CONFIRMATION

function Read-EnvironmentValue {
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [Parameter(Mandatory)]
        [string]$Name
    )

    $line = Get-Content -LiteralPath $Path | Where-Object {
        $_ -match "^$([Regex]::Escape($Name))="
    } | Select-Object -Last 1
    if ($null -eq $line) {
        throw "$Name is missing from $Path."
    }
    return ($line -split '=', 2)[1].Trim()
}

Push-Location $backendRoot
try {
    if (-not (Test-Path -LiteralPath $environmentFile)) {
        throw "$environmentFile was not found."
    }
    if ((Read-EnvironmentValue -Path $environmentFile -Name 'DATABASE_NAME') -ne $expectedDatabase) {
        throw "$environmentFile does not target $expectedDatabase."
    }
    if ((Read-EnvironmentValue -Path $environmentFile -Name 'NODE_ENV') -ne $expectedNodeEnvironment) {
        throw "$environmentFile does not use NODE_ENV=$expectedNodeEnvironment."
    }
    if ((Read-EnvironmentValue -Path $environmentFile -Name 'DATABASE_OPERATOR_USER') -notmatch '^dhumi_[a-z0-9_]+_operator_login$') {
        throw "$environmentFile does not contain the restricted operator LOGIN."
    }

    $evidenceHash = (Get-FileHash -LiteralPath $migrationPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $env:AMAZON_RELEASE_CONFIRMATION = 'I_UNDERSTAND_THIS_PUBLISHES_ONE_CUSTOMER_OPERATION'

    Write-Host "Publishing the offline Amazon products input contract v4 to $expectedDatabase."
    Write-Host 'Bright Data calls: 0'
    & node "--env-file=$environmentFile" --import tsx `
        src/worker/amazonOperationRelease.ts upgrade-input-v4 `
        --confirm-publish `
        --evidence-reference 'restricted://repository/scripts/migrations/0043-amazon-products-input-contract-v4' `
        --evidence-hash $evidenceHash `
        --reviewer $Reviewer `
        --reason 'amazon_products_input_v4_approved'
    if ($LASTEXITCODE -ne 0) {
        throw "Amazon products input-contract v4 publication failed for $expectedDatabase."
    }
}
finally {
    if ($null -eq $previousConfirmation) {
        Remove-Item Env:AMAZON_RELEASE_CONFIRMATION -ErrorAction SilentlyContinue
    }
    else {
        $env:AMAZON_RELEASE_CONFIRMATION = $previousConfirmation
    }
    Pop-Location
}

Write-Host "Amazon products input-contract v4 is active on $expectedDatabase."
