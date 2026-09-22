import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createScraperProcessing,
  scraperContractHash,
  ScraperInputError,
  ScraperResultError,
  type ScraperOperationContract,
} from "../../src/services/scrapers/scraperProcessing.js";

export function targetContract(): ScraperOperationContract {
  return {
    operationCode: "target.products.collect_by_url",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["targets"],
      properties: { targets: { type: "array", minItems: 1, maxItems: 20,
        items: { type: "object", additionalProperties: false, required: ["url"],
          properties: { url: { type: "string", format: "uri", maxLength: 8192 },
            zipcode: { type: "string", pattern: "^[0-9]{1,10}$" }, all_variations: { type: "boolean" } } } } },
    },
    outputSchema: { type: "array", maxItems: 1000, items: {
      type: "object", additionalProperties: false, required: ["url", "title", "final_price"],
      properties: { url: { type: "string", format: "uri" }, title: { type: "string" }, final_price: { type: "number" } },
    } },
    processing: {
      version: 1, revision: 1,
      urls: [{ field: "url", hosts: ["www.target.com", "target.com"], pathPrefixes: ["/p/"], allowFragment: true }],
      request: { endpoint: "scrape", mode: "collect", fields: ["url", "zipcode", "all_variations"],
        snapshot: { enabled: true, cancelEnabled: false, multipartEnabled: false, format: "json" } },
      projectedFields: ["url", "title", "final_price"],
      schemaVersion: "target.products.fixture-output.v1",
      usage: { meterCode: "target.result_records.observed", unit: "records" },
      maxRecords: 1000,
    },
  };
}

const input = { targets: [{ url: "https://www.target.com/p/example/-/A-1002219928#lnk=sametab", zipcode: "01011" }] };
const record = { url: input.targets[0]!.url, title: "Example", final_price: 49.99, private_field: "not projected" };
function raw(records: unknown) {
  const bytes = Buffer.from(JSON.stringify(records));
  return { bytes: Readable.from([bytes]), byteCount: bytes.length, contentType: "application/json", contentEncoding: null, maxBytes: 65536 };
}

