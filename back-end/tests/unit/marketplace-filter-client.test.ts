import { describe, expect, it, vi } from "vitest";
import {
  createMarketplaceFilterClient,
  MarketplaceFilterBoundaryError,
  type MarketplaceFilterFetch,
} from "../../src/services/brightdata/marketplace/marketplaceFilterClient.js";

const apiKey = "private-provider-key";
const snapshotReference = "s_abc123xyz";
const request = {
  dataset_id: "gd_lyy3tktm25m4avu764",
  records_limit: 10,
  filter: { name: "url", operator: "is_not_null" },
} as const;

function client(fetchImplementation: MarketplaceFilterFetch, resultMaxBytes = 4096) {
  return createMarketplaceFilterClient({
    fetch: fetchImplementation,
    requestTimeoutMs: 5000,
    controlResponseMaxBytes: 4096,
    resultMaxBytes,
  });
}

describe("M7 Marketplace Filter client", () => {
  it("submits the documented JSON body exactly once and returns one Snapshot reference", async () => {
    const providerFetch = vi.fn<MarketplaceFilterFetch>(async () => new Response(
      JSON.stringify({ snapshot_id: snapshotReference }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    await expect(client(providerFetch).submit({
      apiKey,
      request,
      signal: new AbortController().signal,
    })).resolves.toEqual({ snapshotReference });

    expect(providerFetch).toHaveBeenCalledOnce();
    expect(providerFetch).toHaveBeenCalledWith(
      "https://api.brightdata.com/datasets/filter",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        body: JSON.stringify(request),
      }),
    );
  });

  it("treats a provider-returned Snapshot ID as an opaque bounded string", async () => {
    const opaqueReference = "provider.snapshot-2026-09-12";
    await expect(client(async () => new Response(
      JSON.stringify({ snapshot_id: opaqueReference }),
      { status: 200, headers: { "content-type": "application/json" } },
    )).submit({
      apiKey,
      request,
      signal: new AbortController().signal,
    })).resolves.toEqual({ snapshotReference: opaqueReference });
  });

  it.each([
    [402, "MARKETPLACE_FILTER_PAYMENT_REQUIRED"],
    [422, "MARKETPLACE_FILTER_ZERO_MATCHES"],
    [429, "MARKETPLACE_FILTER_RATE_LIMITED"],
  ] as const)("maps documented submission HTTP %s without automatic retry", async (status, code) => {
    const providerFetch = vi.fn<MarketplaceFilterFetch>(async () => new Response("private", { status }));
    await expect(client(providerFetch).submit({
      apiKey,
      request,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code, submissionOutcome: "known_failed", retryable: false });
    expect(providerFetch).toHaveBeenCalledOnce();
  });

  it("classifies transport failure and malformed success as ambiguous submissions", async () => {
    await expect(client(async () => { throw new Error("network"); }).submit({
      apiKey,
      request,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "MARKETPLACE_FILTER_SUBMISSION_UNCERTAIN", submissionOutcome: "uncertain" });

    await expect(client(async () => new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    })).submit({ apiKey, request, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "MARKETPLACE_FILTER_SUBMISSION_UNCERTAIN", submissionOutcome: "uncertain" });
  });

  it.each(["scheduled", "building", "ready", "failed"] as const)(
    "accepts documented Snapshot state %s",
    async (status) => {
      const metadata = {
        id: snapshotReference,
        status,
        dataset_id: request.dataset_id,
        dataset_size: 10,
        file_size: 1200,
        cost: 0.025,
      };
      await expect(client(async () => new Response(JSON.stringify(metadata), {
        status: 200,
        headers: { "content-type": "application/json" },
      })).getSnapshotMetadata({
        apiKey,
        snapshotReference,
        signal: new AbortController().signal,
      })).resolves.toEqual({
        id: snapshotReference,
        status,
        datasetId: request.dataset_id,
        datasetSize: 10,
        fileSize: 1200,
        cost: 0.025,
      });
    },
  );

  it("downloads exact JSON bytes with explicit uncompressed JSON parameters", async () => {
    const expected = Buffer.from('[{"url":"https://www.linkedin.com/posts/example"}]');
    const providerFetch = vi.fn<MarketplaceFilterFetch>(async () => new Response(expected, {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const result = await client(providerFetch).downloadSnapshot({
      apiKey,
      snapshotReference,
      signal: new AbortController().signal,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of result.bytes) chunks.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(chunks)).toEqual(expected);
    expect(providerFetch).toHaveBeenCalledWith(
      `https://api.brightdata.com/datasets/snapshots/${snapshotReference}/download?format=json&compress=false`,
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
  });

  it("bounds downloads and safely classifies not-ready and missing Snapshots", async () => {
    const oversized = await client(async () => new Response("12345", {
      status: 200,
      headers: { "content-type": "application/json" },
    }), 4).downloadSnapshot({ apiKey, snapshotReference, signal: new AbortController().signal });
    await expect(async () => {
      for await (const _chunk of oversized.bytes) { /* consume */ }
    }).rejects.toBeInstanceOf(MarketplaceFilterBoundaryError);

    await expect(client(async () => new Response(null, { status: 202 })).downloadSnapshot({
      apiKey, snapshotReference, signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "MARKETPLACE_FILTER_SNAPSHOT_NOT_READY", retryable: true });
    await expect(client(async () => new Response(null, { status: 404 })).getSnapshotMetadata({
      apiKey, snapshotReference, signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "MARKETPLACE_FILTER_SNAPSHOT_NOT_FOUND", retryable: true });
  });
});
