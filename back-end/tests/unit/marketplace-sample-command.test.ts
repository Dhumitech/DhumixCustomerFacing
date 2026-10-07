import { describe, expect, it } from "vitest";
import { parseMarketplaceSampleCommand, runMarketplaceSampleCommand } from "../../src/worker/marketplaceSample.js";

describe("retained Marketplace sample commands", () => {
  it("parses inspection and expiry with their existing flags", () => {
    expect(parseMarketplaceSampleCommand([
      "inspect-fixture", "--metadata-file", "fixture.json", "--sample-version", "1", "--as-of", "2026-10-06T00:00:00.000Z",
    ]).action).toBe("inspect-fixture");
    expect(parseMarketplaceSampleCommand([
      "expire-fixtures", "--as-of", "2026-10-06T00:00:00.000Z", "--limit", "10", "--actor", "operator",
    ]).action).toBe("expire-fixtures");
  });

  it("retains the complete fixture ingestion command", () => {
    const flags = ["sample-file", "metadata-file", "sample-version", "schema-version", "masking-policy-version",
      "retention-policy-version", "provenance-reference", "collected-at", "expires-at", "actor"];
    expect(parseMarketplaceSampleCommand(["ingest-fixture", ...flags.flatMap((flag) => [`--${flag}`, "value"])]).action)
      .toBe("ingest-fixture");
  });

  it("rejects qualification promotion before loading configuration or opening a pool", async () => {
    await expect(runMarketplaceSampleCommand([
      "promote-qualified-sample", "--packet-id", "packet", "--sample-version", "1", "--actor", "operator",
    ])).rejects.toMatchObject({ code: "MARKETPLACE_SAMPLE_INPUT_INVALID" });
  });

  it.each([
    ["expire-fixtures"],
    ["expire-fixtures", "--as-of", "date", "--as-of", "date", "--actor", "actor"],
    ["expire-fixtures", "--as-of", "date", "--limit", "1", "--actor", "actor", "--packet-id", "packet"],
  ].map((values) => ({ values })))("rejects missing, repeated and retired flags %j", ({ values }) => {
    expect(() => parseMarketplaceSampleCommand(values)).toThrow();
  });
});
