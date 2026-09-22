<#
.SYNOPSIS
    Generates the local development secrets and writes back-end\.env.

.DESCRIPTION
    Creates five values:

      - a password for dhumi_dev_identity_login
      - a password for dhumi_dev_customer_api_login
      - a password for dhumi_dev_admission_login
      - an ACCESS_TOKEN_SECRET
      - a RESPONSE_ENVELOPE_LOCAL_KEY

    All three are written into .env, which is gitignored. The two database
    passwords are also delivered to the clipboard on demand, so they can be
    pasted into the psql \password prompt without ever appearing on screen or
    in console scrollback.

    Nothing is printed. A password shown in a terminal survives in scrollback,
    and a password typed at the wrong psql prompt is echoed and written to
    %APPDATA%\postgresql\psql_history in clear. Both have already happened once
    on this project.

    The values are distinct from the dhumi_test credentials by construction.
    Reusing them would mean a leak of the test environment also exposes
    dhumi_dev, and would let an access token minted against dhumi_test verify
    against dhumi_dev, since issuer, audience and signing key would all match.

.PARAMETER Copy
    Which generated value to place on the clipboard: Identity, CustomerApi,
    Admission, or None. Run once per password, at the moment psql asks for it.

.PARAMETER Force
    Overwrite an existing .env. Refused by default, because overwriting orphans
    the roles whose passwords the old file held.

.PARAMETER CompleteEnvelopeKey
    Add only a missing RESPONSE_ENVELOPE_LOCAL_KEY to an existing .env,
    .env.test, or both. Existing database credentials and signing secrets are
    preserved byte-for-byte. Existing envelope keys are validated, not rotated.

.PARAMETER StoreJanitorPassword
    Prompt securely for an existing development and/or test envelope-janitor
    password. The password and SET ROLE capability are verified against the
    target database before only DATABASE_ENVELOPE_JANITOR_PASSWORD is written.

.PARAMETER RotateJanitorPassword
    Generate a fresh envelope-janitor password for one environment, write it,
    and place it on the clipboard for the psql \password prompt. Use this when
    the assigned password is unknown or shorter than the 20-character floor
    that both this script and src\config\environment.ts enforce, because such a
    password can never be stored or loaded and is not recoverable from
    PostgreSQL. One environment per run: the clipboard holds one value, and
    development and test passwords must stay distinct.

.PARAMETER StoreAdmissionPassword
    Prompt securely for an existing development and/or test admission password.
    Login and SET ROLE are verified before the ignored environment file changes.

.PARAMETER RotateAdmissionPassword
    Generate and store one admission password, then place it on the clipboard
    for the corresponding hidden PostgreSQL password prompt.

.EXAMPLE
    .\scripts\New-LocalSecrets.ps1
    Generates the secrets and writes .env.

.EXAMPLE
    .\scripts\New-LocalSecrets.ps1 -Copy Identity
    Puts the identity password on the clipboard for the psql prompt.

.EXAMPLE
    .\scripts\New-LocalSecrets.ps1 -CompleteEnvelopeKey Both
    Safely completes the local response-envelope setting without rotating any
    database password or access-token secret.

.EXAMPLE
    .\scripts\New-LocalSecrets.ps1 -StoreJanitorPassword Both
    Verifies and stores the two already-assigned janitor passwords without
    printing them or changing either PostgreSQL role.

.EXAMPLE
    .\scripts\New-LocalSecrets.ps1 -RotateJanitorPassword Test
    Writes a fresh dhumi_test janitor password and hands back the exact psql
    command that sets the role to match.
