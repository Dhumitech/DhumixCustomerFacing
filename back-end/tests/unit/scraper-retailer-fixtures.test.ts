import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createScraperProcessing, scraperContractHash, type ScraperOperationContract } from "../../src/services/scrapers/scraperProcessing.js";
describe("owner-supplied retailer evidence on one processing implementation", () => {
  const processing = createScraperProcessing();
  it.each(["target", "lowes", "homedepot", "etsy", "walmart"])("%s needs a data contract, not another executor", async (name) => {
    const fixture = JSON.parse(readFileSync(new URL(`../fixtures/scraper-operations/${name}.json`, import.meta.url), "utf8")) as {
      status: string; contract: ScraperOperationContract; input: Record<string, unknown>;
      expectedTargets: Record<string, unknown>[]; records: Record<string, unknown>[]; expectedNormalized: unknown;
    };
    expect(fixture.status).toBe("fixture_only_not_qualified");
    const processor = processing.prepare(fixture.contract, scraperContractHash(fixture.contract));
    expect(processor.serialize(fixture.input)).toEqual(fixture.expectedTargets);
    const bytes = Buffer.from(JSON.stringify(fixture.records));
    const transformed = await processor.normalize({ bytes: Readable.from([bytes]), byteCount: bytes.length, maxBytes: 65536,
      contentType: "application/json", contentEncoding: null });
    expect(JSON.parse(transformed.bytes.toString())).toEqual(fixture.expectedNormalized);
    expect(transformed.recordCount).toBe(fixture.records.length);
    expect(processing.prepare(fixture.contract)).toBe(processor);
  });
});
