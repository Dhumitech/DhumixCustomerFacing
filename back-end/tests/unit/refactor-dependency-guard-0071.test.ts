import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// The deployment-readiness security patches have a separate dated receipt.
// Preserve the original 0071 receipt rather than rewriting migration evidence.
const baseline = JSON.parse(readFileSync(new URL("../fixtures/refactor-dependencies-demo-security-20261008.json", import.meta.url), "utf8")) as { hashes: Record<string,string> };
const azure = JSON.parse(readFileSync(new URL("../fixtures/refactor-dependencies-azure-blob-20261008.json", import.meta.url), "utf8")) as {
  identityVersion: string; storageCheckCommand: string; lockFileSha256LF: string; lockAddedPackages: string[];
};
const deployment = JSON.parse(readFileSync(new URL("../fixtures/refactor-deployment-scripts-20261008.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
};
describe("refactor dependency baseline with reviewed demo security patches", () => {
  it.each(Object.entries(baseline.hashes))("preserves %s, including its scripts/versions", (file, expected) => {
    let bytes = readFileSync(new URL("../../../" + file, import.meta.url));
    if(file==='back-end/package.json'){
      const text=bytes.toString('utf8');
      expect(JSON.parse(text).scripts['operator:template']).toBe('node --env-file-if-exists=.env --import tsx src/worker/template.ts');
      // 0073 adds exactly this declared Target operator entry. The owner's
      // 8 October local-stack request adds five launcher commands. Verify those
      // narrow exceptions, then retain the original dependency/script byte pin.
      bytes=Buffer.from(text.replace(/^    "operator:template": "node --env-file-if-exists=\.env --import tsx src\/worker\/template\.ts",\r?\n/m,''));
      for (const action of ['up', 'start', 'stop', 'status', 'test']) {
        const value = `node --import tsx scripts/local-demo/demo.mjs ${action}`;
        expect(JSON.parse(text).scripts[`demo:${action}`]).toBe(value);
        bytes = Buffer.from(bytes.toString('utf8').replace(new RegExp(`^    "demo:${action}": "node --import tsx scripts/local-demo/demo\\.mjs ${action}",\\r?\\n`, 'm'), ''));
      }
      // The owner requested a portable, real Azure Blob connection. Accept only
      // its declared credential SDK and checker; all preceding entries stay pinned.
      const packageJson = JSON.parse(bytes.toString("utf8"));
      expect(packageJson.dependencies["@azure/identity"]).toBe(azure.identityVersion);
      // Later owner instructions consolidate env loading and add the queue
      // connection checker. Pin each exact command; retain old dated evidence.
      for (const [name, command] of Object.entries(deployment.scripts)) {
        expect(packageJson.scripts[name]).toBe(command);
        delete packageJson.scripts[name];
      }
      // Owner's 9 October portable env request adds a read-only TLS checker.
      // Keep every existing dependency and dated deployment receipt pinned.
      expect(packageJson.scripts["database:check"]).toBe("node --import tsx scripts/azure/check-database.mjs");
      delete packageJson.scripts["database:check"];
      delete packageJson.dependencies["@azure/identity"];
      bytes = Buffer.from(JSON.stringify(packageJson, null, 2) + "\n");
    }
    if (file === "back-end/package-lock.json") {
      const text = bytes.toString("utf8").replace(/\r\n/g, "\n");
      expect(createHash("sha256").update(text).digest("hex")).toBe(azure.lockFileSha256LF);
      const lock = JSON.parse(text);
      expect(lock.packages[""].dependencies["@azure/identity"]).toBe(azure.identityVersion);
      delete lock.packages[""].dependencies["@azure/identity"];
      for (const path of azure.lockAddedPackages) {
        expect(lock.packages[path]).toBeDefined();
        delete lock.packages[path];
      }
      // Reconstruct the exact prior lock: no previous version/integrity/metadata
      // change is hidden by accepting the cloud dependency addition.
      bytes = Buffer.from(JSON.stringify(lock, null, 2) + "\n");
    }
    // Git stores these text files with LF. Compare the same bytes on a clean
    // checkout and on Windows; content, dependency versions and scripts stay pinned.
    const canonical = bytes.toString("utf8").replace(/\r\n/g, "\n");
    expect(createHash("sha256").update(canonical).digest("hex")).toBe(expected);
  });
});
