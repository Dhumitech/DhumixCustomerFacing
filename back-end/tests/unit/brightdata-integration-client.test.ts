import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  BrightDataBoundaryError,
  createBrightDataIntegrationClient,
  type BrightDataFetch,
} from "../../src/services/brightdata/brightDataIntegrationClient.js";

const datasetId = "gd_l7q7dkf244hwjntr0";
const snapshotReference = "s_m4x7enmven8djfqak";
const apiKey = "provider-secret-never-returned";
const targets = [
  {
    url: "https://www.amazon.com/dp/B0CRMZHDG8",
    zipcode: "94107",
    language: "EN",
    all_variations: true,
  },
] as const;

function client(
  fetchImplementation: BrightDataFetch,
  maxResponseBytes = 4096,
  catalogueResponseMaxBytes = 4096,
) {
  return createBrightDataIntegrationClient({
    fetch: fetchImplementation,
    requestTimeoutMs: 5000,
    controlResponseMaxBytes: 4096,
    catalogueResponseMaxBytes,
    resultMaxBytes: maxResponseBytes,
  });
}

async function streamBytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

describe("permanent Bright Data Integration Boundary client", () => {
  it.each(["scrape", "trigger"] as const)("preserves the initial %s Retry-After without polling or re-submitting", async (endpoint) => {
    const transport = vi.fn<BrightDataFetch>(async () => new Response(JSON.stringify({ snapshot_id: snapshotReference }), {
      status: 202, headers: { "content-type": "application/json", "retry-after": "9" },
    }));
    const boundary = client(transport);
    const request = { apiKey, datasetId, targets, fixedQuery: { mode: "collect" as const }, signal: new AbortController().signal };
    const response = await (endpoint === "scrape" ? boundary.submit(request) : boundary.trigger(request));
    expect(response).toMatchObject({ snapshotReference, retryAfterMs: 9000 });
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0]?.[1]?.method).toBe("POST");
  });
  it.each(["starting", "running", "ready", "failed", "canceled"] as const)("reads HTTP 200 provider status %s without treating HTTP success as job success", async (status) => {
    await expect(client(async () => new Response(JSON.stringify({ status, error_message: "private detail" }), {
      status: 200, headers: { "content-type": "application/json" },
    })).getProgress({ apiKey, snapshotReference, signal: new AbortController().signal })).resolves.toEqual({ status });
  });
  it.each([
    [401, "PROVIDER_CREDENTIAL_UNAVAILABLE", false],
    [404, "PROVIDER_REQUEST_REJECTED", true],
    [429, "PROVIDER_RATE_LIMITED", true],
    [500, "PROVIDER_UNAVAILABLE", true],
  ] as const)("classifies read HTTP %s", async (status, code, retryable) => {
    await expect(client(async () => new Response("private detail", { status }))
      .getProgress({ apiKey, snapshotReference, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code, retryable, submissionOutcome: "not_applicable" });
  });
  it.each(["Snapshot is empty", "Snapshot is expired"])("terminates a download rejection: %s", async (body) => {
    await expect(client(async () => new Response(body, { status: 400 }))
      .download({ apiKey, snapshotReference, format: "json", signal: new AbortController().signal }))
      .rejects.toMatchObject({ safeReason: "PROVIDER_HTTP_400", retryable: false });
  });
  it.each([202, 409])("classifies download %s as not-ready without a submission", async (status) => {
    const transport = vi.fn<BrightDataFetch>(async () => new Response("{}", {
      status, headers: { "retry-after": "7", "content-type": "application/json" },
    }));
    await expect(client(transport).download({ apiKey, snapshotReference, format: "json", signal: new AbortController().signal }))
      .rejects.toMatchObject({ safeReason: "PROVIDER_SNAPSHOT_NOT_READY", retryable: true, retryAfterMs: 7000 });
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0]?.[1]?.method).toBe("GET");
  });
  it("keeps a successful submission without a snapshot reference ambiguous", async () => {
    await expect(client(async () => new Response('{"status":"starting"}', {
      status: 202, headers: { "content-type": "application/json" },
    })).submit({ apiKey, datasetId, targets, fixedQuery: { mode: "collect" }, signal: new AbortController().signal }))
      .rejects.toMatchObject({ submissionOutcome: "uncertain", retryable: false });
  });
  it("retains Retry-After for rate-limited status reads", async () => {
    await expect(client(async () => new Response("", { status: 429, headers: { "retry-after": "11" } }))
      .getProgress({ apiKey, snapshotReference, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED", retryAfterMs: 11000 });
  });
  it("retrieves bounded private scraper candidates without changing the public catalogue", async () => {
    const providerFetch = vi.fn<BrightDataFetch>(async () =>
      new Response(
        JSON.stringify([{ id: datasetId, name: "Amazon products" }]),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(
      client(providerFetch).listScrapers({
        apiKey,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual([{ id: datasetId, name: "Amazon products" }]);
    expect(providerFetch).toHaveBeenCalledWith(
      "https://api.brightdata.com/datasets/v3/scrapers",
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
  });

  it("normalizes provider display-name whitespace while keeping provider metadata private", async () => {
    const providerFetch = vi.fn<BrightDataFetch>(async () =>
      new Response(
        JSON.stringify([{
          id: datasetId,
          name: "  Amazon products  ",
          category: "ecommerce",
          domain: "amazon.com",
          sample_output: { private: true },
          use_cases: ["catalogue"],
        }]),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(
      client(providerFetch).listScrapers({
        apiKey,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual([{ id: datasetId, name: "Amazon products" }]);
  });

  it("distinguishes malformed and oversized declared catalogue lengths", async () => {
    const cancel = vi.fn();
    await expect(
      client(async () =>
        new Response(new ReadableStream<Uint8Array>({ cancel }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": "not-a-number",
          },
        }),
      ).listScrapers({ apiKey, signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      code: "PROVIDER_RESPONSE_INVALID",
      safeReason: "PROVIDER_CONTROL_LENGTH_INVALID",
    });

    await expect(
      client(async () =>
        new Response("[]", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": "4097",
          },
        }),
      ).listScrapers({ apiKey, signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      code: "PROVIDER_RESPONSE_INVALID",
      safeReason: "PROVIDER_CONTROL_TOO_LARGE",
      observedByteCount: 4097,
      maximumByteCount: 4096,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("uses a separate finite catalogue ceiling without weakening small control responses", async () => {
    const catalogue = JSON.stringify([{
      id: datasetId,
      name: "Amazon products",
      provider_metadata: "x".repeat(5000),
    }]);
    const catalogueClient = client(
      async () => new Response(catalogue, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      8192,
      8192,
    );

    await expect(catalogueClient.listScrapers({
      apiKey,
      signal: new AbortController().signal,
    })).resolves.toEqual([{ id: datasetId, name: "Amazon products" }]);

    const oversizedControlClient = client(
      async () => new Response(JSON.stringify({ snapshot_id: `s_${"a".repeat(5000)}` }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
      8192,
      8192,
    );
    await expect(oversizedControlClient.submit({
      apiKey,
      datasetId,
      targets: [{ url: "https://www.amazon.com/dp/B000000000" }],
      fixedQuery: { mode: "collect" },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      safeReason: "PROVIDER_CONTROL_TOO_LARGE",
      maximumByteCount: 4096,
    });
  });

  it("pins the scrape origin/query/body and streams an inline 200 result", async () => {
    const responseBytes = Buffer.from('[{"title":"Example"}]', "utf8");
    const providerFetch = vi.fn<BrightDataFetch>(async () =>
      new Response(responseBytes, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const outcome = await client(providerFetch).submit({
      apiKey,
      datasetId,
      targets,
      fixedQuery: { mode: "collect" },
      signal: new AbortController().signal,
    });

    expect(outcome.kind).toBe("inline");
    if (outcome.kind !== "inline") throw new Error("Expected inline outcome");
    expect(await streamBytes(outcome.bytes)).toEqual(responseBytes);
    expect(outcome.contentType).toBe("application/json");

    const [url, init] = providerFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.brightdata.com/datasets/v3/scrape?dataset_id=gd_l7q7dkf244hwjntr0&format=json&notify=false&include_errors=true",
    );
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(init.headers).toEqual({
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({ input: targets });
  });

  it("injects fixed discovery query fields outside customer input", async () => {
    const providerFetch = vi.fn<BrightDataFetch>(async () =>
      new Response("[]", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );

    await client(providerFetch).submit({
      apiKey,
      datasetId,
      targets: [{ keyword: "insulated bottle" }],
      fixedQuery: { mode: "discover", discoverBy: "keyword" },
      limitPerInput: 100,
      signal: new AbortController().signal,
    });

    const [url, init] = providerFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("type=discover_new");
    expect(url).toContain("discover_by=keyword");
    expect(JSON.parse(String(init.body))).toEqual({
      input: [{ keyword: "insulated bottle" }],
      limit_per_input: 100,
    });
  });

  it("preserves an explicitly unbounded null limit_per_input in the provider body", async () => {
    const providerFetch = vi.fn<BrightDataFetch>(async () =>
      new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await client(providerFetch).submit({
      apiKey,
      datasetId,
      targets,
      fixedQuery: { mode: "collect" },
      limitPerInput: null,
      signal: new AbortController().signal,
    });

    const [, init] = providerFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      input: targets,
      limit_per_input: null,
    });
  });

  it("returns a protected 202 reference without placing it in an error", async () => {
    const outcome = await client(async () =>
      new Response(JSON.stringify({ snapshot_id: "s_m4x7enmven8djfqak" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    ).submit({
      apiKey,
      datasetId,
      targets,
      fixedQuery: { mode: "collect" },
      signal: new AbortController().signal,
    });

    expect(outcome).toEqual({
      kind: "snapshot",
      snapshotReference: "s_m4x7enmven8djfqak",
    });
  });

  it("accepts the sd_ snapshot references returned by the live Bright Data account", async () => {
    const liveReferenceShape = "sd_mtfkst3y2n9be8625w";
    const providerFetch = vi
      .fn<BrightDataFetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ snapshot_id: liveReferenceShape }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "ready" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response('[{"rating":5}]', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const boundary = client(providerFetch);

    await expect(
      boundary.submit({
        apiKey,
        datasetId,
        targets,
        fixedQuery: { mode: "collect" },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: "snapshot", snapshotReference: liveReferenceShape });
    await expect(
      boundary.getProgress({
        apiKey,
        snapshotReference: liveReferenceShape,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ status: "ready" });
    const downloaded = await boundary.download({
      apiKey,
      snapshotReference: liveReferenceShape,
      format: "json",
      signal: new AbortController().signal,
    });
    expect(await streamBytes(downloaded.bytes)).toEqual(Buffer.from('[{"rating":5}]'));
    expect(providerFetch.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining("/datasets/v3/scrape?"),
      `https://api.brightdata.com/datasets/v3/progress/${liveReferenceShape}`,
      `https://api.brightdata.com/datasets/v3/snapshot/${liveReferenceShape}?format=json`,
    ]);
  });

  it("keeps separately qualified async submission on the fixed trigger route", async () => {
    const providerFetch = vi.fn<BrightDataFetch>(async () =>
      new Response(JSON.stringify({ snapshot_id: snapshotReference }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      client(providerFetch).trigger({
        apiKey,
        datasetId,
        targets,
        fixedQuery: { mode: "collect" },
        limitPerInput: 3,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ snapshotReference });
    const [url, init] = providerFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.brightdata.com/datasets/v3/trigger?dataset_id=gd_l7q7dkf244hwjntr0&format=json&notify=false&include_errors=true&limit_per_input=3",
    );
    expect(JSON.parse(String(init.body))).toEqual(targets);
  });

  it("keeps the documented discovery selectors on the async trigger route", async () => {
    const providerFetch = vi.fn<BrightDataFetch>(async () =>
      new Response(JSON.stringify({ snapshot_id: snapshotReference }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await client(providerFetch).trigger({
      apiKey,
      datasetId,
      targets,
      fixedQuery: { mode: "discover", discoverBy: "category_url" },
      signal: new AbortController().signal,
    });

    const [url, init] = providerFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.brightdata.com/datasets/v3/trigger?dataset_id=gd_l7q7dkf244hwjntr0&format=json&notify=false&include_errors=true&type=discover_new&discover_by=category_url",
    );
    expect(JSON.parse(String(init.body))).toEqual(targets);
  });

  it("polls and downloads only through fixed provider paths", async () => {
    const providerFetch = vi
      .fn<BrightDataFetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "ready" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response('[{"asin":"B0CRMZHDG8"}]', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const boundary = client(providerFetch);

    await expect(
      boundary.getProgress({
        apiKey,
        snapshotReference: "s_m4x7enmven8djfqak",
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ status: "ready" });
    const downloaded = await boundary.download({
      apiKey,
      snapshotReference: "s_m4x7enmven8djfqak",
      format: "json",
      signal: new AbortController().signal,
    });
    expect(await streamBytes(downloaded.bytes)).toEqual(
      Buffer.from('[{"asin":"B0CRMZHDG8"}]'),
    );

    expect(providerFetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.brightdata.com/datasets/v3/progress/s_m4x7enmven8djfqak",
      "https://api.brightdata.com/datasets/v3/snapshot/s_m4x7enmven8djfqak?format=json",
    ]);
    expect(providerFetch.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
  });

  it("classifies a transport loss during POST as uncertain and never retries", async () => {
    const providerFetch = vi.fn<BrightDataFetch>(async () => {
      throw new Error("private transport diagnostic");
    });

    try {
      await client(providerFetch).submit({
        apiKey,
        datasetId,
        targets,
        fixedQuery: { mode: "collect" },
        signal: new AbortController().signal,
      });
      expect.fail("Expected uncertain submission");
    } catch (error) {
      expect(error).toBeInstanceOf(BrightDataBoundaryError);
      expect(error).toMatchObject({
        code: "PROVIDER_SUBMISSION_UNCERTAIN",
        submissionOutcome: "uncertain",
        retryable: false,
      });
      expect(String(error)).not.toContain("private transport diagnostic");
    }
    expect(providerFetch).toHaveBeenCalledOnce();
  });

  it("rejects malformed identifiers, redirects, provider errors and oversized control bodies", async () => {
    const neverCalled = vi.fn<BrightDataFetch>();
    await expect(
      client(neverCalled).submit({
        apiKey,
        datasetId: "https://attacker.invalid/",
        targets,
        fixedQuery: { mode: "collect" },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_CONFIGURATION_INVALID" });
    expect(neverCalled).not.toHaveBeenCalled();

    await expect(
      client(async () => new Response(null, { status: 302 })).submit({
        apiKey,
        datasetId,
        targets,
        fixedQuery: { mode: "collect" },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_SUBMISSION_UNCERTAIN" });

    await expect(
      client(async () => new Response("private provider body", { status: 401 })).submit({
        apiKey,
        datasetId,
        targets,
        fixedQuery: { mode: "collect" },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_CREDENTIAL_UNAVAILABLE" });

    const oversizedControlBody = JSON.stringify({ snapshot_id: `s_${"x".repeat(5000)}` });
    await expect(
      client(async () =>
        new Response(oversizedControlBody, {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
      ).submit({
        apiKey,
        datasetId,
        targets,
        fixedQuery: { mode: "collect" },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_RESPONSE_INVALID",
      safeReason: "PROVIDER_CONTROL_TOO_LARGE",
      observedByteCount: Buffer.byteLength(oversizedControlBody),
      maximumByteCount: 4096,
    });
  });

  it.each([400, 404, 422] as const)(
    "keeps only the safe provider HTTP status for rejected submissions (%s)",
    async (status) => {
      await expect(
        client(async () => new Response("private provider body", { status })).trigger({
          apiKey,
          datasetId,
          targets,
          fixedQuery: { mode: "collect" },
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({
        code: "PROVIDER_REQUEST_REJECTED",
        safeReason: `PROVIDER_HTTP_${status}`,
      });
    },
  );

  it("classifies insufficient provider balance without retaining the private body", async () => {
    await expect(
      client(async () =>
        new Response("private billing detail", { status: 402 }),
      ).submit({
        apiKey,
        datasetId,
        targets,
        fixedQuery: { mode: "collect" },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_PAYMENT_REQUIRED",
      safeReason: "PROVIDER_HTTP_402",
      submissionOutcome: "known_failed",
      retryable: false,
    });
  });

  it("distinguishes a missing 202 snapshot reference from bounded-control failures", async () => {
    await expect(
      client(async () =>
        new Response(JSON.stringify({ status: "starting" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
      ).submit({
        apiKey,
        datasetId,
        targets,
        fixedQuery: { mode: "collect" },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_RESPONSE_INVALID",
      safeReason: "PROVIDER_SNAPSHOT_REFERENCE_MISSING",
    });
  });

  it("rejects a malformed 202 snapshot reference without exposing it", async () => {
    await expect(
      client(async () =>
        new Response(JSON.stringify({ snapshot_id: "not-a-snapshot-reference" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
      ).submit({
        apiKey,
        datasetId,
        targets,
        fixedQuery: { mode: "collect" },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_RESPONSE_INVALID",
      safeReason: "PROVIDER_SNAPSHOT_REFERENCE_INVALID",
    });
  });

  it("reports a safe metadata reason without exposing a provider response", async () => {
    await expect(
      client(async () =>
        new Response("[]", {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
      ).submit({
        apiKey,
        datasetId,
        targets,
        fixedQuery: { mode: "collect" },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_RESPONSE_INVALID",
      safeReason: "PROVIDER_RESULT_MEDIA_TYPE_INVALID",
    });
  });

  it("rejects invalid snapshot batch and part controls before provider egress", async () => {
    const neverCalled = vi.fn<BrightDataFetch>();
    const boundary = client(neverCalled);

    await expect(
      boundary.getParts({
        apiKey,
        snapshotReference,
        format: "json",
        batchSize: 0,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_CONFIGURATION_INVALID" });
    await expect(
      boundary.download({
        apiKey,
        snapshotReference,
        format: "json",
        part: 1.5,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_CONFIGURATION_INVALID" });
    expect(neverCalled).not.toHaveBeenCalled();
  });
});