#>
[CmdletBinding()]
param(
    [ValidateSet('None', 'Identity', 'CustomerApi', 'Admission')]
    [string]$Copy = 'None',
    [switch]$Force,
    [ValidateSet('None', 'Identity', 'CustomerApi', 'Admission')]
    [string]$RotateTest = 'None',
    [ValidateSet('None', 'Development', 'Test', 'Both')]
    [string]$CompleteEnvelopeKey = 'None',
    [ValidateSet('None', 'Development', 'Test', 'Both')]
    [string]$StoreJanitorPassword = 'None',
    # Deliberately no 'Both': the clipboard carries one value, and the two
    # environments must not share a janitor password.
    [ValidateSet('None', 'Development', 'Test')]
    [string]$RotateJanitorPassword = 'None',
    [ValidateSet('None', 'Development', 'Test', 'Both')]
    [string]$StoreAdmissionPassword = 'None',
    [ValidateSet('None', 'Development', 'Test')]
    [string]$RotateAdmissionPassword = 'None'
)

$ErrorActionPreference = 'Stop'
$backEnd = Split-Path -Parent $PSScriptRoot
Set-Location $backEnd

$envPath = Join-Path $backEnd '.env'
$templatePath = Join-Path $backEnd '.env.example'

function New-Secret {
    param([int]$Bytes)
    $buffer = New-Object byte[] $Bytes
    # RandomNumberGenerator::Create() exists on both .NET Framework, which
    # Windows PowerShell 5.1 runs on, and .NET 5+. The static Fill() method
    # does not: it is .NET Core only and fails on 5.1.
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
    # base64url: A-Z a-z 0-9 _ - only. Safe in a connection string, a psql
    # prompt and a .env file without quoting or escaping.
    return [Convert]::ToBase64String($buffer).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

function Complete-ResponseEnvelopeKey {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$DisplayName
    )

    if (-not (Test-Path $Path)) {
        throw "No $DisplayName file found at $Path."
    }

    $relativePath = Split-Path -Leaf $Path
    & git check-ignore -- $relativePath 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "$relativePath is not covered by .gitignore. Refusing to write a secret."
    }

    $content = [System.IO.File]::ReadAllText($Path)
    $matches = [regex]::Matches($content, '(?m)^RESPONSE_ENVELOPE_LOCAL_KEY=(.*)$')
    if ($matches.Count -gt 1) {
        throw "$DisplayName contains duplicate RESPONSE_ENVELOPE_LOCAL_KEY entries."
    }
    if ($matches.Count -eq 1) {
        $existing = $matches[0].Groups[1].Value.TrimEnd("`r")
        if ($existing -notmatch '^[A-Za-z0-9_-]{43}$') {
            throw "$DisplayName has an invalid RESPONSE_ENVELOPE_LOCAL_KEY; it was not changed."
        }
        Write-Host "$DisplayName already has a valid response-envelope key; unchanged." -ForegroundColor Green
        return
    }

    $newKey = New-Secret -Bytes 32
    $separator = if ($content.Length -eq 0 -or $content.EndsWith("`n")) { '' } else { [Environment]::NewLine }
    $updated = $content + $separator + "RESPONSE_ENVELOPE_LOCAL_KEY=$newKey" + [Environment]::NewLine
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $updated, $utf8WithoutBom)

    $verification = [regex]::Match(
        [System.IO.File]::ReadAllText($Path),
        '(?m)^RESPONSE_ENVELOPE_LOCAL_KEY=([A-Za-z0-9_-]{43})\r?$'
    )
    if (-not $verification.Success) {
        throw "RESPONSE_ENVELOPE_LOCAL_KEY was not written correctly to $DisplayName."
    }
    Write-Host "$DisplayName now has a generated response-envelope key; no other secret was changed." -ForegroundColor Green
}

function Read-EnvironmentSetting {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $matches = [regex]::Matches([System.IO.File]::ReadAllText($Path), "(?m)^$Name=(.*)\r?$")
    if ($matches.Count -ne 1) {
        throw "$Path must contain exactly one $Name entry."
    }
    return $matches[0].Groups[1].Value.TrimEnd("`r")
}

