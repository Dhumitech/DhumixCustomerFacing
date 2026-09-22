<#
.SYNOPSIS
    Manual end-to-end verification of signup and sign-in.

.DESCRIPTION
    Starts the built server against dhumi_test, exercises every accepted and
    rejected path, checks the rows the database actually received, then stops
    the server. Each step prints EXPECTED and ACTUAL so a failure is readable
    without reading the script.

    Nothing here writes to dhumi_dev. The runtime refuses to start if .env.test
    points anywhere else.

.PARAMETER SkipBuild
    Reuse an existing dist/ instead of rebuilding.

.PARAMETER KeepServer
    Leave the server running after the checks, for poking at it by hand.

.EXAMPLE
    .\scripts\smoke\Verify-Signup.ps1
#>
[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$KeepServer
)

$ErrorActionPreference = 'Stop'
$backEnd = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $backEnd

$script:Passed = 0
$script:Failed = 0
$script:ServerProcess = $null

function Write-Step {
    param([int]$Number, [string]$Title)
    Write-Host ''
    Write-Host ("=" * 70)
    Write-Host ("STEP {0}: {1}" -f $Number, $Title)
    Write-Host ("=" * 70)
}

function Assert-Equal {
    param([string]$What, $Expected, $Actual)
    if ("$Expected" -eq "$Actual") {
        Write-Host ("  PASS  {0}: {1}" -f $What, $Actual) -ForegroundColor Green
        $script:Passed++
    }
    else {
        Write-Host ("  FAIL  {0}" -f $What) -ForegroundColor Red
        Write-Host ("        expected: {0}" -f $Expected) -ForegroundColor Red
        Write-Host ("        actual  : {0}" -f $Actual) -ForegroundColor Red
        $script:Failed++
    }
}

function Assert-Contains {
    param([string]$What, [string]$Needle, [string]$Haystack)
    if ($Haystack -like "*$Needle*") {
        Write-Host ("  PASS  {0}" -f $What) -ForegroundColor Green
        $script:Passed++
    }
    else {
        Write-Host ("  FAIL  {0}" -f $What) -ForegroundColor Red
        Write-Host ("        looked for: {0}" -f $Needle) -ForegroundColor Red
        Write-Host ("        in        : {0}" -f $Haystack) -ForegroundColor Red
        $script:Failed++
    }
}

function Assert-NotContains {
    param([string]$What, [string]$Needle, [string]$Haystack)
    if ($Haystack -like "*$Needle*") {
        Write-Host ("  FAIL  {0}: found forbidden '{1}'" -f $What, $Needle) -ForegroundColor Red
        Write-Host ("        in: {0}" -f $Haystack) -ForegroundColor Red
        $script:Failed++
    }
    else {
        Write-Host ("  PASS  {0}" -f $What) -ForegroundColor Green
        $script:Passed++
    }
}

# ---------------------------------------------------------------------------
Write-Step 1 'Prerequisites'

if (-not (Test-Path '.env.test')) {
    throw '.env.test not found. Copy .env.test.example and fill the two restricted role passwords.'
}

$envLines = Get-Content '.env.test' | Where-Object { $_ -match '^\s*[A-Z_]+\s*=' }
$envMap = @{}
foreach ($line in $envLines) {
    $pair = $line -split '=', 2
    $envMap[$pair[0].Trim()] = $pair[1].Trim()
}

Assert-Equal 'target database is dhumi_test' 'dhumi_test' $envMap['DATABASE_NAME']

if ([string]::IsNullOrWhiteSpace($envMap['DATABASE_IDENTITY_PASSWORD'])) {
    throw 'DATABASE_IDENTITY_PASSWORD is empty in .env.test.'
}
Write-Host '  PASS  restricted role passwords are present (values not shown)' -ForegroundColor Green
$script:Passed++

$port = if ($envMap['PORT']) { $envMap['PORT'] } else { '3001' }
$baseUrl = "http://127.0.0.1:$port"
Write-Host ("  INFO  base URL {0}" -f $baseUrl)

# ---------------------------------------------------------------------------
Write-Step 2 'Static checks'

npm run typecheck | Out-Null
Assert-Equal 'typecheck exit code' 0 $LASTEXITCODE

npm test 2>&1 | Select-Object -Last 6 | ForEach-Object { Write-Host "  $_" }
Assert-Equal 'unit and contract suite exit code' 0 $LASTEXITCODE

# ---------------------------------------------------------------------------
Write-Step 3 'Live database suite'

