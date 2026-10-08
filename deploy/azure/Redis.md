# Azure Redis — connected 8 October 2026

The Job Manager now uses **Azure Managed Redis** for the existing concurrency
leases. Its credential is populated in the same private `back-end/.env.azure`;
API/outbox/frontend receive no Redis credential. The real scraping, no-OTP and
create-only organization behavior remains as tested.

| Resource/configuration | Verified value |
| --- | --- |
| Resource group / region | `rg-dhumcustomerfacing-centralindia` / Central India |
| Resource | `redis-dhumi-ci-01`, Azure Managed Redis |
| SKU / availability | `Balanced_B0`, high availability enabled |
| Host / port | `redis-dhumi-ci-01.centralindia.redis.azure.net:10000` |
| Transport / authentication | TLS only, certificate verification, TLS 1.2 minimum; private access key |
| Database / clustering | Cache `default`, non-clustered to match the existing client |
| Eviction / persistence | NoEviction; no disk persistence for temporary leases |
| Lease namespace | `dhumi:run-capacity` |

The [resource template](redis.bicep) passed validation/what-if; deployment created
only the cache and its default cache database. PostgreSQL and its schemas are
unrelated to this Redis database. Existing SQL/Blob/Service Bus resources and
network rules were unchanged. The cache currently exposes an authenticated TLS
endpoint; a private endpoint is a later hosting/networking step.

Microsoft documents [TLS/authentication and cache settings](https://learn.microsoft.com/en-us/azure/redis/configure)
and [capacity/clustering choices](https://learn.microsoft.com/en-us/azure/redis/plan-tiers-and-capacity).
The small cache holds expiring lease tokens, not Run state, results, sessions or
customer records. PostgreSQL remains authoritative for Run/Attempt fencing.

## Same env, scoped to Job Manager

Private `.env.azure` has an authenticated `rediss://` URL and the lease namespace.
The access key was retrieved into the private holder; no existing credential was
rotated. Do not print/copy that URL into logs, context, frontend or Git. Logger
redaction covers the URL at its env/config entry points. The public
[backend.env.example](backend.env.example) leaves the Redis credential blank.

The worker accepts the tested local loopback profile or authenticated Azure
Managed Redis on TLS port 10000. It rejects remote plaintext, missing/short
credentials, unsupported hosts, alternate database paths and TLS-bypass URL
parameters. Local Redis remains forbidden in normal production mode. TLS
certificate verification is never disabled. No dependency was added.

The original lease operations remain: SET NX/PX, token-checked Lua renewal and
release, bounded TTL and disabled offline command buffering. A failed connection
is closed. No synthetic execution path, new Run state or SQL migration was added.

## Checks

From `back-end`:

```powershell
npm run deployment:check
npm run redis:check
npm run queue:check
npm run storage:check
```

`redis:check` verifies TLS/authentication and PING without writing keys or
connecting to SQL/provider/email. Alternate private profile:

```powershell
node --import tsx scripts/azure/check-redis.mjs --env=/secure/dhumi/backend.env
```

Fourteen live lease checks pass on disposable keys: two clients, contention,
wrong-owner rejection, renewal and its TTL, expiry/successor ownership, release,
invalid-authentication rejection and complete key cleanup. No diagnostic keys
remain. The actual local lease integration regression also passes.
Backend unit suite: **1,095 tests / 152 files**; build/application and test
TypeScript pass. Forty-one actual backend checks pass with all four Azure
connections, including existing raw/normalized downloads.

Before activation there were no active Runs, pending SQL commands or old capacity
leases. Only the owned Job Manager was restarted. API/outbox/frontend remained
running, and all process projections match the master env. No recorded app errors,
database mutation, provider submission or email submission occurred.
**Live `leads_engine`, its environment/services, roles/passwords and network
settings remain untouched.**

## Manual testing boundary

The [portal](http://localhost:5173) is ready for owner testing with Azure SQL,
Blob, Service Bus and Redis. API/workers/frontend hosting still runs on this PC
and SQL uses the owned TLS SSH tunnel. Keep the PC/tunnel running. This does not
publish a public cloud application URL. Follow the [manual test sequence](../../docs/runbooks/azure-manual-testing.md).

No fresh paid provider Run was submitted for these infrastructure checks.
An owner-started collection uses the existing real Bright Data worker and the
four Azure connections. Hosting/HTTPS/private app network is the remaining phase.
Normal OTP/invitations remain next-update work.

The cached skill index is dated May 2026; refresh it upstream when maintaining
tooling. The optional [Microsoft Docs MCP](https://github.com/MicrosoftDocs/mcp/blob/main/README.md)
can provide current reference content; this phase verified current Microsoft pages directly.
