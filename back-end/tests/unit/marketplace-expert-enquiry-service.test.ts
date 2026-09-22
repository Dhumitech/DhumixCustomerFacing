import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CsrfService } from "../../src/helpers/csrf.js";
import {
  MarketplaceExpertEnquiryNotFoundError,
  MarketplaceExpertEnquiryPersistenceError,
  MarketplaceExpertEnquiryStaleError,
  type MarketplaceExpertEnquiryRepository,
} from "../../src/services/marketplaceExpertEnquiry/marketplaceExpertEnquiryRepository.js";
import { createMarketplaceExpertEnquiryService } from
  "../../src/services/marketplaceExpertEnquiry/marketplaceExpertEnquiryService.js";
import type { TrustedTenantPrincipal } from
  "../../src/services/tenantAccess/trustedTenantPrincipal.js";

const tenantId = randomUUID();
const userId = randomUUID();
const enquiryId = randomUUID();
const submittedAt = new Date("2026-09-12T10:00:00.000Z");
const principal: TrustedTenantPrincipal = {
  kind: "browser",
  userId,
  sessionId: randomUUID(),
  tenantId,
};

function setup() {
  const repository: MarketplaceExpertEnquiryRepository = {
    create: vi.fn(async () => ({
      kind: "created" as const,
      record: {
        enquiryId,
        templateSlug: "linkedin-posts",
        templateVersion: 1,
        state: "received" as const,
        submittedAt,
      },
    })),
  };
  const csrf: CsrfService = {
    issue: vi.fn(() => "csrf"),
    verify: vi.fn(() => true),
  };
  return {
    repository,
    csrf,
    service: createMarketplaceExpertEnquiryService({
      repository,
      csrf,
      createId: () => enquiryId,
    }),
  };
}

function request() {
  return {
    principal,
    slug: "linkedin-posts",
    csrfToken: "valid-csrf-token-at-least-16",
    idempotencyKey: "expert-enquiry-unit-0001",
    body: { expected_template_version: 1 },
    schemaErrors: [],
    requestId: randomUUID(),
    ipFingerprint: Buffer.alloc(32, 1),
  } as const;
}

describe("M6 Marketplace expert enquiry", () => {
  it("creates a Tenant-bound request without any execution dependency", async () => {
    const context = setup();
    const result = await context.service.submit(request());

    expect(result).toEqual({
      id: enquiryId,
      template_slug: "linkedin-posts",
      template_version: 1,
      state: "received",
      submitted_at: submittedAt.toISOString(),
    });
    expect(context.repository.create).toHaveBeenCalledWith(expect.objectContaining({
      enquiryId,
      tenantId,
      actor: { kind: "browser", userId },
      idempotencyKey: "expert-enquiry-unit-0001",
      templateSlug: "linkedin-posts",
      expectedTemplateVersion: 1,
    }));
  });

  it("returns the durable record for exact idempotent replay or an existing open request", async () => {
    for (const kind of ["replay", "existing"] as const) {
      const context = setup();
      vi.mocked(context.repository.create).mockResolvedValue({
        kind,
        record: {
          enquiryId,
          templateSlug: "linkedin-posts",
          templateVersion: 1,
          state: "in_review",
          submittedAt,
        },
      });
      await expect(context.service.submit(request())).resolves.toMatchObject({
        id: enquiryId,
        state: "in_review",
      });
    }
  });

  it("rejects invalid CSRF, idempotency and immutable version input before persistence", async () => {
    const invalidCsrf = setup();
    vi.mocked(invalidCsrf.csrf.verify).mockReturnValue(false);
    await expect(invalidCsrf.service.submit(request())).rejects.toMatchObject({ status: 403 });
    expect(invalidCsrf.repository.create).not.toHaveBeenCalled();

    const invalidInput = setup();
    await expect(invalidInput.service.submit({
      ...request(),
      idempotencyKey: "short",
      body: { expected_template_version: 0 },
    })).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
    expect(invalidInput.repository.create).not.toHaveBeenCalled();
  });

  it("maps conflict, missing/stale catalogue state and persistence failures safely", async () => {
    const conflict = setup();
    vi.mocked(conflict.repository.create).mockResolvedValue({ kind: "conflict" });
    await expect(conflict.service.submit(request())).rejects.toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
    });

    const missing = setup();
    vi.mocked(missing.repository.create).mockRejectedValue(new MarketplaceExpertEnquiryNotFoundError());
    await expect(missing.service.submit(request())).rejects.toMatchObject({ status: 404 });

    const stale = setup();
    vi.mocked(stale.repository.create).mockRejectedValue(new MarketplaceExpertEnquiryStaleError());
    await expect(stale.service.submit(request())).rejects.toMatchObject({ status: 409 });

    const failed = setup();
    vi.mocked(failed.repository.create).mockRejectedValue(new MarketplaceExpertEnquiryPersistenceError());
    await expect(failed.service.submit(request())).rejects.toMatchObject({ status: 503 });
  });
});
