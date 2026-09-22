[CmdletBinding()]
param(
    [switch]$AcceptEula,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

if (-not $AcceptEula) {
    throw 'Pattern 4 local infrastructure requires explicit EULA acceptance. Re-run with -AcceptEula after accepting the SQL Server and Azure Service Bus emulator terms.'
}

$backendRoot = Split-Path -Parent $PSScriptRoot
$environmentPath = Join-Path $backendRoot '.env.pattern4'

Push-Location $backendRoot
try {
    & git check-ignore --quiet -- '.env.pattern4'
    if ($LASTEXITCODE -ne 0) {
        throw '.env.pattern4 is not ignored by Git. Refusing to write a local infrastructure password.'
    }
}
finally {
    Pop-Location
}

if ((Test-Path -LiteralPath $environmentPath) -and -not $Force) {
    throw '.env.pattern4 already exists. Use -Force only when intentionally rotating the local SQL Server password.'
}

$randomBytes = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($randomBytes)
$randomSuffix = [Convert]::ToBase64String($randomBytes).TrimEnd('=').Replace('+', '_').Replace('/', '-')
$sqlPassword = "Dh9!$randomSuffix"

if ($sqlPassword.Length -lt 16 -or
    $sqlPassword -cnotmatch '[A-Z]' -or
    $sqlPassword -cnotmatch '[a-z]' -or
    $sqlPassword -notmatch '[0-9]' -or
    $sqlPassword -notmatch '[^A-Za-z0-9]') {
    throw 'Generated SQL Server password did not satisfy the required complexity policy.'
}

$content = @(
    'PATTERN4_ACCEPT_EULA=Y'
    "PATTERN4_MSSQL_SA_PASSWORD=$sqlPassword"
    'PATTERN4_REDIS_PORT=6380'
) -join "`n"

[System.IO.File]::WriteAllText(
    $environmentPath,
    "$content`n",
    [System.Text.UTF8Encoding]::new($false)
)

$writtenLines = [System.IO.File]::ReadAllLines($environmentPath)
if ($writtenLines.Count -ne 3 -or
    $writtenLines[0] -ne 'PATTERN4_ACCEPT_EULA=Y' -or
    $writtenLines[2] -ne 'PATTERN4_REDIS_PORT=6380' -or
    $writtenLines[1] -notmatch '^PATTERN4_MSSQL_SA_PASSWORD=.+$') {
    throw 'The Pattern 4 environment file failed post-write validation.'
}

Write-Host 'Created the ignored .env.pattern4 file securely. The generated SQL Server password was not printed.'
