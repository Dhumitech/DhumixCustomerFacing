# Dhumi customer portal

**Current deployment, 9 October: [hosted Azure demo](deploy/azure/Container-Apps.md).**
Frontend, internal API, outbox and Job Manager run in Azure Container Apps using
the tested pinned images and role-scoped mounted secrets. [Open the HTTPS portal](https://ca-dhumi-frontend-ci-01.bluerock-9b30fd6a.centralindia.azurecontainerapps.io).
All four Azure connections, existing organization/scraper/Run/usage reads,
four verified downloads, HTTPS/CORS and all-role logs pass. No OTP/create-only
organizations/Marketplace Coming soon remain. The 4173 Docker roles are stopped
and PC workers paused; do not restart them alongside cloud workers. Existing
app rows and credentials remain, with only four normal download audit receipts
added. Fresh cloud signup/collection manual acceptance is next. The dated
deployment notes below describe preceding boundaries, not the active runtime.

Latest Azure foundation, 9 October: [Container Apps environment and Log Analytics](deploy/azure/Container-Apps-Environment.md)
are created and verified, with a dedicated new app VNet. `cae-dhumi-ci-01` uses
the Consumption profile and zone redundancy; `law-dhumi-ci-01` keeps 30 days
of logs. The master env, existing database network and running 4173 Docker demo
remain unchanged. Hosted frontend/API/workers and their cloud acceptance are
the next deployment step.

Latest Azure resource, 9 October: [Container Registry](deploy/azure/Container-Registry.md)
is created as `acrdhumici01` in the existing Central India resource group.
Both tested Docker images are published and verified by digest/pull, with
admin/anonymous access disabled. The current portal remains on 4173 and the
private env is unchanged. Container Apps environment, logging and application
hosting remain the next deployment steps.

Current manual deployment rehearsal, 9 October: [fresh Docker applications with Azure dependencies](deploy/azure-rehearsal/README.md), at http://127.0.0.1:4173. Frontend/API/outbox/jobs run in Linux containers using the unchanged private `.env.azure`. The preceding PC application roles are paused. Data/services are shared with Azure; there is no database copy or emulator. Existing Run/usage/download checks and container recreation pass; 105 frontend tests pass. Use this portal for the next manual test, preserving no OTP/create-only behavior. Public Azure application hosting remains pending.

Latest connection update, 9 October: [portable Azure connections](deploy/azure/Portable-Connections.md). The filled private `.env.azure` connects API/outbox/jobs directly over verified TLS; its public CA is embedded. Developers can use the same env without SSH keys, tunnels or certificate-file paths. Use the handoff commands there instead of historical bootstrap instructions below. Application hosting remains local.

Current refactored baseline: [0075 status and checkout guidance](docs/runbooks/refactor-status.md), **25 tables / 279 stored columns / 75 migrations**. It was qualified in `dhumi_test` and later copied into Azure `dhumi_shared.app`. Source stays in the existing root packages. Local context, snapshots, credentials and runtime evidence are Git-ignored. Existing database passwords remain; the owner has deferred identity consolidation and further unnecessary refactors in favor of deployment readiness. The original setup commands below are historical baseline guidance; do not replay bootstrap/migrations, replace the owner's `.env`, enable another database or start external services merely to follow them.

Temporary [quick demo without OTP](docs/runbooks/demo-no-otp.md): signup/sign-in and immediate organization creation work without email proof. New users see mandatory themed onboarding; returning users keep a validated active organization. Each user may create one organization. Invitations, joining and activity are deferred; password reset is unavailable in this mode. Passwords, CSRF and server authorization remain required.

The current backend uses [one private deployment environment](deploy/azure/Backend-Environment.md), `back-end/.env.azure`, projected into each process's required credentials. `deployment:check`, `storage:check`, `queue:check` and `redis:check` validate configuration and real Azure connections. Both workers use [Azure Service Bus](deploy/azure/Service-Bus.md), and Job Manager uses [secured Azure Redis](deploy/azure/Redis.md). The owner retains no OTP for this Azure demo; cloud hosting and normal production authentication are later steps.

The [qualified Docker demo package](deploy/demo/README.md) is rehearsed at http://127.0.0.1:3900 in a separate database copy. It includes compiled API/workers, the portal, private infrastructure and an HTTPS deployment recipe. Both package checks pass (1,211 backend tests / 95 frontend tests), with 22 live API checks and all 39 stored object downloads verified. No cloud host has been provisioned.

The current working session uses [the Azure-connected backend](deploy/azure/Connected-Backend.md): Azure `dhumi_shared.app` has **25 tables / 75 entries**, and all 36 referenced results are in real Azure Blob Storage. Both workers use Azure Service Bus; Job Manager uses Azure Redis. The live `leads_engine` is preserved. API/workers/portal hosting remains local. [Open the portal](http://localhost:5173) and follow [manual test steps](docs/runbooks/azure-manual-testing.md). The [Docker/Azurite runbook](docs/runbooks/local-docker-demo.md) belongs to the retained source stack; `demo:start` must not silently switch this connected session back. Real Bright Data execution remains, and qualification submits no paid Run. [Managed hosting requirements](docs/runbooks/real-demo-deployment-readiness.md) remain separate.

Dhumi is a customer-facing portal for authenticated, tenant-isolated scraper Runs and Dataset Marketplace previews. Customers use the React portal and Dhumi API; provider credentials and private storage identifiers stay on the backend. The local backend has three processes: Customer API, Outbox Dispatcher, and Job Manager.

This repository is a development/demo implementation, not a turnkey production deployment. Marketplace sample browsing, filtering, and limited downloads are separate from paid dataset purchase and export. Do not treat a visible dataset or a passing local health check as authorization to create billable provider work.

## Repository map

- [`front-end/`](front-end/) — React/Vite portal; its API client is generated from the backend OpenAPI contract.
- [`back-end/src/`](back-end/src/) — Fastify API, workers, admission logic, and private integrations.
- [`back-end/contracts/openapi.yaml`](back-end/contracts/openapi.yaml) — canonical public HTTP API contract.
- [`back-end/scripts/migrations/`](back-end/scripts/migrations/) — forward-only PostgreSQL migrations.
- [`back-end/scripts/bootstrap/README.md`](back-end/scripts/bootstrap/README.md) — first-time local PostgreSQL bootstrap and restricted roles.
- [`back-end/tests/`](back-end/tests/) — unit, contract, integration, and privileged tests.
- [`docs/decisions/`](docs/decisions/) and [`docs/runbooks/`](docs/runbooks/) — decisions and operator guidance.

## Local requirements

- Node.js 24 and npm (both packages require Node `>=24 <25`)
- PostgreSQL 18 and `psql` on `PATH`
- Docker Desktop with Docker Compose
- PowerShell for the checked-in setup and verification scripts

## First-time setup

From the repository root:

```powershell
Set-Location .\back-end
npm ci
Copy-Item .env.example .env
Copy-Item .env.pattern4.example .env.pattern4

Set-Location ..\front-end
npm ci
Copy-Item .env.example .env.local
```

Complete the local PostgreSQL bootstrap using the [bootstrap guide](back-end/scripts/bootstrap/README.md). Fill the ignored `.env`, `.env.pattern4`, and `.env.local` files with local values. In particular, configure restricted database logins, approved signup legal-document metadata, separate local signing/envelope keys, and the emulator settings. Review and accept the SQL Server and Service Bus emulator license terms before setting `PATTERN4_ACCEPT_EULA=Y`. The frontend's legal-acceptance metadata must match the backend's approved documents; the example hashes are placeholders.

Keep `RUN_EXECUTOR_DRIVER=controlled` for non-billable local work. In a fresh terminal at the repository root, apply reviewed, forward-only migrations with a privileged PostgreSQL identity and an interactive password prompt; never put a database password in the URL:

```powershell
Set-Location .\back-end
.\scripts\migrate.ps1 -DatabaseUrl 'postgresql://postgres@localhost:5432/dhumi_dev' -PromptForPassword
```

The migration runner applies **all pending migrations**, not just one selected version. Review the pending changes and target database before running it.

## Start and verify

Start Docker Desktop and PostgreSQL. In a fresh terminal at the repository root, run:

```powershell
Set-Location .\back-end
npm.cmd run infra:pattern3:up
npm.cmd run infra:pattern4:up
```

Start each of these in its own terminal from `back-end`, and leave the terminals open:

```powershell
npm.cmd run dev
npm.cmd run worker:outbox
npm.cmd run worker:jobs
```

Start the portal in another terminal from `front-end`:

```powershell
npm.cmd run dev
```

Open [http://localhost:5173](http://localhost:5173). Use `localhost` for the portal: the example backend CORS origin is `http://localhost:5173`. From a fresh terminal at the repository root, check the backend and infrastructure without submitting a Run or calling Bright Data:

```powershell
Set-Location .\back-end
.\scripts\Verify-LocalBackend.ps1 -ExpectedExecutorDriver controlled
```

The verifier must end with `READY: backend and infrastructure verification passed.` The portal should return HTTP 200 at `http://localhost:5173`. If a worker is already running, do not start a duplicate. The Job Manager's startup log must show `executorDriver=controlled`.

To stop the stack, press Ctrl+C in the Job Manager, Outbox Dispatcher, API, then frontend terminals. From `back-end`, run `npm.cmd run infra:pattern4:down` followed by `npm.cmd run infra:pattern3:down`. Do **not** add `-v`; that would remove local Docker volumes.

## Checks and boundaries

From a fresh terminal at the repository root:

```powershell
Set-Location .\back-end
npm.cmd run typecheck
npm.cmd test

Set-Location ..\front-end
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

Some privileged integration tests require separate infrastructure or credentials; see their individual READMEs. `RUN_EXECUTOR_DRIVER=bright_data` can create billable work from eligible queued Runs and must not be used casually. A successful health check is not a paid-call approval.

Git stores source, contracts, migrations, and sanitized examples—not PostgreSQL rows, Docker volumes, Azurite objects, generated evidence, signed links, or live secrets. Never commit `.env` files, database passwords, access tokens, provider credentials, or storage connection strings. `Project Specs/`, `Checkpoints/`, and `API-Design-Skill/` are intentionally excluded; review `git status` and the staged diff before pushing because `.gitignore` does not untrack previously committed files.

Generated Marketplace sample-download copies have a separate private retention job. See the [sample-download cleanup runbook](docs/runbooks/sample-download-cleanup.md); it does not delete source samples or raw/normalized Run results.
