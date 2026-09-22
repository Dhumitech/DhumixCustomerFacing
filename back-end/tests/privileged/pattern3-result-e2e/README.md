# Pattern 3 result boundary E2E

This folder proves the complete local Pattern 3 path without a temporary API
or a Bright Data call:

```text
privileged fixture setup
  -> ready Run in dhumi_test
  -> distinct synthetic raw and normalized bytes streamed through ResultIngestionService
  -> two private Azurite blobs
  -> durable raw and validated normalized Artifacts inserted by dhumi_result_recorder
  -> normal Dhumi sign-in in Postman
  -> authenticated GET /v1/runs/{run_id}/result?representation=normalized|raw
  -> representation- and Tenant-scoped Artifact lookup
  -> one representation-labelled download-authorization audit per request
  -> independent read-only short-lived Azurite URLs
  -> exact raw and normalized bytes downloaded
  -> privileged evidence inspection and exact cleanup
```

The PostgreSQL superuser is used only by the fixture setup, evidence inspector,
and cleanup. Ingestion uses the real `dhumi_result_recorder` runtime role. The
result requests use the existing customer API role, authentication middleware,
Tenant RLS, result repository, audit insert, and signer. Omitting the query
parameter remains equivalent to `representation=normalized`.

## Prerequisites

- Docker Desktop is running.
- Migrations through `0028` are applied to `dhumi_test`.
- The test result-recorder LOGIN role is bootstrapped.
- `.env.test` has the test runtime roles and Azurite configuration.
- Never add a Bright Data key to this fixture; Pattern 3 uses synthetic bytes.

## Automated proof

From PowerShell:

```powershell
Set-Location 'D:\BrightDataCustomerFacing\back-end'
& '.\tests\privileged\pattern3-result-e2e\Invoke-Pattern3ResultE2E.ps1' -Action Automated
```

The password prompt is for the local `postgres` superuser and is held only for
the child test process. The test cleans the database rows and Azurite object in
`afterAll`, including on assertion failure.

## Live HTTP proof in one command

Start the backend against `.env.test`, then run:

```powershell
& '.\tests\privileged\pattern3-result-e2e\Invoke-Pattern3ResultE2E.ps1' -Action Http
```

This one action prepares the fixture, performs real sign-in and result HTTP
requests, downloads both signed objects, verifies database/Azurite/audit
evidence, and cleans the exact fixture in a `finally` block. It requires one hidden
PostgreSQL administrator-password prompt.

## Postman proof

1. Prepare a private fixture:

   ```powershell
   & '.\tests\privileged\pattern3-result-e2e\Invoke-Pattern3ResultE2E.ps1' -Action Prepare
   ```

2. Import the generated `*.postman_environment.json` path printed by the
   command. It is created under the Windows temporary directory, not the repo.
   Select that environment in Postman.

3. Start the backend against the test environment in another terminal:

   ```powershell
   node --env-file-if-exists=.env.test --import tsx src/server.ts
   ```

4. Open the `brightdatacall` collection and run the folder
   `Pattern 3 - Result Storage E2E` with the Postman Desktop Agent. The cloud
   runner cannot reach localhost or Azurite.

5. Inspect PostgreSQL, the audit, Azurite metadata, checksum, byte count, and
   exact bytes:

   ```powershell
   & '.\tests\privileged\pattern3-result-e2e\Invoke-Pattern3ResultE2E.ps1' -Action Inspect
   ```

6. Remove the exact fixture rows, blob, local manifest, and local Postman
   environment:

   ```powershell
   & '.\tests\privileged\pattern3-result-e2e\Invoke-Pattern3ResultE2E.ps1' -Action Cleanup
   ```

## Test cases

| Case | Boundary | Expected result | Initial status |
| --- | --- | --- | --- |
| P3-E2E-001 | Owner sign-in | `200`; access token stored only in the selected local Postman environment | Not Run |
| P3-E2E-002 | Result without Dhumi authentication | `401`; no signed URL and no authorization audit | Not Run |
| P3-E2E-003 | Owner normalized authorization | `200`; the validated Artifact checksum and byte count match; signed URL returned | Not Run |
| P3-E2E-004 | Owner raw authorization | `200`; the durable Artifact checksum and byte count match; independent signed URL returned | Not Run |
| P3-E2E-005 | Other-Tenant isolation | `404`; the owner Run and Artifact remain undisclosed | Not Run |
| P3-E2E-006 | Signed Azurite downloads | Both responses are byte-for-byte equal to their distinct synthetic fixtures | Not Run |
| P3-E2E-007 | Private evidence inspection | Raw is `durable`, normalized is `validated`, both checksums and byte counts match, and each has its own representation-labelled audit | Not Run |

The manual fixture intentionally remains after `Prepare` so Postman can use it.
Always finish with `Cleanup`. If Postman is run more than once, the inspector
accepts multiple successful authorization audits while still requiring all
integrity evidence to match exactly.
