# Azure Container Registry

Created and verified on 9 October 2026 (India time). The owner authorized this
registry and publication of the two images already tested in the
[Azure-connected Docker rehearsal](../azure-rehearsal/README.md).
Application hosting remains pending; the manual portal stays on port 4173.

| Setting | Value |
| --- | --- |
| Subscription | `373d10ba-f7db-4db1-938b-14a73655bb0a` |
| Resource group | `rg-dhumcustomerfacing-centralindia` |
| Resource | Azure Container Registry |
| Name | `acrdhumici01` |
| Region | Central India (`centralindia`) |
| Tier | Basic |
| Login server | `acrdhumici01.azurecr.io` |
| Permissions | Registry RBAC (`--role-assignment-mode rbac`) |
| Admin login / anonymous pull | Both disabled |
| Network | Public HTTPS endpoint requiring authentication |

Basic is suitable for this initial two-image release. Higher tiers remain an
in-place upgrade when throughput or private endpoints require them. See
[Microsoft's tier comparison](https://learn.microsoft.com/en-us/azure/container-registry/container-registry-skus).

## Published release

The release tag is `20261008194055`, retained from the tested Docker build.
The images were tagged by their verified local IDs and pushed without rebuilding.
Both remote manifest digests equal those tested IDs; authenticated digest pulls
pass. Both images contain a `linux/amd64` runtime.

| Image | Roles |
| --- | --- |
| `acrdhumici01.azurecr.io/dhumi/backend:20261008194055` | API, outbox dispatcher, Job Manager |
| `acrdhumici01.azurecr.io/dhumi/frontend:20261008194055` | Compiled frontend and Caddy proxy |

Use the digest references in [Container-Registry-Release.json](Container-Registry-Release.json)
for cloud deployment. Tag and corresponding manifest have `writeEnabled=false`
and `deleteEnabled=false`, with reads enabled. Future releases use a new tag;
the repositories remain writable. This follows
[Microsoft's image-lock guidance](https://learn.microsoft.com/en-us/azure/container-registry/container-registry-image-lock).
The images are not signed; digest verification and release locks are the checks
performed here.

## Authentication and configuration

Publication uses the operator's existing Entra session with `az acr login`.
No registry password, service principal or application credential was created.
The master `back-end/.env.azure` and all mounted runtime profiles are unchanged.
The registry endpoint and image references are deployment metadata, not new
backend connection secrets.

During the next Container Apps deployment, give its managed identity registry
`AcrPull` access and configure that identity for image pulls. Each backend role
still needs its own scoped settings at `/run/secrets/runtime.json`; never inject
the complete master environment into every app. See
[Microsoft's authentication guidance](https://learn.microsoft.com/en-us/azure/container-registry/container-registry-authentication).

The frontend image supports `DHUMI_API_UPSTREAM`; configure it for the deployed
API's internal endpoint instead of the local Compose default `api:3000`.
Set the API's frontend/public origin, secure-cookie and proxy settings for the
final HTTPS portal. Preserve the tested no-OTP, create-only organization scope.
Published images alone do not provide a public website.

## Read-only verification

These commands inspect or pull the published release; they do not start workers:

```powershell
$acrSubscription = '373d10ba-f7db-4db1-938b-14a73655bb0a'
az acr show --name acrdhumici01 --resource-group rg-dhumcustomerfacing-centralindia --subscription $acrSubscription --query '{state:provisioningState,tier:sku.name,server:loginServer,admin:adminUserEnabled,anonymous:anonymousPullEnabled}' --output json
az acr login --name acrdhumici01 --subscription $acrSubscription
az acr repository show --name acrdhumici01 --image dhumi/backend:20261008194055 --subscription $acrSubscription
az acr repository show --name acrdhumici01 --image dhumi/frontend:20261008194055 --subscription $acrSubscription
$acrRelease = Get-Content deploy/azure/Container-Registry-Release.json -Raw | ConvertFrom-Json
foreach ($acrImage in $acrRelease.images) {
  docker pull $acrImage.reference
  if ($LASTEXITCODE -ne 0) { throw 'Published image pull failed' }
}
```

The publication checks also found no private configuration files in application
image paths. The four original demo container IDs, start times, restart counts
and image IDs remain unchanged; the proxied API returns 200. There was no SQL
access, provider submission or application restart in this step.

Next: create the Container Apps environment and Log Analytics workspace, then
configure and deploy frontend/API/outbox/jobs with scoped secrets and digest
references. Cloud HTTPS and full hosted workflow acceptance follow that step.
