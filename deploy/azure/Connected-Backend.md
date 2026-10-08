# Azure-connected backend — 8 October 2026

Current application runtime, 9 October: [Docker rehearsal](../azure-rehearsal/README.md)
at http://127.0.0.1:4173. The fresh compiled frontend proxies the private API;
Docker outbox/jobs own the existing Azure queue. PC API/outbox/jobs are paused,
and the previous PC observer is stopped. The same Azure database, Blob, queue,
Redis and credential values remain. The preceding 5173 runtime below is history.
Do not start its workers alongside this rehearsal. All connection, existing
Run/usage/download and container recreation checks pass; cloud hosting is pending.

Latest route update, 9 October: [direct verified TLS](Portable-Connections.md)
replaces the SQL tunnel for API/outbox/jobs. The same env embeds the retained
public CA and selects `20.244.41.57:5432`. Six logins pass on Windows/Linux and
existing Run/usage HTTP reads pass. SSH remains owner-only operator access.

The manual portal at http://localhost:5173 now calls the local API on port 3000
using **Azure `dhumi_shared.app` and Azure Blob Storage**. API, outbox and Job
Manager are running. Azure app has 25 tables and the 75-entry reviewed ledger.
The later [Azure Service Bus increment](Service-Bus.md) is now active in both
workers. The later [Redis increment](Redis.md) also connects Job Manager to Azure.
Application hosting remains local; this is the connected
deployment preparation stage.

`leads_engine` is a live, separate project. No schema/data/permission, credential,
environment or service change was made for it. Existing Azure roles and passwords
are retained. Eight missing source runtime logins were copied with existing
password hashes and capability membership, plus CONNECT only. They received no
`leads_engine` table privileges. No identity consolidation was performed.

## Current private configuration

The owner-requested [single deployment environment](Backend-Environment.md) is
now `back-end/.env.azure`, owner-restricted and Git-ignored. Active processes
project their required settings from this file. API has its three SQL credentials;
workers have only their required credentials. Only Job Manager has the provider
secret/reference key; only API/Job Manager get Blob credentials. No process gets
the PostgreSQL administrator holder. Original `.env` and dated per-process JSON
profiles remain unchanged history, not the active deployment source.

| Connection | Current value |
| --- | --- |
| SQL host / port | `20.244.41.57:5432`, direct TLS to the existing database VM |
| SQL database / schema | `dhumi_shared` / `app` |
| SQL TLS | `verify-full`, inline public CA covering public/private addresses |
| Blob driver | `azure_blob` |
| Blob account / container | `stdhumici01` / private `dhumi-results` |
| Authentication mode | Existing explicit demo mode without OTP |
| Queue / Redis | Azure `sb-dhumi-ci-01/dhumi-run-commands` / secured `redis-dhumi-ci-01` |

The initial `.env.azure-blob` fragment is retained provisioning history. The
single `.env.azure` now supplies SQL/session/provider/Blob settings; it is never
a public template. Share values only through the authorized private handoff.
Another developer can use the filled env and direct endpoint without a tunnel,
certificate-file setup or Azure CLI login. An Azure host with the approved VNet
route can use `172.16.0.4:5432` and the same CA. Managed application hosting and
public HTTPS origins remain a separate step.

## Operating this connected session

From `back-end`:

```powershell
node --import tsx .runtime/azure-app-transfer-20261008/live.private.mjs status
```

The launcher also has `stop` / `start` for its own three application processes,
and now reads the single `.env.azure` through the shared credential projection.
The historical tunnel is recorded in `tunnel.json`; application traffic now uses
direct TLS. Owner SSH access remains available for diagnostics.
It does not rebuild source, replay migrations or create infrastructure.
`demo:start` belongs to the Docker/Azurite stack. Use the connected launcher
for this session; switching profiles is an explicit operation.

## Qualification and preserved data

45 isolated rehearsal cases and 41 main backend cases pass. Eight logins and
seven pool factories authenticate. All 36 referenced result blobs (14,495,830
bytes) were copied with their original keys, headers and checksums; every signed
download was verified. Nine unrelated Azurite objects were left behind.
No new provider or email submission occurred during qualification.

Four source test Attempts had no parent Run and no artifact/provider-call/usage
dependents. The owner approved treating that as data noise. Only these four rows
were excluded from Azure; the source and complete private dump are retained.
The app schema/constraints are unchanged from the refactored source. The full
and app-only Azure backups remain private on the VM and PC; the temporary
rehearsal database was removed after successful checks.

Any later rollback must use the **app-only** backup and affect only `app`.
The full database backup exists for isolated restore proof; never restore it
over live `dhumi_shared`, where `leads_engine` belongs to the other live project.
Leave its environment, roles and services running.

Manual tests now write to Azure `app`. An owner-submitted scraper Run uses the
existing real Bright Data worker and Azure result storage. The completed checks
read existing results; they do not claim a new cloud-backed provider submission.
Continue private hosting/HTTPS and later authentication
configuration using [the readiness record](../../docs/runbooks/real-demo-deployment-readiness.md).
