import { runtimeConfig } from "../config/runtime";
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
      if (security.key !== "BrowserBearer") {
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
