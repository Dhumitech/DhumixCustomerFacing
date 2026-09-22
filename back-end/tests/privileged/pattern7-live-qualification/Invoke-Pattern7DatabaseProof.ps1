[CmdletBinding()]
param(
    [string]$Database = 'dhumi_test'
)

$ErrorActionPreference = 'Stop'
if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    throw 'psql was not found on PATH.'
}

$securePassword = Read-Host 'PostgreSQL administrator password (held only by the proof child process)' -AsSecureString
$pointer = [IntPtr]::Zero
$plainPassword = $null
$previousPassword = $env:PGPASSWORD
try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $env:PGPASSWORD = $plainPassword
    & psql -X -h localhost -p 5432 -U postgres -d $Database `
        --pset=pager=off -v ON_ERROR_STOP=1 `
        -f '.\tests\integration\0024_amazon_live_qualification.sql'
    if ($LASTEXITCODE -ne 0) {
        throw 'Pattern 7 rollback-only database proof failed.'
    }
    Write-Host 'Pattern 7 rollback-only database proof passed.'
}
finally {
    if ($null -eq $previousPassword) {
        Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
    }
    else {
        $env:PGPASSWORD = $previousPassword
    }
    $plainPassword = $null
    if ($pointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}
