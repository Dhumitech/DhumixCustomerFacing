# ADR 0003 - Separate browser session authentication from Tenant authorization

- **Status:** Accepted
- **Date:** 23 August 2026
- **Applies to:** Browser Bearer operations beginning with `POST /v1/auth/logout`

## Context

A Dhumi browser access token carries signed `sub`, `sid`, and `tid` claims.
Those claims are not sufficient current authorization: PostgreSQL remains
authoritative for session, User, Tenant access, and Tenant state.

Applying the complete resource-authorization chain before logout creates an
unsafe result. If a User, Tenant access row, or Tenant becomes unavailable, the
logout request would be rejected before it could revoke the still-active
session family. Credential destruction must not depend on permission to read or
mutate a protected business resource.

## Decision

Browser authentication has two explicit trust levels.

### Trusted session identity

Shared browser session authentication:

1. parses one `Authorization: Bearer` credential;
2. verifies JWT algorithm, signature, issuer, audience, expiry, and purpose;
3. validates that the signed identifiers are database-safe UUIDs; and
4. confirms that `auth_sessions.id = sid`, `auth_sessions.user_id = sub`, the
   session is active, and PostgreSQL time is before its absolute expiry.

It produces `TrustedSessionIdentity` containing `userId`, `sessionId`, and
`issuedTenantId`. The final field is deliberately named `issuedTenantId`: it is
a signed issuance claim and not proof of current Tenant authorization.

Logout uses this trust level, verifies session-bound CSRF, and revokes only the
verified current session family. User, Tenant-access, and Tenant state may
affect resource authorization but do not block credential destruction.

### Trusted Tenant identity

Resource APIs must extend trusted session identity by rechecking the current
User state, active `tenant_user_access` matching the issued Tenant, and active
Tenant state. Only that second boundary may produce a Tenant identity suitable
for Customer API RLS transactions or protected resource access.

The workspace operation will implement this second boundary. A caller-provided
Tenant identifier never establishes either trust level.

## Consequences

- A suspended User or Tenant can still destroy an existing session family.
- A session that is missing, revoked, expired, or bound to another User still
  fails with the same generic `401`.
- Logout does not grant access to any Tenant resource.
- Middleware and request types must distinguish session identity from active
  Tenant authorization rather than using one ambiguous "trusted identity".
- The access-token `tid` may be used for logout audit attribution only after a
  non-blocking server-side relationship lookup; failure to resolve it does not
  prevent revocation.
- Future Browser Bearer resource routes must not mistake
  `TrustedSessionIdentity.issuedTenantId` for authorized Tenant context.
