# One backend deployment environment

Active hosting, 9 October: [Azure Container Apps](Container-Apps.md). The private
.env.azure remains byte-identical as the preparation source. Three app-scoped
runtime-settings secrets hold projected API/outbox/jobs profiles and mount at
/run/secrets/runtime.json. The API projection uses the cloud HTTPS origin,
secure host-only cookies and trust-proxy setting; these deployment overrides
do not alter the source credential values. Frontend has no backend secrets.
PC/Docker workers are paused/stopped; use the cloud portal, not local startup
commands. The dated local-process description below is historical.

Latest connection update, 9 October: [portable direct TLS](Portable-Connections.md).
The filled `.env.azure` uses the static public endpoint and inline public CA.
API/outbox/jobs no longer require a SQL tunnel or certificate-file path. Six
retained logins pass on Windows/Linux; earlier tunnel receipts are history.

The owner's Azure demo uses **one private file: `back-end/.env.azure`**. It is
populated, Git-ignored and restricted to the owner's Windows account. The running
API, Outbox Dispatcher and Job Manager now derive their settings from this file.
The old `back-end/.env` remains the local source profile. The initial
`.env.azure-blob` fragment and dated per-process JSON profiles are retained
history, not the active deployment configuration.

The owner explicitly kept the tested release without OTP, invitations or
joining; those are next-update features. Therefore this deployed-demo profile
uses `NODE_ENV=test`, `DEMO_DISABLE_OTP=true` and
`ORGANIZATION_COLLABORATION_ENABLED=false`. Do not rename that behavior as
normal production authentication or bypass existing production guards. Hosting
a demo on Azure does not require changing its application mode to production.

## What is filled

| Setting | Actual current value/status |
| --- | --- |
| Database | Azure VM `dhumi-db`, database `dhumi_shared`, `app` schema with 25 tables/75 migration entries |
| SQL route | Direct `20.244.41.57:5432`, verified TLS with inline public CA |
| SQL credentials | Six existing runtime credential pairs needed by the three app processes; passwords unchanged |
| Result storage | Real Azure Blob `stdhumici01` / private `dhumi-results`; portable Entra credentials filled |
| Sessions | Existing browser signing/session settings retained |
| Scraping | Existing real Bright Data credential and persistent reference-protection key retained |
| Organization behavior | Create only, one created organization per user, validated returning-user preference |
| Queue / capacity | Azure `sb-dhumi-ci-01/dhumi-run-commands` / secured `redis-dhumi-ci-01` |
| Public origin | Current tested `http://localhost:5173` |
| OTP / email | Disabled for this release; no fabricated OTP or sender credentials |

No PostgreSQL administrator, operator, retired janitor or `leads_engine`
credentials belong in this file. Its filename is not read by the frontend.
The existing reference key must travel securely with the deployment: replacing
it would prevent reading the imported protected provider bindings.

## Run with this file

From `back-end`, after `npm ci` and `npm run build` on another host:

```powershell
npm run deployment:check
npm run database:check
npm run storage:check
npm run queue:check
npm run redis:check
```

`deployment:check` validates all three configurations without making a database,
queue, provider or email call. `storage:check` authenticates Azure Blob and checks
private read/list/delegation access without writing an object. These checks do
not launch extra workers. `queue:check` authenticates sender/receiver links
without sending or consuming messages. `redis:check` verifies TLS/authentication
and PING without writing keys. Read [Service Bus](Service-Bus.md) and [Redis](Redis.md).

Start each role as its own supervised process on the selected host:

```powershell
npm run deployment:api
npm run deployment:outbox
npm run deployment:jobs
```

Do not start duplicates while this PC's three processes are already running.
An explicit alternate secret-file location is supported:

```powershell
node scripts/azure/run-backend.mjs api --env=/secure/dhumi/backend.env
node --import tsx scripts/azure/check-blob-storage.mjs --env=/secure/dhumi/backend.env
```

The launcher selects only the role's settings. API gets identity/customer/admission
SQL and Blob/session credentials. Dispatcher gets its SQL and queue credentials.
Job Manager gets job/recorder SQL, queue, Redis, Blob and provider credentials.
Ambient app secrets and `NODE_OPTIONS` are not inherited by the child.
Do not launch `node --env-file=.env.azure dist/server.js` directly: that would
give the API the entire master credential file, including the worker secrets.

## Before the final cloud-hosting cutover

Keep using this same private file as resources are added. The final hostname is
not yet known; no URL or queue endpoint has been invented. The current file is
working for the Azure-connected PC session. Before running on an Azure host:

1. The direct public endpoint works with the same env. For a private VNet route,
   establish access to `172.16.0.4:5432` and update the database host. Retain the
   existing database and separate live `leads_engine` project.
2. Keep `DATABASE_SSL_CA_BASE64` and `verify-full`. The public CA travels in the
   env; no platform-specific certificate path is required.
3. Set `FRONTEND_ORIGIN` / `APP_PUBLIC_URL` to the real HTTPS origin and configure
   the chosen private API/proxy binding. Set trusted proxy hops only for the
   actual reviewed proxy path.
4. Azure Service Bus and secured Redis are now qualified and active. This file
   retains separate queue credentials and a worker-only Redis URL. Preserve
   execution fencing, settlement, renewal and real scraping during hosting rollout.
5. Transfer existing secrets securely, including the reference-protection key,
   and qualify the complete hosted stack. Keep OTP disabled for this release as
   the owner requested. Normal production authentication is a later update.

The public [backend.env.example](backend.env.example) shows structure only.
Passwords, signing/provider/reference secrets, queue credentials and Blob client
secret are blank there. Obtain them privately from the owner; never commit the
filled file or put backend settings in Vite. An env file alone does not deploy
cloud hosting or networking. Azure Service Bus and Redis are created and connected.

The verified [database/result transfer](Connected-Backend.md) remains in place:
41 backend cases pass with this consolidated environment, and all three active
processes match its projected configuration. Nine focused credential-boundary
tests and TypeScript checks pass. No schema/data/credential change or paid
provider/email submission was made to consolidate settings.
