# Demo organization and account correction — 8 October 2026

The owner supersedes the earlier demo invitation scope: this release creates
organizations only. Invitations, joining and organization activity belong to
the next release with email proof. Existing memberships and Run history remain.

## Acceptance criteria

- After sign-in, an account without active memberships sees the existing Dhumi
  theme in an accessible organization dialog. It explains that an organization
  is mandatory to save scrapers and run services, and offers creation only.
- The owner's sidebar correction places the organization selector immediately
  below Workspace active. Existing users open it on demand. Dialogs render at
  the document viewport so header blur/sidebar clipping cannot hide controls;
  choosing the already active organization closes without clearing Run/Service
  selection. Creation stays mandatory for accounts without active memberships.
  A single active membership shows Your organization, a static active card and
  Back to workspace. Only multiple memberships offer Switch organization.
  Existing users are not asked to select their already active organization.
- Returning users enter an active organization before workspace resource reads.
  A read-only cookie-authenticated session endpoint restores memory after a
  reload. It checks the trusted frontend Origin or same-origin Fetch Metadata,
  active token/session/user and expiry, returns no refresh secret, performs no
  token rotation, and sends no-store headers. Existing refresh/logout CSRF gates
  remain mandatory; credentials stay out of browser storage.
  Remember only a per-user organization UUID as a navigation preference, never
  credentials. Validate it against the server membership list on every entry;
  invalid/removed preferences and unauthorized links cannot grant access.
- Users may retain multiple memberships, but may create one organization only.
  Enforce this in the repository while holding the existing User lock, both at
  issuance and proof completion. Completed idempotent replays remain valid.
- Requests use the organization captured by their query, rather than whichever
  URL happens to be current when asynchronous work starts. Organization changes
  remount workspace resources and cannot reuse another organization's cache.
- Invitation/join controls and activity are replaced with consistent next-update
  messaging. Backend collaboration is disabled by default, retaining the reviewed
  implementation for the later release rather than deleting its schema/history.
- Sign-up and sign-in preserve server validation, Argon2,
  rate limits, CSRF, cookie/session revocation and legal evidence. Add client
  confirmation/validation and safe errors; never weaken proof or tenant guards.
  The owner's subsequent [duplicate-signup correction](duplicate-signup-design.md)
  explicitly replaces generic duplicate signup acceptance with `409
  ACCOUNT_ALREADY_EXISTS`; sign-in/reset responses remain generic.
- The owner's sign-in correction keeps one email/password form with a concise
  heading and subtitle. Forgot password opens a small themed popup containing
  only Contact followed by the password-support mailto,
  `dhumitechnologies@gmail.com`, and a close
  control. It preserves entered fields and sends no reset/code request. Reset
  code entry and sending controls are not exposed in this demo sign-in flow.

## Implementation and verification

Use the existing generated SDK, shared HTTP client, React Query, session provider,
organization service/repository and PostgreSQL transactions. Update OpenAPI with
creator metadata before regenerating the client. No applied SQL, database roles,
credentials, old data, paid submissions or cloud resources are changed.

Reproduce missing onboarding/default selection and organization-limit failures
before fixes. Run focused regressions, both package checks, actual Docker database
concurrency/authentication checks, and browser smoke checks without starting a
paid scrape. Review deployment composition separately and qualify one deployable
demo bundle; record any host/domain/service inputs still required. A local pass
does not constitute a deployed cloud release.

Security review: server membership/creator checks are authoritative; storage is
a navigation hint only. Collaboration gates apply to direct API calls. Bound
queries, strict schemas and safe public errors remain. No stored passwords,
access tokens, OTPs or invitation material enter browser storage or records.
