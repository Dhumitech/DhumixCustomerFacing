<#
.SYNOPSIS
Validates an exact one-to-five-record M9 packet and defaults to a zero-call proof.

.DESCRIPTION
This wrapper refuses execution unless the frozen packet, current authorization,
pricing attestations, migration checksum and zero-use submission fence all
match. Bright Data documents records_limit but no maximum-cost request field,
so this wrapper cannot guarantee or reverse provider billing after a POST has
been accepted. Keep the packet unauthorized whenever the applicable account
rate or Snapshot cost currency is unverified.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$')]
    [string]$PacketId,

    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-fA-F]{64}$')]
    [string]$RequestFingerprint,

    [Parameter()]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$')]
    [string]$Actor = 'm9.strict.operator',

    [Parameter()]
    [string]$DatabaseUrl = 'postgresql://postgres@localhost:5432/dhumi_dev',

    [Parameter()]
    [ValidateSet('dhumi_test', 'dhumi_dev')]
    [string]$ExpectedDatabase = 'dhumi_dev',

    [Parameter(Mandatory)]
    [ValidateRange(1, 5)]
    [int]$ExpectedRecords,

    [Parameter(Mandatory)]
    [ValidateRange(0.000001, 1000000)]
    [decimal]$VerifiedOfficialRateUsdPerThousand,

    [Parameter(Mandatory)]
    [ValidateRange(0.000001, 1000000)]
    [decimal]$VerifiedAccountRateUsdPerThousand,

    [Parameter(Mandatory)]
    [datetimeoffset]$PricingEvidenceCheckedAt,

    [Parameter(Mandatory)]
    [ValidateSet('USD')]
    [string]$SnapshotCostCurrency,

    [Parameter()]
    [switch]$ExecuteAuthorizedPacket,

    [Parameter()]
    [decimal]$ConfirmMaximumEstimatedCostUsd = 0
)

$ErrorActionPreference = 'Stop'
$strictMaximumRecords = 5
$strictUnitCostMicros = 2500
$expectedPacketMaximumCostMicros = $ExpectedRecords * $strictUnitCostMicros
$expectedPacketMaximumCostUsd = [decimal]$expectedPacketMaximumCostMicros / [decimal]1000000
$expectedOfficialRateUsdPerThousand = [decimal]2.5
$maximumEvidenceAge = [timespan]::FromHours(24)
$officialRateSource = 'https://docs.brightdata.com/api-reference/marketplace-dataset-api/filter-dataset'
$requiredMigration = '0055_marketplace_qualification_execution'
$backendRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$environmentFile = Join-Path $backendRoot '.env'
$requiredMigrationFile = Join-Path $backendRoot "scripts\migrations\$requiredMigration.sql"

function Stop-FailClosed {
    param([Parameter(Mandatory)][string]$Reason)
    throw "FAIL CLOSED: $Reason No provider execution was started by this script."
}

if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    Stop-FailClosed 'psql was not found on PATH.'
}
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    Stop-FailClosed 'npm.cmd was not found on PATH.'
}
if (-not (Test-Path -LiteralPath $environmentFile)) {
    Stop-FailClosed '.env was not found.'
}
if (-not (Test-Path -LiteralPath $requiredMigrationFile)) {
    Stop-FailClosed "the required migration file $requiredMigration was not found."
}
$expectedMigrationChecksum = (
    Get-FileHash -LiteralPath $requiredMigrationFile -Algorithm SHA256
).Hash.ToLowerInvariant()

$executorAssignments = @(
    Get-Content -LiteralPath $environmentFile |
        Where-Object { $_ -match '^\s*RUN_EXECUTOR_DRIVER\s*=' }
)
if ($executorAssignments.Count -ne 1 -or
    $executorAssignments[0] -notmatch '^\s*RUN_EXECUTOR_DRIVER\s*=\s*controlled\s*$') {
    Stop-FailClosed '.env must contain exactly RUN_EXECUTOR_DRIVER=controlled.'
}

