import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/helpers/canonicalJson.js";
import {
  canonicalizeServiceCreate,
  serviceActorFingerprint,
  serviceRequestHash,
} from "../../src/helpers/serviceCanonicalization.js";
import { canonicalRequestHash } from "../../src/helpers/signupCanonicalization.js";

describe("Service canonicalization", () => {
  it("sorts object keys recursively while preserving array order", () => {
    expect(canonicalJson({ z: 1, a: { y: [2, { b: true, a: false }], x: null } })).toBe(
      '{"a":{"x":null,"y":[2,{"a":false,"b":true}]},"z":1}',
    );
  });

  it("preserves the established signup hash after extracting canonical JSON", () => {
    expect(
      canonicalRequestHash({
        emailNormalized: "user@example.com",
        workspaceName: "Dhumi Workspace",
        legalAcceptances: [
          { documentType: "terms", documentVersion: "2026-01", contentHash: "A".repeat(64) },
          { documentType: "privacy", documentVersion: "2026-02", contentHash: "B".repeat(64) },
        ],
      }).toString("hex"),
    ).toBe("4ec2ebb0ba41ca0573eb36e8bc6c3b86832bcc7cd6290b61c54037a81dcff716");
  });

  it("keeps exact names, rejects whitespace-only names, and hashes object order identically", () => {
    const first = canonicalizeServiceCreate({
      template_slug: "marketplace-products",
      name: "  Exact customer name  ",
      configuration: { z: 1, nested: { b: 2, a: 1 } },
    });
    const second = canonicalizeServiceCreate({
      template_slug: "marketplace-products",
      name: "  Exact customer name  ",
      configuration: { nested: { a: 1, b: 2 }, z: 1 },
    });
    expect(first.valid && first.value.name).toBe("  Exact customer name  ");
    expect(first.valid && second.valid && serviceRequestHash(first.value).equals(serviceRequestHash(second.value))).toBe(true);
    expect(canonicalizeServiceCreate({
      template_slug: "marketplace-products",
      name: " \t ",
      configuration: {},
    })).toMatchObject({ valid: false });
  });

  it("separates browser and API-key actor fingerprints", () => {
    const tenantId = "11111111-1111-4111-8111-111111111111";
    const browser = serviceActorFingerprint({
      kind: "browser",
      tenantId,
      userId: "22222222-2222-4222-8222-222222222222",
      sessionId: "33333333-3333-4333-8333-333333333333",
    });
    const apiKey = serviceActorFingerprint({
      kind: "api_key",
      tenantId,
      apiKeyId: "22222222-2222-4222-8222-222222222222",
      scopes: ["services:write"],
    });
    expect(browser.equals(apiKey)).toBe(false);
  });
});