function Convert-SecureValue {
    param([Parameter(Mandatory = $true)][Security.SecureString]$Value)

    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

function Store-VerifiedCapabilityPassword {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$DisplayName,
        [Parameter(Mandatory = $true)][string]$CredentialLabel,
        [Parameter(Mandatory = $true)][string]$UserSetting,
        [Parameter(Mandatory = $true)][string]$PasswordSetting,
        [Parameter(Mandatory = $true)][string]$CapabilityRole
    )

    if (-not (Test-Path $Path)) {
        throw "No $DisplayName file found at $Path."
    }
    $relativePath = Split-Path -Leaf $Path
    & git check-ignore -- $relativePath 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "$relativePath is not covered by .gitignore. Refusing to write a password."
    }

    $securePassword = Read-Host "$DisplayName existing $CredentialLabel password" -AsSecureString
    $secureConfirmation = Read-Host "$DisplayName confirm $CredentialLabel password" -AsSecureString
    $password = Convert-SecureValue $securePassword
    $confirmation = Convert-SecureValue $secureConfirmation
    try {
        if ($password -cne $confirmation) {
            throw "$DisplayName password confirmation did not match; the file is unchanged."
        }
        # Node accepts single-quoted .env values. This preserves punctuation
        # such as spaces, # and $ without treating it as syntax. Newlines,
        # control characters and a literal single quote remain disallowed so
        # the serialized value stays one unambiguous setting.
        if (
            $password.Length -lt 20 -or
            $password.Length -gt 256 -or
            $password.Contains("'") -or
            $password -match '[\x00-\x1F\x7F]'
        ) {
            throw "$DisplayName password must be 20-256 printable characters without a single quote; the file is unchanged."
        }

        $databaseHost = Read-EnvironmentSetting -Path $Path -Name 'DATABASE_HOST'
        $databasePort = Read-EnvironmentSetting -Path $Path -Name 'DATABASE_PORT'
        $databaseName = Read-EnvironmentSetting -Path $Path -Name 'DATABASE_NAME'
        $databaseUser = Read-EnvironmentSetting -Path $Path -Name $UserSetting
        $psql = Get-Command psql -ErrorAction Stop
        $previousPgPassword = [Environment]::GetEnvironmentVariable('PGPASSWORD', 'Process')
        try {
            $env:PGPASSWORD = $password
            $probe = & $psql.Source -X -w -h $databaseHost -p $databasePort -U $databaseUser `
                -d $databaseName -Atqc `
                "BEGIN; SET LOCAL ROLE $CapabilityRole; SELECT current_user; ROLLBACK;" 2>&1
            if ($LASTEXITCODE -ne 0 -or $probe -notcontains $CapabilityRole) {
                throw "$DisplayName $CredentialLabel login or SET ROLE verification failed; the file is unchanged."
            }
        }
        finally {
            if ($null -eq $previousPgPassword) {
                Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
            }
            else {
                $env:PGPASSWORD = $previousPgPassword
            }
        }

        $content = [System.IO.File]::ReadAllText($Path)
        $matches = [regex]::Matches($content, "(?m)^$PasswordSetting=.*\r?$")
        if ($matches.Count -gt 1) {
            throw "$DisplayName contains duplicate $PasswordSetting entries."
        }
        if ($matches.Count -eq 1) {
            $serializedPassword = "$PasswordSetting='$password'"
            $updated = [regex]::Replace(
                $content,
                "(?m)^$PasswordSetting=.*\r?$",
                [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $serializedPassword }
            )
        }
        else {
            $separator = if ($content.Length -eq 0 -or $content.EndsWith("`n")) { '' } else { [Environment]::NewLine }
            $updated = $content + $separator + "$PasswordSetting='$password'" + [Environment]::NewLine
        }

        $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($Path, $updated, $utf8WithoutBom)
        Write-Host "$DisplayName $CredentialLabel credential verified and stored; no other setting changed." -ForegroundColor Green
    }
    finally {
        $password = $null
        $confirmation = $null
    }
}