npm run test:database 2>&1 | Select-Object -Last 5 | ForEach-Object { Write-Host "  $_" }
Assert-Equal 'database suite exit code' 0 $LASTEXITCODE

# ---------------------------------------------------------------------------
Write-Step 4 'Build and start the server'

if (-not $SkipBuild) {
    npm run build | Out-Null
    Assert-Equal 'build exit code' 0 $LASTEXITCODE
}

# Refuse to run against a server this script did not start. A stale process
# from an earlier run would answer with its own configuration and its own
# already-consumed rate-limit buckets, and every result below would be a
# measurement of the wrong process.
$occupied = & curl.exe -s -o NUL -w '%{http_code}' "$baseUrl/health-probe" 2>$null
if ($occupied -and $occupied -ne '000') {
    $listener = (netstat -ano | Select-String ":$port\s.*LISTENING") -replace '.*\s(\d+)$', '$1'
    throw "Port $port is already in use (PID $listener). Stop that process and re-run: Stop-Process -Id $listener -Force"
}

# The functional checks below send more requests for one identity than the
# configured signup limit allows, which would throttle them. Raise the limit
# for this run only; a shell variable overrides --env-file in Node. Both
# rate-limit dimensions are proved by the contract suite in step 2.
$env:SIGNUP_RATE_LIMIT_MAX = '500'
$env:SIGNIN_RATE_LIMIT_MAX = '500'

$script:ServerProcess = Start-Process -FilePath 'node' `
    -ArgumentList '--env-file=.env.test', 'dist/server.js' `
    -PassThru -NoNewWindow -RedirectStandardOutput 'scripts/smoke/server.out.log' `
    -RedirectStandardError 'scripts/smoke/server.err.log'

$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    $probe = & curl.exe -s -o NUL -w '%{http_code}' "$baseUrl/health-probe" 2>$null
    if ($probe -and $probe -ne '000') { $ready = $true; break }
}

Assert-Equal 'server accepting connections' $true $ready
if (-not $ready) {
    Write-Host '  --- server error log ---' -ForegroundColor Yellow
    Get-Content 'scripts/smoke/server.err.log' -ErrorAction SilentlyContinue |
        Select-Object -Last 20 | ForEach-Object { Write-Host "  $_" }
    throw 'Server did not start. Check the log above.'
}

# ---------------------------------------------------------------------------
Write-Step 5 'Signup: the accepted path'

$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$email = "manual-check-$stamp@example.test"
$key = "manual-check-$stamp-idem-01"
$hash = 'a' * 64

$body = @{
    email             = $email
    password          = 'a-sufficiently-long-password'
    workspace_name    = 'Manual Check'
    legal_acceptances = @(@{
        document_type    = 'terms'
        document_version = 'manual-v1'
        content_hash     = $hash
        accepted         = $true
    })
} | ConvertTo-Json -Depth 5 -Compress

$bodyFile = Join-Path $env:TEMP "signup-body-$stamp.json"
[System.IO.File]::WriteAllText($bodyFile, $body)

$response = & curl.exe -s -w "`n%{http_code}" -X POST "$baseUrl/v1/auth/signup" `
    -H 'content-type: application/json' -H "idempotency-key: $key" `
    --data-binary "@$bodyFile"
$lines = $response -split "`n"
$status = $lines[-1]
$payload = ($lines[0..($lines.Length - 2)] -join '')

Assert-Equal 'new signup status' 202 $status
Assert-Contains 'fixed accepted message' 'Sign in to continue.' $payload
Assert-NotContains 'no user_id leaked' 'user_id' $payload
Assert-NotContains 'no tenant_id leaked' 'tenant_id' $payload

# ---------------------------------------------------------------------------
Write-Step 6 'Idempotency: replay and conflict'

$replay = & curl.exe -s -o NUL -w '%{http_code}' -X POST "$baseUrl/v1/auth/signup" `
    -H 'content-type: application/json' -H "idempotency-key: $key" `
    --data-binary "@$bodyFile"
Assert-Equal 'identical replay returns the original answer' 202 $replay

$conflictBody = $body -replace 'Manual Check', 'Different Workspace'
$conflictFile = Join-Path $env:TEMP "signup-conflict-$stamp.json"
[System.IO.File]::WriteAllText($conflictFile, $conflictBody)

$conflict = & curl.exe -s -X POST "$baseUrl/v1/auth/signup" `
    -H 'content-type: application/json' -H "idempotency-key: $key" `
    --data-binary "@$conflictFile"
