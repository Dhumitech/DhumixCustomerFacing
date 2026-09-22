import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CsrfService } from "../../src/helpers/csrf.js";
import type { MarketplacePreviewService } from
  "../../src/services/marketplacePreview/marketplacePreviewService.js";
import type {
  MarketplaceSampleDownloadRepository,
} from "../../src/services/marketplaceSampleDownload/marketplaceSampleDownloadRepository.js";
import {
  MarketplaceSampleDownloadRateLimitedError,
  MarketplaceSampleDownloadStaleError,
} from "../../src/services/marketplaceSampleDownload/marketplaceSampleDownloadRepository.js";
import { createMarketplaceSampleDownloadService } from
  "../../src/services/marketplaceSampleDownload/marketplaceSampleDownloadService.js";
import type { MarketplaceSampleDownloadStore } from
  "../../src/services/marketplaceSampleDownload/marketplaceSampleDownloadStore.js";
import type { TrustedTenantPrincipal } from
  "../../src/services/tenantAccess/trustedTenantPrincipal.js";

const tenantId = randomUUID();
const authorizationId = randomUUID();
const principal: TrustedTenantPrincipal = {
  kind: "browser",
  userId: randomUUID(),
  sessionId: randomUUID(),
  tenantId,
};
const expiresAt = new Date("2026-09-11T12:05:00.000Z");

function setup(options: {
  readonly oversized?: boolean;
  readonly rows?: readonly { readonly url: string; readonly text: string }[];
} = {}) {
  const rows = options.rows ?? [
    { url: "https://linkedin.example/posts/1", text: "Synt***one." },
    { url: "https://linkedin.example/posts/2", text: "Synt***two." },
  ];
  const preview: MarketplacePreviewService = {
    get: vi.fn(async () => { throw new Error("unexpected get"); }),
    query: vi.fn(async () => ({
      template_slug: "linkedin-posts",
      template_version: 1,
      sample_version: 1,
      sample_record_count: rows.length,
      matches_in_sample: rows.length,
      selected_fields: ["url", "text"],
      rows,
      masking_notice: "Values containing *** are masked.",
      page: { next_cursor: null, has_more: false },
    })),
  };
  let stored:
    | { objectKey: string; contentType: string; fileName: string; byteCount: number; checksumHex: string }
    | undefined;
  const repository: MarketplaceSampleDownloadRepository = {
    reserve: vi.fn(async (input) => {
      stored = {
        objectKey: input.objectKey,
        contentType: input.contentType,
        fileName: input.fileName,
        byteCount: input.byteCount,
        checksumHex: input.checksum.toString("hex"),
      };
      return {
        kind: "created" as const,
        record: {
          authorizationId,
          state: "reserved" as const,
          ...stored,
          recordCount: input.recordCount,
          downloadExpiresAt: null,
        },
      };
    }),
    complete: vi.fn(async () => undefined),
    fail: vi.fn(async () => true),
  };
  const store: MarketplaceSampleDownloadStore = {
    putImmutable: vi.fn(async (input) => ({
      objectKey: input.objectKey,
      contentType: input.contentType,
      fileName: input.fileName,
      byteCount: input.bytes.byteLength,
      checksumHex: createHash("sha256").update(input.bytes).digest("hex"),
      eTag: "etag",
    })),
    authorize: vi.fn(async (input) => ({
      downloadUrl: `http://127.0.0.1:10000/devstoreaccount1/dhumi-results/${stored?.objectKey}?sig=redacted`,
      expiresAt: input.expiresAt,
      transport: "loopback-http" as const,
    })),
    deleteIfMatching: vi.fn(async () => "deleted" as const),
  };
  const csrf: CsrfService = {
    issue: vi.fn(() => "csrf"),
    verify: vi.fn(() => true),
  };
  return {
    preview,
    repository,
    store,
    csrf,
    service: createMarketplaceSampleDownloadService({
      preview,
      repository,
      store,
      csrf,
      maxRecords: 100,
      maxBytes: options.oversized ? 10 : 1024 * 1024,
      rateLimitMax: 10,
      rateWindowSeconds: 3600,
      downloadTtlSeconds: 300,
      createId: () => authorizationId,
      now: () => new Date("2026-09-11T12:00:00.000Z"),
    }),
  };
}

function request(format: "json" | "csv" = "json") {
  return {
    principal,
    slug: "linkedin-posts",
    csrfToken: "valid-csrf-token-at-least-16",
    idempotencyKey: "sample-download-unit-0001",
    body: {
      expected_sample_version: 1,
      selected_fields: ["url", "text"],
      format,
      record_limit: 2,
    },
    schemaErrors: [],
    requestId: randomUUID(),
    ipFingerprint: Buffer.alloc(32, 1),
  } as const;
}

