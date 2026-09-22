import { describe, expect, it, vi } from "vitest";
import {
  MarketplaceCatalogueBoundaryError,
  createMarketplaceDatasetCatalogueClient,
  type MarketplaceCatalogueFetch,
} from "../../src/services/brightdata/marketplace/marketplaceDatasetCatalogueClient.js";

const apiKey = "private-provider-key";
const postsId = "gd_lyy3tktm25m4avu764";

function client(fetchImplementation: MarketplaceCatalogueFetch, responseMaxBytes = 4096) {
  return createMarketplaceDatasetCatalogueClient({
    fetch: fetchImplementation,
    requestTimeoutMs: 5000,
    responseMaxBytes,
  });
}

describe("Marketplace Dataset catalogue client", () => {
  it("retrieves the documented Dataset list and retains its exact evidence bytes", async () => {
    const bytes = Buffer.from(JSON.stringify([
      { id: postsId, name: " LinkedIn posts ", size: 129200000 },
    ]));
    const providerFetch = vi.fn<MarketplaceCatalogueFetch>(async () => new Response(bytes, {
      status: 200,
      headers: { "content-type": "application/json", "content-length": String(bytes.length) },
    }));

    const result = await client(providerFetch).listDatasets({
      apiKey,
      signal: new AbortController().signal,
    });

    expect(result.value).toEqual([{ id: postsId, name: "LinkedIn posts", size: 129200000 }]);
    expect(result.bytes).toEqual(bytes);
    expect(result.contentType).toBe("application/json");
    expect(providerFetch).toHaveBeenCalledWith(
      "https://api.brightdata.com/datasets/list",
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
  });

  it("preserves an omitted record count as unknown when the retained provider evidence omits size", async () => {
    const bytes = Buffer.from(JSON.stringify([
      { id: postsId, name: "LinkedIn posts" },
    ]));
    const result = await client(async () => new Response(bytes, {
      status: 200,
      headers: { "content-type": "application/json" },
    })).listDatasets({ apiKey, signal: new AbortController().signal });

    expect(result.value).toEqual([{ id: postsId, name: "LinkedIn posts", size: null }]);
  });

  it("retrieves documented field metadata only for the requested Dataset", async () => {
    const document = {
      id: postsId,
      fields: {
        url: { type: "url", active: true, required: true, description: "Post URL" },
        text: { type: "text" },
      },
    };
    const providerFetch = vi.fn<MarketplaceCatalogueFetch>(async () => new Response(
      JSON.stringify(document),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const result = await client(providerFetch).getDatasetMetadata({
      apiKey,
      datasetId: postsId,
      signal: new AbortController().signal,
    });

    expect(result.value).toEqual(document);
    expect(providerFetch).toHaveBeenCalledWith(
      `https://api.brightdata.com/datasets/${postsId}/metadata`,
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
  });

  it("fails closed for a mismatched metadata Dataset ID", async () => {
    await expect(client(async () => new Response(JSON.stringify({
      id: "gd_l1viktl72bvl7bjuj0",
      fields: {},
    }), { status: 200, headers: { "content-type": "application/json" } }))
      .getDatasetMetadata({
        apiKey,
        datasetId: postsId,
        signal: new AbortController().signal,
      }))
      .rejects.toMatchObject({ code: "MARKETPLACE_CATALOGUE_RESPONSE_INVALID" });
  });

  it.each([
    [401, "MARKETPLACE_CATALOGUE_CREDENTIAL_REJECTED", false],
    [404, "MARKETPLACE_CATALOGUE_RESOURCE_NOT_FOUND", false],
    [429, "MARKETPLACE_CATALOGUE_RATE_LIMITED", true],
    [500, "MARKETPLACE_CATALOGUE_UNAVAILABLE", true],
  ] as const)("classifies read-only HTTP %s safely", async (status, code, retryable) => {
    await expect(client(async () => new Response("private", { status })).listDatasets({
      apiKey,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code, retryable });
  });

  it("rejects malformed, non-JSON and oversized responses", async () => {
    const cases = [
      new Response("{}", { status: 200, headers: { "content-type": "text/plain" } }),
      new Response("not-json", { status: 200, headers: { "content-type": "application/json" } }),
      new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "4097" },
      }),
    ];

    for (const response of cases) {
      await expect(client(async () => response).listDatasets({
        apiKey,
        signal: new AbortController().signal,
      })).rejects.toBeInstanceOf(MarketplaceCatalogueBoundaryError);
    }
  });

  it("rejects undocumented Dataset-list and field-metadata shapes", async () => {
    await expect(client(async () => new Response(JSON.stringify([
      { id: postsId, name: "LinkedIn posts", size: "unknown" },
    ]), { status: 200, headers: { "content-type": "application/json" } })).listDatasets({
      apiKey,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "MARKETPLACE_CATALOGUE_RESPONSE_INVALID" });

    await expect(client(async () => new Response(JSON.stringify({
      id: postsId,
      fields: { url: { active: true } },
    }), { status: 200, headers: { "content-type": "application/json" } }))
      .getDatasetMetadata({
        apiKey,
        datasetId: postsId,
        signal: new AbortController().signal,
      }))
      .rejects.toMatchObject({ code: "MARKETPLACE_CATALOGUE_RESPONSE_INVALID" });
  });
});
