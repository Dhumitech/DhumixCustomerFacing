# Dhumi customer portal

Current local refactor: [0075 status and checkout guidance](docs/runbooks/refactor-status.md), only in `dhumi_test`: **25 tables / 279 stored columns / 75 migrations**. Source stays in the existing root packages. Local context, snapshots, credentials and runtime evidence are Git-ignored. Existing database identities/passwords remain until their separately qualified replacement. Normal private-env startup still needs owner-provided `OTP_SECRET` and `EMAIL_FROM`. The original setup commands below are historical baseline guidance; do not replay bootstrap/migrations, replace the owner's `.env`, enable another database or start external services merely to follow them.

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
