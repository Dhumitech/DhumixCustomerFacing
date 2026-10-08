# Azure Blob Storage for Dhumi Run results

The owner requested Blob Storage first, with a defined information layout, on
8 October 2026. The authorized target is subscription
`373d10ba-f7db-4db1-938b-14a73655bb0a`, existing resource group
`rg-dhumcustomerfacing-centralindia`, region `centralindia`.

The account and private container are **created in Azure**. The reproducible
definition is [blob-storage.bicep](blob-storage.bicep). Backend configuration now
supports `azure_blob`, authenticated by a dedicated Microsoft Entra service
principal, with immutable writes and user-delegation download signing.
The cloud profile connects directly to Azure; it does not deploy Azurite.
The later owner-authorized [connected backend](Connected-Backend.md) now uses
this Azure account; the Docker/Azurite source is retained separately.

## Account and container

| Setting | Value |
| --- | --- |
| Account | `stdhumici01` |
| Kind / redundancy / tier | StorageV2 / Standard_LRS / Hot |
| Results container | `dhumi-results`, private |
| HTTPS / minimum TLS | Required / TLS 1.2 |
| Anonymous access / Shared Key authorization | Disabled / disabled |
| Authentication | Microsoft Entra ID; dedicated portable service principal `app-dhumi-blob-ci-01` |
| Recovery | Blob versioning; seven-day blob and container soft delete |
| Network | Public HTTPS endpoint with authentication required; no private endpoint configured yet |
| Tags | `project=dhumi`, `environment=demo`, `purpose=run-results` |

No app queue, database, other cloud resource or application identity is created
by this template. It creates the storage account, its Blob service configuration
and one empty results container. It does not request or export account keys.

## Portable backend connection

The owner requested credentials that another developer can use on a deployment
host. The dedicated service principal uses tenant ID, client ID and client
secret rather than assuming the host already has an Azure managed identity.
The original fragment `back-end/.env.azure-blob` is retained provisioning history.
The owner's later [single deployment environment](Backend-Environment.md),
`back-end/.env.azure`, now holds the active connection, restricted to the owner's
Windows account and ignored by Git. Share values privately with authorized
backend developers. The tracked [example](blob-storage.env.example) has public
identifiers and a blank secret, never a usable credential.

| Permission | Scope | Purpose |
| --- | --- | --- |
| Storage Blob Data Contributor | Only `stdhumici01` / `dhumi-results` | Read and write the result objects |
| Storage Blob Delegator | Only account `stdhumici01` | Obtain a user-delegation key for download signing |

This identity has no PostgreSQL access or subscription Contributor permission.
The credential expires **8 October 2027 at 15:33:14 UTC**. Rotation is a later
explicit operation; preserve access until the replacement has been checked.

Merge this fragment into the **API and Job Manager's private backend environment**.
The outbox worker needs queue access, not this Blob credential. Other required
database, browser authentication, queue, Redis and provider settings remain
separate. Never put `AZURE_CLIENT_SECRET` in a frontend/Vite environment.
For cloud Blob use `RESULT_STORAGE_DRIVER=azure_blob`; keep
`RESULT_STORAGE_CONNECTION_STRING` and `RESULT_DOWNLOAD_PROXY_URL` empty.
The adapter builds `https://stdhumici01.blob.core.windows.net` itself, checks
the existing container is private, and never creates or changes cloud resources
at application startup. It has no Azurite or Shared Key fallback.

From `back-end`, verify just the cloud storage connection:

```powershell
npm run storage:check
```

This reads `.env.azure` and projects only storage settings. Without that file it
can use injected storage environment values; it never reads the original `.env`.
It checks client authentication, private-container access, blob read/list rights
and user-delegation signing rights. It prints no secrets or signed URLs, writes
no blobs, connects to no database and submits no provider/email work. To check
a different private profile explicitly:

```powershell
node --import tsx scripts/azure/check-blob-storage.mjs --env=/secure/azure-blob.env
```

The live connection check passed on 8 October 2026. The later transfer copied
all 36 SQL-referenced raw/normalized objects with unchanged keys, headers and
SHA-256; all real Azure signed downloads verify. Backend/API reads pass against
the restored Azure app. No additional provider Run was submitted for qualification.
Provisioning this storage phase does not deploy the full application.

## Exact object layout

Keep the existing [object identity contract](../../back-end/src/services/storage/resultObjectIdentity.ts)
and [Run artifact recorder](../../back-end/src/services/storage/resultArtifactFinalizerRepository.ts).
`tenantId` in the code is the organization's UUID, not a Microsoft Entra tenant.

```text
stdhumici01
└── dhumi-results
    └── tenants/{organizationId}/runs/{runId}/attempts/{attemptId}/
        ├── raw/v{artifactVersion}/result
        └── normalized/v{artifactVersion}/result
```

These are Blob name prefixes, not separately created physical folders. They
appear when the application writes its first result. UUIDs are lowercase.
The literal final name is `result`, without a filename extension; content type
and encoding identify the bytes. Changing it to `result.json`, adding a demo
prefix or using account emails would break existing object-key validation.
Logical artifact version and output schema version are separate: an artifact
at `normalized/v1/result` can use Amazon output schema v2. Stored recovery can
write a new artifact version rather than overwrite existing results.