function Rotate-CapabilityPassword {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$DisplayName,
        [Parameter(Mandatory = $true)][string]$ExpectedDatabase,
        [Parameter(Mandatory = $true)][string]$ExpectedRole,
        [Parameter(Mandatory = $true)][string]$CredentialLabel,
        [Parameter(Mandatory = $true)][string]$UserSetting,
        [Parameter(Mandatory = $true)][string]$PasswordSetting
    )

    if (-not (Test-Path $Path)) {
        throw "No $DisplayName file found at $Path."
    }
    $relativePath = Split-Path -Leaf $Path
    & git check-ignore -- $relativePath 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "$relativePath is not covered by .gitignore. Refusing to write a password."
    }

    $database = Read-EnvironmentSetting -Path $Path -Name 'DATABASE_NAME'
    if ($database -cne $ExpectedDatabase) {
        throw "Refusing to rotate: $DisplayName targets '$database', not $ExpectedDatabase."
    }

    # The janitor LOGIN name is deterministic per environment and is not a
    # secret. A file written from an older template carries no entry at all,
    # which previously failed deep inside the psql verification with a message
    # about the password. Add it when absent; never silently replace a
    # deliberate choice.
    $content = [System.IO.File]::ReadAllText($Path)
    $userMatches = [regex]::Matches($content, "(?m)^$UserSetting=(.*)\r?$")
    if ($userMatches.Count -gt 1) {
        throw "$DisplayName contains duplicate $UserSetting entries."
    }
    if ($userMatches.Count -eq 1) {
        $existingUser = $userMatches[0].Groups[1].Value.TrimEnd("`r")
        if ($existingUser -cne $ExpectedRole) {
            throw "$DisplayName sets $UserSetting to '$existingUser', not $ExpectedRole; resolve that before rotating."
        }
    }
    else {
        $separator = if ($content.Length -eq 0 -or $content.EndsWith("`n")) { '' } else { [Environment]::NewLine }
        $content = $content + $separator + "$UserSetting=$ExpectedRole" + [Environment]::NewLine
        Write-Host "$DisplayName had no $UserSetting; added $ExpectedRole." -ForegroundColor Yellow
    }

    # 32 bytes -> 43 base64url characters, past the 20-character floor that
    # both this script and the configuration schema enforce.
    $newPassword = New-Secret -Bytes 32

    # Serialized exactly as -StoreJanitorPassword writes it, so both modes
    # leave this setting in one format.
    $serialized = "$PasswordSetting='$newPassword'"
    $passwordMatches = [regex]::Matches($content, "(?m)^$PasswordSetting=.*\r?$")
    if ($passwordMatches.Count -gt 1) {
        throw "$DisplayName contains duplicate $PasswordSetting entries."
    }
    if ($passwordMatches.Count -eq 1) {
        $updated = [regex]::Replace(
            $content,
            "(?m)^$PasswordSetting=.*\r?$",
            [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $serialized }
        )
    }
    else {
        $separator = if ($content.Length -eq 0 -or $content.EndsWith("`n")) { '' } else { [Environment]::NewLine }
        $updated = $content + $separator + $serialized + [Environment]::NewLine
    }

    # The file is written and verified FIRST, so the only step that can still
    # fail is the psql one and re-running stays safe. A hand-edited file that
    # never saved is what desynchronised a role from its file previously.
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $updated, $utf8WithoutBom)

    $check = Read-EnvironmentSetting -Path $Path -Name $PasswordSetting
    if ($check -cne "'$newPassword'") {
        throw "$PasswordSetting was not written to $DisplayName; nothing was rotated."
    }

    Set-Clipboard -Value $newPassword

    Write-Host ''
    Write-Host "$DisplayName updated: $PasswordSetting is a fresh 43-character value." -ForegroundColor Green
    Write-Host 'The same value is on the clipboard. No value was printed.' -ForegroundColor Green
    Write-Host ''
    Write-Host 'Now set the role to match. Paste the clipboard at both hidden prompts:' -ForegroundColor Cyan
    Write-Host ''
    # Built by concatenation. A double-quoted PowerShell string turns the
    # backslash-1-8 and backslash-b in the path into escape sequences and
    # prints a mangled command.
    $sep = [char]92
    $psqlPath = @('C:', 'Program Files', 'PostgreSQL', '18', 'bin', 'psql.exe') -join $sep
    $command = "  & '$psqlPath' -X -W -h localhost -U postgres -d $ExpectedDatabase -c " +
        [char]34 + $sep + 'password ' + $ExpectedRole + [char]34
    Write-Host $command
    Write-Host ''
    Write-Host 'Paste only at the two hidden password prompts. A password typed at a' -ForegroundColor Yellow
    Write-Host 'SQL prompt is echoed and stored in psql_history in clear.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host 'Then confirm the role and file agree, and clear the clipboard:' -ForegroundColor Cyan
    Write-Host '  npm run test:database'
    Write-Host '  Set-Clipboard -Value " "'
    Write-Host ''
}

