# Docker rehearsal with the existing Azure services

**Runtime handoff completed, 9 October:** the four owned rehearsal containers
are gracefully stopped and retained for rollback. Use the [hosted Azure portal](../azure/Container-Apps.md)
for manual testing. Do not execute the local start/recreate commands below while
cloud workers are active. These steps describe the preceding rehearsal only;
rollback requires an idle gate and stopping cloud workers before local startup.

This package runs the current root frontend, API, outbox dispatcher and Job
Manager in four Linux containers before Azure application hosting. It uses
the owner's private `back-end/.env.azure`, retaining its credentials and direct
verified PostgreSQL TLS. It creates no Azure resources, database copy, migrations,
emulators or synthetic Runs. The accepted demo keeps OTP and collaboration off.

**Application runtime is separate; Azure data and services are shared.** Manual
signup, organization, saved scraper and Run actions write to the same
`dhumi_shared.app` used during the preceding tests. Real Runs incur real provider
work. The launcher/checkers never submit a provider request or send email.
`leads_engine` and other projects remain outside this package.

The portal is **http://127.0.0.1:4173**. Caddy serves the compiled frontend and
proxies `/v1/*` to the private API on 3000. Only the portal port is published,
bound to loopback. Production frontend configuration uses this same origin;
no localhost API address or backend credential is baked into JavaScript.
Azure result downloads remain HTTPS links to private Blob storage.

This supersedes the older emulator rehearsal at port 3900 for this test. That
package and its private volumes remain unchanged. The preceding Vite profile
on 5173 is preserved on disk; it is not the active qualified portal. Use 4173
after the application handoff.

## Prepare and build

Prerequisites: Docker Engine/Desktop with Compose, Node.js 24 and the private
filled `.env.azure`. No Azure CLI sign-in, SSH tunnel, CA-file installation or
database administrator credential is needed to run these four containers.
From the repository root:

```powershell
npm --prefix back-end ci
npm --prefix back-end run build
node back-end/scripts/azure/prepare-docker-rehearsal.mjs --port=4173
$rehearsalEnv = 'back-end/.runtime/azure-docker-rehearsal/compose.private.env'
$rehearsalCompose = 'deploy/azure-rehearsal/compose.yml'
docker compose --env-file $rehearsalEnv -f $rehearsalCompose config --quiet
docker compose --env-file $rehearsalEnv -f $rehearsalCompose build
```

Preparation projects the existing master through the shared role allowlists.
Only API gets identity/customer/admission credentials and session keys. Outbox
gets its SQL login and queue sender. Jobs gets Job Manager/result-recorder SQL,
queue receiver, Blob, Redis and provider/reference keys. Runtime JSON files are
mounted read-only; images never contain `.env.azure`. The frontend gets only
the exact public signup legal metadata used by the preceding portal.
Its existing demo values are retained in [signup-legal.json](signup-legal.json)
for a fresh developer checkout with just the project and `.env.azure`; no
additional private frontend env is required. The repeated `a` hash is the
preceding demo's fixture consent metadata, not a newly verified production
legal-document digest. A future normal production release must supply its
approved document catalogue. This rehearsal preserves the tested demo values.

Only child API listener, proxy trust and public-origin settings change. Database,
Blob, queue, Redis, secrets and encryption keys are retained. The master env
is unchanged. Private generated files and evidence stay in ignored
`back-end/.runtime/azure-docker-rehearsal/`, protected for the owner on the host.
Docker can read the individually mounted secret files as UID 1000.

Preparation refuses an existing completed bundle. Do not overwrite mounted
settings during a Run; stop this rehearsal and deliberately prepare a new
reviewed bundle before a later configuration change.

## Verify connections before starting workers

From the same root PowerShell session:

```powershell
$rehearsalCheck = "$((Get-Location).Path.Replace('\','/'))/back-end/scripts/azure/check-docker-rehearsal.mjs:/app/scripts/azure/check-docker-rehearsal.mjs:ro"
foreach ($rehearsalRole in @('api','outbox','jobs')) {
  docker compose --env-file $rehearsalEnv -f $rehearsalCompose run --rm --no-deps -v $rehearsalCheck $rehearsalRole node scripts/azure/check-docker-rehearsal.mjs $rehearsalRole
  if ($LASTEXITCODE -ne 0) { throw 'Container connection qualification failed' }
}
```

These use the actual Linux image and that role's mounted credentials. All six
SQL logins authenticate with certificate/endpoint verification and explicit
read-only transactions ending in rollback; only the `app` catalogue count is
read. Blob checks list/read and delegation permissions. Queue checks open a
sender batch without sending and peek without consuming. Redis uses TLS/PING,
without lease writes. No provider adapter is invoked.

## Hand off application ownership

Before the first `up`, verify no active Runs or pending Run commands and stop
the preceding deployment's owned API/outbox/jobs. Do not run another set of
workers against the same queue. Keep any operator access, unrelated containers
and database services running. The owner's PC handoff and database preservation
evidence are recorded in the dated context, not implemented by this Compose
file. An operator-only idle inspection may use SSH; application startup does not.

```powershell
docker compose --env-file $rehearsalEnv -f $rehearsalCompose up -d --no-build --wait --wait-timeout 90
docker compose --env-file $rehearsalEnv -f $rehearsalCompose ps
Invoke-RestMethod http://127.0.0.1:4173/v1/status
```

API and frontend have HTTP healthchecks. Check worker logs and authenticated
dependency checks as well; a running worker container alone does not prove
queue execution. All roles run as UID 1000 with read-only root filesystems,
temporary `/tmp`, dropped capabilities and bounded memory/log files. No database
or result volume is used: all persistent application state is in Azure.

## Owner's manual acceptance

Sign in again on 127.0.0.1; its host-only browser cookies are separate from the
localhost portal. Existing Azure accounts, organizations, saved scrapers, Runs
and usage should appear. Test:

1. New signup, required fields/password checks and existing-email rejection.
2. Sign-in, sign-out, refresh and returning organization preference.
3. One organization creation per account; services require an organization.
   Invitations/joining/activity remain deferred. Password support is contact-only.
4. Load saved scrapers; Marketplace shows the accepted Coming soon cards.
5. Manually start an Amazon collection, including the chosen variant option;
   wait for the existing progress screen to become ready.
6. Download results and check Runs/usage. Repeat the same URL as a separate Run
   and verify its own result and usage, rather than reusing another Run's output.

After the Run is terminal, a controlled container recreation should retain
login/organization/results and reconnect the workers. Do not interrupt a paid
Run to perform this deployment smoke check. Logs can contain sensitive context;
keep them private and report only sanitized status/request/trace information.

## Stop / return to the preceding runtime

Wait for Runs and pending execution work to finish first:

```powershell
docker compose --env-file $rehearsalEnv -f $rehearsalCompose down
```

This removes only this project's application containers/network, not Azure
resources or data. Only after it stops may the preceding owned PC/cloud worker
group be started again. Do not use Docker prune or stop other Compose projects.

Cloud hosting, public HTTPS/domain configuration and Azure-host restart/ingress
acceptance are still required after this local manual rehearsal. The retained
no-OTP mode is the owner's selected demo release, not the deferred normal OTP
production flow. See [portable connections](../azure/Portable-Connections.md).
