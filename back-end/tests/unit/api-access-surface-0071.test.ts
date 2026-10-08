import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Route {
  method: string;
  path: string;
  operationId: string;
  access: string;
}
const manifest = JSON.parse(
  readFileSync(new URL("../../contracts/api-surface.json", import.meta.url), "utf8"),
) as { routes: Route[] };
const openapi = readFileSync(new URL("../../contracts/openapi.yaml", import.meta.url), "utf8");
function runtimeRoutes() {
  const result: Array<{ method: string; path: string; guard: string }> = [];
  const directory = new URL("../../src/routes/", import.meta.url);
  for (const name of readdirSync(directory).filter((name) => name.endsWith("Routes.ts"))) {
    const source = readFileSync(new URL(name, directory), "utf8");
    const registrations = [
      ...source.matchAll(/app\.(get|post|patch|put|delete)(?:<[^;]*?>)?\(["']([^"'\r\n]+)["'],/g),
    ];
    for (const [index, registration] of registrations.entries()) {
      const body = source.slice(registration.index, registrations[index + 1]?.index);
      const guard = /\bpreHandler\s*:\s*([^\r\n]+)/.exec(body)?.[1] ?? "";
      result.push({
        method: registration[1]!.toUpperCase(),
        path: registration[2]!.replace(/:([A-Za-z_]+)/g, "{$1}"),
        guard,
      });
    }
  }
  return result;
}

describe("0071 route access surface", () => {
  it("keeps every accepted operation's declared access level visible", () => {
    const declarations = [
      ...openapi.matchAll(/      operationId: (\w+)\r?\n      x-dhumi-access: (\w+)/g),
    ].map((match) => ({ operationId: match[1], access: match[2] }));
    expect(declarations).toHaveLength(39);
    expect(declarations).toEqual(
      manifest.routes.map(({ operationId, access }) => ({ operationId, access })),
    );
    expect(
      manifest.routes
        .filter((route) => route.access === "browser_user")
        .map((route) => route.operationId),
    ).toEqual(["listTemplates", "getTemplate", "getMarketplaceSample", "queryMarketplaceSample"]);
    expect(
      manifest.routes.find((route) => route.operationId === "authorizeMarketplaceSampleDownload")
        ?.access,
    ).toBe("organization_member");
    expect(
      manifest.routes.find((route) => route.operationId === "createMarketplaceExpertEnquiry")
        ?.access,
    ).toBe("organization_member");
  });
  it("matches the actual registered route guard and catches accidental access-level changes", () => {
    const runtime = runtimeRoutes();
    expect(runtime).toHaveLength(manifest.routes.length);
    for (const route of manifest.routes) {
      const actual = runtime.find(
        (value) => value.method === route.method && value.path === route.path,
      );
      expect(actual, route.method + " " + route.path).toBeDefined();
      if (route.access === "browser_user")
        expect(actual?.guard).toContain("requireBrowsePrincipal");
      if (route.access === "organization_member" || route.access === "organization_admin")
        expect(actual?.guard).toContain("requireTenantPrincipal");
      if (route.access === "browser_session")
        expect(actual?.guard).toContain("requireBrowserSession");
      if (route.access === "purpose_bound_verification") expect(actual?.guard).toContain("optionalSession");
      if (route.access === "public" || route.access === "refresh_cookie_csrf") {
        expect(actual?.guard).not.toMatch(
          /require(BrowsePrincipal|TenantPrincipal|BrowserSession)/,
        );
      }
    }
  });
});
