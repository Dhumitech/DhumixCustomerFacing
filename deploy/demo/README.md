# Dhumi demo deployment

This is one Docker Compose deployment of the existing application. The portal,
API, PostgreSQL, outbox dispatcher, real Bright Data Job Manager, Redis, Azurite
and Service Bus emulator run together. Only Caddy publishes web ports. Database,
queue and storage ports stay private. This package has been rehearsed locally at
http://127.0.0.1:3900; no public server has been deployed.

The demo permits signup and one organization per creator without OTP. Invitations,
joining and activity are deferred. Existing memberships remain selectable. Runs
use the real provider through the normal progress screen, with no synthetic
fallback. Starting a collection can incur provider charges; qualification of this
change did not submit a collection.

Dataset Marketplace is a catalogue showcase for this release: LinkedIn People
and LinkedIn Posts are marked Coming soon. Previews, downloads and access
requests are deferred in the frontend; retained backend/data remain unchanged.
Rebuild the portal from the latest root source before releasing this correction.
The earlier 3900 rehearsal image does not include these later frontend changes.

## Prepare a private release

Use Node 24, PostgreSQL 18 client tools, Docker Engine and Docker Compose v2 with
raw `env_file` support. Start from this repository, including `back-end`,
`front-end` and `deploy`. Prefer an x86-64 Linux VM with 4 CPUs, 8 GB RAM and
persistent disk for this SQL-backed emulator stack. This sizing is a starting
point for a small demo, not load-test evidence.

From `back-end`, prepare an export of **Docker port 55432/dhumi_test only**:

```powershell
node --import tsx scripts/local-demo/prepare-deployment.mjs --public-origin=https://demo.your-domain.example --name=hosted-demo-release
```

Use your actual hostname. The exporter refuses active Runs and pending supported
Run commands, preserves all 25 tables, 75 migration entries and existing database
roles/passwords, and exports stored result objects with checksums. It makes no
host-port-5432 connection and does not replay migrations. Old unrelated outbox
test topics remain in history and are not dispatched as Run commands.

The output under `back-end/.runtime/hosted-demo-release` is **private**: database
dump, role password hashes, runtime credentials, encryption keys and result data.
Keep it out of Git, images, tickets and context records. Transfer this directory
privately to the VM. On Linux, restrict its parent to the deployment owner (mode
700). Runtime JSON files are read-only mounts readable by container UID 1000;
do not make the containing directory public. Preserve this bundle securely with
backups: encrypted provider bindings require its original encryption keys.

On the VM, edit the private `compose.private.env`:

```text
DHUMI_PRIVATE_DIR='/absolute/private/path/to/hosted-demo-release'
```

The exporter sets hostname, frontend Origin, secure cookies, public download
prefix and web ports for that hostname. Point its DNS A record at the VM and allow
inbound TCP 80/443. Keep PostgreSQL, Redis, AMQP, Azurite and SQL Server ports
closed. Caddy obtains HTTPS certificates for the configured hostname; certificate
issuance must be verified on the actual host. A CDN/load balancer is not part of
this one-edge configuration.

## Build and start

From the repository root on the VM:

```bash
docker compose --env-file /absolute/private/path/to/hosted-demo-release/compose.private.env -f deploy/demo/compose.yml build api frontend
docker compose --env-file /absolute/private/path/to/hosted-demo-release/compose.private.env -f deploy/demo/compose.yml up -d --no-build
docker compose --env-file /absolute/private/path/to/hosted-demo-release/compose.private.env -f deploy/demo/compose.yml ps
```

The initial empty PostgreSQL volume restores the reviewed schema/data once.
Database restore uses a single transaction; historical test rows are preserved.
Restore disables triggers only during data loading and reenables them before
commit. Result restore checks bytes, checksums and private-container access and
refuses to overwrite different bytes. Subsequent starts reuse named volumes.
Do not run `down -v`, migrations or the ordinary host-profile worker commands.

The application profile deliberately retains `NODE_ENV=test` from the local demo
so protected provider binding contexts keep their original environment. This is
an explicit demo profile, not production mode. Runtime containers are non-root,
read-only and receive only their mounted role configuration. The provider key is
mounted only in the Job Manager. The API trusts exactly one private proxy hop for
client-IP rate limits; the direct local profile trusts none. Caddy discards
untrusted incoming forwarded-IP headers ([Caddy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)).

Hosted Azurite uses a generated private account key, not the documented shared
development key. Custom accounts disable `devstoreaccount1`
([Azurite documentation](https://github.com/Azure/Azurite#customized-storage-accounts--keys)).
Only signed GET/HEAD object downloads pass through `/blob`; writes are denied.
Storage access logging is suppressed to keep signed URLs out of logs. Existing
local `.env`, PostgreSQL passwords and provider credentials are unchanged.

## Verify on the host

1. Open the HTTPS site and `/v1/status`; check the certificate and API health.
2. Sign up and sign in. Confirm that a new account automatically sees the themed
   mandatory create-organization dialog. Reject invalid email/password and
   mismatched password confirmation.
3. Create an organization. Save a scraper, reload the page and sign out/in.
   Confirm that the same organization and saved scraper return. A second create
   request must return 409; removed/closed organization history does not reset
   the creation limit.
4. Check Members shows the next-update notice and direct invitation/activity
   requests remain disabled. Check another organization's resources are hidden.
5. Download an existing authorized result and verify its checksum. Unsigned
   container listing and storage writes must fail.
6. If the owner chooses to test a paid collection, follow Run/events through
   ready/failed and inspect artifacts, usage and audit. Do not automatically
   retry a submission with an ambiguous provider outcome.

For the existing local rehearsal, use:

```powershell
docker compose --env-file back-end/.runtime/hosted-demo-rehearsal/compose.private.env -f deploy/demo/compose.yml ps
```

The original manual-testing portal remains http://localhost:5173 with Docker SQL
port 55432. The packaged rehearsal is a separate data copy at
http://127.0.0.1:3900; newly created accounts/organizations in one do not appear in
the other. Do not confuse either database with the untouched host port 5432.

## Operating limits and next release

Back up PostgreSQL, stored objects and private encryption/configuration material
together. Never clone queued work into a second running worker deployment. Pin
the tested app image release tag; preserve the previous image for application
rollback and preserve volumes. Reverting code does not restore database data.

This is a small demo using local emulators. Microsoft documents Service Bus
emulator limitations, including loss of messaging state on restart
([emulator documentation](https://learn.microsoft.com/en-us/azure/service-bus-messaging/overview-emulator)).
Do not restart the queue while work is active. Managed Azure Service Bus/storage,
production secret management, OTP/email proof, invitation/activity release,
production monitoring/backups and load qualification remain separate work.

Both npm audits pass. The installed Docker Scout scanner requires Docker login,
so an OS/container CVE scan has not been completed. Actual cloud hostname/TLS,
firewall and provider connectivity must be checked after the host is selected.
Do not describe the local rehearsal as a completed production deployment.
