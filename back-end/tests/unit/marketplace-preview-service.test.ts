import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CsrfService } from "../../src/helpers/csrf.js";
import type {
  MarketplacePreviewManifest,
  MarketplacePreviewRepository,
} from "../../src/services/marketplacePreview/marketplacePreviewRepository.js";
import {
  createMarketplacePreviewService,
} from "../../src/services/marketplacePreview/marketplacePreviewService.js";
import type { MarketplaceSampleStore } from
  "../../src/services/marketplaceSample/marketplaceSampleStore.js";
import type { TrustedTenantPrincipal } from
  "../../src/services/tenantAccess/trustedTenantPrincipal.js";

const principal: TrustedTenantPrincipal = {
  kind: "browser",
  userId: randomUUID(),
  sessionId: randomUUID(),
  tenantId: randomUUID(),
};

const sampleBytes = Buffer.from(JSON.stringify([
  {
    url: "https://www.linkedin.com/posts/dhumi-synthetic-post-001",
    text: "Synthetic LinkedIn Posts sample record one.",
  },
  {
    url: "https://www.linkedin.com/posts/dhumi-synthetic-post-002",
    text: "Synthetic LinkedIn Posts sample record two.",
  },
]), "utf8");

const manifest: MarketplacePreviewManifest = {
  templateSlug: "linkedin-posts",
  templateVersion: 1,
  sampleVersion: 1,
  sampleRecordCount: 2,
  sampleByteCount: sampleBytes.byteLength,
  sampleChecksumHex: createHash("sha256").update(sampleBytes).digest("hex"),
  sampleObjectKey:
    `marketplace/samples/${randomUUID()}/1/${"a".repeat(64)}.json`,
  collectedAt: new Date("2026-09-11T00:00:00.000Z"),
  expiresAt: new Date("2026-10-11T00:00:00.000Z"),
  fields: [
    {
      name: "url",
      type: "url",
      active: true,
      required: true,
      description: "LinkedIn post URL",
      sampleVisibility: "visible",
      allowedOperators: ["=", "!=", "in", "not_in", "includes", "not_includes"],
    },
    {
      name: "text",
      type: "text",
      active: true,
      required: false,
      description: "LinkedIn post text",
      sampleVisibility: "masked",
      allowedOperators: ["=", "!=", "in", "not_in", "includes", "not_includes"],
    },
  ],
};

function dependencies() {
  const repository: MarketplacePreviewRepository = {
    resolve: vi.fn(async () => manifest),
  };
  const store: MarketplaceSampleStore = {
    putImmutable: vi.fn(async () => { throw new Error("unexpected write"); }),
    deleteAndVerify: vi.fn(async () => { throw new Error("unexpected delete"); }),
    open: vi.fn(async () => ({
      receipt: {
        objectKey: manifest.sampleObjectKey,
        contentType: "application/json",
        byteCount: sampleBytes.byteLength,
        checksumHex: manifest.sampleChecksumHex,
        eTag: "fixture-etag",
      },
      bytes: sampleBytes,
    })),
  };
  const csrf: CsrfService = {
    issue: vi.fn(() => "csrf-token"),
    verify: vi.fn(() => true),
  };
  return { repository, store, csrf };
}

