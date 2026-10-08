# Hosted Dhumi demo — 9 October 2026

The frontend, Customer API, Outbox Dispatcher and Job Manager are deployed in
`rg-dhumcustomerfacing-centralindia`, Central India, using the tested
[digest-pinned release](Container-Registry-Release.json).

**Portal:** https://ca-dhumi-frontend-ci-01.bluerock-9b30fd6a.centralindia.azurecontainerapps.io

Use this HTTPS portal for manual testing. The four `dhumi-azure-rehearsal`
containers on port 4173 are stopped, retained for rollback. Earlier PC workers
remain paused. Cloud applications need no PC process, SSH tunnel or emulator.
Do not start either local worker stack alongside the cloud workers.

## Applications and connections

| Application | Exposure | Capacity | Purpose |
| --- | --- | --- | --- |
| `ca-dhumi-frontend-ci-01` | Public HTTPS, container port 8080 | 0.25 CPU / 0.5 GiB | Compiled portal; same-origin `/v1/*` proxy |
| `ca-dhumi-api-ci-01` | Internal HTTPS, container port 3000 | 0.5 CPU / 1 GiB | Authentication, organizations, scrapers, Runs, downloads and usage |
| `ca-dhumi-outbox-ci-01` | No ingress | 0.25 CPU / 0.5 GiB | Publish persisted Run commands to Service Bus |
| `ca-dhumi-jobs-ci-01` | No ingress | 1 CPU / 2 GiB | Consume commands, real Bright Data execution, results and usage |

Each role has one continuously running replica, maximum one. These are
Container Apps, not scheduled jobs. Frontend/API have startup, readiness and
liveness probes. The workers execute the existing compiled startup, database
capability and schema checks. Console/system logs go to `law-dhumi-ci-01`.
[Deployment metadata](Container-Apps-Deployment.json) lists actual revisions,
images and ingress settings without credentials.

All dependencies remain the existing Azure resources:

- PostgreSQL on `dhumi-db`, direct `20.244.41.57:5432`, `dhumi_shared.app`,
  verified TLS with the retained public CA; 25 tables / 75 migration entries.
- Private Blob container `stdhumici01/dhumi-results`.
- Service Bus `sb-dhumi-ci-01/dhumi-run-commands`.
- Secured Redis `redis-dhumi-ci-01` over TLS.

`leads_engine` belongs to a live separate project and must never be accessed or
changed by these deployment or qualification steps.

## Where the settings live

The unchanged, ignored `back-end/.env.azure` remains the private source for
deployment preparation. [prepare-container-apps.mjs](../../back-end/scripts/azure/prepare-container-apps.mjs)
validates the source and projects only each role's required credentials. It
writes private parameter/profile files under ignored
`back-end/.runtime/azure-container-apps-20261009/`; never commit or print them.

Each backend Container App stores its own JSON profile in the app-scoped
`runtime-settings` secret, mounted as `/run/secrets/runtime.json`. The API gets
its three SQL capabilities, browser-session settings and Blob credentials;
outbox gets its SQL capability and queue sender credentials; jobs gets its two
SQL capabilities, queue receiver, Blob, Redis and provider settings. The full
master env is not uploaded to each app. The frontend has no backend credentials.
Existing credential values were retained.

The API projection sets `HOST=0.0.0.0`, `PORT=3000`,
`FRONTEND_ORIGIN` and `APP_PUBLIC_URL` to the HTTPS portal, and
`TRUST_PROXY_HOPS=1`. Refresh cookies remain host-only, HttpOnly, with Secure
enabled for HTTPS. Caddy proxies to the internal API over verified HTTPS.
Allowed-origin preflight passes; an untrusted origin receives no permission.
HTTP redirects to HTTPS. The internal API returns 404 from the public internet.

`id-dhumi-acr-pull-ci-01` is a managed identity with only registry-scoped
`AcrPull`. Its runtime identity lifecycle is `None`: Azure uses it to pull the
images, while application service credentials remain the accepted portable
profile. No registry password/admin account was enabled. See Microsoft's
[secret mounts](https://learn.microsoft.com/azure/container-apps/manage-secrets)
and [managed identity lifecycle](https://learn.microsoft.com/azure/container-apps/managed-identity)
documentation; the tested Caddy version handles the HTTPS upstream Host as
described in its [reverse-proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

## Qualification and scope

A temporary manual Container Apps Job ran the existing
[read-only checker](../../back-end/scripts/azure/check-docker-rehearsal.mjs)
in three scoped containers. All six SQL logins, Blob read/delegation, Service
Bus sender authentication/receiver peek and Redis TLS/authenticated PING pass.
The job succeeded and was deleted after its sanitized evidence was retained.
It sent/consumed no queue messages and made no provider or email submission.

The public portal passes SPA/deep routes, proxied API status, security headers,
HTTPS redirect and CORS checks. Using an existing session without creating a
user/session, existing organization, saved scraper and catalogue reads pass.
Two existing ready Runs, usage events/summary and four raw/normalized downloads
pass; all downloaded bytes match the database size and SHA-256. All existing
app rows are preserved. The only added rows are four ordinary download
authorization audit receipts. All four roles deliver logs; both worker startup
records pass with no error-level records at qualification.

The owner-selected demo behavior is retained: no OTP/email verification,
password sign-in, duplicate-signup rejection, mandatory create-only organization
onboarding, one created organization per user, returning organization preference,
deferred invitations/joining/activity and Marketplace Coming soon. No application
source, migrations, roles/passwords or existing credential values were changed
by this hosting increment. No fresh scraping submission was made for qualification.

## Manual acceptance

1. Open the HTTPS portal and sign in; browser sessions are scoped to this new
   origin, so the earlier localhost browser login does not carry over.
2. Confirm the returning organization and saved scrapers load. A fresh account
   should create its single organization; duplicate signup should be rejected.
3. Start one owner-approved collection, follow its Run/progress, and verify
   the download and Usage once ready. This is real Bright Data work.
4. Re-run the same input deliberately and verify its distinct Run/results.
   Confirm Marketplace cards remain Coming soon and collaboration stays deferred.

These manual cloud account/collection actions are the next acceptance check;
the automated qualification verified existing data without a new paid scrape.
Custom domain, automated releases, alert rules, secret rotation and next-update
OTP/collaboration are separate increments, not prerequisites for this HTTPS demo.

## Deployment and rollback

Root deployment source is [registry-pull-identity.bicep](registry-pull-identity.bicep),
[container-app.bicep](container-app.bicep) and
[connection-qualification-job.bicep](connection-qualification-job.bicep).
Use Azure CLI incremental group deployments with the private prepared parameter
files. Secure object parameters hold the profiles; deployment outputs contain
only names/IDs/status/FQDNs. Do not use `--debug`, echo settings or put credentials
in command-line arguments.

For later backend/secret changes, first gate zero active Runs, zero unpublished
Run commands and zero active/scheduled queue messages, then freeze creation and
perform a controlled worker rollout. Never run both stacks or replay migrations
to deploy an image. For a rollback to the retained Docker rehearsal, first stop
the cloud workers/API admission after the same idle gate, confirm cloud replicas
are stopped, then start the owned Docker roles from the existing private profile.
Keep at least one complete digest-pinned release and its private profile available.
