[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$backendRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$environmentPath = Join-Path $backendRoot '.env'
$passwordPointer = [IntPtr]::Zero
$plainPassword = $null

function Set-EnvironmentEntry(
    [string]$content,
    [string]$name,
    [string]$value
) {
    $escapedName = [Regex]::Escape($name)
    $replacement = "$name=$value"

    if ($content -match "(?m)^$escapedName=.*$") {
        return [Regex]::Replace(
            $content,
            "(?m)^$escapedName=.*$",
            [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $replacement }
        )
    }

    $separator = if ($content.Length -eq 0 -or $content.EndsWith("`n")) { '' } else { "`r`n" }
    return "$content$separator$replacement`r`n"
}

if (-not (Test-Path -LiteralPath $environmentPath -PathType Leaf)) {
    throw "Missing ignored environment file: $environmentPath"
}

try {
    $securePassword = Read-Host `
        'Dev operator password used for dhumi_dev_operator_login' `
        -AsSecureString

    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR(
        $securePassword
    )
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
        $passwordPointer
    )

    if ($plainPassword -notmatch '^[A-Za-z0-9_-]{24,}$') {
        throw 'DATABASE_OPERATOR_PASSWORD must be at least 24 URL-safe characters: A-Z, a-z, 0-9, underscore or hyphen.'
    }

    $content = [IO.File]::ReadAllText($environmentPath)
    $content = Set-EnvironmentEntry `
        -content $content `
        -name 'DATABASE_OPERATOR_USER' `
        -value 'dhumi_dev_operator_login'
    $content = Set-EnvironmentEntry `
        -content $content `
        -name 'DATABASE_OPERATOR_PASSWORD' `
        -value $plainPassword

    [IO.File]::WriteAllText(
        $environmentPath,
        $content,
        [Text.UTF8Encoding]::new($false)
    )

    Write-Host 'Dev operator credentials were stored in the ignored .env file.'
    Write-Host 'The password was not printed.'
}
finally {
    $plainPassword = $null
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
}
