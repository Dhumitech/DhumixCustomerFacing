import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `Project Specs\07_Implementation\02_Sequential_Implementation_Plan.md` requires
 * provider and Integration Boundary dependencies to be impossible to import
 * from the Identity and Tenant Access modules.
 *
 * A module-first layout would make that structural, because `identity/` and
 * `brightdata/` would be top-level siblings. The accepted layer-first layout
 * places both under `src/services/`, so `../brightdata/...` is two path
 * segments away with nothing stopping it. This test is that boundary.
 */
const SOURCE_ROOT = new URL("../../src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** Directories that must never reach the Integration Boundary. */
const CUSTOMER_FACING_MODULES = [
  "services/identity",
  "services/tenantAccess",
  "services/workspace",
  "services/apiKeys",
  "services/catalogue",
  "services/customerServices",
  "services/admission",
  "services/runQuery",
  "controllers",
  "routes",
  "helpers",
];

const FORBIDDEN_IMPORT =
  /(?:from\s+|import\()["'][^"']*(?:brightdata|bright-data|provider(?:Client|Adapter|Credential)?|vault|queue|worker|objectStorage)[^"']*["']/i;

function typescriptFilesUnder(directory: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }

  return entries.flatMap((entry) => {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      return typescriptFilesUnder(full);
    }
    return full.endsWith(".ts") ? [full] : [];
  });
}

describe("Bright Data Integration Boundary", () => {
  it("is not imported by any customer-facing module", () => {
    const offenders: string[] = [];

    for (const moduleDirectory of CUSTOMER_FACING_MODULES) {
      for (const file of typescriptFilesUnder(join(SOURCE_ROOT, moduleDirectory))) {
        if (FORBIDDEN_IMPORT.test(readFileSync(file, "utf8"))) {
          offenders.push(relative(SOURCE_ROOT, file).replace(/\\/g, "/"));
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("scans a non-empty set of files, so the check cannot pass vacuously", () => {
    const scanned = CUSTOMER_FACING_MODULES.flatMap((moduleDirectory) =>
      typescriptFilesUnder(join(SOURCE_ROOT, moduleDirectory)),
    );

    expect(scanned.length).toBeGreaterThan(0);
  });

  it("detects a forbidden import when one is present", () => {
    // Guards the regex itself. Without this, a broken pattern would make the
    // boundary test pass silently forever.
    expect(FORBIDDEN_IMPORT.test('import { x } from "../brightdata/adapters/x.js";')).toBe(
      true,
    );
    expect(FORBIDDEN_IMPORT.test('import { x } from "../provider/client.js";')).toBe(true);
    expect(FORBIDDEN_IMPORT.test('import { x } from "../worker/runWorker.js";')).toBe(true);
    expect(FORBIDDEN_IMPORT.test('import { y } from "../database/pools.js";')).toBe(false);
  });
});
