[CmdletBinding()]
param(
    [Parameter()]
    [string]$PsqlPath = 'C:\Program Files\PostgreSQL\18\bin\psql.exe',

    [Parameter()]
    [string]$ServerHost = 'localhost',

    [Parameter()]
    [ValidateRange(1, 65535)]
    [int]$Port = 5432,

    [Parameter()]
    [string]$DatabaseName = 'dhumi_test',

    [Parameter()]
    [string]$UserName = 'postgres'
)

$ErrorActionPreference = 'Stop'

if ($DatabaseName -ne 'dhumi_test') {
    throw 'This concurrency test is locked to the isolated dhumi_test database.'
}
if (-not (Test-Path -LiteralPath $PsqlPath -PathType Leaf)) {
    throw "psql was not found at: $PsqlPath"
}

foreach ($value in @($ServerHost, $DatabaseName, $UserName)) {
    if ([string]::IsNullOrWhiteSpace($value) -or $value -match "[\r\n]") {
        throw 'Connection values must be non-empty single-line strings.'
    }
}

function Get-Sha256Hex {
    param(
        [Parameter(Mandatory)]
        [byte[]]$Bytes
    )

    # Windows PowerShell 5.1 runs on .NET Framework, which does not provide
    # SHA256.HashData() or Convert.ToHexString(). Use the compatible instance
    # API so this test works in both Windows PowerShell 5.1 and PowerShell 7+.
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hashBytes = $sha256.ComputeHash($Bytes)
        return (($hashBytes | ForEach-Object { $_.ToString('x2') }) -join '')
    }
    finally {
        $sha256.Dispose()
    }
}

$securePassword = Read-Host 'PostgreSQL password (held only for these child processes)' -AsSecureString
$passwordPointer = [IntPtr]::Zero
$plainPassword = $null
$oldPgPassword = $env:PGPASSWORD
$temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ("dhumi-signup-race-" + [guid]::NewGuid().ToString('N'))