describe("M4 stored Marketplace sample query", () => {
  it("returns deterministic rows while masking only the reviewed masked field", async () => {
    const deps = dependencies();
    const service = createMarketplacePreviewService({
      ...deps,
      cursorSecret: "m4-test-cursor-secret-at-least-32-characters",
      maxBytes: 1024 * 1024,
    });

    const result = await service.get({
      principal,
      slug: "linkedin-posts",
      cursor: undefined,
      limit: "1",
      schemaErrors: [],
    });

    expect(result.template_slug).toBe("linkedin-posts");
    expect(result.sample_record_count).toBe(2);
    expect(result.matches_in_sample).toBe(2);
    expect(result.selected_fields).toEqual(["url", "text"]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.url).toBe(
      "https://www.linkedin.com/posts/dhumi-synthetic-post-001",
    );
    expect(result.rows[0]?.text).toContain("***");
    expect(result.rows[0]?.text).not.toBe(
      "Synthetic LinkedIn Posts sample record one.",
    );
    expect(result.masking_notice).toMatch(/masked/i);
    expect(result.page.has_more).toBe(true);
    expect(result.page.next_cursor).toEqual(expect.any(String));

    expect(deps.store.putImmutable).not.toHaveBeenCalled();
    expect(deps.store.deleteAndVerify).not.toHaveBeenCalled();
  });

  it("filters visible stored values, projects masked fields, and keeps counts sample-relative", async () => {
    const service = createMarketplacePreviewService({
      ...dependencies(),
      cursorSecret: "m4-test-cursor-secret-at-least-32-characters",
      maxBytes: 1024 * 1024,
    });

    const result = await service.query({
      principal,
      slug: "linkedin-posts",
      csrfToken: "valid-csrf-token",
      body: {
        expected_sample_version: 1,
        selected_fields: ["text"],
        filter: { name: "url", operator: "includes", value: "002" },
        page: { limit: 30 },
      },
      schemaErrors: [],
    });

    expect(result.sample_record_count).toBe(2);
    expect(result.matches_in_sample).toBe(1);
    expect(result.selected_fields).toEqual(["text"]);
    expect(result.rows).toEqual([{ text: expect.stringContaining("***") }]);
  });

  it("rejects filtering and sorting on a pre-purchase masked field", async () => {
    const service = createMarketplacePreviewService({
      ...dependencies(),
      cursorSecret: "m4-test-cursor-secret-at-least-32-characters",
      maxBytes: 1024 * 1024,
    });

    await expect(service.query({
      principal,
      slug: "linkedin-posts",
      csrfToken: "valid-csrf-token",
      body: {
        expected_sample_version: 1,
        selected_fields: ["text"],
        filter: { name: "text", operator: "includes", value: "two" },
        page: { limit: 30 },
      },
      schemaErrors: [],
    })).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });

    await expect(service.query({
      principal,
      slug: "linkedin-posts",
      csrfToken: "valid-csrf-token",
      body: {
        expected_sample_version: 1,
        selected_fields: ["text"],
        sort: [{ field: "text", direction: "asc" }],
        page: { limit: 30 },
      },
      schemaErrors: [],
    })).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
  });

  it("rejects stale versions, unknown fields, unsupported operators and tampered cursors", async () => {
    const service = createMarketplacePreviewService({
      ...dependencies(),
      cursorSecret: "m4-test-cursor-secret-at-least-32-characters",
      maxBytes: 1024 * 1024,
    });

    await expect(service.query({
      principal,
      slug: "linkedin-posts",
      csrfToken: "valid-csrf-token",
      body: {
        expected_sample_version: 2,
        selected_fields: ["url"],
        page: { limit: 30 },
      },
      schemaErrors: [],
    })).rejects.toMatchObject({ status: 409, code: "STATE_CONFLICT" });

    await expect(service.query({
      principal,
      slug: "linkedin-posts",
      csrfToken: "valid-csrf-token",
      body: {
        expected_sample_version: 1,
        selected_fields: ["unreviewed"],
        page: { limit: 30 },
      },
      schemaErrors: [],
    })).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });

    await expect(service.query({
      principal,
      slug: "linkedin-posts",
      csrfToken: "valid-csrf-token",
      body: {
        expected_sample_version: 1,
        selected_fields: ["url"],
        filter: { name: "url", operator: ">", value: "x" },
        page: { limit: 30 },
      },
      schemaErrors: [],
    })).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });

    await expect(service.get({
      principal,
      slug: "linkedin-posts",
      cursor: "tampered.cursor",
      limit: "30",
      schemaErrors: [],
    })).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
  });

  it("requires a valid CSRF token only for browser POST queries", async () => {
    const deps = dependencies();
    vi.mocked(deps.csrf.verify).mockReturnValue(false);
    const service = createMarketplacePreviewService({
      ...deps,
      cursorSecret: "m4-test-cursor-secret-at-least-32-characters",
      maxBytes: 1024 * 1024,
    });

    await expect(service.query({
      principal,
      slug: "linkedin-posts",
      csrfToken: "invalid-csrf-token",
      body: {
        expected_sample_version: 1,
        selected_fields: ["url"],
        page: { limit: 30 },
      },
      schemaErrors: [],
    })).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });
  });
});
