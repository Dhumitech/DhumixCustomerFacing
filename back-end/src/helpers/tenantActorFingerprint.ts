import { createHash } from "node:crypto";
import type { TrustedTenantPrincipal } from "../services/tenantAccess/trustedTenantPrincipal.js";

export type TenantActorFingerprintNamespace = "tenant" | "legacy-service";

/**
 * Produces a stable, non-secret identity for Tenant-scoped idempotency.
 * `legacy-service` preserves already-issued Service replay identities while
 * new Tenant mutations use the shared v1 namespace.
 */
export function tenantActorFingerprint(
  principal: TrustedTenantPrincipal,
  namespace: TenantActorFingerprintNamespace = "tenant",
): Buffer {
  const prefix =
    namespace === "legacy-service"
      ? "dhumi:service-actor:v1"
      : "dhumi:tenant-actor:v1";
  const identity = `${prefix}:browser:${principal.userId}`;
  return createHash("sha256").update(identity, "utf8").digest();
}
