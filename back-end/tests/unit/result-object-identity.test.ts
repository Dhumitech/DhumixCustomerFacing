import { describe, expect, it } from "vitest";
import {
  createResultObjectKey,
  isResultObjectKeyForRun,
} from "../../src/services/storage/resultObjectIdentity.js";

const identity = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  runId: "22222222-2222-4222-8222-222222222222",
  attemptId: "33333333-3333-4333-8333-333333333333",
  kind: "normalized",
  artifactVersion: 1,
} as const;

describe("result object identity", () => {
  it("derives one deterministic server-owned key from immutable IDs", () => {
    const key = createResultObjectKey(identity);

    expect(key).toBe(
      "tenants/11111111-1111-4111-8111-111111111111/" +
        "runs/22222222-2222-4222-8222-222222222222/" +
        "attempts/33333333-3333-4333-8333-333333333333/normalized/v1/result",
    );
    expect(isResultObjectKeyForRun(key, identity.tenantId, identity.runId)).toBe(true);
  });

  it("rejects invalid identifiers, unsupported kinds, and unsafe versions", () => {
    expect(() => createResultObjectKey({ ...identity, tenantId: "../escape" })).toThrow(
      /tenantId/,
    );
    expect(() =>
      createResultObjectKey({ ...identity, kind: "manifest" as "normalized" }),
    ).toThrow(/kind/);
    expect(() => createResultObjectKey({ ...identity, artifactVersion: 0 })).toThrow(
      /artifactVersion/,
    );
  });

  it("does not accept another Tenant, Run, or a prefix-only lookalike", () => {
    const key = createResultObjectKey(identity);
    expect(
      isResultObjectKeyForRun(
        key,
        "44444444-4444-4444-8444-444444444444",
        identity.runId,
      ),
    ).toBe(false);
    expect(
      isResultObjectKeyForRun(
        `${key}/unexpected`,
        identity.tenantId,
        identity.runId,
      ),
    ).toBe(false);
  });
});
