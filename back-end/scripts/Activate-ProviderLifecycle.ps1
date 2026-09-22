[CmdletBinding()]
param(
    # Password-free privileged local PostgreSQL connection string.
    # Inspection requires visibility across tenants (for example local postgres).
    [Parameter(Mandatory)][string]$DatabaseUrl,
    [Parameter(Mandatory)][string]$ExpectedDatabase,
    [guid]$RunId = [guid]::Empty,
    # Explicitly authorizes existing queued work to execute, potentially billed.
    [switch]$ResumeBillableWork
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$backendRoot = Split-Path -Parent $PSScriptRoot
$targetVersion = '0044_provider_poll_checkpoint'

function Assert-StackStopped {
    $processes = @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq 'node.exe' -and $_.CommandLine -match
        '(?i)(src|dist)[\\/](server\.(ts|js)|worker[\\/](jobManager|outboxDispatcher)\.(ts|js))'
    })
    if ($processes.Count -gt 0) {
        $ids = ($processes.ProcessId -join ', ')
        throw "Backend processes are still running (PIDs: $ids). Stop their launchers gracefully and wait for shutdown, then rerun. No process was killed."
    }
}

function Read-Database([string]$Sql) {
    $result = & psql -X --dbname=$DatabaseUrl --no-password --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 --command $Sql
    if ($LASTEXITCODE -ne 0) { throw 'Database inspection failed; activation stopped.' }
    return ($result -join "`n").Trim()
}

if ($DatabaseUrl -match '(?i)://[^/@\s]+:[^/@\s]+@' -or $DatabaseUrl -match '(?i)(^|\s)password\s*=') {
    throw 'Use a password-free DatabaseUrl; the script prompts securely.'
}
foreach ($command in @('psql', 'node', 'npm.cmd')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "$command is required on PATH." }
}
Assert-StackStopped
if (-not (Test-Path -LiteralPath (Join-Path $backendRoot '.env'))) { throw 'Backend .env is missing.' }
$migrations = @(Get-ChildItem (Join-Path $PSScriptRoot 'migrations') -Filter '*.sql' | Sort-Object Name)
if ($migrations[-1].BaseName -ne $targetVersion) { throw 'Migration set changed; review this rollout script before proceeding.' }

$previousPassword = $env:PGPASSWORD
$pointer = [IntPtr]::Zero
Push-Location $backendRoot
try {
    $secret = Read-Host 'Local PostgreSQL privileged password' -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $actualDatabase = Read-Database 'SELECT current_database();'
    if ($actualDatabase -ne $ExpectedDatabase) { throw "Database mismatch: connected to $actualDatabase." }

    # Fail rather than silently hiding tenant rows under RLS. No Run mutations.
    Write-Host 'Pending Runs (local privileged, read-only inspection):'
    Write-Host (Read-Database @'
BEGIN READ ONLY;
SET LOCAL row_security = off;
SELECT id, tenant_id, public_status, internal_status, accepted_at, next_action_at
FROM app.runs WHERE public_status IN ('queued', 'running') ORDER BY accepted_at;
COMMIT;
'@)
    if ($RunId -ne [guid]::Empty) {
        $runLiteral = $RunId.ToString()
        Write-Host 'Affected Run and Attempts (no provider credentials or reference bytes):'
        Write-Host (Read-Database @"
BEGIN READ ONLY;
SET LOCAL row_security = off;
SELECT id, public_status, internal_status, customer_error_code, retryable, updated_at
FROM app.runs WHERE id = '$runLiteral'::uuid;
SELECT id, kind, state, outcome_class, started_at, finished_at,
       worker_lease_expires_at, provider_reference_ciphertext IS NOT NULL AS has_provider_reference
FROM app.run_attempts WHERE run_id = '$runLiteral'::uuid ORDER BY started_at;
COMMIT;
"@)
    }

    # The runner applies every pending migration. Require all predecessors to
    # exist with their current checksum, so this rollout can apply only 0044.
    foreach ($migration in $migrations) {
        $version = $migration.BaseName
        if ($version -notmatch '^[A-Za-z0-9_.-]+$') { throw 'Invalid migration filename.' }
        $checksum = (Get-FileHash $migration.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        $recorded = Read-Database "SELECT checksum FROM app.schema_migrations WHERE version = '$version';"
        if ($recorded -eq '' -and $version -eq $targetVersion) { continue }
        if ($recorded -ne $checksum) { throw "Missing or mismatched migration: $version. Review before activation." }
    }
    Assert-StackStopped
    & (Join-Path $PSScriptRoot 'migrate.ps1') -DatabaseUrl $DatabaseUrl
    $expectedHash = (Get-FileHash (Join-Path $PSScriptRoot "migrations/$targetVersion.sql") -Algorithm SHA256).Hash.ToLowerInvariant()
    $appliedHash = Read-Database "SELECT checksum FROM app.schema_migrations WHERE version = '$targetVersion';"
    if ($appliedHash -ne $expectedHash) { throw '0044 verification failed.' }
    Write-Host 'Migration 0044 verified. No provider call was made by this script so far.'
}
finally {
    $env:PGPASSWORD = $previousPassword
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    Pop-Location
}

if (-not $ResumeBillableWork) {
    Write-Host 'Worker remains stopped. Review pending Runs and the affected Run before resuming.'
    Write-Host 'Rerun with -ResumeBillableWork when existing queue execution is authorized.'
    return
}

Assert-StackStopped
Push-Location $backendRoot
try {
    # Use the repository startup command, loading the existing .env unchanged.
    # Foreground execution keeps shutdown/logs visible; Ctrl+C requests drain.
    Write-Host 'Starting Job Manager. Existing queued work may now incur provider charges.'
    & npm.cmd run worker:jobs
    if ($LASTEXITCODE -ne 0) { throw 'Job Manager exited with an error; inspect its logs.' }
}
finally { Pop-Location }