# Each comparison is parenthesised deliberately. PowerShell binds the comma
# tighter than -ne, so the unparenthesised form parsed as one chained
# comparison against an array rather than five booleans: the collapsed result
# always had Count 1, and this guard silently never rejected anything.
$selectedModes = @(
    ($CompleteEnvelopeKey -ne 'None'),
    ($StoreJanitorPassword -ne 'None'),
    ($RotateJanitorPassword -ne 'None'),
    ($StoreAdmissionPassword -ne 'None'),
    ($RotateAdmissionPassword -ne 'None'),
    ($RotateTest -ne 'None'),
    ($Copy -ne 'None')
) | Where-Object { $_ }
if ($selectedModes.Count -gt 1 -or ($Force -and $selectedModes.Count -gt 0)) {
    throw 'Choose exactly one completion, storage, rotation, copy, or generation mode.'
}

# ---------------------------------------------------------------------------
# Janitor rotation: for a password that is unknown or below the 20-character
# floor. Such a value cannot be stored by -StoreJanitorPassword and cannot be
# loaded by the worker, and PostgreSQL stores only a verifier, so recovery is
# impossible and rotation is the only path.
# ---------------------------------------------------------------------------
if ($RotateJanitorPassword -ne 'None') {
    if ($RotateJanitorPassword -eq 'Development') {
        Rotate-CapabilityPassword -Path $envPath -DisplayName '.env' `
            -ExpectedDatabase 'dhumi_dev' -ExpectedRole 'dhumi_dev_envelope_janitor_login' `
            -CredentialLabel 'envelope-janitor' `
            -UserSetting 'DATABASE_ENVELOPE_JANITOR_USER' `
            -PasswordSetting 'DATABASE_ENVELOPE_JANITOR_PASSWORD'
    }
    else {
        Rotate-CapabilityPassword -Path (Join-Path $backEnd '.env.test') -DisplayName '.env.test' `
            -ExpectedDatabase 'dhumi_test' -ExpectedRole 'dhumi_test_envelope_janitor_login' `
            -CredentialLabel 'envelope-janitor' `
            -UserSetting 'DATABASE_ENVELOPE_JANITOR_USER' `
            -PasswordSetting 'DATABASE_ENVELOPE_JANITOR_PASSWORD'
    }
    exit 0
}

if ($StoreJanitorPassword -ne 'None') {
    if ($StoreJanitorPassword -in @('Development', 'Both')) {
        Store-VerifiedCapabilityPassword -Path $envPath -DisplayName '.env' `
            -CredentialLabel 'envelope-janitor' `
            -UserSetting 'DATABASE_ENVELOPE_JANITOR_USER' `
            -PasswordSetting 'DATABASE_ENVELOPE_JANITOR_PASSWORD' `
            -CapabilityRole 'dhumi_envelope_janitor'
    }
    if ($StoreJanitorPassword -in @('Test', 'Both')) {
        Store-VerifiedCapabilityPassword -Path (Join-Path $backEnd '.env.test') -DisplayName '.env.test' `
            -CredentialLabel 'envelope-janitor' `
            -UserSetting 'DATABASE_ENVELOPE_JANITOR_USER' `
            -PasswordSetting 'DATABASE_ENVELOPE_JANITOR_PASSWORD' `
            -CapabilityRole 'dhumi_envelope_janitor'
    }
    Write-Host 'Janitor credential storage finished. No value was printed or copied.' -ForegroundColor Cyan
    exit 0
}