$now = [datetimeoffset]::UtcNow
if ($PricingEvidenceCheckedAt -gt $now.AddMinutes(5) -or
    ($now - $PricingEvidenceCheckedAt) -gt $maximumEvidenceAge) {
    Stop-FailClosed 'pricing evidence must be no more than 24 hours old and cannot be future-dated.'
}
if ($VerifiedOfficialRateUsdPerThousand -ne $expectedOfficialRateUsdPerThousand) {
    Stop-FailClosed "the verified official Filter rate differs from USD 2.50 per 1,000 records. Re-prepare and re-fingerprint the packet. Source: $officialRateSource"
}
if ($VerifiedAccountRateUsdPerThousand -gt $VerifiedOfficialRateUsdPerThousand) {
    Stop-FailClosed 'the applicable account/partnership rate exceeds the verified official rate.'
}
if ($SnapshotCostCurrency -ne 'USD') {
    Stop-FailClosed 'the Snapshot cost currency is not confirmed as USD.'
}

$effectiveRate = $VerifiedOfficialRateUsdPerThousand
$calculatedMaximumMicros = [decimal]::Ceiling(
    ($effectiveRate / [decimal]1000) *
    [decimal]$ExpectedRecords *
    [decimal]1000000
)
if ($calculatedMaximumMicros -ne [decimal]$expectedPacketMaximumCostMicros) {
    Stop-FailClosed "the calculated $ExpectedRecords-record maximum is $calculatedMaximumMicros USD micros, but the strict packet ceiling is $expectedPacketMaximumCostMicros."
}

try {
    $databaseUri = [uri]$DatabaseUrl
}
catch {
    Stop-FailClosed 'DatabaseUrl is not a valid URI.'
}
if ($databaseUri.Scheme -notin @('postgres', 'postgresql')) {
    Stop-FailClosed 'DatabaseUrl must use postgres or postgresql.'
}
if ($databaseUri.UserInfo -match ':') {
    Stop-FailClosed 'DatabaseUrl must not contain a password.'
}
$databaseFromUrl = [uri]::UnescapeDataString($databaseUri.AbsolutePath).TrimStart('/')
if ($databaseFromUrl -ne $ExpectedDatabase) {
    Stop-FailClosed "DatabaseUrl names '$databaseFromUrl', expected '$ExpectedDatabase'."
}

$passwordPointer = [IntPtr]::Zero
$plainPassword = $null
$previousPgPassword = $env:PGPASSWORD
$proofLine = $null

try {
    $securePassword = Read-Host 'PostgreSQL administrator password (held only by the proof child process)' -AsSecureString
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    $env:PGPASSWORD = $plainPassword

    $proof = & psql -X "--dbname=$DatabaseUrl" --no-password --quiet `
        --tuples-only --no-align --set=ON_ERROR_STOP=1 --command @"
SELECT concat_ws('|',
  current_database(),
  encode(packet.request_fingerprint, 'hex'),
  packet.authorization_state,
  coalesce(packet.exact_request->>'records_limit', ''),
  packet.maximum_estimated_cost_micros::text,
  packet.currency_code,
  packet.maximum_provider_submissions::text,
  packet.automatic_submission_retries::text,
  packet.poll_deadline_ms::text,
  packet.provider_submission_count::text,
  packet.execution_state,
  coalesce((packet.authorization_expires_at > clock_timestamp())::text, 'f'),
  coalesce((
    SELECT migration.checksum
    FROM app.schema_migrations AS migration
    WHERE migration.version = '$requiredMigration'
  ), '')
)
FROM app.marketplace_qualification_packets AS packet
WHERE packet.id = '$PacketId'::uuid;
"@
    if ($LASTEXITCODE -ne 0) {
        Stop-FailClosed 'the packet proof query failed.'
    }
    $proofLine = (($proof -join "`n").Trim())
}
finally {
    if ($null -eq $previousPgPassword) {
        Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
    }
    else {
        $env:PGPASSWORD = $previousPgPassword
    }
    $plainPassword = $null
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
}

