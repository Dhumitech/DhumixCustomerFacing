# Shared scraper processing and operation onboarding

Status: shared processing, private draft staging, one immutable release identity
and fail-closed commercial admission are implemented and verified offline,
20 September 2026. **Migrations 0066-0069 have not been activated on operational
databases. No new retailer is published or qualified.**

## What is shared

One processing module validates and serializes input, classifies result errors,
projects reviewed output fields and validates normalized JSON. One private
executor handles HTTP submission, asynchronous continuation, cancellation,
durable polling budgets and raw/normalized ingestion. Existing Tenant
transactions, idempotency, connection pools, worker concurrency, outbox,
Attempt fences, storage, downloads, audit and usage remain shared.

Pure processing lives in `back-end/src/services/scrapers/`. Provider access stays
in `back-end/src/services/brightdata/`. Admission imports only the pure module;
it cannot import the provider client or resolve credentials. The existing
Integration Boundary security test remains unchanged.

The dispatcher registers **protocol/version identities**, not retailers. Target,
Lowe's, Home Depot, Etsy and Walmart all use the same new executor in offline
tests. They have five JSON fixture packages, not five TypeScript executors.
Migration `0068` adds the one reviewed `1.1.0` runtime identity. Migration
`0069` adds one commercial-capacity function for every operation on that
protocol; neither migration contains a retailer identity or creates customer
work.

## 1. Gather an operation's evidence

Retain exact approved provider inputs, successful responses, error responses and
continuation/cancellation capabilities. Do not infer a complete input/output
contract, location rules or supported optional values from one successful row.
Obtain the operation's commercial and qualification approval separately.

The supplied retailer packages deliberately remain
`fixture_only_not_qualified`. They project four observed fields from twelve
success records. This demonstrates the reusable seam, not complete provider
schemas. In particular:

| Observed difference | Shared processing behavior |
| --- | --- |
| Target ZIP `01011` | Preserve a string and leading zeros |
| Lowe's `availability` array | Preserve its array type; do not coerce to a string |
| Home Depot string price and numeric `store_number` | Preserve each reviewed type |
| Etsy `all_variations: false` | Preserve false; do not treat it as missing |
| Walmart optional fields observed only as empty strings | Reject unproven nonempty values in this fixture contract |

