[CmdletBinding()]
param(
    [Parameter()]
    [string]$DatabaseUrl = $env:DATABASE_URL,

    [Parameter()]
    [string]$MigrationOwnerRole = 'dhumi_owner',

    [Parameter()]
    [switch]$PromptForPassword,

    # Set only by the gated 0070 review launcher. This selects ONLY 0070; it
    # cannot bootstrap a database or advance to later refactor migrations.
    [ValidatePattern('^[A-Fa-f0-9]{64}$')]
    [string]$Reviewed0070Sha256,

    # Selects ONLY the reviewed organization cutover; never the whole chain.
    [ValidatePattern('^[A-Fa-f0-9]{64}$')]
    [string]$Reviewed0071Sha256,

    # Additive catalogue/execution expansion ONLY. Legacy writers stay active;
    # the later 0073 contraction has its own stopped-process cutover gates.
    [ValidatePattern('^[A-Fa-f0-9]{64}$')]
    [string]$Reviewed0072Sha256,

    # Catalogue/execution contraction ONLY, after its separate reviewed cutover.
    [ValidatePattern('^[A-Fa-f0-9]{64}$')]
    [string]$Reviewed0073Sha256,

    # Marketplace contraction ONLY, with matching qualified repositories.
    [ValidatePattern('^[A-Fa-f0-9]{64}$')]
    [string]$Reviewed0074Sha256,

    # Organization naming and final field contraction ONLY. Identities stay.
    [ValidatePattern('^[A-Fa-f0-9]{64}$')]
    [string]$Reviewed0075Sha256,

    [string]$PsqlPath
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($DatabaseUrl)) {
    throw 'DATABASE_URL is required. Use a privileged migration identity; do not use a customer or Bright Data credential.'
}

if ($MigrationOwnerRole -ne 'dhumi_owner') {
    throw 'MigrationOwnerRole must be dhumi_owner for the accepted database architecture.'
}

if ($DatabaseUrl -match '(?i)://[^/@\s]+:[^/@\s]+@' -or
    $DatabaseUrl -match '(?i)(^|\s)password\s*=') {
    throw 'DATABASE_URL must not contain a password. Use an interactive prompt or an approved external secret mechanism.'
}

$migrationDirectory = Join-Path $PSScriptRoot 'migrations'
$migrations = @(Get-ChildItem -LiteralPath $migrationDirectory -Filter '*.sql' |
    Sort-Object Name)

if (@($Reviewed0070Sha256,$Reviewed0071Sha256,$Reviewed0072Sha256,$Reviewed0073Sha256,$Reviewed0074Sha256,$Reviewed0075Sha256 | Where-Object { $_ }).Count -gt 1) {
    throw 'Select exactly one reviewed refactor migration.'
}
$reviewedPhase = if ($Reviewed0075Sha256) { '0075' } elseif ($Reviewed0074Sha256) { '0074' } elseif ($Reviewed0073Sha256) { '0073' } elseif ($Reviewed0072Sha256) { '0072' } elseif ($Reviewed0071Sha256) { '0071' } else { '0070' }
$reviewedHash = if ($Reviewed0075Sha256) { $Reviewed0075Sha256.ToLowerInvariant() } elseif ($Reviewed0074Sha256) { $Reviewed0074Sha256.ToLowerInvariant() } elseif ($Reviewed0073Sha256) { $Reviewed0073Sha256.ToLowerInvariant() } elseif ($Reviewed0072Sha256) { $Reviewed0072Sha256.ToLowerInvariant() } elseif ($Reviewed0071Sha256) { $Reviewed0071Sha256.ToLowerInvariant() } else { ([string]$Reviewed0070Sha256).ToLowerInvariant() }

