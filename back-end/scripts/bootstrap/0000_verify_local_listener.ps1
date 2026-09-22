[CmdletBinding()]
param(
    [Parameter()]
    [ValidateRange(1, 65535)]
    [int]$Port = 5432
)

$ErrorActionPreference = 'Stop'

$allowedAddresses = @('127.0.0.1', '::1')
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop)

if ($listeners.Count -eq 0) {
    throw "No process is listening on TCP port $Port."
}

$externalListeners = @(
    $listeners | Where-Object { $_.LocalAddress -notin $allowedAddresses }
)

if ($externalListeners.Count -gt 0) {
    $unsafeBindings = ($externalListeners | ForEach-Object {
        "$($_.LocalAddress):$($_.LocalPort)"
    }) -join ', '

    throw "PostgreSQL is not loopback-only. Unsafe listener(s): $unsafeBindings"
}

$listeners |
    Sort-Object LocalAddress, LocalPort |
    Select-Object LocalAddress, LocalPort, OwningProcess

Write-Host "PASS: TCP port $Port is listening only on IPv4/IPv6 loopback."
