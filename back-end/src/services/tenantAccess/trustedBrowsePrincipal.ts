import type { TrustedSessionIdentity } from "../identity/browserAuthenticationService.js";

/** Browser identity plus an optional, separately authorized organization selection. */
export type TrustedBrowsePrincipal = {
  readonly kind: "browser";
  readonly tenantId?: string;
} & TrustedSessionIdentity;
