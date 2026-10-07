# ADR 0015 - Shared development database on a private VM

- **Status:** Accepted
- **Date:** 22 September 2026
- **Applies to:** The shared development database `dhumi_shared` on the team
  VM only. Local `dhumi_dev`, `dhumi_test` and any production database keep the
  localhost-only baseline.

## Context

Local refactor implementation note, 7 October 2026: migration `0075_naming`
targets only the owner's `dhumi_test`. Organization names and transaction-local
`app.organization_id` replace the physical tenant names. Existing test capability
roles/logins and passwords are retained until the owner's separate identities
phase (at most three password-bearing identities). The Target's app/worker grant
consolidation, bootstrap replacement, full clean-clone replay and cluster role
retirement are pending; no `dhumi_shared`/`dhumi_dev` or network change is implied.
Read [the public checkout status](../runbooks/refactor-status.md)
for actual application/verification status. The original shared-development
decision below remains dated architectural context.

The bootstrap in `back-end/scripts/bootstrap` assumes a PostgreSQL cluster that
no other machine can reach. `0000_cluster_preflight.sql` requires PostgreSQL
18, a superuser, `listen_addresses = 'localhost'` and exactly three SCRAM HBA
rules (local socket, `127.0.0.1/32`, `::1/128`). `0002_create_database.sql`
repeats the listener check, and `0000_verify_local_listener.ps1` accepts only
loopback listeners.

Several developers now need to use and edit the same data. The worker
configuration pins Redis, the Service Bus emulator and Azurite to each
machine's loopback, so PostgreSQL is the only part that can be shared without
code changes. This decision makes one deliberate exception to the
localhost-only rule and records who may do what on the shared database.

## Decision

### Hosting and network

- A small Linux VM runs PostgreSQL 18 with one database, `dhumi_shared`. The
  VM has no public inbound ports. Everyone reaches it through the team's
  Tailscale network (or an equivalent private WireGuard network with its own
  address ranges).
- PostgreSQL listens on `localhost` and the VM's Tailscale addresses. Beyond
  the three local rules, `pg_hba.conf` adds only:

  ```text
  hostssl  all  postgres  100.64.0.0/10        reject
  hostssl  all  postgres  fd7a:115c:a1e0::/48  reject
  hostssl  all  all       100.64.0.0/10        scram-sha-256
  hostssl  all  all       fd7a:115c:a1e0::/48  scram-sha-256
  ```

- TLS uses a server certificate issued for the VM's Tailscale DNS name.
  Developers connect with `DATABASE_SSL_MODE=verify-full` and
  `DATABASE_SSL_CA_FILE`, which the API and workers already support.
- A Tailscale ACL limits port 5432 to the developers' devices.
- `postgres` connects only from the VM itself: over an SSH session, or through
  an SSH tunnel, which arrives as a localhost connection.

### Bootstrap order and the expected preflight failure

1. Install PostgreSQL 18 listening on `localhost` only, with the three local
   SCRAM rules.
2. Run bootstrap `0000`-`0003` unchanged. They pass because the cluster is
   still local-only.
3. Seed the data, create the logins, then widen the listener and HBA as
   described above.

After step 3, `0000_cluster_preflight.sql`, `0002_create_database.sql` and
`0000_verify_local_listener.ps1` fail if rerun on this cluster. **That failure
is expected and shows this exception is in effect.** Do not weaken those checks
to make them pass; a network-aware preflight would be a separate reviewed
change. `0001` and the login scripts `0004`-`0009` do not check the listener
and remain usable, run as `postgres` on the VM.

### Seed data

- The database is seeded once from the owner's local `dhumi_dev` using a full
  `pg_dump` of the `app` schema (schema and data together), restored as
  `postgres`. A superuser is required because 26 tables force row-level
  security.
- Do not use a data-only restore into a freshly migrated schema.
  `migrate.ps1` would apply every migration on `main`, including any that the
  local database never ran, and the insert triggers would fire during the
  load.
- The copy carries the owner's accounts, audit history, API-key hashes,
  Marketplace metadata, launch evidence and protected provider references.
  Sample and Run-result bytes stay in the owner's local Azurite. Provider
  references can only be decrypted with the owner's
  `PROVIDER_REFERENCE_LOCAL_KEY`.
- After the copy, the two databases diverge. The owner's `dhumi_dev` stays
  private and is the only place for billable provider work.

### Who may do what

**Owner**

- Administers the VM and the cluster, and is the only person who uses
  `postgres`.
