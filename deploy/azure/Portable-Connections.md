# Portable Azure backend connections

Completed for the owner's 9 October 2026 request: private `back-end/.env.azure`
connects the existing backend directly to Azure, with its public database CA
embedded. SSH keys, tunnels, certificate-file paths and Azure CLI sign-in are
not required to run the backend. Application hosting is still on this PC.

| Dependency | Connection | Authentication |
| --- | --- | --- |
| PostgreSQL | Static `20.244.41.57:5432`, `dhumi_shared.app` | Existing six runtime logins/passwords, SCRAM and verified TLS |
| Blob | `stdhumici01` / private `dhumi-results` | Existing tenant/client ID/client secret |
| Service Bus | `sb-dhumi-ci-01` / `dhumi-run-commands` | Existing separate sender/receiver Entra credentials |
| Redis | `redis-dhumi-ci-01.centralindia.redis.azure.net:10000` | Existing authenticated, certificate-verified `rediss` URL |

## One private env

The database settings in the filled file are:

```dotenv
DATABASE_HOST='20.244.41.57'
DATABASE_PORT='5432'
DATABASE_NAME='dhumi_shared'
DATABASE_SSL_MODE='verify-full'
DATABASE_SSL_CA_BASE64='<retained public CA PEM encoded as base64; filled privately>'
```

`DATABASE_SSL_CA_FILE` is absent. An absolute CA-file path remains supported as
an alternative. Selecting both sources, malformed trust material, private keys
or inline trust with TLS disabled is rejected. Each SQL pool explicitly checks
the configured address, including IP addresses. The installed server certificate
covers the public/private addresses and expires on 1 October 2027.

All existing database, provider, reference-protection, session, Blob, queue and
Redis credential values are retained. VM-hosted PostgreSQL continues using its
own logins; Blob/queue client IDs authorize those Azure services.

## Developer handoff

Share the project and filled `.env.azure` privately. Put the file in `back-end`.
It is Git-ignored; never put it in Vite, source, documentation or a container image.
Install Node.js 24, then run from `back-end`:

```powershell
npm ci
npm run build
npm run deployment:check
npm run database:check
npm run storage:check
npm run queue:check
npm run redis:check
```

These checks authenticate connections without creating users/Runs, writing app
data, consuming queue messages or submitting scraping/email. Database checks
use explicit read-only transactions ending in rollback. Do not replay historical
bootstrap/migrations against the shared database for checkout setup.

Run the intended deployment's three roles in separate supervised sessions:

```powershell
npm run deployment:api
npm run deployment:outbox
npm run deployment:jobs
```

The owner's API/workers are currently running in the [Docker rehearsal](../azure-rehearsal/README.md)
at http://127.0.0.1:4173; the preceding PC role group is paused. Coordinate the handoff before
starting additional workers against the same queue. The launcher gives each
role only its required credentials; never load the full master env directly into
the API. Frontend setup stays in the root `front-end` package.

The same filled env passed all six database checks on Windows and in an isolated
Linux container with the existing Node 24 image/dependencies. Network access to
PostgreSQL 5432 and the Azure endpoints is required. Database installation,
emulators, certificate imports and SSH-tunnel setup are unnecessary.

## Server scope and verification

Two HBA rules were added: plaintext rejection and TLS/SCRAM access, matching
only `dhumi_shared` and `dhumi_test_{identity,customer_api,admission,
outbox_dispatcher,job_manager,result_recorder}_login`. They accept IPv4 sources
(`0.0.0.0/0`); existing role permissions continue governing access. The existing
public network rule was retained. Every earlier HBA byte is preserved after the
new block. Validated configuration was reloaded without restarting PostgreSQL.

No schema/data, migration, login/password, grant, NSG or firewall change occurred.
`leads_engine` and its environment, credentials and services remain untouched.
The previous HBA is privately backed up on the VM under
`/var/lib/postgresql/18/main/dhumi-direct-tls-20261009/`; the previous env and
sanitized operator evidence are in ignored `.runtime/azure-direct-tls-20261009/`.
The owner's SSH access is retained for optional diagnostics/rollback; application
traffic uses direct TLS.

Verification: 1,118 unit cases across 154 files, TypeScript/build, six direct
logins on both operating systems, all three Azure dependency checks, and three
negative checks (plaintext, wrong password, untrusted CA) pass. Existing Run and
usage HTTP reads pass after cutover. The database remains 25 app tables/75 ledger
entries. No new provider/email work was submitted.

For Azure hosting, configure the listener and real HTTPS frontend origins. A
future VNet host can select `172.16.0.4:5432` after its private route is established.
Keep the accepted no-OTP/create-only demo mode. See [env structure](backend.env.example),
[active backend](Connected-Backend.md) and [manual testing](../../docs/runbooks/azure-manual-testing.md).
