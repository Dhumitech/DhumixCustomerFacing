import { describe, expect, it } from "vitest";
import {
  AMAZON_OPERATION_DEFINITIONS,
} from "../../src/services/brightdata/amazon/amazonOperationDefinitions.js";
import {
  AmazonOperationContractError,
  serializeAmazonProviderRequest,
} from "../../src/services/brightdata/amazon/amazonOperationSerializer.js";

describe("Pattern 6 Amazon private request serializer", () => {
  it("serializes every candidate example with only its declared fields", () => {
    for (const definition of AMAZON_OPERATION_DEFINITIONS) {
      const serialized = serializeAmazonProviderRequest({
        operationCode: definition.operationCode,
        validatedInput: structuredClone(definition.example),
        providerRequest: definition.providerRequest,
      });
      expect(serialized.targets).toEqual(definition.example.targets);
      expect(serialized.fixedQuery).toEqual(
        definition.providerRequest.mode === "collect"
          ? { mode: "collect" }
          : { mode: "discover", discoverBy: definition.providerRequest.discoverBy },
      );
    }
  });

  it("canonicalizes safe strings and Amazon URLs without adding provider fields", () => {
    const result = serializeAmazonProviderRequest({
      operationCode: "amazon.products.collect_by_url",
      validatedInput: {
        targets: [
          {
            url: "https://WWW.AMAZON.COM:443/dp/B0CRMZHDG8?th=1",
            zipcode: " 94107 ",
            language: " EN ",
            all_variations: true,
          },
        ],
      },
      providerRequest: { mode: "collect" },
    });
    expect(result.targets).toEqual([
      {
        url: "https://www.amazon.com/dp/B0CRMZHDG8?th=1",
        zipcode: "94107",
        language: "EN",
        all_variations: true,
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/dataset|notify|include_errors/i);
  });

  it.each([
    ["http scheme", "http://www.amazon.com/dp/B0CRMZHDG8"],
    ["non-Amazon host", "https://example.test/dp/B0CRMZHDG8"],
    ["embedded credentials", "https://user:pass@www.amazon.com/dp/B0CRMZHDG8"],
    ["explicit port", "https://www.amazon.com:8443/dp/B0CRMZHDG8"],
    ["fragment", "https://www.amazon.com/dp/B0CRMZHDG8#details"],
    ["wrong URL role", "https://www.amazon.com/s?k=mouse"],
  ])("rejects %s before egress", (_label, url) => {
    expect(() =>
      serializeAmazonProviderRequest({
        operationCode: "amazon.products.collect_by_url",
        validatedInput: { targets: [{ url }] },
        providerRequest: { mode: "collect" },
      }),
    ).toThrow(AmazonOperationContractError);
  });

  it("rejects unknown fields, control characters and an unknown operation", () => {
    expect(() =>
      serializeAmazonProviderRequest({
        operationCode: "amazon.products.discover_by_keyword",
        validatedInput: {
          targets: [{ keyword: "wireless\u0000mouse", injected: true }],
        },
        providerRequest: { mode: "discover", discoverBy: "keyword" },
      }),
    ).toThrow(AmazonOperationContractError);
    expect(() =>
      serializeAmazonProviderRequest({
        operationCode: "amazon.unknown.operation",
        validatedInput: { targets: [{ keyword: "mouse" }] },
        providerRequest: { mode: "collect" },
      }),
    ).toThrow(AmazonOperationContractError);
  });

  it("fails closed when protected mapping policy disagrees with the definition", () => {
    expect(() =>
      serializeAmazonProviderRequest({
        operationCode: "amazon.products.discover_by_upc",
        validatedInput: { targets: [{ upc: "012345678901" }] },
        providerRequest: { mode: "discover", discoverBy: "keyword" },
      }),
    ).toThrow(AmazonOperationContractError);
    expect(() =>
      serializeAmazonProviderRequest({
        operationCode: "amazon.products.collect_by_url",
        validatedInput: {
          targets: [{ url: "https://www.amazon.com/dp/B0CRMZHDG8" }],
        },
        providerRequest: { mode: "discover", discoverBy: "keyword" },
      }),
    ).toThrow(AmazonOperationContractError);
  });
});
