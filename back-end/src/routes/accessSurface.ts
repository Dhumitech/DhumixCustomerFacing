import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
export type AccessLevel = "public" | "browser_session" | "browser_user" | "organization_member" | "organization_admin" | "purpose_bound_verification" | "refresh_cookie_csrf";
interface AccessRoute { method: string; path: string; access: AccessLevel }
/** Declare access on the actual Fastify routes, before registration.
 * The contract supplies metadata; authentication/transaction guards enforce it. */
export function installAccessSurface(app: FastifyInstance): void {
  const manifest = JSON.parse(readFileSync(new URL("../../contracts/api-surface.json", import.meta.url), "utf8")) as { routes: AccessRoute[] };
  app.addHook("onRoute", route => {
    if (!route.url.startsWith("/v1/")) return;
    const path = route.url.replace(/:([A-Za-z_]+)/g, "{$1}");
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      const match = manifest.routes.find(entry => entry.path === path && entry.method === (method === "HEAD" ? "GET" : method));
      if (!match) throw new Error("Registered API route is absent from the contract surface");
      if (route.config?.access !== undefined && route.config.access !== match.access) throw new Error("Route access differs from its contract");
      route.config = { ...route.config, access: match.access };
    }
  });
}