if ($RotateAdmissionPassword -ne 'None') {
    if ($RotateAdmissionPassword -eq 'Development') {
        Rotate-CapabilityPassword -Path $envPath -DisplayName '.env' `
            -ExpectedDatabase 'dhumi_dev' -ExpectedRole 'dhumi_dev_admission_login' `
            -CredentialLabel 'admission' `
            -UserSetting 'DATABASE_ADMISSION_USER' `
            -PasswordSetting 'DATABASE_ADMISSION_PASSWORD'
    }
    else {
        Rotate-CapabilityPassword -Path (Join-Path $backEnd '.env.test') -DisplayName '.env.test' `
            -ExpectedDatabase 'dhumi_test' -ExpectedRole 'dhumi_test_admission_login' `
            -CredentialLabel 'admission' `
            -UserSetting 'DATABASE_ADMISSION_USER' `
            -PasswordSetting 'DATABASE_ADMISSION_PASSWORD'
    }
    exit 0
}

if ($StoreAdmissionPassword -ne 'None') {
    if ($StoreAdmissionPassword -in @('Development', 'Both')) {
        Store-VerifiedCapabilityPassword -Path $envPath -DisplayName '.env' `
            -CredentialLabel 'admission' `
            -UserSetting 'DATABASE_ADMISSION_USER' `
            -PasswordSetting 'DATABASE_ADMISSION_PASSWORD' `
            -CapabilityRole 'dhumi_admission'
    }
    if ($StoreAdmissionPassword -in @('Test', 'Both')) {
        Store-VerifiedCapabilityPassword -Path (Join-Path $backEnd '.env.test') -DisplayName '.env.test' `
            -CredentialLabel 'admission' `
            -UserSetting 'DATABASE_ADMISSION_USER' `
            -PasswordSetting 'DATABASE_ADMISSION_PASSWORD' `
            -CapabilityRole 'dhumi_admission'
    }
    Write-Host 'Admission credential storage finished. No value was printed or copied.' -ForegroundColor Cyan
    exit 0
}

# ---------------------------------------------------------------------------
# Completion mode: repair only the missing local response-envelope setting.
# This is safe for environments whose database LOGIN passwords already exist.
# ---------------------------------------------------------------------------
if ($CompleteEnvelopeKey -ne 'None') {
    if ($CompleteEnvelopeKey -in @('Development', 'Both')) {
        Complete-ResponseEnvelopeKey -Path $envPath -DisplayName '.env'
    }
    if ($CompleteEnvelopeKey -in @('Test', 'Both')) {
        Complete-ResponseEnvelopeKey -Path (Join-Path $backEnd '.env.test') -DisplayName '.env.test'
    }
    Write-Host 'Envelope completion finished. No value was printed or copied.' -ForegroundColor Cyan
    exit 0
}