if (-not [string]::IsNullOrWhiteSpace($reviewedHash)) {
    if ($DatabaseUrl -cnotmatch '^postgresql://(?<admin>[A-Za-z_][A-Za-z0-9_]*)@localhost:5432/dhumi_test$') {
        throw "$reviewedPhase is restricted to the review launcher target localhost:5432/dhumi_test."
    }
    if ($Matches['admin'] -like 'dhumi_test_*_login') {
        throw "$reviewedPhase requires an authorized migration administrator, not a runtime identity."
    }
    $expectedOptions = "-c dhumi.refactor_apply=$reviewedPhase -c dhumi.backup_restore_verified=yes -c dhumi.matching_backend_ready=yes -c dhumi.processes_stopped=yes -c dhumi.queue_compatibility_verified=yes -c dhumi.reviewed_sql_sha256=$reviewedHash"
    if ($reviewedPhase -eq '0072') {
        $expectedOptions = "-c dhumi.refactor_apply=0072 -c dhumi.backup_restore_verified=yes -c dhumi.old_writers_qualified=yes -c dhumi.reviewed_sql_sha256=$reviewedHash -c dhumi.owner_approved=yes"
    }
    if ($reviewedPhase -eq '0071') {
        $expectedOptions += ' -c dhumi.owner_approved=yes -c dhumi.organization_privileges_qualified=yes -c dhumi.write_path_qualified=yes'
    }
    if ($reviewedPhase -in @('0073','0074','0075')) {
        $expectedOptions = "-c dhumi.refactor_apply=$reviewedPhase -c dhumi.backup_restore_verified=yes -c dhumi.backend_qualified=yes -c dhumi.reviewed_sql_sha256=$reviewedHash -c dhumi.owner_approved=yes"
    }
    if ($env:PGOPTIONS -cne $expectedOptions) {
        throw "$reviewedPhase requires the exact review/backup/cutover gates from its review launcher."
    }
    $reviewedName = if ($reviewedPhase -eq '0075') { '0075_naming.sql' } elseif ($reviewedPhase -eq '0074') { '0074_marketplace.sql' } elseif ($reviewedPhase -eq '0073') { '0073_catalogue_execution_contract.sql' } elseif ($reviewedPhase -eq '0072') { '0072_catalogue_execution_expand.sql' } elseif ($reviewedPhase -eq '0071') { '0071_organizations.sql' } else { '0070_archive.sql' }
    $migrations = @($migrations | Where-Object { $_.Name -ceq $reviewedName })
    if ($migrations.Count -ne 1 -or
        (Get-FileHash -LiteralPath $migrations[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $reviewedHash) {
        throw "The reviewed $reviewedPhase migration is absent or its checksum changed."
    }
} elseif (@($migrations | Where-Object { $_.Name -match '^007[0-5]_' }).Count -gt 0) {
    # Refuse BEFORE any connection or historical writes. Dated clean-clone
    # harnesses are not authorization to cross this destructive cutover.
    throw 'Refactor migrations require their phase-specific review launcher; this generic command cannot apply the full refactor chain.'
}

if ($migrations.Count -eq 0) {
    throw "No SQL migrations found in $migrationDirectory"
}

if ([string]::IsNullOrWhiteSpace($PsqlPath)) {
    $client = Get-Command psql -ErrorAction SilentlyContinue
    if ($null -eq $client) {
        throw 'psql was not found on PATH. Supply the path of an already installed supported client.'
    }
    $PsqlPath = $client.Source
}
if (-not (Test-Path -LiteralPath $PsqlPath -PathType Leaf)) {
    throw 'The supplied psql client path does not exist.'
}
$clientArguments = @('-X', "--dbname=$DatabaseUrl", '--set=ON_ERROR_STOP=1')
if (-not [string]::IsNullOrWhiteSpace($reviewedHash)) {
    $clientArguments += @('--no-password', '--set=VERBOSITY=terse')
}

$passwordPointer = [IntPtr]::Zero
$plainPassword = $null
$oldPgPassword = $env:PGPASSWORD

try {
    if ($PromptForPassword) {
        $securePassword = Read-Host 'PostgreSQL password (held only for migration child processes)' -AsSecureString
        $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
        $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
        $env:PGPASSWORD = $plainPassword
    }

    foreach ($migration in $migrations) {
        $version = [System.IO.Path]::GetFileNameWithoutExtension($migration.Name)
        $checksum = (Get-FileHash -LiteralPath $migration.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        $migrationPath = $migration.FullName

        if (-not [string]::IsNullOrWhiteSpace($reviewedHash) -and $checksum -ne $reviewedHash) {
            throw "$reviewedPhase changed after review; no SQL was executed."
        }

        if ($version -notmatch '^[A-Za-z0-9_.-]+$') {
            throw "Migration filename contains unsupported characters: $($migration.Name)"
        }
        if ($checksum -notmatch '^[0-9a-f]{64}$') {
            throw "Migration checksum is not a valid SHA-256 value: $($migration.Name)"
        }

        # Both values are generated locally and validated above before being placed
        # in SQL literals. They never contain user input or secrets.
        $ledgerLookupSql = "SET ROLE dhumi_owner; SELECT checksum FROM app.schema_migrations WHERE version = '$version'; RESET ROLE;"
        $ledgerInsertSql = "SET ROLE dhumi_owner; INSERT INTO app.schema_migrations (version, checksum) VALUES ('$version', '$checksum'); RESET ROLE;"
        $trackingExists = & $PsqlPath @clientArguments --tuples-only --no-align --quiet `
            --command "SET ROLE dhumi_owner; SELECT to_regclass('app.schema_migrations') IS NOT NULL; RESET ROLE;"
        if ($LASTEXITCODE -ne 0) {
            throw 'Could not inspect the migration ledger.'
        }
        if (-not [string]::IsNullOrWhiteSpace($reviewedHash) -and $trackingExists.Trim() -ne 't') {
            throw "$reviewedPhase requires an existing migration ledger; it cannot bootstrap a database."
        }

        if ($trackingExists.Trim() -eq 't') {
            $recordedChecksum = & $PsqlPath @clientArguments --tuples-only --no-align --quiet `
                --command $ledgerLookupSql
            if ($LASTEXITCODE -ne 0) {
                throw "Could not read the migration ledger for $($migration.Name)"
            }
            if (-not [string]::IsNullOrWhiteSpace($recordedChecksum)) {
                if ($recordedChecksum.Trim() -ne $checksum) {
                    throw "Migration checksum changed after application: $($migration.Name). Create a new forward-only migration instead of editing it."
                }
                Write-Host "Skipping $($migration.Name) (already applied)"
                continue
            }
        }

        Write-Host "Applying $($migration.Name)"
        if (-not [string]::IsNullOrWhiteSpace($reviewedHash) -and
            (Get-FileHash -LiteralPath $migrationPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $reviewedHash) {
            throw "$reviewedPhase changed before application; inspect its new checksum."
        }
        & $PsqlPath @clientArguments `
            --single-transaction `
            "--file=$migrationPath" `
            --command $ledgerInsertSql
        if ($LASTEXITCODE -ne 0) {
            throw "Migration failed: $($migration.Name). Inspect the error and ledger before retrying."
        }
    }
}
finally {
    if ($PromptForPassword) {
        if ($null -eq $oldPgPassword) {
            Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
        } else {
            $env:PGPASSWORD = $oldPgPassword
        }
        $plainPassword = $null
        if ($passwordPointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
        }
    }
}
