[CmdletBinding()]
param(
    [Parameter()]
    [string]$MigrationDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent) 'migrations'),

    [Parameter()]
    [string]$TestDirectory = (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'tests')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $MigrationDirectory -PathType Container)) {
    throw "Migration directory was not found: $MigrationDirectory"
}

$migrationFiles = @(Get-ChildItem -LiteralPath $MigrationDirectory -Filter '*.sql' | Sort-Object Name)
if ($migrationFiles.Count -eq 0) {
    throw "No migrations were found in: $MigrationDirectory"
}

$migrationText = ($migrationFiles | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw }) -join "`n"
$testText = if (Test-Path -LiteralPath $TestDirectory -PathType Container) {
    (Get-ChildItem -LiteralPath $TestDirectory -Recurse -File |
        Where-Object Extension -in @('.sql', '.ps1') |
        ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw }) -join "`n"
} else {
    ''
}

$results = [System.Collections.Generic.List[object]]::new()
function Add-Check {
    param(
        [string]$Category,
        [string]$Check,
        [bool]$Passed,
        [string]$PassDetail,
        [string]$FailDetail,
        [ValidateSet('FAIL', 'WARN')]
        [string]$FailureStatus = 'FAIL'
    )
    $results.Add([pscustomobject]@{
        Category = $Category
        Check = $Check
        Status = if ($Passed) { 'PASS' } else { $FailureStatus }
        Details = if ($Passed) { $PassDetail } else { $FailDetail }
    })
}

$forbiddenPattern = '(?i)\b(activation_keys?|subscriptions?|invoices?|payments?|credit_balances?|tenant_quotas?|remaining_quota|team_invites?|memberships?)\b'
Add-Check 'Scope' 'No superseded product tables or columns' ($migrationText -notmatch $forbiddenPattern) `
    'No activation, billing, quota, team, invite, or membership schema was found.' `
    'A superseded activation/billing/quota/team/invite/membership term exists in executable migrations.'

$familyPattern = "product_family\s+IN\s*\(\s*'marketplace_dataset'\s*,\s*'scraper_library'\s*\)"
Add-Check 'Scope' 'Only the two approved product families' ($migrationText -match $familyPattern) `
    'Marketplace Datasets and Scraper Library are the constrained product families.' `
    'The exact approved product-family constraint was not found.'

$runStateIsCorrected = $migrationText -match "(?is)(?:CREATE\s+TABLE\s+app\.runs\s*\([^;]+|ALTER\s+TABLE\s+app\.runs[^;]+)'UPSTREAM_FAILED'"
Add-Check 'Run lifecycle' 'Run CHECK accepts UPSTREAM_FAILED' $runStateIsCorrected `
    'The stored Run state constraint includes UPSTREAM_FAILED.' `
    'The transition graph uses UPSTREAM_FAILED, but the runs.internal_status CHECK does not allow it.'

Add-Check 'Immutability' 'Provider mappings are immutable after publication' `
    ($migrationText -match '(?is)CREATE\s+TRIGGER[^;]+ON\s+app\.provider_mappings[^;]+reject_version_mutation') `
    'Provider Mapping rows have a database immutability trigger.' `
    'Provider Mapping IDs are pinned by Runs, but the mapping row can still be updated in place.'

Add-Check 'Immutability' 'Run events are append-only' `
    ($migrationText -match '(?is)CREATE\s+TRIGGER[^;]+ON\s+app\.run_events[^;]+reject_version_mutation') `
    'Run event rows have a database append-only trigger.' `
    'run_events is specified as append-only, but no UPDATE/DELETE rejection trigger was found.'

$idempotencySchemaText = ([regex]::Matches(
    $migrationText,
    '(?is)(?:CREATE\s+TABLE|ALTER\s+TABLE)\s+app\.idempotency_records\b[^;]*;'
) | ForEach-Object Value) -join "`n"
$hasCiphertext = $idempotencySchemaText -match '(?i)(envelope|response).*cipher|cipher.*(envelope|response)'
$hasKeyReference = $idempotencySchemaText -match '(?i)(kms|key).*reference|reference.*(kms|key)'
$hasRecoveryTime = $idempotencySchemaText -match '(?i)recoverable.*until|recovery.*expires'
$hasDestructionTime = $idempotencySchemaText -match '(?i)destroyed.*at|destruction.*time'
Add-Check 'Idempotency' 'API-key lost-response recovery envelope is representable' `
    ($hasCiphertext -and $hasKeyReference -and $hasRecoveryTime -and $hasDestructionTime) `
    'Encrypted response, key reference, recovery deadline, and destruction evidence fields are present.' `
    'The 10-minute encrypted API-key response envelope cannot be stored with the current idempotency table.'

$signupMatches = [regex]::Matches(
    $migrationText,
    '(?is)CREATE\s+OR\s+REPLACE\s+FUNCTION\s+app\.create_signup\s*\(.*?\$\$;(?:\s|$)'
)
$signupFunction = if ($signupMatches.Count -gt 0) { $signupMatches[$signupMatches.Count - 1].Value } else { '' }
$hasExistingEmailPath = $signupFunction -match '(?is)ON\s+CONFLICT|unique_violation|FROM\s+app\.users.*email_normalized'
Add-Check 'Signup' 'Existing email has a generic accepted path' $hasExistingEmailPath `
    'The signup database function contains a safe existing-identity branch.' `
    'create_signup inserts users directly; an existing normalized email can surface a uniqueness failure instead of the required generic accepted result.'

$hasConcurrentClaim = $signupFunction -match '(?is)pg_advisory_xact_lock|INSERT\s+INTO\s+app\.idempotency_records.*?ON\s+CONFLICT'
Add-Check 'Signup' 'Concurrent first use of one idempotency key is serialized safely' $hasConcurrentClaim `
    'The signup idempotency claim has an atomic conflict/locking path.' `
    'SELECT FOR UPDATE cannot lock a missing idempotency row; two first requests can race at INSERT.'

$hasRefreshHistory = $migrationText -match '(?is)CREATE\s+TABLE\s+app\.auth_refresh_tokens' -and
    $migrationText -match '(?is)auth_refresh_tokens_one_active_per_session' -and
    $migrationText -match "(?is)state\s*=\s*'reused'"
Add-Check 'Authentication' 'Rotated refresh-token reuse is representable' $hasRefreshHistory `
    'Hashed token generations, one-active-generation enforcement, and reused state are present.' `
    'The schema cannot retain a rotated hash and distinguish token reuse from an unrelated invalid secret.'

$producerUpdatePattern = '(?is)GRANT\s+(?:SELECT\s*,\s*)?INSERT\s*,\s*UPDATE\s+ON.*?app\.outbox_events.*?TO\s+dhumi_(identity|admission|job_manager|result_recorder)'
$producerUpdateRevoked = @('dhumi_identity', 'dhumi_admission', 'dhumi_job_manager', 'dhumi_result_recorder') |
    ForEach-Object { $migrationText -match "(?is)REVOKE\s+UPDATE\s+ON\s+app\.outbox_events\s+FROM[^;]*\b$_\b" } |
    Where-Object { -not $_ } |
    Measure-Object |
    Select-Object -ExpandProperty Count
Add-Check 'Least privilege' 'Outbox producers cannot rewrite outbox rows' `
    (($migrationText -notmatch $producerUpdatePattern) -or $producerUpdateRevoked -eq 0) `
    'Only the dispatcher can update claim/publish metadata.' `
    'One or more producer roles have direct UPDATE on outbox_events, bypassing dispatcher fencing.'

