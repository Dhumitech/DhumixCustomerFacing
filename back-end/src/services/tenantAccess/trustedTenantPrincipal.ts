import type { TrustedTenantIdentity } from "./tenantAuthorizationService.js";

/** Customer operations accept only a resolved browser-session user. */
export type TrustedTenantPrincipal = { readonly kind: "browser" } & TrustedTenantIdentity;
