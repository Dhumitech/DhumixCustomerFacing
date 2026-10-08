<#
.SYNOPSIS
  Creates the Azure resources for the Dhumi hosted demo: one resource group and
  one Linux VM that runs the existing deploy/demo Docker package.

.DESCRIPTION
  Without -Execute this prints the plan and changes nothing. With -Execute it
  creates (or reuses) the resource group, network security group, virtual
  network, static public IP with a DNS name, and the VM (cloud-init installs
  Docker). Managed services added later (Storage, Service Bus, Redis, Key Vault,
  Container Apps, ...) go into the same resource group and virtual network.

  Windows PowerShell 5.1 compatible. Requires Azure CLI, signed in.
#>
[CmdletBinding()]
param(
  [string]$ResourceGroup = 'rg-dhumi-customer',
  [string]$Location = 'centralindia',
  [string]$Prefix = 'dhumi-demo',
  [string]$DnsLabel = 'dhumi-demo',
  [string]$VmSize = 'Standard_D4s_v5',
  [int]$OsDiskGb = 128,
  [string]$AdminUser = 'azureuser',
  [string]$AdminSourceIp = '',
  [string]$SshKeyPath = (Join-Path $env:USERPROFILE '.ssh\dhumi_demo_ed25519'),
  [switch]$Execute
)
$ErrorActionPreference = 'Stop'
function Assert-LastExit([string]$Step) { if ($LASTEXITCODE -ne 0) { throw "Failed: $Step" } }

$tags = @('project=dhumi-customer', 'component=hosted-demo')
$vnet = "vnet-$Prefix"; $subnet = 'snet-app'; $nsg = "nsg-$Prefix"
$publicIp = "pip-$Prefix"; $vm = "vm-$Prefix"
$hostName = "$DnsLabel.$Location.cloudapp.azure.com"

$account = az account show --query "{name:name, id:id, user:user.name}" -o json | ConvertFrom-Json
Assert-LastExit 'az account show (run az login first)'

if (-not $AdminSourceIp) { $AdminSourceIp = (Invoke-RestMethod -Uri 'https://api.ipify.org' -TimeoutSec 15).Trim() }
if ($AdminSourceIp -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { throw "AdminSourceIp '$AdminSourceIp' is not an IPv4 address" }

Write-Host ''
Write-Host 'Dhumi hosted demo - Azure plan' -ForegroundColor Cyan
Write-Host "  Subscription : $($account.name) ($($account.id)) as $($account.user)"
Write-Host "  Resource grp : $ResourceGroup  [$Location]"
Write-Host "  VNet/subnet  : $vnet 10.60.0.0/16 / $subnet 10.60.1.0/24 (room left for later subnets)"
Write-Host "  NSG          : $nsg  - 22 from $AdminSourceIp only; 80 and 443 from Internet"
Write-Host "  Public IP    : $publicIp (Standard, static)  DNS: $hostName"
Write-Host "  VM           : $vm  $VmSize  Ubuntu 24.04  $OsDiskGb GB Premium SSD  user $AdminUser"
Write-Host "  SSH key      : $SshKeyPath(.pub) - created if missing"
Write-Host "  Public origin for prepare-deployment: https://$hostName"
Write-Host ''
if (-not $Execute) { Write-Host 'Plan only. Re-run with -Execute to create these resources (they are billed).' -ForegroundColor Yellow; return }

if (-not (Test-Path "$SshKeyPath.pub")) {
  # Windows PowerShell 5.1 drops empty native arguments; '""' passes an empty passphrase.
  ssh-keygen -t ed25519 -f $SshKeyPath -N '""' -C 'dhumi-demo'
  Assert-LastExit 'ssh-keygen'
}

az group create --name $ResourceGroup --location $Location --tags $tags --only-show-errors -o none
Assert-LastExit 'resource group'

az network nsg create -g $ResourceGroup -n $nsg --location $Location --tags $tags --only-show-errors -o none
Assert-LastExit 'nsg'
az network nsg rule create -g $ResourceGroup --nsg-name $nsg -n allow-ssh-admin --priority 1000 --direction Inbound --access Allow --protocol Tcp --source-address-prefixes "$AdminSourceIp/32" --destination-port-ranges 22 --only-show-errors -o none
Assert-LastExit 'nsg rule ssh'
az network nsg rule create -g $ResourceGroup --nsg-name $nsg -n allow-http --priority 1010 --direction Inbound --access Allow --protocol Tcp --source-address-prefixes Internet --destination-port-ranges 80 --only-show-errors -o none
Assert-LastExit 'nsg rule http'
az network nsg rule create -g $ResourceGroup --nsg-name $nsg -n allow-https --priority 1020 --direction Inbound --access Allow --protocol Tcp --source-address-prefixes Internet --destination-port-ranges 443 --only-show-errors -o none
Assert-LastExit 'nsg rule https'

az network vnet create -g $ResourceGroup -n $vnet --location $Location --address-prefixes 10.60.0.0/16 --subnet-name $subnet --subnet-prefixes 10.60.1.0/24 --tags $tags --only-show-errors -o none
Assert-LastExit 'vnet'

az network public-ip create -g $ResourceGroup -n $publicIp --location $Location --sku Standard --allocation-method Static --dns-name $DnsLabel --tags $tags --only-show-errors -o none
Assert-LastExit "public ip (DNS label '$DnsLabel' may be taken - pick another with -DnsLabel)"

$cloudInit = Join-Path $env:TEMP "dhumi-demo-cloud-init-$PID.yaml"
(Get-Content -Raw (Join-Path $PSScriptRoot 'cloud-init.yaml')).Replace('__ADMIN_USER__', $AdminUser) | Set-Content -Path $cloudInit -Encoding ascii -NoNewline
try {
  az vm create -g $ResourceGroup -n $vm --location $Location --image 'Canonical:ubuntu-24_04-lts:server:latest' --size $VmSize --admin-username $AdminUser --authentication-type ssh --ssh-key-values "$SshKeyPath.pub" --os-disk-size-gb $OsDiskGb --storage-sku Premium_LRS --vnet-name $vnet --subnet $subnet --nsg $nsg --public-ip-address $publicIp --custom-data $cloudInit --tags $tags --only-show-errors -o none
  Assert-LastExit 'vm'
} finally { Remove-Item $cloudInit -ErrorAction SilentlyContinue }

Write-Host ''
Write-Host 'Created.' -ForegroundColor Green
Write-Host "  SSH         : ssh -i `"$SshKeyPath`" $AdminUser@$hostName"
Write-Host "  Docker ready: ssh -i `"$SshKeyPath`" $AdminUser@$hostName cloud-init status --wait"
Write-Host "  Next        : prepare-deployment.mjs --public-origin=https://$hostName, then Publish-DemoRelease.ps1"
