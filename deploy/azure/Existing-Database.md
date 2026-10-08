# Existing PostgreSQL host — owner-confirmed 8 October 2026

The owner identified PostgreSQL on the existing `dhumi-db` VM. Retain this
database host for the incremental deployment; do not provision a replacement
server because the application has a different resource group.

## Current verified database — later owner-authorized app transfer

The owner explicitly authorized app-only replacement afterwards. Azure database
`dhumi_shared.app` now has **25 tables / 75 migration entries**, imported from
the tested Docker `dhumi_test.app`. Four parentless test Attempt rows were omitted
with the owner's approval; schema and constraints match the refactored source.
Full/app-only backups were restored in isolation before the main transaction.

**`leads_engine` is live and belongs to a separate project.** Its five tables,
data, ownership, permissions, object identities, existing credentials and other
project's environment received no changes. Preservation checks pass. PostgreSQL
was not restarted. `public` is unchanged. Existing `leads_app` access remains.

PostgreSQL 18.6/TLS is verified. Eight retained source logins now authenticate,
using their existing passwords and explicit CONNECT only; seven real backend
pool factories pass. API/workers run locally through an owned SSH tunnel on
`127.0.0.1:55434` with full PostgreSQL certificate verification. The SQL database
is `dhumi_shared`, regardless of the retained login names containing `test`.
See [connected backend](Connected-Backend.md) for actual profiles and boundaries.

## Earlier read-only Azure metadata observations

| Item | Observed value |
| --- | --- |
| Subscription | `373d10ba-f7db-4db1-938b-14a73655bb0a` |
| Database resource group | `DhumixBrightDataCustomer` |
| VM / region | `dhumi-db` / `centralindia` |
| State / OS / size | Running / Linux / Standard_B2s |
| NIC / private address | `dhumi-db755` / `172.16.0.4` |
| Virtual network / address space | `vnet-centralindia-8` / `172.16.0.0/16` |
| Subnet | `snet-centralindia-1` |
| NIC security group | `dhumi-db-nsg` |
| Public IP resource | `dhumi-db-ip`; address value not used as application configuration here |

Exact owner-provided VM resource ID:

```text
/subscriptions/373d10ba-f7db-4db1-938b-14a73655bb0a/resourceGroups/DhumixBrightDataCustomer/providers/Microsoft.Compute/virtualMachines/dhumi-db
```

The application/storage group remains `rg-dhumcustomerfacing-centralindia`,
also Central India. [Resources can connect across resource groups](https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/overview).
Group membership alone does not provide a route or database authorization.
Select hosting with private access to this VM's VNet or an explicitly connected
application VNet. `172.16.0.4` works only with that private connectivity; it is
not an internet database endpoint.

## Confirmed network follow-up

The NIC NSG currently has two custom inbound TCP Allow rules:

- `default-allow-ssh`, priority 1000: source `*`, destination `*`, port `22`.
- `allow-dhumi-postgres-tls`, priority 1010: source `0.0.0.0/0`, destination
  `172.16.0.4`, port `5432`.

These are actual rules, not a PostgreSQL connection test. During the authorized
networking phase, restrict database ingress to the selected backend path and
SSH to the owner/admin path. Preserve required access before removing broad
rules. No firewall, VNet, SSH or VM setting was changed here.

## Database and application boundaries

- PostgreSQL service, exact database, TLS/CA, runtime permissions and the
  restored 25-table schema are now verified by the later transfer above.
- Retain existing PostgreSQL credentials. The Blob service principal supplies
  Blob authorization only, not SQL authorization.
- Cloud API/worker settings must reference this reachable host and the confirmed
  database, with validated TLS and restricted logins. Local private `.env` and
  the Docker source remain unchanged; active runtime uses the separate cloud profile.
- The owner's later app-only replacement superseded the earlier dump-last
  timing. SQL and all 36 referenced result objects are transferred. A dump cannot copy the
  [Blob result bytes](Blob-Storage.md#later-database-and-result-transfer).

The initial host record performed only control-plane reads. The later scoped
transfer used existing SSH access, read-only inspections, backups and the
authorized `app` replacement; network rules remain unchanged.
