import type { ApiScope } from "../../helpers/apiKeyMaterial.js";
import type { TrustedApiKeyIdentity } from "../apiKeys/apiKeyAuthenticationService.js";
import type { TrustedTenantIdentity } from "./tenantAuthorizationService.js";

export type TrustedTenantPrincipal =
  | ({ readonly kind: "browser" } & TrustedTenantIdentity)
  | TrustedApiKeyIdentity;

export function principalHasScope(
  principal: TrustedTenantPrincipal,
  requiredScope: ApiScope,
): boolean {
  return principal.kind === "browser" || principal.scopes.includes(requiredScope);
}
