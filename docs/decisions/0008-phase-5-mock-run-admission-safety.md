# ADR 0008 - Phase-5 mock Run admission safety profile

- **Status:** Accepted
- **Date:** 25 August 2026
- **Applies to:** `POST /v1/services/{service_id}/runs` in `local` and `test`
- **Numbering note:** This repository decision is unrelated to
  `Project Specs/docs/adr/0008-*`; the two decision directories have independent
  numbering.

## Context

Run admission must create a global provider-cost hold and reject unsafe queue or
submission pressure before commit. Real Bright Data commercial, account and
capacity evidence remains unresolved under DP-00 through DP-06, so production
values cannot be inferred from public provider documentation.

The Phase-5 software foundation still needs deterministic local/test behavior
that can exercise concurrency, rollback and queue-health invariants without a
Bright Data credential or provider request. The outbox dispatcher and Job
Manager do not yet exist, so the profile must also prevent an unattended local
outbox from growing without bound.

## Decision

Migration `0018` introduces the versioned profile
`phase5_mock_admission_v1`. It is executable only for runtime environments
`local` and `test`.

The profile values are:

| Control | Local/test value | Failure |
|---|---:|---|
| Per-Tenant accepted Runs in the preceding 60 seconds | 30 maximum | `429 PLATFORM_CAPACITY_LIMIT` |
| Globally unpublished `jobs.execute` commands | 100 maximum before admitting another | `429 PLATFORM_CAPACITY_LIMIT` |
| Age of oldest unpublished due `jobs.execute` command | 300 seconds maximum | `503 SERVICE_UNAVAILABLE` |
| Provider cost-hold amount | 0 micros | Not customer-visible |
| Currency | `USD` | Not customer-visible |
| Unit | `mock_run` | Not customer-visible |
| Hold evidence reference | `phase5_mock_admission_v1` | Internal only |

These are conservative software-test controls, not Bright Data facts, a
customer quota, a plan entitlement, a rate card or a production SLO.

PostgreSQL owns the check. A tightly scoped `SECURITY DEFINER` function:

1. requires a transaction-local trusted Tenant context;
2. rejects every environment except `local` and `test`;
3. acquires a transaction-scoped advisory lock for the profile/environment;
4. checks the calling Tenant's recent accepted Runs through forced RLS;
5. checks global unpublished `jobs.execute` depth and oldest due age without
   returning another Tenant's rows or identifiers; and
6. returns only the fixed hold metadata when all checks pass.

The advisory lock remains held until the caller's admission transaction commits
its Run and outbox row. Therefore concurrent Tenants cannot both observe the
same last free global slot. The function is owned by the non-login migration
owner, uses a fixed safe `search_path`, is revoked from `PUBLIC`, and grants
`EXECUTE` only to `dhumi_admission`. It does not use a `current_user` capability
guard because `current_user` inside a `SECURITY DEFINER` function is the function
owner; the EXECUTE ACL is the capability boundary.

`staging` and `production` always fail closed under this profile. No real
adapter, Bright Data credential, endpoint or request is enabled. A later live
profile requires a new accepted decision backed by DP-00 through DP-06 evidence,
new versioned database/configuration state, load tests and a forward migration.

## Consequences

- Phase-5 admission can be implemented and concurrency-tested without inventing
  provider pricing or account limits.
- Every accepted mock Run has a cost-hold row while making no monetary claim.
- A stopped/missing dispatcher eventually stops new admissions instead of
  allowing unbounded outbox growth.
- The limits can be changed only through a new reviewed profile version, so a
  local environment variable cannot silently weaken cross-Tenant safety.
- This decision does not make asynchronous execution operational and does not
  authorize any Bright Data traffic.
