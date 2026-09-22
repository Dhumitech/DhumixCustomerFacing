# ADR 0002 - Argon2id password hashing parameters

- **Status:** Accepted
- **Date:** 18 August 2026
- **Applies to:** `POST /v1/auth/signup`, `POST /v1/auth/sign-in`

## Context

`Project Specs\05_Security\01_Authentication_and_Keys.md` requires:

> Passwords use an approved memory-hard password hash with versioned parameters.

No parameter values are specified anywhere in the specification, so they must be
chosen and recorded rather than left to a service module.

## Decision

### Algorithm and parameters

Argon2id through `@node-rs/argon2` 2.0.2, with:

```text
memory  19456 KiB (19 MiB)
time    2 iterations
lanes   1
```

These are the OWASP Password Storage minimum for Argon2id. Measured on the local
development machine at a median of **22.5 ms** per hash across seven runs
(range 20.0-24.7 ms).

`@node-rs/argon2` was chosen over the `argon2` package because it ships a
prebuilt Windows binary and does not require node-gyp on Node 24.

### Parameters are a configured floor, not a default

`PASSWORD_ARGON2_MEMORY_KIB`, `PASSWORD_ARGON2_TIME_COST` and
`PASSWORD_ARGON2_PARALLELISM` are validated at startup. Memory and time cost are
enforced as **minimums**: configuration may raise the cost, never lower it. A
value below the baseline fails startup.

A weak hash configuration cannot be corrected retroactively, because every
password stored under it stays weak until each customer signs in again.

### Versioning is carried by the encoded hash, not a separate tag

Argon2 encodes its own parameters in the PHC string it produces:

```text
$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>
```

The stored hash therefore already records the parameters it was created with.
No separate version column or configuration tag is introduced.

`PasswordHasher.needsRehash(encoded)` parses those embedded parameters and
compares them with current configuration. When the cost is later raised, the
stored hash still verifies against its own recorded parameters, and the record
is upgraded on the next successful verification.

This satisfies "versioned parameters" without adding a value that could drift
out of step with the hashes it claims to describe.

### The password is excluded from the signup request hash

`app.create_signup` stores a canonical `request_hash` so a replayed
`Idempotency-Key` can be compared against the original request. The password is
deliberately **not** part of that canonical form.

Two rejected alternatives:

1. **Hash the Argon2 output.** Argon2 salts randomly, so the same request
   produces a different encoded hash every time. Idempotent replay would break.
2. **Hash the plaintext password.** This stores a brute-forceable digest of a
   customer password in `idempotency_records`, a table with a 24-hour retention
   window. Unacceptable.

Consequence: a replay carrying the same `Idempotency-Key` and the same body but
a different password is treated as a replay, not a conflict. It creates nothing
and returns the original generic `202`, so no state depends on the difference.

### Hashing is unconditional

The password is hashed on every signup request, including one whose email is
already registered.

Inside `app.create_signup` the existing-identity branch exits early and performs
less work. If hashing were conditional, a registered email would answer in a few
milliseconds while a new one took roughly 25 ms. That timing difference is an
account-enumeration oracle that defeats the generic `202` response.

## Consequences

- Signup and sign-in each cost about 22.5 ms of CPU on a libuv threadpool
  thread, capping throughput at roughly 178 hashes per second at the default
  four threads. Signup rate limiting is therefore a capacity control, not
  optional hardening.
- `UV_THREADPOOL_SIZE` becomes a deployment capacity parameter.
- Raising the cost later requires no migration and no data change.

## References

- `Project Specs\05_Security\01_Authentication_and_Keys.md`
- `Project Specs\02_Architecture\04_Failure_Retry_and_Idempotency.md`
- `Checkpoints\Apis\03_Signup_API_Design.md`
- OWASP Password Storage Cheat Sheet, Argon2id guidance
