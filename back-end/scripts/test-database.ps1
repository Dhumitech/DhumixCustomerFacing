[CmdletBinding()]
param(
    [Parameter()]
    [string]$DatabaseUrl = $env:DATABASE_TEST_URL
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($DatabaseUrl)) {
    throw 'DATABASE_TEST_URL is required. It must identify an isolated disposable test database.'
}

if ($DatabaseUrl -match '(?i)://[^/@\s]+:[^/@\s]+@' -or
    $DatabaseUrl -match '(?i)(^|\s)password\s*=') {
    throw 'DATABASE_TEST_URL must not contain a password. Use the interactive prompt or an approved external secret mechanism.'
}

if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    throw 'psql was not found on PATH.'
}

$resolvedDatabase = & psql -X --dbname=$DatabaseUrl --tuples-only --no-align --quiet `
    --set=ON_ERROR_STOP=1 --command='SELECT current_database();'
if ($LASTEXITCODE -ne 0) {
    throw 'Could not verify the test database identity.'
}
if ($resolvedDatabase.Trim() -ne 'dhumi_test') {
    throw "Refusing to run database tests against '$($resolvedDatabase.Trim())'. Expected dhumi_test."
}

& (Join-Path $PSScriptRoot 'migrate.ps1') -DatabaseUrl $DatabaseUrl

$testDirectory = Join-Path (Split-Path $PSScriptRoot -Parent) 'tests\integration'
$tests = Get-ChildItem -LiteralPath $testDirectory -Filter '*.sql' | Sort-Object Name
foreach ($test in $tests) {
    Write-Host "Running database test $($test.Name)"
    $testPath = $test.FullName
    & psql -X --dbname=$DatabaseUrl --set=ON_ERROR_STOP=1 "--file=$testPath"
    if ($LASTEXITCODE -ne 0) {
        throw "Database test failed: $($test.Name)"
    }
}
