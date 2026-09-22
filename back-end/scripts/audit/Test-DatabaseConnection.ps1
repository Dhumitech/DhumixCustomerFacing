[CmdletBinding()]
param(
    [Parameter()]
    [string]$PsqlPath,

    [Parameter()]
    [string]$ServerHost = 'localhost',

    [Parameter()]
    [ValidateRange(1, 65535)]
    [int]$Port = 5432,

    [Parameter()]
    [string]$DatabaseName = 'dhumi_dev',

    [Parameter()]
    [string]$UserName = 'postgres'
)

$ErrorActionPreference = 'Stop'

function Resolve-PsqlPath {
    param([string]$RequestedPath)

    if (-not [string]::IsNullOrWhiteSpace($RequestedPath)) {
        if (-not (Test-Path -LiteralPath $RequestedPath -PathType Leaf)) {
            throw "psql was not found at: $RequestedPath"
        }
        return (Resolve-Path -LiteralPath $RequestedPath).Path
    }

    $command = Get-Command psql -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $candidates = Get-ChildItem -LiteralPath 'C:\Program Files\PostgreSQL' -Directory -ErrorAction SilentlyContinue |
        Sort-Object { [version]$_.Name } -Descending |
        ForEach-Object { Join-Path $_.FullName 'bin\psql.exe' }
    $candidate = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if ($candidate) {
        return $candidate
    }

    throw 'psql was not found. Pass -PsqlPath or install the PostgreSQL client.'
}

foreach ($value in @($ServerHost, $DatabaseName, $UserName)) {
    if ([string]::IsNullOrWhiteSpace($value) -or $value -match "[\r\n]") {
        throw 'Connection values must be non-empty single-line strings.'
    }
}

$psql = Resolve-PsqlPath -RequestedPath $PsqlPath
$sql = @'
SELECT
  current_database() AS database_name,
  current_user AS connected_user,
  current_setting('server_version') AS server_version,
  COALESCE(inet_server_addr()::text, 'local-socket') AS server_address,
  inet_server_port() AS server_port,
  pg_is_in_recovery() AS is_replica,
  current_setting('transaction_read_only') AS transaction_read_only;
'@

Write-Host "Connecting read-only check to $DatabaseName on ${ServerHost}:$Port as $UserName"
Write-Host "psql: $psql"

$arguments = @(
    # Keep the CSV header: ConvertFrom-Csv needs the column names below.
    '-X', '-W', '--csv', '--quiet',
    "--host=$ServerHost", "--port=$Port", "--username=$UserName", "--dbname=$DatabaseName",
    '--set=ON_ERROR_STOP=1', "--command=$sql"
)

$output = & $psql @arguments
if ($LASTEXITCODE -ne 0) {
    throw "Database connection failed with psql exit code $LASTEXITCODE."
}

$rows = @($output | ConvertFrom-Csv)
if ($rows.Count -ne 1) {
    throw 'The connection check did not return exactly one server identity row.'
}
if ('database_name' -notin $rows[0].PSObject.Properties.Name) {
    throw 'The connection CSV did not contain its expected header. No result was accepted.'
}

$rows[0] | Format-List
Write-Host 'PASS: database connection succeeded. No database object or row was changed.' -ForegroundColor Green
