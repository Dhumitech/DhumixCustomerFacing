import { createHash } from "node:crypto";
import { canonicalJson } from "./canonicalJson.js";

/**
 * Deterministic inputs for the user-only signup transaction.
 *
 * Every function here is pure. The password never reaches any value produced by
 * this module; see `docs/decisions/0002-argon2id-password-hashing.md`.
 */

export interface CanonicalLegalAcceptance {
  readonly documentType: string;
  readonly documentVersion: string;
  readonly contentHash: string;
}

export interface CanonicalSignupRequest {
  readonly emailNormalized: string;
  /** Deprecated and ignored for new signup requests; used only for v1 replay. */
  readonly workspaceName?: string;
  readonly legalAcceptances: readonly CanonicalLegalAcceptance[];
}

/**
 * `app.users` enforces `email_normalized = lower(email_normalized)`.
 *
 * Trim and lower-case only. Dots and plus-tags are deliberately preserved:
 * stripping them is provider-specific behaviour that would silently merge
 * addresses their owners consider distinct.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Canonical form stored as `idempotency_records.request_hash`.
 *
 * The password is excluded. Including the Argon2 output would break replay
 * because Argon2 salts randomly, and including the plaintext would store a
 * brute-forceable password digest in the database.
 *
 * Legal acceptances are sorted so that submitting the same set in a different
 * order is recognised as the same request.
 */
export function canonicalRequestHash(request: CanonicalSignupRequest): Buffer {
  return signupHash(request, false);
}

/** Reproduce the historical bytes only; never create a new v1 claim. */
export function legacySignupRequestHash(
  request: CanonicalSignupRequest & { readonly workspaceName: string },
): Buffer {
  return signupHash(request, true);
}

function signupHash(request: CanonicalSignupRequest, legacy: boolean): Buffer {
  const acceptances = [...request.legalAcceptances]
    .map((acceptance) => ({
      content_hash: acceptance.contentHash.toLowerCase(),
      document_type: acceptance.documentType,
      document_version: acceptance.documentVersion,
    }))
    .sort((left, right) => {
      const leftKey = `${left.document_type}\u0000${left.document_version}`;
      const rightKey = `${right.document_type}\u0000${right.document_version}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });

  return sha256(
    canonicalJson({
      email_normalized: request.emailNormalized,
      legal_acceptances: acceptances,
      operation: "auth.signup",
      version: legacy ? 1 : 2,
      ...(legacy ? { workspace_name: request.workspaceName } : {}),
    }),
  );
}

/**
 * Scopes the signup idempotency claim.
 *
 * The unique index is
 * `(actor_fingerprint, operation_code, idempotency_key) WHERE organization_id IS NULL`,
 * and signup is unauthenticated, so the "actor" is the identity being claimed.
 * A digest is used rather than the address itself; this is not a privacy gain
 * over `users.email_normalized`, which is stored in clear, but it keeps the
 * address out of an index that is not the identity table.
 */
export function actorFingerprint(emailNormalized: string): Buffer {
  return sha256(`auth.signup\u0000${emailNormalized}`);
}
