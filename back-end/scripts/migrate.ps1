[CmdletBinding()]
param(
    [Parameter()]
    [string]$DatabaseUrl = $env:DATABASE_URL,

    [Parameter()]
    [string]$MigrationOwnerRole = 'dhumi_owner',

    [Parameter()]
    [switch]$PromptForPassword
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

if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    throw 'psql was not found on PATH. Install a supported PostgreSQL client before running migrations.'
}

$migrationDirectory = Join-Path $PSScriptRoot 'migrations'
$migrations = Get-ChildItem -LiteralPath $migrationDirectory -Filter '*.sql' |
    Sort-Object Name

if ($migrations.Count -eq 0) {
    throw "No SQL migrations found in $migrationDirectory"
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
        $trackingExists = & psql -X --dbname=$DatabaseUrl --tuples-only --no-align --quiet `
            --set=ON_ERROR_STOP=1 `
            --command "SET ROLE dhumi_owner; SELECT to_regclass('app.schema_migrations') IS NOT NULL; RESET ROLE;"
        if ($LASTEXITCODE -ne 0) {
            throw 'Could not inspect the migration ledger.'
        }

        if ($trackingExists.Trim() -eq 't') {
            $recordedChecksum = & psql -X --dbname=$DatabaseUrl --tuples-only --no-align --quiet `
                --set=ON_ERROR_STOP=1 `
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
        & psql -X --dbname=$DatabaseUrl `
            --set=ON_ERROR_STOP=1 `
            --single-transaction `
            "--file=$migrationPath" `
            --command $ledgerInsertSql
        if ($LASTEXITCODE -ne 0) {
            throw "Migration failed: $($migration.Name)"
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