Assert-Contains 'same key + different body is a conflict' 'IDEMPOTENCY_CONFLICT' $conflict
Assert-NotContains 'conflict does not leak SQLSTATE' '23505' $conflict

# ---------------------------------------------------------------------------
Write-Step 7 'Rejections and the Problem shape'

$unknown = $body -replace '\}$', ',"referral_code":"abc"}'
$unknownFile = Join-Path $env:TEMP "signup-unknown-$stamp.json"
[System.IO.File]::WriteAllText($unknownFile, $unknown)

$unknownResult = & curl.exe -s -D - -X POST "$baseUrl/v1/auth/signup" `
    -H 'content-type: application/json' -H "idempotency-key: $key-unknown" `
    --data-binary "@$unknownFile"
Assert-Contains 'unknown property is rejected, not stripped' 'MALFORMED_REQUEST' $unknownResult
Assert-Contains 'errors use application/problem+json' 'application/problem+json' $unknownResult

$noKey = & curl.exe -s -o NUL -w '%{http_code}' -X POST "$baseUrl/v1/auth/signup" `
    -H 'content-type: application/json' --data-binary "@$bodyFile"
Assert-Equal 'missing Idempotency-Key is rejected' 400 $noKey

$shortPassword = $body -replace 'a-sufficiently-long-password', 'short'
$shortFile = Join-Path $env:TEMP "signup-short-$stamp.json"
[System.IO.File]::WriteAllText($shortFile, $shortPassword)
$shortResult = & curl.exe -s -o NUL -w '%{http_code}' -X POST "$baseUrl/v1/auth/signup" `
    -H 'content-type: application/json' -H "idempotency-key: $key-short" `
    --data-binary "@$shortFile"
Assert-Equal 'password under 12 characters is rejected' 400 $shortResult

# ---------------------------------------------------------------------------
Write-Step 8 'Enumeration: an existing email is indistinguishable'

$existing = & curl.exe -s -w "`n%{http_code}" -X POST "$baseUrl/v1/auth/signup" `
    -H 'content-type: application/json' -H "idempotency-key: $key-second" `
    --data-binary "@$bodyFile"
$existingLines = $existing -split "`n"
$existingStatus = $existingLines[-1]
$existingPayload = ($existingLines[0..($existingLines.Length - 2)] -join '')

Assert-Equal 'already-registered email returns the same status' $status $existingStatus
Assert-Equal 'already-registered email returns the same body' $payload $existingPayload
Assert-Equal 'both are the fixed accepted body' '{"accepted":true,"message":"Account request accepted. Sign in to continue."}' $existingPayload

# ---------------------------------------------------------------------------
Write-Step 9 'Sign-in: the accepted path'

$signInFile = Join-Path $env:TEMP "signin-$stamp.json"
[System.IO.File]::WriteAllText(
    $signInFile,
    (@{ email = $email; password = 'a-sufficiently-long-password' } | ConvertTo-Json -Compress)
)

