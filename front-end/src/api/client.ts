import { runtimeConfig } from "../config/runtime";
import { requestOrganization } from "./organizationScope";
import { tokenStore } from "../session/tokenStore";
import { createClient, createConfig } from "./generated/client";

/**
 * The one shared Dhumi HTTP client. Features import SDK operations and pass
 * this instance; they never create independent fetch clients.
 */
export const dhumiClient = createClient(
  createConfig({
    baseUrl: runtimeConfig.apiOrigin,
    credentials: "include",
    auth: (security) => {
      // With one bearer scheme the generator omits its optional key identifier.
      if (
        security.type !== "http" ||
        security.scheme !== "bearer" ||
        (security.key !== undefined && security.key !== "BrowserBearer")
      ) {
        return undefined;
      }

      return tokenStore.getSnapshot()?.access_token;
    },
  }),
);

dhumiClient.interceptors.request.use((request) => {
  const session = tokenStore.getSnapshot();
  const method = request.method.toUpperCase();
  const isMutation =
    method !== "GET" && method !== "HEAD" && method !== "OPTIONS";

  const path = new URL(request.url).pathname;
  const needsOrganization = path === "/v1/services" || /^\/v1\/services\/[^/]+\/runs$/.test(path) ||
    /^\/v1\/runs\/[^/]+\/(cancel|retry)$/.test(path) || /\/(sample\/downloads|expert-enquiries)$/.test(path);
  if (isMutation && needsOrganization && window.location.pathname.startsWith("/workspace") && !request.headers.has("X-Dhumi-Organization"))
    requestOrganization();

  if (
    session === null ||
    !isMutation ||
    !request.headers.has("Authorization") ||
    request.headers.has("X-CSRF-Token")
  ) {
    return request;
  }

  const headers = new Headers(request.headers);
  headers.set("X-CSRF-Token", session.csrf_token);
  return new Request(request, { headers });
});
