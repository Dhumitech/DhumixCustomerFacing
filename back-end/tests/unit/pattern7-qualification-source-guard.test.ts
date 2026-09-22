import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const commandUrl = new URL("../../src/worker/amazonQualification.ts", import.meta.url);

describe("Pattern 7 qualification source boundary", () => {
  it("requires explicit live/billable flags and exposes no token or provider-id option", async () => {
    const source = await readFile(commandUrl, "utf8");
    expect(source).toContain('"--confirm-live"');
    expect(source).toContain('"--confirm-billable"');
    expect(source).toContain('"--execution-mode"');
    expect(source).toContain('const mode = value(options, "--execution-mode")');
    expect(source).toContain("executionMode: executionMode(request.options)");
    expect(source).not.toContain('"--api-key"');
    expect(source).not.toContain('"--dataset-id"');
    expect(source).not.toContain("localBrightDataCanary");
  });

  it("contains no Fastify route or public API registration", async () => {
    const source = await readFile(commandUrl, "utf8");
    expect(source).not.toMatch(/fastify|registerRoute|\/v1\//i);
  });
});