- Creates and removes logins. Passwords are delivered through a password
  manager, never through chat or Git.
- Is the only person who applies migrations, only from `main`, after merge.
  `migrate.ps1` has no lock and applies every pending file, so check
  `app.schema_migrations` first. If `0066`-`0069` are pending (the scraper
  onboarding runbook records them as not activated on operational
  databases), applying them here is a separate decision.
- Is the only person who runs `worker:*` against `dhumi_shared`, and always
  with `RUN_EXECUTOR_DRIVER=controlled`. `BRIGHTDATA_API_KEY` and
  `PROVIDER_REFERENCE_LOCAL_KEY` never leave the owner's machine and are never
  used against this database.
- Is the only person who changes the release-gate tables listed below.
- Keeps nightly `pg_dump` backups off the VM, and proves one restore before
  developers are onboarded.

**Each developer**

- Gets three runtime logins for their local Customer API, created with
  bootstrap `0004` and `0006`: `dhumi_<dev>_identity_login`,
  `dhumi_<dev>_customer_api_login` and `dhumi_<dev>_admission_login`, where
  `<dev>` is a lowercase handle.
- Gets one editor login, `dhumi_<dev>_editor_login`, for SQL editing in psql
  or pgAdmin:
  - `BYPASSRLS`, inheriting read/write on `app` tables from a group role,
    `dhumi_shared_editor`, including default privileges for future tables.
  - Read-only on the release gates and the migration ledger:
    `schema_migrations`, `launch_evidence`, `feature_flags`,
    `provider_mappings`, `provider_credentials`, `adapter_definitions` and
    `adapter_versions`.
  - No `SUPERUSER`, `CREATEDB`, `CREATEROLE` or `REPLICATION`, and no
    `EXECUTE` on `app` functions.
  - Not a member of `dhumi_owner` or of any capability role. Owner membership
    would allow DDL and disabling triggers, and `SET ROLE dhumi_job_manager`
    would bypass the Run-status guard.
  - The editor logins and the group role are created by a new bootstrap
    script, not by this record.
- Database triggers still apply to editors. Audit, legal-acceptance,
  Run-event, usage, version, mapping and Marketplace evidence rows reject
  `UPDATE` and `DELETE`, and only `dhumi_job_manager` can change a Run's
  status.
- May change their own password with `\password`.
- May not change the schema, run migrations, run `worker:*` against this
  database, store provider credentials, or share a login.

**Nobody**

- Opens port 5432 to the internet.
- Connects over the network without TLS.
- Gives a developer `SUPERUSER`.
- Commits connection details or passwords.
- Puts real customer data in `dhumi_shared`.

### Removing a developer

Set their four logins to `NOLOGIN` or drop them, terminate their open sessions,
and remove their device from the Tailscale ACL.

## Consequences

- Editor logins see every Tenant's rows. Tenant isolation is deliberately off
  for them, which is why real customer data is excluded.
- `dhumi_shared` is not evidence for any `DP-*` gate or release, because its
  data is editable by design.
- Runs that any developer creates execute only on the owner's machine, and
  only while the owner's workers are running; otherwise they stay `queued`.
  Result downloads and Marketplace sample files work only through the owner's
  API, because the bytes are in the owner's Azurite. Other developers' APIs
  fail those requests. This is expected in the database-only setup.
- Each local Customer API opens three pools of up to `DATABASE_POOL_MAX`
  connections (default 10), and PostgreSQL's default `max_connections` is 100.
  Developers set `DATABASE_POOL_MAX=3`.
- Every query crosses the network, so the API is slower than against a local
  database. Place the VM near the team.
- Tests are unaffected. `scripts/test-database.ps1` and the database
  integration tests refuse any database other than `dhumi_test`.

## Alternatives considered

- **Local databases only (the current model).** Developers could not share
  or edit the same data.
- **Exposing the owner's PC over Tailscale.** Availability would depend on
  one machine, and the owner's private state would become shared.
- **Azure Database for PostgreSQL Flexible Server.** It provides no
  superuser, so the bootstrap would need a managed-service variant. Revisit
  during production hardening.
- **A shared server running the whole backend.** Runs, results and samples
  would work for everyone. Not chosen for now.
- **`SUPERUSER` logins for developers.** Rejected: a superuser can drop the
  database, disable triggers and run shell commands on the VM through
  `COPY ... PROGRAM`.

## Revisit when

- a second machine needs to run workers,
- real customer data would be involved,
- developers need end-to-end Runs and downloads, or
- production hardening starts.