try {
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    $env:PGPASSWORD = $plainPassword

    New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null

    $commonArguments = @(
        '-X', '--quiet', "--host=$ServerHost", "--port=$Port",
        "--username=$UserName", "--dbname=$DatabaseName", '--set=ON_ERROR_STOP=1'
    )

    $preflightSql = @'
SELECT
  current_database() AS database_name,
  EXISTS (
    SELECT 1 FROM app.schema_migrations
    WHERE version = '0004_database_integrity_corrections'
  ) AS correction_applied;
'@
    $preflightOutput = & $PsqlPath @commonArguments --csv "--command=$preflightSql"
    if ($LASTEXITCODE -ne 0) {
        throw 'Concurrency-test preflight could not connect to PostgreSQL.'
    }
    $preflight = @($preflightOutput | ConvertFrom-Csv)
    if ($preflight.Count -ne 1 -or $preflight[0].database_name -ne 'dhumi_test') {
        throw 'Concurrency-test preflight did not resolve dhumi_test.'
    }
    if ($preflight[0].correction_applied -ne 't') {
        throw 'Migration 0004 must be applied to dhumi_test before this test.'
    }

    $token = (Get-Date -Format 'yyyyMMddHHmmssfff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    $email = "signup-race-$token@example.test"
    $idempotencyKey = "signup-race-$token"
    $actorBytes = [Text.Encoding]::UTF8.GetBytes($email)
    $requestBytes = [Text.Encoding]::UTF8.GetBytes("$email|Race Workspace|terms-v1")
    $actorHex = Get-Sha256Hex -Bytes $actorBytes
    $requestHex = Get-Sha256Hex -Bytes $requestBytes
    $startAt = [DateTime]::UtcNow.AddSeconds(3).ToString('yyyy-MM-ddTHH:mm:ss.fffffffZ')
    $documentHash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

    $sessionSql = @"
\set ON_ERROR_STOP on
BEGIN;
SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM (TIMESTAMPTZ '$startAt' - clock_timestamp()))));
SET LOCAL ROLE dhumi_identity;
SELECT user_id, tenant_id, replayed
FROM app.create_signup(
  '$email',
  'concurrency-test-password-hash',
  'Race Workspace',
  '[{"document_type":"terms","document_version":"v1","document_hash_hex":"$documentHash"}]'::jsonb,
  '$idempotencyKey',
  decode('$requestHex', 'hex'),
  decode('$actorHex', 'hex')
);
COMMIT;
"@

    $sqlA = Join-Path $temporaryDirectory 'session-a.sql'
    $sqlB = Join-Path $temporaryDirectory 'session-b.sql'
    $outA = Join-Path $temporaryDirectory 'session-a.out'
    $outB = Join-Path $temporaryDirectory 'session-b.out'
    $errA = Join-Path $temporaryDirectory 'session-a.err'
    $errB = Join-Path $temporaryDirectory 'session-b.err'
    $sessionSql | Set-Content -LiteralPath $sqlA -Encoding utf8
    $sessionSql | Set-Content -LiteralPath $sqlB -Encoding utf8

    $processArgsA = ($commonArguments + @('--tuples-only', '--no-align', "--file=`"$sqlA`"")) -join ' '
    $processArgsB = ($commonArguments + @('--tuples-only', '--no-align', "--file=`"$sqlB`"")) -join ' '

    $processA = Start-Process -FilePath $PsqlPath -ArgumentList $processArgsA `
        -RedirectStandardOutput $outA -RedirectStandardError $errA `
        -WindowStyle Hidden -PassThru
    $processB = Start-Process -FilePath $PsqlPath -ArgumentList $processArgsB `
        -RedirectStandardOutput $outB -RedirectStandardError $errB `
        -WindowStyle Hidden -PassThru

    # Windows PowerShell 5.1 can return a blank ExitCode for a process started
    # with redirected output unless the native process handle is materialized
    # before the process exits. Keep both handles while the sessions run so a
    # real success/failure code is available after WaitForExit().
    $null = $processA.Handle
    $null = $processB.Handle
    $processA.WaitForExit()
    $processB.WaitForExit()

    $sessionAOutput = Get-Content -LiteralPath $outA -Raw
    $sessionBOutput = Get-Content -LiteralPath $outB -Raw
    $sessionAError = Get-Content -LiteralPath $errA -Raw
    $sessionBError = Get-Content -LiteralPath $errB -Raw

    if ($processA.ExitCode -ne 0 -or $processB.ExitCode -ne 0) {
        throw "Concurrent signup failed. A=$($processA.ExitCode) B=$($processB.ExitCode)`nA error: $sessionAError`nB error: $sessionBError"
    }

    $combinedOutput = $sessionAOutput + "`n" + $sessionBOutput
    if (($combinedOutput -split "`r?`n" | Where-Object { $_ -match '\|f$' }).Count -ne 1 -or
        ($combinedOutput -split "`r?`n" | Where-Object { $_ -match '\|t$' }).Count -ne 1) {
        throw "Expected exactly one created result and one replay result.`n$combinedOutput"
    }

    $verifySql = @"
SELECT
  (SELECT count(*) FROM app.users WHERE email_normalized = '$email') AS users,
  (SELECT count(*)
   FROM app.tenants tenant
   JOIN app.tenant_user_access access ON access.tenant_id = tenant.id
   JOIN app.users app_user ON app_user.id = access.user_id
   WHERE app_user.email_normalized = '$email') AS tenants,
  (SELECT count(*)
   FROM app.idempotency_records
   WHERE scope_kind = 'signup'
     AND actor_fingerprint = decode('$actorHex', 'hex')
     AND operation_code = 'auth.signup'
     AND idempotency_key = '$idempotencyKey') AS idempotency_records,
  (SELECT count(*)
   FROM app.audit_events audit
   JOIN app.users app_user ON app_user.id = audit.actor_user_id
   WHERE app_user.email_normalized = '$email'
     AND audit.action = 'tenant.signup') AS signup_audits,
  (SELECT count(*)
   FROM app.outbox_events outbox
   JOIN app.users app_user
     ON app_user.id::text = outbox.payload->>'user_id'
   WHERE app_user.email_normalized = '$email'
     AND outbox.topic = 'notifications.signup_accepted') AS signup_outbox;
"@
    $verifyOutput = & $PsqlPath @commonArguments --csv "--command=$verifySql"
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not verify the committed concurrency-test result.'
    }
    $verification = @($verifyOutput | ConvertFrom-Csv)
    if ($verification.Count -ne 1) {
        throw 'Concurrency verification did not return exactly one row.'
    }

    foreach ($field in @('users', 'tenants', 'idempotency_records', 'signup_audits', 'signup_outbox')) {
        if ([int]$verification[0].$field -ne 1) {
            throw "Concurrency assertion failed: $field=$($verification[0].$field), expected 1."
        }
    }

    Write-Host 'PASS: concurrent same-key signup created one User, one Tenant, one idempotency result, one audit, and one outbox event.' -ForegroundColor Green
    Write-Host "Test email retained in dhumi_test: $email"
}
finally {
    if ($null -eq $oldPgPassword) {
        Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
    } else {
        $env:PGPASSWORD = $oldPgPassword
    }
    $plainPassword = $null
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
    if (Test-Path -LiteralPath $temporaryDirectory -PathType Container) {
        $resolvedTemporaryDirectory = [IO.Path]::GetFullPath($temporaryDirectory)
        $resolvedSystemTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
        $temporaryLeaf = [IO.Path]::GetFileName($resolvedTemporaryDirectory)
        if (-not $resolvedTemporaryDirectory.StartsWith($resolvedSystemTemp, [StringComparison]::OrdinalIgnoreCase) -or
            $temporaryLeaf -notmatch '^dhumi-signup-race-[0-9a-f]{32}$') {
            throw "Refusing to remove unexpected temporary path: $resolvedTemporaryDirectory"
        }
        Remove-Item -LiteralPath $resolvedTemporaryDirectory -Recurse -Force
    }
}
