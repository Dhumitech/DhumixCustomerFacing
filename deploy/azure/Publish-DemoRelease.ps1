<#
.SYNOPSIS
  Copies the current source and one prepared private bundle to the demo VM,
  then builds and starts deploy/demo there (vm-deploy.sh).

.DESCRIPTION
  Without -Execute this only validates inputs and prints what it would send.
  The bundle must come from back-end/scripts/local-demo/prepare-deployment.mjs
  with --public-origin=https://<VmHost>. Secrets travel only over SSH; they are
  never written into the source archive (the archive excludes .env*, .runtime,
  *.private.* and node_modules). An existing bundle on the VM is never replaced.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$VmHost,
  [Parameter(Mandatory = $true)][string]$BundleName,
  [string]$AdminUser = 'azureuser',
  [string]$SshKeyPath = (Join-Path $env:USERPROFILE '.ssh\dhumi_demo_ed25519'),
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [switch]$Execute
)
$ErrorActionPreference = 'Stop'
function Assert-LastExit([string]$Step) { if ($LASTEXITCODE -ne 0) { throw "Failed: $Step" } }

$bundle = Join-Path $RepoRoot "back-end\.runtime\$BundleName"
$prepared = Join-Path $bundle 'prepared.json'
if (-not (Test-Path $prepared)) { throw "No prepared bundle at $bundle - run prepare-deployment.mjs first" }
$origin = (Get-Content -Raw $prepared | ConvertFrom-Json).publicOrigin
if ($origin -ne "https://$VmHost") { throw "Bundle was prepared for $origin, not https://$VmHost" }

$target = "$AdminUser@$VmHost"
$sshArgs = @('-i', $SshKeyPath, '-o', 'StrictHostKeyChecking=accept-new')
$archive = Join-Path $env:TEMP "dhumi-source-$PID.tgz"
$sourcePaths = @('back-end/package.json', 'back-end/package-lock.json', 'back-end/tsconfig.json', 'back-end/.dockerignore',
  'back-end/src', 'back-end/contracts', 'back-end/infra', 'front-end', 'deploy/demo', 'deploy/azure/vm-deploy.sh')
$excludes = @('node_modules', 'dist', '.runtime', '.env*', '*.private.*', '*.credentials.*', '*.pem', '*.key',
  'graphify-out', 'coverage', 'test-results', 'playwright-report', '*.log', '*.tsbuildinfo', '*.dump')

Write-Host "Target      : $target  (/opt/dhumi)"
Write-Host "Bundle      : $bundle  (origin $origin)"
Write-Host "Source from : $RepoRoot  ->  $($sourcePaths -join ', ')"
if (-not $Execute) { Write-Host 'Validated. Re-run with -Execute to copy and start the stack.' -ForegroundColor Yellow; return }

Push-Location $RepoRoot
try {
  $tarArgs = @('-czf', $archive) + ($excludes | ForEach-Object { "--exclude=$_" }) + $sourcePaths
  tar @tarArgs
  Assert-LastExit 'source archive'
} finally { Pop-Location }

try {
  ssh @sshArgs $target 'cloud-init status --wait >/dev/null && docker compose version'
  Assert-LastExit 'VM not ready (cloud-init/Docker)'

  ssh @sshArgs $target "test ! -e /opt/dhumi/private/$BundleName"
  Assert-LastExit "Bundle $BundleName already exists on the VM; prepare a new one instead of overwriting"

  scp @sshArgs $archive "${target}:/opt/dhumi/source.tgz"
  Assert-LastExit 'copy source'
  ssh @sshArgs $target 'rm -rf /opt/dhumi/src && mkdir -p /opt/dhumi/src && tar -xzf /opt/dhumi/source.tgz -C /opt/dhumi/src && rm /opt/dhumi/source.tgz'
  Assert-LastExit 'unpack source'

  scp @sshArgs -r $bundle "${target}:/opt/dhumi/private/$BundleName"
  Assert-LastExit 'copy private bundle'

  ssh @sshArgs $target "sh /opt/dhumi/src/deploy/azure/vm-deploy.sh $BundleName"
  Assert-LastExit 'build and start'
} finally { Remove-Item $archive -ErrorAction SilentlyContinue }

Write-Host "Started. Open https://$VmHost (certificate issuance can take a minute)." -ForegroundColor Green