$runEventUpdatePattern = '(?is)GRANT\s+(?:INSERT\s*,\s*)?UPDATE\s+ON.*?app\.run_events.*?TO\s+dhumi_(job_manager|result_recorder)'
$runEventUpdateRevoked = @('dhumi_job_manager', 'dhumi_result_recorder') |
    ForEach-Object { $migrationText -match "(?is)REVOKE\s+UPDATE\s+ON\s+app\.run_events\s+FROM[^;]*\b$_\b" } |
    Where-Object { -not $_ } |
    Measure-Object |
    Select-Object -ExpandProperty Count
Add-Check 'Least privilege' 'Roles cannot rewrite Run history' `
    (($migrationText -notmatch $runEventUpdatePattern) -or $runEventUpdateRevoked -eq 0) `
    'Run history roles are insert-only.' `
    'A runtime role has UPDATE on run_events while the table lacks an append-only guard.'

$jobCredentialPattern = '(?is)GRANT\s+SELECT\s+ON.*?app\.provider_credentials.*?TO\s+dhumi_job_manager'
$jobCredentialRevoked = $migrationText -match '(?is)REVOKE\s+SELECT\s+ON\s+app\.provider_credentials\s+FROM[^;]*\bdhumi_job_manager\b'
Add-Check 'Integration boundary' 'Job Manager cannot read the vault-secret registry' `
    (($migrationText -notmatch $jobCredentialPattern) -or $jobCredentialRevoked) `
    'Provider credential registry access remains outside Job Manager.' `
    'dhumi_job_manager has SELECT on provider_credentials, which is wider than its normalized-outcome responsibility.'

$requiredTestSignals = [ordered]@{
    'RLS negative test' = 'missing tenant context'
    'Composite tenant FK test' = 'cross-tenant'
    'Legal Run transition test' = 'transition_run'
    'Sequential signup replay test' = 'signup replay'
    'Different-body idempotency test' = 'IDEMPOTENCY_CONFLICT'
    'Concurrent signup/idempotency test' = 'concurrent'
    'Refresh rotation/reuse test' = 'refresh.*reuse|reuse.*refresh'
    'API-key recovery/expiry test' = 'IDEMPOTENCY_REPLAY_EXPIRED'
    'Attempt claim/fence race test' = 'attempt.*fence|fence.*attempt'
    'Outbox stale-claim reclaim test' = 'stale.*claim|claim.*expir'
    'Cost-hold concurrency test' = 'cost.hold.*concurr|concurr.*cost.hold'
    'Provider Mapping immutability test' = 'provider.mapping.*immut|immut.*provider.mapping'
    'Run-event immutability test' = 'run.event.*immut|immut.*run.event'
}
foreach ($entry in $requiredTestSignals.GetEnumerator()) {
    Add-Check 'Test coverage' $entry.Key ($testText -match "(?is)$($entry.Value)") `
        'A matching integration-test case was found.' `
        'No matching test case was found under back-end\tests.' 'WARN'
}

$sortedResults = @($results | Sort-Object Category, Check)
$sortedResults | Format-Table Category, Status, Check -AutoSize
foreach ($result in $sortedResults | Where-Object Status -ne 'PASS') {
    Write-Host "[$($result.Status)] $($result.Category) / $($result.Check): $($result.Details)"
}
$passCount = @($results | Where-Object Status -eq 'PASS').Count
$warnCount = @($results | Where-Object Status -eq 'WARN').Count
$failCount = @($results | Where-Object Status -eq 'FAIL').Count
Write-Host "`nSource audit summary: PASS=$passCount WARN=$warnCount FAIL=$failCount"

if ($failCount -gt 0) {
    exit 2
}