if ([string]::IsNullOrWhiteSpace($proofLine)) {
    Stop-FailClosed "packet $PacketId was not found in $ExpectedDatabase."
}
$fields = $proofLine.Split('|')
if ($fields.Count -ne 13) {
    Stop-FailClosed 'the packet proof returned an unexpected shape.'
}

$actualDatabase = $fields[0]
$actualFingerprint = $fields[1]
$authorizationState = $fields[2]
$recordsLimit = $fields[3]
$maximumCostMicros = $fields[4]
$currencyCode = $fields[5]
$maximumSubmissions = $fields[6]
$automaticRetries = $fields[7]
$pollDeadlineMs = $fields[8]
$submissionCount = $fields[9]
$executionState = $fields[10]
$authorizationIsCurrent = $fields[11]
$migrationChecksum = $fields[12]
$parsedPollDeadline = 0
$pollDeadlineIsValid = [int]::TryParse($pollDeadlineMs, [ref]$parsedPollDeadline)

if ($actualDatabase -ne $ExpectedDatabase -or
    $actualFingerprint -ne $RequestFingerprint.ToLowerInvariant() -or
    $recordsLimit -ne "$ExpectedRecords" -or
    $maximumCostMicros -ne "$expectedPacketMaximumCostMicros" -or
    $currencyCode -ne 'USD' -or
    $maximumSubmissions -ne '1' -or
    $automaticRetries -ne '0' -or
    -not $pollDeadlineIsValid -or
    $parsedPollDeadline -lt 1 -or $parsedPollDeadline -gt 300000 -or
    $migrationChecksum -ne $expectedMigrationChecksum) {
    Stop-FailClosed "the persisted packet or migration does not match the strict $ExpectedRecords-record, $expectedPacketMaximumCostMicros-micro contract."
}

Write-Host '[PASS] Fresh pricing evidence - official rate USD 2.50/1,000 records'
Write-Host "[PASS] Account/partnership rate - USD $VerifiedAccountRateUsdPerThousand/1,000 records"
Write-Host "[PASS] Calculated maximum - $ExpectedRecords record(s), USD $expectedPacketMaximumCostUsd, $expectedPacketMaximumCostMicros USD micros"
Write-Host "[PASS] Packet fingerprint - $actualFingerprint"
Write-Host "[PASS] Packet persistence - state=$authorizationState; submissions=$submissionCount; execution=$executionState"

if (-not $ExecuteAuthorizedPacket) {
    Write-Host ''
    Write-Host 'CHECK ONLY: strict fail-closed proof passed.'
    Write-Host 'Bright Data calls made by this script: 0.'
    return
}

if ($ConfirmMaximumEstimatedCostUsd -ne $expectedPacketMaximumCostUsd) {
    Stop-FailClosed "execution requires -ConfirmMaximumEstimatedCostUsd $expectedPacketMaximumCostUsd."
}
if ($authorizationState -ne 'authorized' -or $authorizationIsCurrent -ne 'true') {
    Stop-FailClosed 'the exact packet is not currently authorized.'
}
if ($submissionCount -ne '0' -or $executionState -ne 'not_started') {
    Stop-FailClosed 'the packet has already been claimed, submitted or executed.'
}

$previousExecutorDriver = $env:RUN_EXECUTOR_DRIVER
try {
    $env:RUN_EXECUTOR_DRIVER = 'controlled'
    Push-Location $backendRoot
    try {
        & npm.cmd run operator:marketplace-qualification -- execute `
            --packet-id $PacketId `
            --request-fingerprint $($RequestFingerprint.ToLowerInvariant()) `
            --actor $Actor `
            --confirm-exact-authorized-packet
        if ($LASTEXITCODE -ne 0) {
            throw "Marketplace qualification operator exited with code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}
finally {
    if ($null -eq $previousExecutorDriver) {
        Remove-Item Env:RUN_EXECUTOR_DRIVER -ErrorAction SilentlyContinue
    }
    else {
        $env:RUN_EXECUTOR_DRIVER = $previousExecutorDriver
    }
}
