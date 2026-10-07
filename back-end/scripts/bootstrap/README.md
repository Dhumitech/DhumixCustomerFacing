# Dhumi local PostgreSQL bootstrap

## Local refactor boundary — 7 October 2026

The owner-selected `dhumi_test` table refactor reaches migration `0075_naming`:
25 application tables and 279 stored columns. Read
[the public checkout status](../../../docs/runbooks/refactor-status.md)
for application status and verification. Runtime code lives in the existing root
backend/frontend; context folders contain records only.

Existing test LOGIN/capability roles and passwords remain required under the
owner's tables-first instruction. Do not run bootstrap `0001`–`0009` against
the applied test database, revoke its runtime grants, or retire cluster roles.
The owner requested at most three password-bearing identities after the table
refactor; that separate implementation has not happened. The Target's
`dhumi_app`/`dhumi_worker` grant consolidation and full clean-clone replay remain
pending with it. An empty restored 0074 schema was upgraded with exact 0075,
but this is not a replay of all historical migrations.

The manual steps below describe the original bootstrap. They do not authorize
creating/upgrading `dhumi_dev`, `dhumi_shared` or deployment environments.

These files prepare the PostgreSQL 18 local-development foundation without
mixing cluster administration with application table migrations.

No script in this folder is executed automatically. Creating the roles,
database and schema remains a deliberate manual administrator action.

## Approved values

| Setting | Value | Kind |
|---|---|---|
| Development database | `dhumi_dev` | Local environment value |
| Ownership role | `dhumi_owner` | Architecture constant |
| Application schema | `app` | Architecture constant |
| Encoding | `UTF8` | Database contract |
| Locale provider | `builtin` | Database contract |
| Built-in locale | `PG_UNICODE_FAST` | Database contract |
| Database timezone | `UTC` | Database contract |

Role and schema names are intentionally fixed because migrations, grants and
RLS use them as a security contract. Host, port, administrator and target
database are supplied at execution time. No password belongs in these files or
in a command-line connection URI.

## Manual order

1. Complete the PostgreSQL hardening/restart and reconnect with SCRAM.
2. Run the read-only listener check.
3. Run `0000_cluster_preflight.sql` and review every HBA row.
4. Run `0001_cluster_roles.sql`.
5. Run `0002_create_database.sql`.
6. Connect to the new database and run `0003_prepare_app_schema.sql`.
7. Stop. Do not run `scripts/migrate.ps1` or create tables yet.

Example PowerShell commands from the repository root:

```powershell
$bootstrap = Join-Path $PWD 'back-end\scripts\bootstrap'
$listenerCheck = Join-Path $bootstrap '0000_verify_local_listener.ps1'
$preflightSql = Join-Path $bootstrap '0000_cluster_preflight.sql'
$rolesSql = Join-Path $bootstrap '0001_cluster_roles.sql'
$databaseSql = Join-Path $bootstrap '0002_create_database.sql'
$schemaSql = Join-Path $bootstrap '0003_prepare_app_schema.sql'

& $listenerCheck -Port 5432

psql -X -W --host=localhost --port=5432 --username=postgres --dbname=postgres `
  --set=target_database=dhumi_dev --set=owner_role=dhumi_owner `
  "--file=$preflightSql"

psql -X -W --host=localhost --port=5432 --username=postgres --dbname=postgres `
  "--file=$rolesSql"

psql -X -W --host=localhost --port=5432 --username=postgres --dbname=postgres `
  --set=target_database=dhumi_dev --set=owner_role=dhumi_owner `
  "--file=$databaseSql"

psql -X -W --host=localhost --port=5432 --username=postgres --dbname=dhumi_dev `
  --set=target_database=dhumi_dev --set=owner_role=dhumi_owner --set=app_schema=app `
  "--file=$schemaSql"
```

`-W` asks for the password interactively. Never paste the password into the
command, a Markdown file, an environment file or source control.

## Failure rule

Stop on the first failure. Do not alter an unexpected role, reuse an existing
database, weaken an HBA rule or bypass the checks. If database creation succeeds
but a later hardening statement fails, the script intentionally leaves the new
database with connections disabled. Inspect and resolve that state manually.

## Ownership boundary

- `scripts/bootstrap` owns cluster roles, the development database and the
  empty `app` schema security baseline.
- `scripts/migrations` owns application tables, functions, constraints, RLS,
  grants and forward-only changes.
- Runtime services use only their approved capability role. They never use
  `postgres` or `dhumi_owner` as a normal application identity.

## Restricted runtime LOGIN roles

After the application migrations are approved and applied, prepare distinct
LOGIN roles for the Identity and customer API connection pools. This is a
manual cluster-administration action, not an application migration.

Run `0004_runtime_login_roles.sql` separately for each environment. The script
rejects existing roles rather than altering them, prompts for both new
passwords using PostgreSQL's secure `\password` command, grants each LOGIN role
exactly one capability role with `INHERIT FALSE`, and grants direct database
`CONNECT` only. Each new password is requested twice so PostgreSQL can confirm
that it was entered correctly. Do not use `\prompt -s`; PostgreSQL 18 does not
support a silent `\prompt` option.

After these LOGIN roles exist, `0000_cluster_preflight.sql` and
`0001_cluster_roles.sql` accept only this exact restricted membership shape.
They still stop on an unsafe role, an additional membership, an inheriting
grant, an administrative grant, a missing password, or an unexpected LOGIN-role
name. The scripts never repair or weaken an unexpected role automatically.

Example for the local test database:

```powershell
psql -X -W --host=localhost --port=5432 --username=postgres --dbname=dhumi_test `
  --set=target_database=dhumi_test `
  --set=identity_login_role=dhumi_test_identity_login `
  --set=customer_api_login_role=dhumi_test_customer_api_login `
  "--file=$bootstrap\0004_runtime_login_roles.sql"
```

Use different LOGIN role names and different generated passwords for
`dhumi_dev`. Never place either password in this README, a command-line URI,
Git, logs, or the committed `.env.example` file.