# curl output arrives as a string array. Join it first: `-match` over an array
# filters elements and leaves $Matches unset, which silently yields no status.
$signInLines = & curl.exe -s -D - -X POST "$baseUrl/v1/auth/sign-in" `
    -H 'content-type: application/json' --data-binary "@$signInFile"
$signInRaw = ($signInLines | Out-String)
$signInStatus = if ($signInRaw -match 'HTTP/[\d.]+\s+(\d{3})') { $Matches[1] } else { 'none' }
$signInBody = ($signInLines | Where-Object { $_ -match '^\s*\{' } | Select-Object -Last 1)

Assert-Equal 'sign-in status' 200 $signInStatus

$session = $signInBody | ConvertFrom-Json
Assert-Equal 'AuthSession field count' 4 (@($session.PSObject.Properties.Name)).Count
Assert-Equal 'token_type' 'Bearer' $session.token_type
Assert-Contains 'access_token is a compact JWS' '.' $session.access_token

# ---------------------------------------------------------------------------
Write-Step 10 'Sign-in: the refresh cookie'

$cookieLine = ($signInLines | Where-Object { $_ -match '^set-cookie:' }) -join ' '

Assert-Contains 'refresh cookie is set' 'dhumi_refresh=' $cookieLine
Assert-Contains 'cookie is HttpOnly' 'HttpOnly' $cookieLine
Assert-Contains 'cookie is SameSite=Strict' 'SameSite=Strict' $cookieLine
Assert-Contains 'cookie is scoped to /v1/auth' 'Path=/v1/auth' $cookieLine

# The refresh token belongs only in the cookie. AuthSession carries four fields
# and none of them is it.
$cookieValue = if ($cookieLine -match 'dhumi_refresh=([A-Za-z0-9_-]+)') { $Matches[1] } else { 'unset' }
Assert-NotContains 'refresh token absent from the response body' $cookieValue $signInBody

# ---------------------------------------------------------------------------
Write-Step 11 'Sign-in: the access token carries the resolved Tenant'

# The customer never supplies a tenant, and dhumi_customer_api cannot discover
# one, so sign-in resolves it and signs it in. The payload is decoded here
# without verifying; the signature, issuer, audience, expiry and purpose checks
# are proved by the unit suite in step 2.
$payloadSegment = ($session.access_token -split '\.')[1]
$padded = $payloadSegment.Replace('-', '+').Replace('_', '/')
switch ($padded.Length % 4) { 2 { $padded += '==' } 3 { $padded += '=' } }
$claims = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($padded)) |
    ConvertFrom-Json

Assert-Contains 'claim: subject is a uuid' '-' $claims.sub
Assert-Contains 'claim: session id is a uuid' '-' $claims.sid
Assert-Contains 'claim: tenant id is a uuid' '-' $claims.tid
Assert-Equal 'claim: purpose' 'browser_access' $claims.pur
Assert-Equal 'claim: audience' 'dhumi-browser' $claims.aud

# ---------------------------------------------------------------------------
Write-Step 12 'Sign-in: every rejection looks the same'

$wrongFile = Join-Path $env:TEMP "signin-wrong-$stamp.json"
[System.IO.File]::WriteAllText(
    $wrongFile,
    (@{ email = $email; password = 'definitely-the-wrong-password' } | ConvertTo-Json -Compress)
)
$ghostFile = Join-Path $env:TEMP "signin-ghost-$stamp.json"
[System.IO.File]::WriteAllText(
    $ghostFile,
    (@{ email = "ghost-$stamp@example.test"; password = 'a-sufficiently-long-password' } |
        ConvertTo-Json -Compress)
)
$badShapeFile = Join-Path $env:TEMP "signin-badshape-$stamp.json"
[System.IO.File]::WriteAllText(
    $badShapeFile,
    (@{ email = $email; password = 'a-sufficiently-long-password'; remember_me = $true } |
        ConvertTo-Json -Compress)
)

function Get-SignInFailure {
    param([string]$File)
    $lines = & curl.exe -s -D - -X POST "$baseUrl/v1/auth/sign-in" `
        -H 'content-type: application/json' --data-binary "@$File"
    $raw = ($lines | Out-String)
    $status = if ($raw -match 'HTTP/[\d.]+\s+(\d{3})') { $Matches[1] } else { 'none' }
    $body = ($lines | Where-Object { $_ -match '^\s*\{' } | Select-Object -Last 1)
    # request_id is per request by design; normalise before comparing bodies.
    $normalised = $body -replace '"request_id":"[^"]+"', '"request_id":"X"'
    return @{ Status = $status; Body = $normalised; Raw = $raw }
}

$wrong = Get-SignInFailure $wrongFile
$ghost = Get-SignInFailure $ghostFile
$badShape = Get-SignInFailure $badShapeFile

Assert-Equal 'wrong password status' 401 $wrong.Status
Assert-Equal 'unknown email status' 401 $ghost.Status
Assert-Equal 'malformed body status, not an undeclared 400' 401 $badShape.Status

Assert-Equal 'unknown email is byte-identical to a wrong password' $wrong.Body $ghost.Body
Assert-Equal 'malformed body is byte-identical to a wrong password' $wrong.Body $badShape.Body
Assert-Contains 'WWW-Authenticate is sent, as the contract declares' 'www-authenticate' $wrong.Raw.ToLower()
Assert-Contains 'errors use application/problem+json' 'application/problem+json' $wrong.Raw.ToLower()

# ---------------------------------------------------------------------------
Write-Step 13 'Sign-in: timing does not reveal whether an address exists'