# ---------------------------------------------------------------------------
# Rotate mode: generate one new password, write it into .env.test, and place it
# on the clipboard for the psql prompt.
#
# The file is written FIRST and verified, so the only step that can still fail
# is the psql one, and re-running is safe. Editing .env.test by hand is what
# desynchronised the role from the file previously: the role password changed
# and the manual edit never saved.
# ---------------------------------------------------------------------------
if ($RotateTest -ne 'None') {
    $testEnvPath = Join-Path $backEnd '.env.test'
    if (-not (Test-Path $testEnvPath)) { throw "No .env.test found at $testEnvPath." }

    $ignoredTest = & git check-ignore .env.test 2>$null
    if ($LASTEXITCODE -ne 0) { throw '.env.test is not covered by .gitignore.' }

    $key = if ($RotateTest -eq 'Identity') { 'DATABASE_IDENTITY_PASSWORD' }
           elseif ($RotateTest -eq 'CustomerApi') { 'DATABASE_CUSTOMER_API_PASSWORD' }
           else { 'DATABASE_ADMISSION_PASSWORD' }
    $role = if ($RotateTest -eq 'Identity') { 'dhumi_test_identity_login' }
            elseif ($RotateTest -eq 'CustomerApi') { 'dhumi_test_customer_api_login' }
            else { 'dhumi_test_admission_login' }

    $database = ((Get-Content $testEnvPath | Where-Object { $_ -match '^DATABASE_NAME=' }) -split '=', 2)[1]
    if ($database -ne 'dhumi_test') {
        throw "Refusing to rotate: .env.test targets '$database', not dhumi_test."
    }

    $newPassword = New-Secret -Bytes 32

    $testContent = Get-Content $testEnvPath -Raw
    $testContent = $testContent -replace "(?m)^$key=.*$", "$key=$newPassword"
    [System.IO.File]::WriteAllText($testEnvPath, $testContent)

    $check = ((Get-Content $testEnvPath | Where-Object { $_ -match "^$key=" }) -split '=', 2)[1]
    if ($check -cne $newPassword) {
        throw "$key was not written to .env.test. The file is unchanged; nothing was rotated."
    }

    Set-Clipboard -Value $newPassword

    Write-Host ''
    Write-Host ".env.test updated: $key is now a fresh 43-character value." -ForegroundColor Green
    Write-Host 'The same value is on the clipboard.' -ForegroundColor Green
    Write-Host ''
    Write-Host 'Now set the role to match. Paste the clipboard at both hidden prompts:' -ForegroundColor Cyan
    Write-Host ''
    # Built by concatenation. A double-quoted PowerShell string turns the
    # backslash-1-8 and backslash-b in the path into escape sequences and
    # prints a mangled command.
    $sep = [char]92
    $psqlPath = @('C:', 'Program Files', 'PostgreSQL', '18', 'bin', 'psql.exe') -join $sep
    $command = "  & '$psqlPath' -X -W -h localhost -U postgres -d dhumi_test -c " +
        [char]34 + $sep + 'password ' + $role + [char]34
    Write-Host $command
    Write-Host ''
    Write-Host 'Then verify and clear:' -ForegroundColor Cyan
    Write-Host '  npm run test:database'
    Write-Host '  Set-Clipboard -Value " "'
    Write-Host ''
    exit 0
}

# ---------------------------------------------------------------------------
# Copy mode: read an existing .env, put one password on the clipboard, exit.
# ---------------------------------------------------------------------------
if ($Copy -ne 'None') {
    if (-not (Test-Path $envPath)) {
        throw "No .env found. Run this script without -Copy first."
    }

    $key = if ($Copy -eq 'Identity') { 'DATABASE_IDENTITY_PASSWORD' }
           elseif ($Copy -eq 'CustomerApi') { 'DATABASE_CUSTOMER_API_PASSWORD' }
           else { 'DATABASE_ADMISSION_PASSWORD' }

    $line = Get-Content $envPath | Where-Object { $_ -match "^$key=" } | Select-Object -First 1
    if (-not $line) { throw "$key not found in .env." }

    $value = ($line -split '=', 2)[1]
    if ([string]::IsNullOrWhiteSpace($value)) { throw "$key is empty in .env." }

    Set-Clipboard -Value $value
    Write-Host "$key is on the clipboard. Paste it at the psql prompt." -ForegroundColor Green
    Write-Host 'The clipboard still holds it afterwards. Clear it when finished:' -ForegroundColor Yellow
    Write-Host '  Set-Clipboard -Value " "' -ForegroundColor Yellow
    exit 0
}

# ---------------------------------------------------------------------------
# Generate mode
# ---------------------------------------------------------------------------
if (-not (Test-Path $templatePath)) {
    throw ".env.example not found at $templatePath."
}

if ((Test-Path $envPath) -and -not $Force) {
    throw ".env already exists. Pass -Force to replace it, but note that the roles created with the old passwords will no longer match."
}

# Refuse to write a file git would track.
$ignored = & git check-ignore .env 2>$null
if ($LASTEXITCODE -ne 0) {
    throw '.env is not covered by .gitignore. Fix that before generating secrets.'
}