## Information saved

| Location | Information |
| --- | --- |
| `raw/.../result` | Provider response bytes received by the existing executor, kept before normalization. Preserve original content type and encoding. Raw data may include product details beyond the published output projection. |
| `normalized/.../result` | Validated output consumed by Dhumi and downloaded by the authorized user. Current Amazon Collect by URL is a JSON array under `amazon.products.collect-by-url.output.v2`. |
| Blob metadata | Existing `dhumi_sha256` and `dhumi_byte_count` integrity receipt. Blob properties also retain content type, content encoding, length, ETag and last-modified time. |
| PostgreSQL `app.artifacts` | Organization, Run, Attempt, kind, logical artifact version, object key, content type/encoding, byte count, checksum, schema version, record count, artifact state and optional expiry. |
| Other PostgreSQL records | Accounts and memberships, saved scrapers, Run progress/events, protected provider references, audit, outbox and usage. |

The existing [Amazon output projection](../../back-end/src/services/brightdata/amazon/amazonOutputContracts.ts)
contains `asin`, `title`, `url`, `domain`, `currency`, `final_price`,
`initial_price`, `rating`, `reviews_count`, `availability`, `brand`,
`image_url` and `timestamp`. Provider-specific fields outside this projection,
including additional variant details, remain in the raw result. The
[v2 normalizer](../../back-end/src/services/brightdata/amazon/amazonProductsResultV2.ts)
validates the projection and represents missing prices/availability as null.
Do not invent fields, store login credentials or duplicate the database as
per-Run JSON manifests. Provider result content stays private.

## Writing and reading rules

1. Persist raw bytes first. Finish the blob write, verify its integrity receipt,
   then register the durable raw artifact in PostgreSQL.
2. Read and validate the persisted raw result, normalize it, and save/register
   the normalized artifact. A failed normalizer retains the raw evidence;
   it does not fabricate a successful normalized result.
3. Preserve application-level create-only writes (`If-None-Match: *`). An
   identical retry is idempotent; different bytes for the same identity are
   rejected. This is not a locked Azure WORM retention policy.
4. Authorize the organization and Run through the API before downloading.
   The Azure adapter checks Blob metadata against `app.artifacts` and issues
   a short-lived, HTTPS-only, read-only SAS for that one blob using a user
   delegation key. Never grant a browser container list/write access.
5. The portable API/Job Manager profile uses the dedicated Blob identity above.
   Keep the outbox worker without Blob credentials. Azure identities are
   separate from the existing PostgreSQL logins.

Seven-day soft delete is a recovery window after deletion, not a seven-day
Run lifetime. No lifecycle auto-delete or archive policy is applied. Existing
real executor artifacts have `expiresAt=null`; choose an explicit application
retention policy before enabling cleanup. Soft delete/versioning also do not
replace coordinated database backups with result and reference-key retention.

## Later database and result transfer

A SQL dump includes the artifact index, not the Blob bytes. When restoring the
final database, transfer each referenced local raw/normalized object separately,
using the unchanged object key, content headers, byte count and SHA-256. Verify
each copy against its artifact record before declaring historical downloads
available. This transfer was completed by the owner's later cutover authorization:
36 referenced objects totaling 14,495,830 bytes are verified in Azure. The nine
unreferenced Azurite objects were not copied. Azure app result records now point
to the same verified object keys.

## Deploy only these resources

From the repository root, inspect the plan before executing:

```powershell
az deployment group validate --subscription 373d10ba-f7db-4db1-938b-14a73655bb0a --resource-group rg-dhumcustomerfacing-centralindia --template-file deploy/azure/blob-storage.bicep
az deployment group what-if --subscription 373d10ba-f7db-4db1-938b-14a73655bb0a --resource-group rg-dhumcustomerfacing-centralindia --template-file deploy/azure/blob-storage.bicep
az deployment group create --subscription 373d10ba-f7db-4db1-938b-14a73655bb0a --resource-group rg-dhumcustomerfacing-centralindia --name dhumi-blob-storage-20261008 --mode Incremental --template-file deploy/azure/blob-storage.bicep
```

The recorded deployment and authenticated connection checks establish this
storage phase. The later app/result transfer and connected backend are recorded
in [the handoff](Connected-Backend.md). A full managed-service staging Run
is a separate deployment check, not implied by account creation.

References: [storage account settings](https://learn.microsoft.com/en-us/azure/templates/microsoft.storage/2025-06-01/storageaccounts),
[Blob service settings](https://learn.microsoft.com/en-us/azure/templates/microsoft.storage/2025-06-01/storageaccounts/blobservices),
[container soft delete](https://learn.microsoft.com/en-us/azure/storage/blobs/soft-delete-container-overview),
[Blob authorization](https://learn.microsoft.com/en-us/azure/storage/blobs/authorize-access-azure-active-directory),
[user-delegation SAS in JavaScript](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blob-create-user-delegation-sas-javascript).
