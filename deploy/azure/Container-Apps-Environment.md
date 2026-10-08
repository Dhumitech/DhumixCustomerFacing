# Container Apps environment and logs

**Created and verified on 9 October 2026 (India time).** The environment,
workspace and VNet provisioning states are Succeeded. Azure validation/preview,
workspace binding and authenticated read-only query, subnet delegation, region,
Consumption-only profile, zone setting and existing demo preservation checks
pass. No Container Apps have been deployed yet.

This is the application-hosting foundation for the owner's existing Azure demo.
The deployment uses the same subscription, Central India region and application
resource group as Blob, Service Bus, Redis and ACR. The template creates the
environment, logging workspace and a dedicated new application network. It
does not deploy frontend/API/workers or change the existing database network.

| Resource | Name / setting |
| --- | --- |
| Subscription | `373d10ba-f7db-4db1-938b-14a73655bb0a` |
| Application resource group | `rg-dhumcustomerfacing-centralindia` |
| Container Apps environment | `cae-dhumi-ci-01` |
| Log Analytics workspace | `law-dhumi-ci-01` |
| App VNet | `vnet-dhumi-ci-01`, `10.60.0.0/16` |
| Dedicated infrastructure subnet | `snet-containerapps`, `10.60.0.0/23` |
| Subnet delegation | `Microsoft.App/environments` |
| Compute | Workload-profiles environment, `Consumption` profile only |
| Ingress capability | External environment for the future HTTPS frontend |
| Availability | Zone redundancy enabled at environment creation |
| Logging | Log Analytics, `PerGB2018`, 30-day retention |
| Platform-managed resource group | `rg-dhumi-aca-managed-ci-01` |

The full live result and IDs are recorded in
[Container-Apps-Environment-Resources.json](Container-Apps-Environment-Resources.json).
The authoritative infrastructure definition is
[container-apps-environment.bicep](container-apps-environment.bicep).

## Growth and networking

The owner plans to keep the same resources after the demo. Custom VNet
integration supports future private endpoints/routes; a dedicated `/23` gives
room to grow. Subscription ranges were checked before choosing `10.60.0.0/16`.
The database VNet `vnet-centralindia-8` is separate and has no new peering,
subnet, route or security-rule change from this deployment. The backend's
existing direct verified public TLS configuration remains the next app
deployment's starting point. SQL access from hosted containers must still be
qualified before the application handoff.

Azure fixes the environment subnet and zone setting at creation, so they were
chosen now. Enabling zone redundancy on the environment does not by itself
make a single-replica app resilient to a zone failure; the later application
deployment must choose replica counts accordingly. See
[Microsoft networking requirements](https://learn.microsoft.com/en-us/azure/container-apps/custom-virtual-networks)
and [reliability guidance](https://learn.microsoft.com/en-us/azure/reliability/reliability-container-apps).

Azure automatically owns the separate infrastructure resource group with its
load balancer and public IP resources. Leave those resources to the platform.
These infrastructure resources have their own Azure charges, in addition to
app compute and log ingestion. No Dedicated compute profile, NAT Gateway,
private endpoint, Key Vault, new database or application identity is created
by this template.

## Logs and secrets

The environment's console/system log destination is the named Log Analytics
workspace. ARM resolves its ingestion key internally using `listKeys()`; it
is never output, written into `.env.azure`, or included in release metadata.
Logging credentials belong to Azure's platform configuration. The public
resource metadata contains IDs and settings only. See
[Microsoft logging options](https://learn.microsoft.com/en-us/azure/container-apps/log-options).

The current private `.env.azure` remains the backend source. When the four apps
are deployed, project it into role-specific secrets mounted at
`/run/secrets/runtime.json`, as in the qualified Docker package. Preserve the
provider/reference keys and existing passwords; use a registry-pull managed
identity for the [published release](Container-Registry-Release.json).
Secrets are not needed in the infrastructure template.

## Deploy and inspect

From the repository root, with Azure CLI and Bicep available:

```powershell
$acaSubscription = '373d10ba-f7db-4db1-938b-14a73655bb0a'
$acaGroup = 'rg-dhumcustomerfacing-centralindia'
az deployment group what-if --name dhumi-aca-environment --resource-group $acaGroup --subscription $acaSubscription --template-file deploy/azure/container-apps-environment.bicep
# Review the preview before applying it. Use Incremental mode.
az deployment group create --name dhumi-aca-environment --resource-group $acaGroup --subscription $acaSubscription --template-file deploy/azure/container-apps-environment.bicep --mode Incremental --query '{state:properties.provisioningState,outputs:properties.outputs}' --output json
az containerapp env show --name cae-dhumi-ci-01 --resource-group $acaGroup --subscription $acaSubscription --query '{state:properties.provisioningState,domain:properties.defaultDomain,zoneRedundant:properties.zoneRedundant,profiles:properties.workloadProfiles,subnet:properties.vnetConfiguration.infrastructureSubnetId,logs:properties.appLogsConfiguration.destination}' --output json
az monitor log-analytics workspace show --workspace-name law-dhumi-ci-01 --resource-group $acaGroup --subscription $acaSubscription --query '{state:provisioningState,tier:sku.name,retentionDays:retentionInDays}' --output json
```

The template owns the complete subnet list of its new VNet. If future work
adds subnets, update the reviewed definition before redeploying it. Existing
database networks and services are not declared in the template.

## Next application step

Deploy four Container Apps using the existing digest-pinned images:

- Frontend: external HTTPS ingress, port 8080, configured internal API upstream.
- API: internal ingress, port 3000, scoped runtime secret and final HTTPS origins.
- Outbox: no ingress, sender profile; coordinate worker ownership before startup.
- Job Manager: no ingress, receiver/Blob/Redis/provider profile; same handoff gate.

Then qualify registry pulls, all six SQL logins, Blob/queue/Redis, health probes,
proxy/cookies, existing data/downloads and restart behavior. Cloud workers must
not start alongside the manual Docker workers without a deliberate handoff.
Keep no OTP, create-only organizations and Marketplace Coming soon. Public
cloud workflow acceptance and actual app-log delivery remain pending until
application deployment. The current portal stays at http://127.0.0.1:4173.