Provider documentation confirms the common `200` inline and `202` snapshot
paths, with `Retry-After` on the latter. Per-operation support still needs
qualification. Sources: [synchronous requests](https://docs.brightdata.com/api-reference/scrapers/synchronous-requests),
[asynchronous requests](https://docs.brightdata.com/api-reference/rest-api/scraper/asynchronous-requests),
[progress monitoring](https://docs.brightdata.com/api-reference/scrapers/management-apis/monitor-progress).

## 2. Supply one reviewed operation package

Start from `back-end/tests/fixtures/scraper-operations/target.json`. Keep the
package internal and separate from public catalogue responses:

```text
operation-package.json
  evidence                         source checksum, provenance, limitations
  contract
    operationCode                  stable internal operation identity
    inputSchema                    strict targets[] objects and field types
    outputSchema                   strict normalized object array
    processing
      version / revision           immutable descriptor revision
      urls                         accepted HTTPS hosts/paths per URL field
      request                      reviewed scrape/trigger and collect/discover
      request.fields               exact reviewed target field names
      request.limitPerInput        explicit reviewed omission/null/value rule
      request.snapshot             qualified continuation/cancel capabilities
      projectedFields              exact normalized output properties
      schemaVersion                immutable output contract identity
      usage                        observed record meter and unit
      maxRecords                   bounded post-response processing policy
  input / records                  offline success evidence
  expectedTargets                  exact expected serialization
  expectedNormalized               exact expected normalized JSON
```

Current shared processing is intentionally **type-preserving projection**, not
a configurable transform language. JSON Schema expresses required/optional
fields, types, enums, regexes, arrays and objects. Serialization copies only
present reviewed fields; it never silently adds defaults, renames parameters,
coerces values or removes unknown input. A transformation or protocol behavior
not supported by this version requires a reviewed, pure extension in a **new
engine version** and fixtures, not arbitrary executable JSON.

Contracts use only local schema references and fixed approved provider paths.
Never put provider tokens, dataset/snapshot IDs, Tenant IDs, object keys or
arbitrary endpoints into a package/public Template. The provider dataset ID
belongs in the existing encrypted protected mapping, including its AAD lineage.

## 3. Validate offline

```powershell
Set-Location 'D:\BrightDataCustomerFacing\back-end'
npm.cmd run operator:scraper-contract -- validate --package '.\tests\fixtures\scraper-operations\target.json'
```

This command does not load `.env`, open a database, resolve a secret or create
a provider client. It verifies exact fixture serialization/normalization and
prints the immutable contract SHA-256 plus the proposed private
`scraper_processing` / `scraper_contract_sha256` output policy. Exit zero means
**offline characterization passed**, not qualified or published. It performs no
migration generation, publication, pointer change, Service/Run creation or POST.
An example path must point to a real file. The validator now reports a missing
file explicitly; `D:\actual\path\my-scraper.json` is not a repository file.

Use the same command for the other four packages. Adding a same-protocol
operation does not require another route, worker, database pool or product
table. Its approved schemas, presentation, private mapping and evidence are
still required; an unsupported protocol needs a new shared protocol module.

## 3a. Register a reviewed private draft

Migration `0067_shared_scraper_draft_registration.sql` adds a guarded operator
function for any same-protocol operation. It creates a pending evidence row,
draft Template and immutable version 1, and one audit. It creates **no**
provider mapping, enabled adapter, public pointer, Service, Run or outbox row.
Exact replays return `replayed`; changed packages or slugs conflict. The
customer capability cannot see the draft.

Before staging, make a real package file from exact reviewed evidence. The
five `tests/fixtures/scraper-operations/*.json` files have
`status: fixture_only_not_qualified` and **cannot** be staged. A candidate adds
these reviewed, operation-specific fields while retaining the validated
`contract`, `input`, `records`, `expectedTargets` and `expectedNormalized`:

```json
{
  "status": "reviewed_candidate",
  "evidence": {
    "kind": "reviewed_provider_contract",
    "sourceSha256": "<sha256-of-reviewed-source>"
  },
  "presentation": {
    "slug": "<unique-operation-slug>",
    "publicName": "<reviewed-name>",
    "publicDescription": "<reviewed-description>",
    "availabilityCopy": "Qualification pending",
    "configurationSchema": {
      "type": "object", "additionalProperties": false, "properties": {}
    },
    "metadata": {
      "domain_slug": "<domain-slug>", "domain_name": "<domain-name>",
      "category": "<category>", "icon_key": "<icon-key>",
      "operation_group": "<operation-group>",
      "operation_name": "<operation-name>", "display_priority": 100
    }
  }
}
```

This is a field outline, **not a runnable package**. Only use a real, reviewed
file, with the existing contract and fixtures. `reviewed_candidate` means a
human reviewed the offline package; it does not assert live qualification.
Keep restricted provider evidence outside the public catalogue.

After activating the reviewed migrations through `0067` using the existing
privileged migration workflow, stage a real package with the configured
operator role, explicitly naming the expected database:

```powershell
Set-Location 'D:\BrightDataCustomerFacing\back-end'
$package = Read-Host 'Absolute path to the existing reviewed scraper package JSON'
if (-not (Test-Path -LiteralPath $package -PathType Leaf)) { throw 'The package file does not exist.' }
$evidence = Read-Host 'Restricted, non-secret evidence reference'
$database = Read-Host 'Expected database name (for example dhumi_dev)'
npm.cmd run operator:scraper-onboard -- stage --package $package `
  --evidence-reference $evidence --actor local.operator `
  --expected-database $database --confirm-draft
```

The script rejects a fixture-only package before connecting to PostgreSQL.
This command must not be mistaken for qualification or publication. Do not
change `SHARED_SCRAPER_PIPELINE_ENABLED` or submit a customer Run based on it.

## 4. Verify the foundation without touching dev/test

```powershell
Set-Location 'D:\BrightDataCustomerFacing\back-end'
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
& '.\tests\privileged\shared-scraper-processing\Verify-SharedScraperProcessing.ps1'
```

The PowerShell verifier requires PostgreSQL 18 binaries on PATH. It refuses an
occupied/non-operational port mismatch, creates a new temporary loopback-only
cluster on port 54390, uses the existing role/database/schema bootstrap and
forward migration runner, exercises rollback-only guards, then stops its own
cluster in `finally`. Temporary trust authentication is for synthetic test data
only. It never connects to `dhumi_dev`/`dhumi_test`, starts workers or calls a
provider. Its stopped temporary data/log path is printed for inspection; do not
expose or reuse that trust-authenticated cluster as an application database.

The real SQL matrix covers least privilege, owner FORCE RLS, exact pins, wrong
Tenant, stale fence, expired lease, durable-raw requirement, credential-free
normalization and original ambiguous continuation. It also proves a
reconciliation attempt cannot acquire submission authority.

## 5. Protected release and rollout — operation-specific evidence still pending

1. Review migrations `0066` through `0069` and deployment order.
   It registers a **disabled** shared adapter and three narrow guarded readers;
   it creates no retailer Template, mapping, Tenant data or queued work.
   Migration `0067` adds private draft staging only. Migration `0068` adds a
   separate enabled runtime identity without binding it to any operation.
   Migration `0069` requires a mapping-owned, approved spending policy before
   admission; missing, malformed, expired or over-limit policy fails before a
   Run or outbox event exists.
2. Apply reviewed pending migrations using the existing privileged migration
   workflow, then deploy API/worker code together. This implementation did not
   apply anything to operational dev/test databases.

   From the backend directory, the bounded activation command is:

   ```powershell
   Set-Location -LiteralPath 'D:\BrightDataCustomerFacing\back-end'
   & '.\tests\privileged\shared-scraper-processing\Apply-SharedScraperProcessingMigrations.ps1' -Target Both
   ```

   It prompts once for the PostgreSQL administrator password, verifies the
   `dhumi_test` and `dhumi_dev` identities, applies only pending migrations
   through `0069`, verifies every ledger checksum and guarded database surface,
   and fails if a newer migration exists. It does not alter the worker flag,
   publish an operation, start a worker or call Bright Data.
3. `SHARED_SCRAPER_PIPELINE_ENABLED` defaults to `false`. An explicit worker
   opt-in requires the new readers. `RUN_EXECUTOR_DRIVER` was not changed.
   Controlled execution still uses the existing synthetic executor; this flag
   does not itself authorize a Bright Data call. The versioned dispatcher also
   registers all three immutable Amazon identities (`1.0.0-pattern6`,
   `1.1.0-pattern8-output-contracts` and `1.1.0-pattern8-release`) with their
   exact migration-backed digests. This compatibility list is unit-checked
   against migrations `0032`, `0040` and `0041`, so enabling the shared path
   does not strand existing Amazon v4 Services.
4. Complete an operation's missing provider contract, error/continuation
   evidence, commercial approval and independent bounded qualification.
   Any live billable test needs the owner's explicit authorization.
5. Stage the reviewed immutable draft with `operator:scraper-onboard`, then
   create an encrypted mapping and independently qualified release version
   using a reviewed forward-only release procedure. Bind public input/output
   schemas, private processing rules and operation identity with the reported hash.
   Include a numeric provider-enforced `limitPerInput` and an approved
   `scraper_spending` policy whose evidence hash matches exactly. Admission and
   worker execution both recheck this evidence. **A generic protected retailer
   qualification/activation command is not implemented by this foundation.**
   That is the remaining administration seam; do not bypass immutable triggers
   or enable an unqualified mapping using ad hoc SQL.
6. Verify worker protocol readiness before enabling admission/publication.
   Only then advance the approved public Template pointer. Existing Services
   keep their historical version. Do not modify Amazon v4 or its pinned adapter.
7. Run storage-backed and end-to-end worker regression in staging with the
   approved new pin before customer release. Keep Marketplace execution absent
   until its separate payment/entitlement gates are complete.

**Turning off the flag alone is not a rollback for already admitted new-engine
Runs.** First stop new admissions for those new Templates, drain/reconcile their
pending Runs with a compatible worker, and retain a compatible dispatcher until
all new pins are terminal. Never rewrite historical Run pins to another engine.

## Resource behavior and measurements

- The LRU cache is bounded (default 128 contracts per process). Two validators
  compile per contract while cached, not per request. Evicted contracts can
  compile again; no unbounded global Ajv cache remains behind eviction.
- A guarded plan resolves the operation once per execution phase; there are no
  per-field SQL lookups, new pools or per-retailer HTTP clients. Dispatcher
  identity resolution is an additional small fenced read, not claimed to be
  query-free.
- Raw bytes stream into the existing object store before parsing. New
  normalization uses one exact-size bounded read and one JSON parse for error
  classification plus projection. The all-error comparison test measures
  legacy **two raw reads** versus new **one**, with the same safe terminal code.
- A one-second `Retry-After` in a 50ms-poll fixture takes one wait, not twenty
  DB-checkpoint slices. Wait slices are capped at five seconds to check
  cancellation. Provider delays, deadlines and failure counts remain durable.
- Per-worker concurrency/leases and global result byte caps stay in the
  existing configuration. Output bodies remain in object storage, not a
  PostgreSQL product table. Empty/mixed/all-error behavior stays strict and
  contract-driven; mixed error/success output fails.
- Current 20-input and 1,000-record fixture caps are **Dhumi resource policy**,
  not provider limits or price estimates. `maxRecords` is checked **after** the
  provider responds; it is **not a pre-submission spending cap**. Commercial
  limits and `limitPerInput` require separate approved provider evidence.
  `0069` fails closed until that evidence is bound to the exact protected
  mapping. It does not invent a provider price or turn fixture caps into one.

## What a future same-protocol scraper requires

A future developer does **not** add another executor, router branch, queue,
database pool, public endpoint, Run table or download path. They supply one
reviewed operation package, protected provider-resource mapping, explicit
commercial policy, qualification evidence and release approval. Input/output
fields and URL rules remain operation-specific data. Only a behavior the shared
contract cannot express safely (for example a proven rename/conversion or a
different provider protocol) requires a new versioned processing module.

Therefore Target is not a special reusable implementation. It is one fixture
used to prove the common seam. The same path accepts any future operation that
fits the documented protocol contract; unsupported behavior fails validation
instead of silently creating site-specific fallback code.

These measurements prove avoided work, not a claimed throughput percentage.
CPU/heap/event-loop delay and pool occupancy under representative payloads,
cache misses and concurrent active snapshots still need staging load tests.

## What this does not change

Legacy Amazon source digests and immutable mappings stay intact. Their runtime
compatibility bindings are centralized in `amazonExecutorIdentities.ts`; they
are not copied into each new scraper package. No public API,
frontend, provider credential, operational `.env`, Marketplace offer importer,
sample-ingestion rights policy, payment/entitlement boundary or cloud deployment
was rewritten. Dynamic Marketplace onboarding remains a separate follow-up.
