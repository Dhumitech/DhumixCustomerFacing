# ADR 0007 - Versioned Dhumi API-key format and verifier

- **Status:** Accepted
- **Date:** 23 August 2026
- **Applies to:** Dhumi customer API credentials

## Context

Migration 0007 deliberately stayed format-neutral. Creation and later API-key
authentication now need one stable, parseable format that carries no Tenant or
User data, supports an indexed non-secret lookup prefix and leaves a database
disclosure with only a verifier of high-entropy material.

## Decision

Version 1 credentials use:

```text
dhk_v1_<lookup>.<secret>
```

- `lookup` is 12 cryptographically random bytes encoded base64url without
  padding (16 characters).
- `secret` is 32 cryptographically random bytes encoded base64url without
  padding (43 characters).
- `key_prefix` stores `dhk_v1_<lookup>` and is safe to display.
- `key_hash` stores SHA-256 over the complete UTF-8 serialized credential.
- generation uses `node:crypto.randomBytes`; equality checks for future
  authentication use constant-time comparison after indexed prefix lookup.
- prefix collision retries are bounded to three newly generated candidates.

The version and separators are syntax, not authorization. Tenant, User, scope,
provider and environment data never appear in the credential.

## Consequences

- The full credential contains at least 256 bits of secret entropy.
- Prefix lookup is cheap while the stored hash remains insufficient to forge a
  credential.
- Later format changes introduce a new explicit version and parser branch.
- Revocation/list operations never return the full credential.