describe("shared scraper processing", () => {
  it("caches one immutable processor across repeated and concurrent use", async () => {
    const processing = createScraperProcessing();
    const contract = targetContract();
    const processor = processing.prepare(contract, scraperContractHash(contract));
    expect(processing.prepare(structuredClone(contract), scraperContractHash(contract))).toBe(processor);
    await Promise.all(Array.from({ length: 20 }, async () => {
      expect(processor.serialize(input)).toEqual(input.targets);
      expect((await processor.normalize(raw([record]))).recordCount).toBe(1);
    }));
    expect(processing.stats()).toMatchObject({ compilations: 2, cacheHits: 1, cacheEntries: 1, parses: 20 });
  });
  it("preserves leading zeros, boolean types, fragments when reviewed, and does not mutate input", () => {
    const processing = createScraperProcessing();
    const processor = processing.prepare(targetContract());
    const value = { targets: [{ ...input.targets[0], all_variations: false }] };
    const before = structuredClone(value);
    expect(processor.serialize(value)).toEqual(value.targets);
    expect(value).toEqual(before);
  });
  it.each([
    "https://target.com.attacker.example/p/product",
    "http://www.target.com/p/product",
    "https://user:password@www.target.com/p/product",
    "https://www.target.com:444/p/product",
    "https://www.target.com/",
    "https://www.target.com/p/../other",
  ])("rejects the same unsafe URL before admission and serialization: %s", (url) => {
    const processor = createScraperProcessing().prepare(targetContract());
    const value = { targets: [{ url }] };
    expect(processor.validateInput(value).valid).toBe(false);
    expect(() => processor.serialize(value)).toThrow(ScraperInputError);
  });
  it.each([
    { ...input, unknown: true }, { targets: [{ ...input.targets[0], unknown: true }] },
    { targets: [{ ...input.targets[0], zipcode: 1011 }] },
    { targets: [{ ...input.targets[0], zipcode: "rrr" }] },
    { targets: [{ ...input.targets[0], all_variations: "1" }] }, { targets: [] },
  ])("does not coerce, default or ignore unsupported input", (value) => {
    expect(() => createScraperProcessing().prepare(targetContract()).serialize(value)).toThrow(ScraperInputError);
  });
  it("projects explicitly, validates, and normalizes in a single bounded parse", async () => {
    const processing = createScraperProcessing();
    const result = await processing.prepare(targetContract()).normalize(raw([record]));
    expect(JSON.parse(result.bytes.toString())).toEqual([{ url: record.url, title: "Example", final_price: 49.99 }]);
    expect(result.schemaVersion).toBe("target.products.fixture-output.v1");
    expect(processing.stats().parses).toBe(1);
  });
  it.each([
    { records: [{ error: "private error", error_code: "aborted_page" }], classification: "all_inputs_failed" },
    { records: [record, { error: "private error" }], classification: "mixed_results" },
    { records: [{ ...record, final_price: "49.99" }], classification: "invalid_result" },
    { records: { results: [record] }, classification: "invalid_result" },
    { records: [null], classification: "invalid_result" },
  ])("classifies $classification without reading/parsing raw evidence twice", async ({ records, classification }) => {
    const processing = createScraperProcessing();
    await expect(processing.prepare(targetContract()).normalize(raw(records))).rejects.toMatchObject({ classification });
    expect(processing.stats().parses).toBe(1);
  });
  it("keeps Home Depot string prices and Lowe's array availability operation-specific", async () => {
    const processing = createScraperProcessing();
    for (const [name, field, schema, value] of [
      ["homedepot", "final_price", { type: "string" }, "6.47"],
      ["lowes", "availability", { type: "array", items: { type: "string" } }, ["Available"]],
    ] as const) {
      const contract = targetContract();
      const changed = { ...contract, operationCode: `${name}.products.collect_by_url`,
        outputSchema: { type: "array", items: { type: "object", additionalProperties: false, required: [field], properties: { [field]: schema } } },
        processing: { ...contract.processing, projectedFields: [field] } };
      const result = await processing.prepare(changed).normalize(raw([{ [field]: value }]));
      expect(JSON.parse(result.bytes.toString())).toEqual([{ [field]: value }]);
    }
  });
  it("rejects changed descriptors, remote refs, unsafe field names and incomplete projection", () => {
    const contract = targetContract();
    const processing = createScraperProcessing();
    const expectedHash = scraperContractHash(contract);
    expect(() => processing.prepare({ ...contract, operationCode: "other.products.collect_by_url" }, expectedHash)).toThrow();
    expect(() => processing.prepare({ ...contract, inputSchema: { $ref: "https://example.com/schema" } })).toThrow();
    expect(() => processing.prepare({ ...contract, processing: { ...contract.processing, projectedFields: ["__proto__"] } })).toThrow();
    expect(() => processing.prepare({ ...contract, processing: { ...contract.processing, projectedFields: ["title"] } })).toThrow();
  });
  it("bounds cached contracts and evicts unused validators", () => {
    const processing = createScraperProcessing({ maxCachedContracts: 2 });
    for (let revision = 1; revision <= 3; revision++) {
      const contract = targetContract();
      processing.prepare({ ...contract, processing: { ...contract.processing, revision } });
    }
    expect(processing.stats()).toMatchObject({ cacheEntries: 2, compilations: 6 });
  });
  it("rejects contracts whose schema does not guarantee the processing input shape", () => {
    const contract = targetContract();
    for (const inputSchema of [
      { ...contract.inputSchema, required: [] },
      { ...contract.inputSchema, properties: { targets: { type: "array", minItems: 0, maxItems: 20, items: { type: "object", properties: {}, additionalProperties: false } } } },
      { ...contract.inputSchema, properties: { targets: { type: "array", minItems: 1, maxItems: 20, items: { properties: {}, additionalProperties: false } } } },
    ]) {
      expect(() => createScraperProcessing().prepare({ ...contract, inputSchema })).toThrow();
    }
  });
  it("rejects truncated/oversized/encoded results and excessive records", async () => {
    const processor = createScraperProcessing().prepare(targetContract());
    await expect(processor.normalize({ ...raw([record]), maxBytes: 2 })).rejects.toBeInstanceOf(ScraperResultError);
    await expect(processor.normalize({ ...raw([record]), byteCount: 1 })).rejects.toBeInstanceOf(ScraperResultError);
    await expect(processor.normalize({ ...raw([record]), contentEncoding: "gzip" })).rejects.toBeInstanceOf(ScraperResultError);
    await expect(processor.normalize(raw(Array.from({ length: 1001 }, () => record)))).rejects.toBeInstanceOf(ScraperResultError);
  });
});
