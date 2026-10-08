# Real local Docker demo

Latest organization update: [create-only organization design](../specs/demo-organization-design.md).
New users create an organization before service use; returning users restore the
session and validated active organization. Each user may create one organization.
Invitations/joining/activity are deferred. The separate [packaged deployment
rehearsal](../../deploy/demo/README.md) has its own copied data at port 3900;
the original manual portal below remains port 5173. Monitoring is stopped.

The owner's latest instruction replaces synthetic execution with **real Bright
Data scraping through the existing frontend Run/progress screen**. The canonical
operation is **Amazon products — Collect by URL**. No customer API contract,
database identity or applied migration is changed for this switch.

The original `127.0.0.1:5432/dhumi_test` remains a read-only clone source.
All interactive writes and Runs use Docker `127.0.0.1:55432/dhumi_test`.
Application source is root `back-end` / `front-end`; Context contains evidence.

## Running components

| Component | Local address |
| --- | --- |
| Portal | http://localhost:5173 |
| Customer API | http://localhost:3000/v1/status |
| Docker PostgreSQL 18.6 | 127.0.0.1:55432 / dhumi_test |
| Private Blob results / Azurite | 127.0.0.1:10000 |
| Service Bus emulator | 127.0.0.1:5672; health 5300 |
| Redis capacity leases | 127.0.0.1:6380 |
| Provider | Real Bright Data Amazon Products API, called only by Job Manager |

The normal compiled API, Outbox Dispatcher and Job Manager use their existing
restricted identities. The worker uses `/datasets/v3/scrape`, accepts actual
inline results and retains the existing snapshot/poll/download recovery path
when the provider returns 202. Customer admission still returns 202 with a Run
ID; the current frontend shows progress and downloads. No placeholder or
controlled fallback is selected for interactive Runs.

## Start and resume

```powershell
Set-Location D:\BrightDataCustomerFacing\back-end
npm.cmd run demo:start
npm.cmd run demo:status
```

Use `npm.cmd run demo:up` when local infrastructure must be provisioned/reused.
It retains an already-qualified Docker database and current demo user data.
The first real publication additionally requires
`--publisher-id=<existing active demo user UUID>`; the existing cutover receipt
remembers that attribution for later runs. The approved local cutover used the
owner's existing signed-in demo user. Do not assume another user's identity.

The first publication creates a new immutable version of the existing
`amazon-products-collect-by-url` Template, rather than modifying old versions.
It reads the actual account's scraper catalogue and encrypts the verified
dataset binding. Repeating provisioning checks the stored binding/definition
and refuses to overwrite a different accepted publication. It submits no scrape.

Existing `BRIGHTDATA_API_KEY` stays private in the backend credential holder.
Only the Job Manager child receives it. The persistent provider-reference key
comes from an existing `PROVIDER_REFERENCE_LOCAL_KEY` or the ignored,
current-user-protected `real-provider-reference-key.private.txt`. Preserve that
key with the database backup: it protects dataset and provider snapshot
references. Do not replace it on restart. API/frontend/outbox receive neither
provider credential, and runtime pools never receive the admin holder.

Credentials and settings are child-process overrides, not edits to `.env`.
Port 55432, dedicated queue `dhumi-demo-run-commands`, private container
`dhumi-demo-results` and Redis prefix `dhumi:local-demo:capacity` stay fixed.
Registered processes restart when their launch configuration changes, after
checking PID identity; unrelated processes/containers are untouched.

## Manual real scraping

Current Collect by URL publication is Template **v4**, with output schema v2.
Variants missing price/availability retain those values as `null`; records are
not discarded. Saved Services from v3 are disabled rather than repinned. Save
a fresh scraper name (for example `amazon-filter-v2`) for future Runs. The
owner's existing 136-record Run was recovered under its original ID from its
stored raw response; its previous failure remains in history.

1. Open the portal using `localhost`. Sign up/sign in and create an organization
   or select your existing one. Temporary OTP bypass remains enabled; invitations
   are shared manually. Session passwords, CSRF, membership and RLS still apply.
2. Choose **Amazon products — Collect by URL** from the Scraper Library.
3. Save a new scraper, for example `amazon-filterbuy-real`. Earlier synthetic
   Services are disabled and cannot be silently repinned to real execution.
4. Enter `https://www.amazon.com/dp/B00CK01P2A`, ZIP `10001`, language `EN`.
   Leave variants disabled for the single-product verification. Start collection.
5. Follow the Run until Ready, then prepare and download raw/normalized JSON.
   Check the real ASIN/product, and verify the Run, events and usage pages.
6. Invite another account and check shared Run visibility and admin restrictions.

Interactive submissions now reach the real provider and use its account's
billing. The previous `local-demo-products` and fabricated `linkedin-posts`
Templates are retired and absent from the catalogue. Their earlier Runs,
artifact bytes and immutable versions remain history; no past result is relabelled
as a real scrape. The other twelve Amazon operations remain unpublished because
this change qualifies only Collect by URL. Marketplace has no replacement fake
sample; real sample publication remains its own governed task.

## Verification without unintended paid requests

```powershell
npm.cmd run demo:test
```

The command now inspects Docker schema/publication/secret boundaries read-only,
then runs provider unit tests and separate Blob/Service Bus/Redis adapter tests.
It does not create users, organizations, Services or Runs, pause the worker,
or emit provider submissions. Unit tests use injected transport fixtures;
they are independent of interactive runtime. Adapter tests use the dedicated
`dhumi-demo-test-commands` queue and disposable objects/lease prefixes.

One normal-worker live qualification was explicitly performed for the owner's
selected product/ZIP, with one submission and its persisted idempotency guard.
Private receipt: `.runtime/local-demo/live-demo-verification.json`.
Do not rerun or remove the one-shot guard to conceal another paid verification.
Provider calls remain fenced and recorded; ambiguous submission POSTs are never
blindly retried.

## Monitoring and stop

Read-only manual observation remains active through **14:52 India time on
8 October**, with the existing three-second capture/five-minute review schedule.
It now observes real Runs and allows the provider's polling deadline. It never
submits provider work or controls the browser. Inspect/stop the observer:

```powershell
node .runtime/local-demo/manual-test-observer.private.mjs status
node .runtime/local-demo/manual-test-observer.private.mjs stop
```

Stopping observation leaves the app running; pause its separate app heartbeat
if ending the session early. To stop only the registered application processes,
run `npm.cmd run demo:stop`. Docker database/emulator volumes are retained.
Do not reset volumes, replay migrations or use ordinary host-profile workers.
Private sessions, signed URLs, dumps, role hashes and runtime keys stay ignored.

## Deployment boundary

This is a **working real-provider local demo**, not a completed cloud release.
See [the concrete Azure readiness map](real-demo-deployment-readiness.md).
Azurite and Service Bus emulator are still local substitutes. Production
configuration deliberately rejects them, environment-backed provider secrets,
the local reference protector and OTP bypass. Do not disable those gates or
claim changing host names alone deploys the application.
