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
    [string]$UserName = 'postgres',

    [Parameter()]
    [string]$ExpectedOwner = 'dhumi_owner',

    [Parameter()]
    [string]$ExpectedSchema = 'app',

    [Parameter()]
    [string]$MigrationDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent) 'migrations'),

    [Parameter()]
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'output'),

    [Parameter()]
    [switch]$FailOnWarning
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

foreach ($pair in @{
    ServerHost = $ServerHost
    DatabaseName = $DatabaseName
    UserName = $UserName
    ExpectedOwner = $ExpectedOwner
    ExpectedSchema = $ExpectedSchema
}.GetEnumerator()) {
    if ([string]::IsNullOrWhiteSpace($pair.Value) -or $pair.Value -notmatch '^[A-Za-z0-9_.:-]+$') {
        throw "$($pair.Key) contains an unsupported value."
    }
}

if ($DatabaseName -in @('postgres', 'template0', 'template1')) {
    throw 'Audit an application database such as dhumi_dev or dhumi_test, not an administrative/template database.'
}
if (-not (Test-Path -LiteralPath $MigrationDirectory -PathType Container)) {
    throw "Migration directory was not found: $MigrationDirectory"
}

$psql = Resolve-PsqlPath -RequestedPath $PsqlPath
$sqlPath = Join-Path $PSScriptRoot 'database-readonly-audit.sql'
if (-not (Test-Path -LiteralPath $sqlPath -PathType Leaf)) {
    throw "Audit SQL file was not found: $sqlPath"
}

Write-Host "Running read-only audit against $DatabaseName on ${ServerHost}:$Port"
Write-Host "psql: $psql"

$arguments = @(
    # Keep the CSV header: ConvertFrom-Csv needs record_type/category/etc.
    '-X', '-W', '--csv', '--quiet',
    "--host=$ServerHost", "--port=$Port", "--username=$UserName", "--dbname=$DatabaseName",
    '--set=ON_ERROR_STOP=1',
    "--set=expected_database=$DatabaseName",
    "--set=expected_owner=$ExpectedOwner",
    "--set=expected_schema=$ExpectedSchema",
    "--file=$sqlPath"
)

$rawOutput = & $psql @arguments
if ($LASTEXITCODE -ne 0) {
    throw "The database audit SQL failed with psql exit code $LASTEXITCODE."
}

$records = @($rawOutput | ConvertFrom-Csv)
if ($records.Count -eq 0) {
    throw 'The database audit returned no rows.'
}
$requiredColumns = @('record_type', 'category', 'record_name', 'status', 'details')
$actualColumns = @($records[0].PSObject.Properties.Name)
$missingColumns = @($requiredColumns | Where-Object { $_ -notin $actualColumns })
if ($missingColumns.Count -gt 0) {
    throw "The audit CSV header is invalid. Missing columns: $($missingColumns -join ', '). No result was accepted."
}

$results = [System.Collections.Generic.List[object]]::new()
foreach ($record in $records | Where-Object record_type -eq 'CHECK') {
    $results.Add([pscustomobject]@{
        Category = $record.category
        Check = $record.record_name
        Status = $record.status
        Details = $record.details
    })
}

$ledger = @($records | Where-Object record_type -eq 'MIGRATION')
$localMigrations = @(Get-ChildItem -LiteralPath $MigrationDirectory -Filter '*.sql' | Sort-Object Name)
foreach ($migration in $localMigrations) {
    $version = [IO.Path]::GetFileNameWithoutExtension($migration.Name)
    $localChecksum = (Get-FileHash -LiteralPath $migration.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $live = @($ledger | Where-Object record_name -eq $version)
    if ($live.Count -eq 0) {
        $results.Add([pscustomobject]@{
            Category = 'Migrations'; Check = $version; Status = 'FAIL'
            Details = 'Local migration has not been applied to the database.'
        })
    } elseif ($live.Count -gt 1) {
        $results.Add([pscustomobject]@{
            Category = 'Migrations'; Check = $version; Status = 'FAIL'
            Details = 'Migration ledger contains duplicate versions.'
        })
    } elseif ($live[0].details -ne $localChecksum) {
        $results.Add([pscustomobject]@{
            Category = 'Migrations'; Check = $version; Status = 'FAIL'
            Details = "Checksum mismatch. live=$($live[0].details); local=$localChecksum"
        })
    } else {
        $results.Add([pscustomobject]@{
            Category = 'Migrations'; Check = $version; Status = 'PASS'
            Details = $localChecksum
        })
    }
}

$localVersions = @($localMigrations | ForEach-Object { [IO.Path]::GetFileNameWithoutExtension($_.Name) })
foreach ($live in $ledger | Where-Object { $_.record_name -notin $localVersions }) {
    $results.Add([pscustomobject]@{
        Category = 'Migrations'; Check = $live.record_name; Status = 'FAIL'
        Details = 'Database ledger has a migration that is absent from the local source directory.'
    })
}

$sorted = @($results | Sort-Object Category, Check)
$sorted | Format-Table -AutoSize -Wrap

$passCount = @($sorted | Where-Object Status -eq 'PASS').Count
$warnCount = @($sorted | Where-Object Status -eq 'WARN').Count
$failCount = @($sorted | Where-Object Status -eq 'FAIL').Count
$infoCount = @($sorted | Where-Object Status -eq 'INFO').Count

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$baseName = "database-audit-$DatabaseName-$timestamp"
$csvPath = Join-Path $OutputDirectory "$baseName.csv"
$markdownPath = Join-Path $OutputDirectory "$baseName.md"
$sorted | Export-Csv -LiteralPath $csvPath -NoTypeInformation -Encoding utf8

$markdown = [System.Collections.Generic.List[string]]::new()
$markdown.Add("# Database Audit - $DatabaseName")
$markdown.Add('')
$markdown.Add("Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss K')")
$markdown.Add('')
$markdown.Add("Summary: PASS=$passCount, WARN=$warnCount, FAIL=$failCount, INFO=$infoCount")
$markdown.Add('')
$markdown.Add('| Category | Check | Status | Details |')
$markdown.Add('|---|---|---|---|')
foreach ($result in $sorted) {
    $category = ([string]$result.Category).Replace('|', '\|').Replace("`r", ' ').Replace("`n", ' ')
    $check = ([string]$result.Check).Replace('|', '\|').Replace("`r", ' ').Replace("`n", ' ')
    $status = ([string]$result.Status).Replace('|', '\|')
    $details = ([string]$result.Details).Replace('|', '\|').Replace("`r", ' ').Replace("`n", ' ')
    $markdown.Add("| $category | $check | $status | $details |")
}
$markdown | Set-Content -LiteralPath $markdownPath -Encoding utf8

Write-Host "`nAudit summary: PASS=$passCount WARN=$warnCount FAIL=$failCount INFO=$infoCount"
Write-Host "CSV report: $csvPath"
Write-Host "Markdown report: $markdownPath"

if ($failCount -gt 0) {
    Write-Host 'RESULT: NOT GREEN. Resolve FAIL items with a new forward-only migration and rerun.' -ForegroundColor Red
    exit 2
}
if ($FailOnWarning -and $warnCount -gt 0) {
    Write-Host 'RESULT: warnings are configured as failures.' -ForegroundColor Yellow
    exit 1
}

Write-Host 'RESULT: GREEN for the checks covered by this audit. Human semantic review is still required.' -ForegroundColor Green