# Argon2 runs on every request, including when no identity matched. Skipping it
# would make an unknown address answer in about a millisecond against roughly
# 27 ms for a real one, which defeats the identical error with a stopwatch.
function Measure-SignIn {
    param([string]$File)
    $samples = foreach ($i in 1..6) {
        [double](& curl.exe -s -o NUL -w '%{time_total}' -X POST "$baseUrl/v1/auth/sign-in" `
            -H 'content-type: application/json' --data-binary "@$File")
    }
    $sorted = $samples | Sort-Object
    return [math]::Round($sorted[3] * 1000, 1)
}

$knownMs = Measure-SignIn $wrongFile
$ghostMs = Measure-SignIn $ghostFile
$ratio = if ($knownMs -gt 0) { [math]::Round($ghostMs / $knownMs, 2) } else { 0 }

Write-Host ("  INFO  known address median {0} ms, unknown {1} ms, ratio {2}" -f $knownMs, $ghostMs, $ratio)

if ($ratio -gt 0.5 -and $ratio -lt 2.0) {
    Write-Host '  PASS  no usable timing signal between known and unknown addresses' -ForegroundColor Green
    $script:Passed++
}
else {
    Write-Host '  FAIL  timing differs enough to enumerate accounts' -ForegroundColor Red
    Write-Host '        conditional password hashing has probably been reintroduced' -ForegroundColor Red
    $script:Failed++
}

# ---------------------------------------------------------------------------
Write-Step 14 'What the database actually received'

$verifier = @'
import { loadRuntimeConfig } from "./dist/config/environment.js";
import { createDatabasePools } from "./dist/services/database/pools.js";
import { withIdentityTransaction } from "./dist/services/database/transactions.js";

const email = process.argv[2];
const config = loadRuntimeConfig();
const pools = createDatabasePools(config.database, () => {});
const rows = await withIdentityTransaction(pools.identity, async (db) => {
  const r = await db.query(
    `SELECT
       (SELECT count(*) FROM app.users WHERE email_normalized = $1) AS users,
       (SELECT count(*) FROM app.tenants t JOIN app.tenant_user_access a ON a.tenant_id = t.id
          JOIN app.users u ON u.id = a.user_id WHERE u.email_normalized = $1) AS tenants,
       (SELECT count(*) FROM app.tenant_user_access a JOIN app.users u ON u.id = a.user_id
         WHERE u.email_normalized = $1 AND a.state = 'active') AS access,
       (SELECT count(*) FROM app.legal_acceptances l JOIN app.users u ON u.id = l.user_id
         WHERE u.email_normalized = $1) AS legal,
       (SELECT count(*) FROM app.idempotency_records
         WHERE scope_kind = 'signup' AND state = 'completed'
           AND idempotency_key = $2) AS idempotency`,
    [email, process.argv[3]],
  );
  return r.rows[0];
});
console.log(JSON.stringify(rows));
await pools.close();
'@

$verifierPath = 'verify-rows.mjs'
[System.IO.File]::WriteAllText((Join-Path $backEnd $verifierPath), $verifier)
try {
    $counts = & node --env-file=.env.test $verifierPath $email $key | ConvertFrom-Json
    Assert-Equal 'exactly one user' 1 $counts.users
    Assert-Equal 'exactly one tenant' 1 $counts.tenants
    Assert-Equal 'exactly one active owner access' 1 $counts.access
    Assert-Equal 'exactly one legal acceptance' 1 $counts.legal
    Assert-Equal 'idempotency record completed' 1 $counts.idempotency
}
finally {
    Remove-Item (Join-Path $backEnd $verifierPath) -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
Write-Step 15 'Shut down and summarise'

Remove-Item $bodyFile, $conflictFile, $unknownFile, $shortFile, $signInFile,
    $wrongFile, $ghostFile, $badShapeFile -ErrorAction SilentlyContinue

if ($KeepServer) {
    Write-Host ("  INFO  server left running on {0} (PID {1})" -f $baseUrl, $script:ServerProcess.Id)
}
elseif ($script:ServerProcess -and -not $script:ServerProcess.HasExited) {
    Stop-Process -Id $script:ServerProcess.Id -Force
    Write-Host '  INFO  server stopped'
}

Write-Host ''
Write-Host ("=" * 70)
Write-Host ("RESULT: {0} passed, {1} failed" -f $script:Passed, $script:Failed) `
    -ForegroundColor $(if ($script:Failed -eq 0) { 'Green' } else { 'Red' })
Write-Host ("=" * 70)
Remove-Item Env:SIGNUP_RATE_LIMIT_MAX -ErrorAction SilentlyContinue
Remove-Item Env:SIGNIN_RATE_LIMIT_MAX -ErrorAction SilentlyContinue
Write-Host ("Test identity used: {0}" -f $email)
Write-Host 'It remains in dhumi_test. That database is disposable.'

if ($script:Failed -gt 0) { exit 1 }
