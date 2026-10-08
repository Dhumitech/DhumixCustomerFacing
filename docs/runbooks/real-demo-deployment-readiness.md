# Real demo deployment readiness

The [current connected session](../../deploy/azure/Connected-Backend.md) uses
Azure PostgreSQL, real Azure Blob and [Azure Service Bus](../../deploy/azure/Service-Bus.md),
and [secured Azure Redis](../../deploy/azure/Redis.md), with local API/workers/portal.
The demo uses real Bright Data Amazon Collect by URL through the
existing API/outbox/worker/storage/Run screen. The [packaged demo](../../deploy/demo/README.md)
now provides Linux images, private infrastructure, a same-origin download proxy
and an HTTPS hosting recipe. It is qualified locally as an emulator demo.
The managed production requirements below remain separate; no cloud host is
deployed. The owner has deferred invitations/joining/activity and selected a
create-only organization flow for this update.

## Deploy these components

| Component | Azure implementation | Existing application role |
| --- | --- | --- |
| PostgreSQL | Existing Linux VM `dhumi-db`, `DhumixBrightDataCustomer`, Central India | Verified TLS/backend access; app restored to 25 tables/75 entries, live leads_engine preserved; hosting needs its approved private route |
| Result storage | Private Azure Blob container | Raw-first immutable writes, normalization, SHA-256 metadata and short-lived read URLs |
| Command queue | Created `sb-dhumi-ci-01/dhumi-run-commands` | Both workers connect through queue-scoped Entra roles; live delivery tests pass |
| Capacity leases | Created `redis-dhumi-ci-01`, Azure Managed Redis | Verified TLS/authentication; 14 actual lease tests and Job Manager connection pass |
| Secrets | Azure Key Vault with workload identity | Dhumi-owned Bright Data key and durable reference-protection key |
| API and workers | Container Apps/App Service/selected host; API plus two continuously running workers | API health/HTTPS; outbox and Job Manager run separately |
| Frontend | Static Web Apps/static hosting or the selected host | Production SPA build with correct API origin and deep-link fallback |

The later owner-selected Azure route uses subscription
`373d10ba-f7db-4db1-938b-14a73655bb0a`, resource group
`rg-dhumcustomerfacing-centralindia`, Central India. [Blob Storage](../../deploy/azure/Blob-Storage.md)
is created: private `stdhumici01/dhumi-results`; portable credentials authenticate
and obtain user-delegation signing keys. Hosting and the other managed services
remain pending. The later owner-authorized app/result transfer is complete;
do not replay old migrations or replace existing credentials.

The [existing database host record](../../deploy/azure/Existing-Database.md)
confirms verified SQL/TLS access to dhumi_shared/app and protected leads_engine.
Current NSG rules permit TCP 22/5432 from all
internet addresses; the selected hosting network must establish and restrict
the intended application/admin access paths.

## Actual code gaps before a cloud release

1. Azure Blob configuration/composition and read-only user-delegation signing
   are implemented with the existing immutable store, object identity and
   integrity receipts. Cloud authentication/private access/signing permission
   checks pass. Historical bytes and signed downloads are now qualified: 36
   exact objects verify, plus actual backend/API reads against Azure SQL.
   A new provider submission through the fully managed staging stack remains
   separate; existing-result qualification sends no paid work.
2. Azure queue configuration/composition is now implemented and qualified on
   the existing publisher/receiver contracts. Duplicate detection, settlement,
   renewal, redelivery and DLQ round trips pass. Secured Azure Redis is also
   qualified: ownership, renewal TTL, expiry/successor, release and failed auth
   checks pass. Both transports are active in the current connected worker.
3. `localEnvironmentSecretProvider.ts` and the local reference protector are
   intentionally forbidden in production. Add the approved managed secret/key
   adapter and protect already-bound dataset/snapshot references with the same
   authenticated context. Retain a recoverable key; do not mint a new one per boot.
4. Package images, configurable HTTPS origins, private network ports and worker
   composition are delivered by the demo package. Actual cloud hostname/TLS,
   firewall, connectivity, container vulnerability scanning and managed service
   staging qualification remain required.
5. OTP bypass is an explicit non-production demo exception. Decide the hosted
   demo's authentication policy rather than changing production guards silently.
   A production release requires normal identity proof/email and approved legal
   configuration, secure cookies and PostgreSQL TLS.

Run matching checks against the managed services after staging is provisioned:
sign-in/create-only organization, real collect-by-URL, trace/Attempts/provider calls,
outbox delivery/recovery, raw-before-normalized durability, downloads/checksums,
usage, tenant isolation and restart recovery. A successful local run is useful
evidence, but does not prove those managed service interactions.

## Rollback/retention

Keep application image/configuration revisions and encrypted database backups
with the corresponding durable reference key. Roll back app/config revisions
without replaying reviewed SQL or deleting results. Preserve completed Run
evidence and provider-call intent to prevent duplicate paid submissions.
Live provider failures must produce a real safe failure or recovery state;
never restore synthetic empty results as a success fallback.