# 32 bytes -> 43 characters, comfortably past the 20-character floor the
# configuration schema enforces for database passwords.
$identityPassword = New-Secret -Bytes 32
$customerApiPassword = New-Secret -Bytes 32
$admissionPassword = New-Secret -Bytes 32
# 48 bytes -> 64 characters, past the 32-character floor for the signing key.
$accessTokenSecret = New-Secret -Bytes 48
# 32 bytes is exactly the AES-256-GCM root required by the local adapter.
$responseEnvelopeLocalKey = New-Secret -Bytes 32

$content = Get-Content $templatePath -Raw
$content = $content -replace '(?m)^# Copy this file to \.env.*$',
    "# Generated by scripts\New-LocalSecrets.ps1. Never commit this file."
$content = $content -replace '(?m)^DATABASE_IDENTITY_PASSWORD=.*$',
    "DATABASE_IDENTITY_PASSWORD=$identityPassword"
$content = $content -replace '(?m)^DATABASE_CUSTOMER_API_PASSWORD=.*$',
    "DATABASE_CUSTOMER_API_PASSWORD=$customerApiPassword"
$content = $content -replace '(?m)^DATABASE_ADMISSION_PASSWORD=.*$',
    "DATABASE_ADMISSION_PASSWORD=$admissionPassword"
$content = $content -replace '(?m)^ACCESS_TOKEN_SECRET=.*$',
    "ACCESS_TOKEN_SECRET=$accessTokenSecret"
$content = $content -replace '(?m)^RESPONSE_ENVELOPE_LOCAL_KEY=.*$',
    "RESPONSE_ENVELOPE_LOCAL_KEY=$responseEnvelopeLocalKey"

[System.IO.File]::WriteAllText($envPath, $content)

# Verify every secret actually landed, rather than trusting the replacements.
$written = Get-Content $envPath
$checks = @{
    'DATABASE_IDENTITY_PASSWORD'     = 20
    'DATABASE_CUSTOMER_API_PASSWORD' = 20
    'DATABASE_ADMISSION_PASSWORD'    = 20
    'ACCESS_TOKEN_SECRET'            = 32
    'RESPONSE_ENVELOPE_LOCAL_KEY'    = 43
}
foreach ($key in $checks.Keys) {
    $line = $written | Where-Object { $_ -match "^$key=" } | Select-Object -First 1
    $value = if ($line) { ($line -split '=', 2)[1] } else { '' }
    if ($value.Length -lt $checks[$key]) {
        throw "$key was not written correctly. Delete .env and try again."
    }
}

$database = (($written | Where-Object { $_ -match '^DATABASE_NAME=' }) -split '=', 2)[1]

Write-Host ''
Write-Host 'Wrote .env with five freshly generated secrets.' -ForegroundColor Green
Write-Host '  DATABASE_IDENTITY_PASSWORD      43 characters'
Write-Host '  DATABASE_CUSTOMER_API_PASSWORD  43 characters'
Write-Host '  DATABASE_ADMISSION_PASSWORD     43 characters'
Write-Host '  ACCESS_TOKEN_SECRET             64 characters'
Write-Host '  RESPONSE_ENVELOPE_LOCAL_KEY     43 characters'
Write-Host ''
Write-Host "Target database: $database"
Write-Host ''
Write-Host 'Values are not printed. Use -Copy to move one to the clipboard when' -ForegroundColor Yellow
Write-Host 'psql asks for it.' -ForegroundColor Yellow
Write-Host ''
Write-Host 'Next:' -ForegroundColor Cyan
Write-Host '  1. Fix the \password placement in scripts\bootstrap\0004_runtime_login_roles.sql'
Write-Host '     so a typo cannot discard the role creation and grants together.'
Write-Host '  2. Create the roles, pasting each password when prompted:'
Write-Host '       .\scripts\New-LocalSecrets.ps1 -Copy Identity'
Write-Host '       .\scripts\New-LocalSecrets.ps1 -Copy CustomerApi'
Write-Host '       .\scripts\New-LocalSecrets.ps1 -Copy Admission'
Write-Host '  3. Clear the clipboard afterwards:  Set-Clipboard -Value " "'
Write-Host ''
