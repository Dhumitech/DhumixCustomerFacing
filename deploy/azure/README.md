# Azure deployment

**Active hosted deployment, 9 October: [Container Apps](Container-Apps.md).**
Frontend/API/outbox/jobs are running in Azure with the tested images and three
scoped mounted backend secrets. [HTTPS portal](https://ca-dhumi-frontend-ci-01.bluerock-9b30fd6a.centralindia.azurecontainerapps.io)
and [actual application metadata](Container-Apps-Deployment.json). Existing
data/services, all six SQL logins, Blob/queue/Redis, HTTPS/CORS and four downloads
pass. Local 4173 Docker roles are stopped; PC workers remain paused. Cloud has
no PC/SSH dependency. No OTP/create-only/Marketplace Coming soon scope remains.
Manual cloud account/collection acceptance is next. Earlier deployment notes
below retain their dated scopes and must not select the active runtime.

Latest completed foundation, 9 October: [Container Apps environment and logs](Container-Apps-Environment.md).
`cae-dhumi-ci-01`, `law-dhumi-ci-01` and the dedicated `vnet-dhumi-ci-01`
are created in Central India. Zone redundancy, Consumption profile, dedicated
subnet and workspace binding/query checks pass. Existing database network,
master env and four running 4173 Docker containers are unchanged. Azure owns
the separate platform infrastructure group. No hosted app or app secrets yet;
next deploy frontend/API/outbox/jobs with the tested registry images and a
qualified worker handoff. [Actual resource IDs](Container-Apps-Environment-Resources.json).

Latest completed resource, 9 October: [Container Registry](Container-Registry.md),
`acrdhumici01.azurecr.io` (Basic, Central India), holds both tested Docker images.
Their remote digests match the local qualification and authenticated pulls pass.
Admin/anonymous access are disabled; release tags/manifests are protected.
[Pinned deployment references](Container-Registry-Release.json) contain no secrets.
The 4173 rehearsal and master env remain unchanged. Next is the Container Apps
environment with Log Analytics, then four hosted application roles.

Latest manual rehearsal, 9 October: [four fresh Docker application containers](../azure-rehearsal/README.md)
at http://127.0.0.1:4173 use all existing Azure dependencies and the unchanged
private `.env.azure`. The PC application roles are paused. This replaces the
preceding 5173 application runtime for the next manual test; the older emulator
package remains history. Azure application hosting/public HTTPS is still pending.

**Current owner-selected route, 8 October 2026:** provision managed Azure
services incrementally in `rg-dhumcustomerfacing-centralindia`, subscription
`373d10ba-f7db-4db1-938b-14a73655bb0a`, Central India. The first resource is
[Azure Blob Storage](Blob-Storage.md): `stdhumici01` / private `dhumi-results`,
with a portable backend service-principal profile and verified authentication.
Cloud result storage uses `azure_blob`; Azurite remains a local test emulator.
The owner-confirmed [existing PostgreSQL host](Existing-Database.md) is the
running Linux `dhumi-db` VM in `DhumixBrightDataCustomer`, also Central India.
Retain it; hosting networking must reach its private address `172.16.0.4`.
The later owner-authorized transfer is complete: `dhumi_shared.app` has 25 tables
and 75 migration entries; the live `leads_engine` is preserved. All 36 indexed
result blobs are transferred and downloads verified. The [connected backend](Connected-Backend.md)
uses Azure SQL with verified TLS and real Blob, while the API/portal, queue and
Redis remain local at that dated transfer boundary. The later [Service Bus deployment](Service-Bus.md)
now connects outbox/jobs to real Azure sb-dhumi-ci-01/dhumi-run-commands.
The later [Redis deployment](Redis.md) connects Job Manager to redis-dhumi-ci-01.
Managed hosting/private network and later secret/authentication integration
remain separate; the full cloud application deployment is pending.

The [single backend deployment environment](Backend-Environment.md) is populated
in ignored `back-end/.env.azure` and used by all three app processes through
scoped credential projection. The owner retains the no-OTP demo for this release;
normal production authentication is deferred. [backend.env.example](backend.env.example)
is the public blank-secret structure, not a ready-to-run credential file.

The [manual portal](http://localhost:5173) is ready to test with all four Azure
infrastructure dependencies. [Manual test steps](../../docs/runbooks/azure-manual-testing.md)
preserve the owner's no-OTP release. API/workers/frontend still run on the PC;
the public cloud application deployment is the remaining phase.

## Earlier VM emulator rehearsal recipe — retained reference

The older recipe below has different default names and hosts emulators.
It is not the current managed Blob deployment or a command to execute next.

Goal: put the existing [deploy/demo](../demo/README.md) package on Azure now, then add managed services (Storage, Service Bus, Redis, Key Vault, Container Apps, …) to the **same resource group and virtual network** one at a time, as the code gains adapters for each.

Nothing here runs automatically. Both scripts print a plan unless you pass `-Execute`.

## What step 1 creates (resource group `rg-dhumi-customer`, Central India)

| Resource | Name | Notes |
| --- | --- | --- |
| Resource group | `rg-dhumi-customer` | Holds this demo and later managed services |
| Virtual network | `vnet-dhumi-demo` 10.60.0.0/16, subnet `snet-app` 10.60.1.0/24 | Address space left for Container Apps / private-endpoint subnets later |
| Network security group | `nsg-dhumi-demo` | 22 from your current IP only; 80/443 from Internet (Caddy HTTPS) |
| Public IP | `pip-dhumi-demo` (Standard, static) | DNS `dhumi-demo.centralindia.cloudapp.azure.com` (no domain purchase needed) |
| VM | `vm-dhumi-demo`, Standard_D4s_v5 (4 vCPU, 16 GB), Ubuntu 24.04, 128 GB Premium SSD | cloud-init installs Docker Engine + Compose v2 |

Everything else runs inside Docker on the VM: Caddy (HTTPS, Let's Encrypt), API, outbox and Job Manager, PostgreSQL 18 (restored copy), Azurite, Service Bus emulator + SQL Server, Redis. Checked on 8 Oct 2026: the sizes are offered in Central India and the subscription has quota (DSv5 0/65 vCPUs, regional 27/65).

Rough cost: VM + disk + IP, on the order of US$150–200 per month if left running — confirm in the Azure pricing calculator. Stop (deallocate) the VM when not demoing to pay only for disk and IP.

## Prerequisites (on this Windows machine)

1. Azure CLI signed in to the intended subscription (`az account show`).
2. **PowerShell 7** — `prepare-deployment.mjs` calls `pwsh.exe` to lock down the private export folder. Install with `winget install --id Microsoft.PowerShell --source winget`.
3. The local Docker demo (port 55432) running with **no active Runs and no pending queue work** — the export refuses otherwise.
4. Decide the sign-up policy: the package runs in demo mode (no email verification), so anyone who signs up and creates an organization can start **paid** Bright Data Runs.

## Steps

1. Plan, then create the infrastructure:

   ```powershell
   .\deploy\azure\New-DemoInfrastructure.ps1
   .\deploy\azure\New-DemoInfrastructure.ps1 -Execute
   ```

   Use `-DnsLabel <name>` if `dhumi-demo` is taken, `-ResourceGroup` to use another group.

2. Export a private release bundle from the local Docker demo (from `back-end`, after installing PowerShell 7):

   ```powershell
   node --import tsx scripts/local-demo/prepare-deployment.mjs --public-origin=https://dhumi-demo.centralindia.cloudapp.azure.com --name=azure-demo-1
   ```

   The bundle (database export, role password hashes, runtime settings, keys, result blobs) lands in ignored `back-end/.runtime/azure-demo-1`. Never commit or share it. Data created locally after this export does not reach Azure.

3. Copy and start:

   ```powershell
   .\deploy\azure\Publish-DemoRelease.ps1 -VmHost dhumi-demo.centralindia.cloudapp.azure.com -BundleName azure-demo-1
   .\deploy\azure\Publish-DemoRelease.ps1 -VmHost dhumi-demo.centralindia.cloudapp.azure.com -BundleName azure-demo-1 -Execute
   ```

   It archives the current source (no secrets), copies it and the bundle over SSH, fixes Linux file permissions (`vm-deploy.sh`), builds the images on the VM and starts the stack. The image therefore includes all current local code, e.g. the duplicate-signup correction.

4. Verify with the checklist in [deploy/demo/README.md](../demo/README.md#verify-on-the-host): HTTPS certificate, `/v1/status`, sign-up/create organization, saved scraper survives reload, Members notice, downloads. Starting a collection is a paid Bright Data request — do it only deliberately.

## Operating notes

- SSH: `ssh -i ~/.ssh/dhumi_demo_ed25519 azureuser@dhumi-demo.centralindia.cloudapp.azure.com`; your IP changes → update NSG rule `allow-ssh-admin`.
- Stack: on the VM, `cd /opt/dhumi/src` and use `docker compose --env-file /opt/dhumi/private/<bundle>/compose.private.env -f deploy/demo/compose.yml ps|logs|restart`. Never `down -v` (deletes the database and results volumes).
- Back up: Azure Backup for the VM, or regular `pg_dump` + Azurite volume copies, together with the bundle's keys.
- If Bright Data restricts the API key by IP, allow the VM's public IP.
- Restarting the Service Bus emulator drops queued messages; don't restart it while Runs are active.

## Step 2 onward — managed services in the same resource group

Each needs a code adapter first (see [deployment readiness](../../docs/runbooks/real-demo-deployment-readiness.md)); create the resource only when its adapter is ready:

1. Storage account (private Blob container) — replace Azurite.
2. Service Bus namespace (Standard) + queue — replace the emulator and SQL Server container.
3. Azure Managed Redis — replace the Redis container (needs TLS/password support).
4. Key Vault + managed identity — Bright Data key, reference-protection key, app secrets.
5. Existing owner-confirmed `dhumi-db` PostgreSQL VM — qualify private access/TLS and the reviewed final transfer; a replacement database server is not the selected route.
6. Container Registry + Container Apps (API, outbox, jobs) + Log Analytics/Application Insights — replace the VM.
7. Communication Services Email — real verification codes instead of demo mode.

Separately: the existing `dhumi-db` VM (resource group `DhumixBrightDataCustomer`) currently allows PostgreSQL 5432 and SSH 22 from any internet address; restrict those rules.
