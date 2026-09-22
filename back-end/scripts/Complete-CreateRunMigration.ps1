[CmdletBinding()]
param(
    [Parameter()]
    [string]$TestDatabaseUrl = 'postgresql://postgres@localhost:5432/dhumi_test',

    [Parameter()]
    [string]$DevelopmentDatabaseUrl = 'postgresql://postgres@localhost:5432/dhumi_dev'
)

$ErrorActionPreference = 'Stop'

foreach ($databaseUrl in @($TestDatabaseUrl, $DevelopmentDatabaseUrl)) {
    if ($databaseUrl -match '(?i)://[^/@\s]+:[^/@\s]+@' -or
        $databaseUrl -match '(?i)(^|\s)password\s*=') {
        throw 'Database URLs must not contain passwords.'
    }
}

if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    throw 'psql was not found on PATH.'
}

$backEnd = Split-Path -Parent $PSScriptRoot
$passwordPointer = [IntPtr]::Zero
$plainPassword = $null
$oldPgPassword = $env:PGPASSWORD
$oldPrivilegedUrl = $env:PRIVILEGED_TEST_DATABASE_URL
$oldPrivilegedFlag = $env:RUN_CREATE_RUN_PRIVILEGED_TESTS
$oldDatabaseFlag = $env:RUN_DATABASE_INTEGRATION_TESTS

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
        # Test receives every pending migration first. 0018 is already safely
        # ledgered in the reported environment; 0019 supplies the restricted
        # Service row-lock boundary discovered by the runtime proof.
        & (Join-Path $PSScriptRoot 'migrate.ps1') `
            -DatabaseUrl $TestDatabaseUrl

        & psql -X -h localhost -U postgres -d dhumi_test `
            -v ON_ERROR_STOP=1 `
            -f .\tests\integration\0011_run_admission.sql
        Assert-ChildSuccess `
            'Run-admission SQL proof failed. dhumi_dev was not migrated.'

        & npm run typecheck
        Assert-ChildSuccess `
            'Typecheck failed. dhumi_dev was not migrated.'

        & npm test
        Assert-ChildSuccess `
            'Application tests failed. dhumi_dev was not migrated.'

        & npm run test:database
        Assert-ChildSuccess `
            'Database tests failed. dhumi_dev was not migrated.'

        $env:PRIVILEGED_TEST_DATABASE_URL = $TestDatabaseUrl
        $env:RUN_CREATE_RUN_PRIVILEGED_TESTS = 'true'
        $env:RUN_DATABASE_INTEGRATION_TESTS = 'true'

        & node --env-file-if-exists=.env.test `
            node_modules/vitest/vitest.mjs run `
            tests/privileged/create-run-concurrency-database.test.ts `
            --config vitest.privileged.config.ts `
            --reporter=verbose
        Assert-ChildSuccess `
            'Privileged Run tests failed. dhumi_dev was not migrated.'

        & npm run build
        Assert-ChildSuccess `
            'Build failed. dhumi_dev was not migrated.'

        # Dev advances only after the identical test migration and all proof
        # layers have succeeded.
        & (Join-Path $PSScriptRoot 'migrate.ps1') `
            -DatabaseUrl $DevelopmentDatabaseUrl

        $migrations = @(
            '0018_run_admission',
            '0019_run_service_lock'
        )

        foreach ($database in @('dhumi_test', 'dhumi_dev')) {
            foreach ($version in $migrations) {
                $migrationPath = Join-Path `
                    $PSScriptRoot `
                    "migrations\$version.sql"
                $expectedChecksum = (
                    Get-FileHash -Algorithm SHA256 -LiteralPath $migrationPath
                ).Hash.ToLowerInvariant()
                $ledgerSql = @"
SET ROLE dhumi_owner;
SELECT count(*)::text || '|' || COALESCE(max(checksum), '')
FROM app.schema_migrations
WHERE version = '$version';
RESET ROLE;
"@
                $ledgerResult = (
                    & psql -X -qAt -h localhost -U postgres -d $database `
                        -v ON_ERROR_STOP=1 `
                        -c $ledgerSql |
                        Out-String
                ).Trim()
                Assert-ChildSuccess "$database ledger query failed."

                if ($ledgerResult -ne "1|$expectedChecksum") {
                    throw "$database has an incorrect $version ledger entry: '$ledgerResult'."
                }
            }

            $surfaceSql = @"
SET ROLE dhumi_owner;
SELECT
  (to_regprocedure(
    'app.require_phase5_mock_run_capacity(text)'
  ) IS NOT NULL)::text || '|' ||
  (to_regprocedure(
    'app.lock_service_for_run(uuid)'
  ) IS NOT NULL)::text || '|' ||
  EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'app.runs'::regclass
      AND attname = 'validated_input'
      AND NOT attisdropped
      AND attnotnull
  )::text || '|' ||
  EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE connamespace = 'app'::regnamespace
      AND conname = 'outbox_events_jobs_execute_shape_check'
  )::text;
RESET ROLE;
"@
            $surfaceResult = (
                & psql -X -qAt -h localhost -U postgres -d $database `
                    -v ON_ERROR_STOP=1 `
                    -c $surfaceSql |
                    Out-String
            ).Trim()
            Assert-ChildSuccess "$database schema verification failed."

            if ($surfaceResult -ne 'true|true|true|true') {
                throw "$database has an incomplete Run surface: '$surfaceResult'."
            }

            Write-Host `
                "$database - PASS: ledgers, checksums and Run surface verified." `
                -ForegroundColor Green
        }

        Write-Host `
            'FINAL PASS - createRun migrations and proofs completed.' `
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

    if ($null -eq $oldPrivilegedUrl) {
        Remove-Item Env:PRIVILEGED_TEST_DATABASE_URL `
            -ErrorAction SilentlyContinue
    }
    else {
        $env:PRIVILEGED_TEST_DATABASE_URL = $oldPrivilegedUrl
    }

    if ($null -eq $oldPrivilegedFlag) {
        Remove-Item Env:RUN_CREATE_RUN_PRIVILEGED_TESTS `
            -ErrorAction SilentlyContinue
    }
    else {
        $env:RUN_CREATE_RUN_PRIVILEGED_TESTS = $oldPrivilegedFlag
    }

    if ($null -eq $oldDatabaseFlag) {
        Remove-Item Env:RUN_DATABASE_INTEGRATION_TESTS `
            -ErrorAction SilentlyContinue
    }
    else {
        $env:RUN_DATABASE_INTEGRATION_TESTS = $oldDatabaseFlag
    }

    $plainPassword = $null
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
}
