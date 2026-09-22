[CmdletBinding()]
param(
    [Parameter()]
    [string]$TestDatabaseUrl = 'postgresql://postgres@localhost:5432/dhumi_test'
)

$ErrorActionPreference = 'Stop'

if ($TestDatabaseUrl -ne 'postgresql://postgres@localhost:5432/dhumi_test') {
    throw 'This proof-and-start script may target only local dhumi_test.'
}

if ($TestDatabaseUrl -match '(?i)://[^/@\s]+:[^/@\s]+@' -or
    $TestDatabaseUrl -match '(?i)(^|\s)password\s*=') {
    throw 'TestDatabaseUrl must not contain a password.'
}

if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    throw 'psql was not found on PATH.'
}

$backEnd = Split-Path -Parent $PSScriptRoot
$migration = Join-Path $PSScriptRoot 'migrations\0021_run_cancellation.sql'
$proof = Join-Path $backEnd 'tests\integration\0014_run_cancellation.sql'

foreach ($requiredFile in @($migration, $proof)) {
    if (-not (Test-Path -LiteralPath $requiredFile)) {
        throw "Required cancellation file is missing: $requiredFile"
    }
}

$passwordPointer = [IntPtr]::Zero
$plainPassword = $null
$oldPgPassword = $env:PGPASSWORD

function Assert-ChildSuccess {
    param([Parameter(Mandatory)][string]$Message)
    if ($LASTEXITCODE -ne 0) {
        throw $Message
    }
}

try {
    $securePassword = Read-Host `
        'PostgreSQL postgres password (held only by child processes)' `
        -AsSecureString
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR(
        $securePassword
    )
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
        $passwordPointer
    )
    $env:PGPASSWORD = $plainPassword

    Push-Location $backEnd
    try {
        Write-Host `
            'Running rollback-only migration 0021 proof against dhumi_test...' `
            -ForegroundColor Cyan

        & psql -X -h localhost -U postgres -d dhumi_test `
            -v ON_ERROR_STOP=1 `
            -f $proof
        Assert-ChildSuccess `
            'Cancellation migration proof failed. Migration 0021 was not ledgered.'

        Write-Host 'Applying migration 0021 to dhumi_test...' `
            -ForegroundColor Cyan

        & (Join-Path $PSScriptRoot 'migrate.ps1') `
            -DatabaseUrl $TestDatabaseUrl
        Assert-ChildSuccess 'Migration 0021 failed on dhumi_test.'

        $expectedChecksum = (
            Get-FileHash -Algorithm SHA256 -LiteralPath $migration
        ).Hash.ToLowerInvariant()

        $ledgerSql = @"
SET ROLE dhumi_owner;
SELECT count(*)::text || '|' || COALESCE(max(checksum), '')
FROM app.schema_migrations
WHERE version = '0021_run_cancellation';
RESET ROLE;
"@
        $ledgerResult = (
            & psql -X -qAt -h localhost -U postgres -d dhumi_test `
                -v ON_ERROR_STOP=1 `
                -c $ledgerSql |
                Out-String
        ).Trim()
        Assert-ChildSuccess 'dhumi_test migration-ledger verification failed.'

        if ($ledgerResult -ne "1|$expectedChecksum") {
            throw "dhumi_test has an incorrect 0021 ledger entry: '$ledgerResult'."
        }

        $surfaceSql = @"
SET ROLE dhumi_owner;
SELECT
  (to_regprocedure(
    'app.lock_run_for_cancellation(uuid)'
  ) IS NOT NULL)::text || '|' ||
  (to_regclass(
    'app.outbox_events_one_jobs_cancel_per_run_idx'
  ) IS NOT NULL)::text || '|' ||
  (to_regclass(
    'app.run_events_one_cancellation_requested_per_run_idx'
  ) IS NOT NULL)::text || '|' ||
  has_function_privilege(
    'dhumi_admission',
    'app.lock_run_for_cancellation(uuid)',
    'EXECUTE'
  )::text || '|' ||
  (NOT has_function_privilege(
    'dhumi_admission',
    'app.transition_run(uuid,bigint,text,text,text,uuid,text,boolean,jsonb)',
    'EXECUTE'
  ))::text;
RESET ROLE;
"@
        $surfaceResult = (
            & psql -X -qAt -h localhost -U postgres -d dhumi_test `
                -v ON_ERROR_STOP=1 `
                -c $surfaceSql |
                Out-String
        ).Trim()
        Assert-ChildSuccess 'dhumi_test cancellation-surface verification failed.'

        if ($surfaceResult -ne 'true|true|true|true|true') {
            throw "dhumi_test has an incomplete cancellation surface: '$surfaceResult'."
        }

        Write-Host `
            'PASS - proof rolled back, migration 0021 ledgered, checksum and least privilege verified on dhumi_test.' `
            -ForegroundColor Green
    }
    finally {
        Pop-Location
    }
}
finally {
    if ($null -eq $oldPgPassword) {
        Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
    }
    else {
        $env:PGPASSWORD = $oldPgPassword
    }

    $plainPassword = $null
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
}
