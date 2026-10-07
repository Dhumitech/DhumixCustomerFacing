import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const baseline = JSON.parse(readFileSync(new URL("../fixtures/refactor-dependencies-0071.json", import.meta.url), "utf8")) as { hashes: Record<string,string> };
describe("0071 no-new-dependencies baseline", () => {
  it.each(Object.entries(baseline.hashes))("preserves %s, including its scripts/versions", (file, expected) => {
    let bytes = readFileSync(new URL("../../../" + file, import.meta.url));
    if(file==='back-end/package.json'){
      const text=bytes.toString('utf8');
      expect(JSON.parse(text).scripts['operator:template']).toBe('node --env-file-if-exists=.env --import tsx src/worker/template.ts');
      // 0073 adds exactly this declared Target operator entry. All historical
      // dependencies, versions, existing scripts and other bytes stay pinned.
      bytes=Buffer.from(text.replace(/^    "operator:template": "node --env-file-if-exists=\.env --import tsx src\/worker\/template\.ts",\r?\n/m,''));
    }
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected);
  });
});