describe("M5 Marketplace stored-sample download", () => {
  it("stores, signs and audits the exact masked JSON projection", async () => {
    const context = setup();
    const response = await context.service.authorize(request());
    const write = vi.mocked(context.store.putImmutable).mock.calls[0]?.[0];
    expect(write?.bytes.toString("utf8")).toBe(`${JSON.stringify([
      { url: "https://linkedin.example/posts/1", text: "Synt***one." },
      { url: "https://linkedin.example/posts/2", text: "Synt***two." },
    ], null, 2)}\n`);
    expect(write?.objectKey).toMatch(new RegExp(`^marketplace/sample-downloads/${tenantId}/${authorizationId}/`));
    expect(response).toMatchObject({ sample_version: 1, format: "json", record_count: 2 });
    expect(response).not.toHaveProperty("object_key");
    expect(context.repository.complete).toHaveBeenCalledOnce();
  });

  it("serializes the same selected projection as RFC 4180-style CSV", async () => {
    const context = setup();
    await context.service.authorize(request("csv"));
    const bytes = vi.mocked(context.store.putImmutable).mock.calls[0]?.[0].bytes.toString("utf8");
    expect(bytes).toBe(
      "url,text\r\nhttps://linkedin.example/posts/1,Synt***one.\r\nhttps://linkedin.example/posts/2,Synt***two.\r\n",
    );
  });

  it.each([
    ["=1+2", '"\t=1+2"'],
    ["+SUM(1,2)", '"\t+SUM(1,2)"'],
    ["-1+2", '"\t-1+2"'],
    ["@SUM(1)", '"\t@SUM(1)"'],
    ["  =1+2", '"\t  =1+2"'],
    ["\t=1+2", '"\t\t=1+2"'],
    ["\r\n=1+2", '"\t\r\n=1+2"'],
    ["＝1+2", '"\t＝1+2"'],
    ['ordinary";=1+2', '"ordinary"";=1+2"'],
  ])("keeps spreadsheet formulas inert in CSV for %j", async (input, expected) => {
    const context = setup({ rows: [{ url: "https://linkedin.example/posts/1", text: input }] });
    const response = await context.service.authorize(request("csv"));
    const bytes = vi.mocked(context.store.putImmutable).mock.calls[0]?.[0].bytes;
    expect(bytes?.toString("utf8")).toBe(
      `url,text\r\nhttps://linkedin.example/posts/1,${expected}\r\n`,
    );
    expect(response.checksum).toBe(createHash("sha256").update(bytes!).digest("hex"));
  });

  it("does not change formula-like values in the JSON representation", async () => {
    const value = "=1+2";
    const context = setup({ rows: [{ url: "https://linkedin.example/posts/1", text: value }] });
    await context.service.authorize(request("json"));
    const bytes = vi.mocked(context.store.putImmutable).mock.calls[0]?.[0].bytes;
    expect(JSON.parse(bytes!.toString("utf8"))).toEqual([
      { url: "https://linkedin.example/posts/1", text: value },
    ]);
  });

  it("rejects invalid CSRF, idempotency, record ceilings and byte ceilings before disclosure", async () => {
    const invalidCsrf = setup();
    vi.mocked(invalidCsrf.csrf.verify).mockReturnValue(false);
    await expect(invalidCsrf.service.authorize(request())).rejects.toMatchObject({ status: 403 });

    const invalidInput = setup();
    await expect(invalidInput.service.authorize({
      ...request(), idempotencyKey: "short", body: { ...request().body, record_limit: 101 },
    })).rejects.toMatchObject({ status: 422 });

    const oversized = setup({ oversized: true });
    await expect(oversized.service.authorize(request())).rejects.toMatchObject({ status: 413 });
    expect(oversized.repository.reserve).not.toHaveBeenCalled();
  });

  it("maps tenant rate limiting to 429 without storage or signing", async () => {
    const context = setup();
    vi.mocked(context.repository.reserve).mockRejectedValue(new MarketplaceSampleDownloadRateLimitedError());
    await expect(context.service.authorize(request())).rejects.toMatchObject({ status: 429 });
    expect(context.store.putImmutable).not.toHaveBeenCalled();
  });

  it("re-signs an exact authorized idempotent replay without a second completion audit", async () => {
    const context = setup();
    vi.mocked(context.repository.reserve).mockResolvedValue({
      kind: "replay",
      record: {
        authorizationId,
        state: "authorized",
        objectKey: `marketplace/sample-downloads/${tenantId}/${authorizationId}/${"a".repeat(64)}.json`,
        contentType: "application/json; charset=utf-8",
        fileName: "linkedin-posts-sample-v1.json",
        byteCount: 200,
        checksumHex: "a".repeat(64),
        recordCount: 2,
        downloadExpiresAt: expiresAt,
      },
    });
    const response = await context.service.authorize(request());
    expect(response.record_count).toBe(2);
    expect(context.store.putImmutable).not.toHaveBeenCalled();
    expect(context.repository.complete).not.toHaveBeenCalled();
    expect(context.store.authorize).toHaveBeenCalledOnce();
    expect(context.store.authorize).toHaveBeenCalledWith(expect.objectContaining({
      expiresAt,
      maxTtlSeconds: 300,
    }));
  });

  it("rejects an expired idempotent replay instead of extending its audited URL window", async () => {
    const context = setup();
    vi.mocked(context.repository.reserve).mockResolvedValue({
      kind: "replay",
      record: {
        authorizationId,
        state: "authorized",
        objectKey: `marketplace/sample-downloads/${tenantId}/${authorizationId}/${"a".repeat(64)}.json`,
        contentType: "application/json; charset=utf-8",
        fileName: "linkedin-posts-sample-v1.json",
        byteCount: 200,
        checksumHex: "a".repeat(64),
        recordCount: 2,
        downloadExpiresAt: new Date("2026-09-11T11:59:59.000Z"),
      },
    });
    await expect(context.service.authorize(request())).rejects.toMatchObject({ status: 409 });
    expect(context.store.authorize).not.toHaveBeenCalled();
    expect(context.repository.complete).not.toHaveBeenCalled();
  });

  it("fails closed if durable audit completion fails after signing", async () => {
    const context = setup();
    vi.mocked(context.repository.complete).mockRejectedValue(new Error("audit failed"));
    await expect(context.service.authorize(request())).rejects.toMatchObject({ status: 503 });
    expect(context.repository.fail).toHaveBeenCalledOnce();
    expect(context.store.deleteIfMatching).toHaveBeenCalledWith({
      tenantId,
      authorizationId,
      receipt: expect.objectContaining({
        objectKey: expect.stringContaining(`/${tenantId}/${authorizationId}/`),
        checksumHex: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    });
  });

  it("preserves the object when completion committed but its acknowledgement was lost", async () => {
    const context = setup();
    vi.mocked(context.repository.complete).mockRejectedValue(new Error("commit response lost"));
    vi.mocked(context.repository.fail).mockResolvedValue(false);
    await expect(context.service.authorize(request())).rejects.toMatchObject({ status: 503 });
    expect(context.store.deleteIfMatching).not.toHaveBeenCalled();
  });

  it("leaves an uncertain database outcome for reconciliation instead of blindly deleting", async () => {
    const context = setup();
    vi.mocked(context.repository.complete).mockRejectedValue(new Error("database unavailable"));
    vi.mocked(context.repository.fail).mockRejectedValue(new Error("database unavailable"));
    await expect(context.service.authorize(request())).rejects.toMatchObject({ status: 503 });
    expect(context.store.deleteIfMatching).not.toHaveBeenCalled();
  });

  it("cleans up an upload whose acknowledgement was lost using the reserved exact receipt", async () => {
    const context = setup();
    vi.mocked(context.store.putImmutable).mockRejectedValue(new Error("upload response lost"));
    await expect(context.service.authorize(request())).rejects.toMatchObject({ status: 503 });
    expect(context.store.deleteIfMatching).toHaveBeenCalledOnce();
    expect(context.repository.complete).not.toHaveBeenCalled();
  });

  it("does not disclose a URL if immediate cleanup also fails", async () => {
    const context = setup();
    vi.mocked(context.repository.complete).mockRejectedValue(new Error("completion failed"));
    vi.mocked(context.store.deleteIfMatching).mockRejectedValue(new Error("storage unavailable"));
    await expect(context.service.authorize(request())).rejects.toMatchObject({ status: 503 });
    expect(context.store.deleteIfMatching).toHaveBeenCalledOnce();
  });

  it("also cleans up a stale completion while preserving the customer-safe 409", async () => {
    const context = setup();
    vi.mocked(context.repository.complete).mockRejectedValue(new MarketplaceSampleDownloadStaleError());
    await expect(context.service.authorize(request())).rejects.toMatchObject({ status: 409 });
    expect(context.store.deleteIfMatching).toHaveBeenCalledOnce();
  });

  it("does not attempt cleanup when reservation never succeeded", async () => {
    const context = setup();
    vi.mocked(context.repository.reserve).mockRejectedValue(new Error("database unavailable"));
    await expect(context.service.authorize(request())).rejects.toMatchObject({ status: 503 });
    expect(context.repository.fail).not.toHaveBeenCalled();
    expect(context.store.deleteIfMatching).not.toHaveBeenCalled();
  });
});
