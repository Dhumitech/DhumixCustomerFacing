import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  apiKeyActorFingerprint,
  apiKeyEnvelopeAad,
  apiKeyRequestHash,
  canonicalizeApiKeyCreate,
} from "../../src/helpers/apiKeyCanonicalization.js";
import {
  apiKeyHashMatches,
  createApiKeyMaterial,
  parseApiKeyCredential,
} from "../../src/helpers/apiKeyMaterial.js";
import {
  ResponseEnvelopeError,
  createLocalResponseEnvelope,
} from "../../src/helpers/responseEnvelope.js";

describe("API-key material and canonicalization", () => {
  it("creates the accepted versioned format and hashes the complete credential", () => {
    let call = 0;
    const material = createApiKeyMaterial((size) => {
      call += 1;
      return Buffer.alloc(size, call);
    });

    expect(material.prefix).toMatch(/^dhk_v1_[A-Za-z0-9_-]{16}$/);
    expect(material.secret).toMatch(/^dhk_v1_[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/);
    expect(material.secret.startsWith(`${material.prefix}.`)).toBe(true);
    expect(material.hash).toEqual(
      createHash("sha256").update(material.secret, "utf8").digest(),
    );
    expect(parseApiKeyCredential(material.secret)).toEqual({
      prefix: material.prefix,
      hash: material.hash,
    });
    expect(apiKeyHashMatches(material.hash, material.hash)).toBe(true);
  });

  it("rejects non-canonical API-key serialization and verifier material", () => {
    const material = createApiKeyMaterial((size) => Buffer.alloc(size, 9));
    const [prefix, secretPart] = material.secret.split(".") as [string, string];

    for (const candidate of [
      material.secret.toUpperCase(),
      `${material.secret}=`,
      `${material.secret}.extra`,
      `${prefix.slice(0, -1)}!.${secretPart}`,
      `${prefix}.${secretPart.slice(0, -1)}!`,
      `${prefix}.${secretPart.slice(0, -1)}B`,
    ]) {
      expect(parseApiKeyCredential(candidate)).toBeUndefined();
    }

    expect(apiKeyHashMatches(material.hash, undefined)).toBe(false);
    expect(apiKeyHashMatches(material.hash, Buffer.alloc(31))).toBe(false);
    expect(apiKeyHashMatches(material.hash, Buffer.alloc(32))).toBe(false);
  });

  it("trims names, sorts scopes and canonicalizes equivalent expiry instants", () => {
    const result = canonicalizeApiKeyCreate(
      {
        name: "  CI key  ",
        scopes: ["runs:write", "catalog:read"],
        expires_at: "2027-01-01T05:30:00+05:30",
      },
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(result).toMatchObject({
      valid: true,
      value: { name: "CI key", scopes: ["catalog:read", "runs:write"] },
    });
    if (!result.valid) throw new Error("canonicalization unexpectedly failed");
    expect(result.value.expiresAt?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(apiKeyRequestHash(result.value)).toHaveLength(32);
    expect(apiKeyActorFingerprint("user-id")).toHaveLength(32);
  });

  it("rejects duplicate/unknown scopes and non-future expiry", () => {
    const result = canonicalizeApiKeyCreate(
      {
        name: " ",
        scopes: ["runs:read", "runs:read", "admin:*"],
        expires_at: "2025-01-01T00:00:00Z",
      },
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(result).toMatchObject({
      valid: false,
      issues: [
        { field: "name" },
        { field: "scopes" },
        { field: "expires_at" },
      ],
    });
  });
});

describe("local response envelope", () => {
  const key = Buffer.alloc(32, 7).toString("base64url");
  const context = apiKeyEnvelopeAad({
    tenantId: "11111111-1111-4111-8111-111111111111",
    idempotencyRecordId: "22222222-2222-4222-8222-222222222222",
    apiKeyId: "33333333-3333-4333-8333-333333333333",
  });

  it("round-trips only with the authenticated Tenant/operation/resource context", async () => {
    const envelope = createLocalResponseEnvelope("test", key);
    const sealed = await envelope.seal(Buffer.from("one-time-secret", "utf8"), context);

    await expect(
      envelope.open(sealed.ciphertext, sealed.keyReference, context),
    ).resolves.toEqual(Buffer.from("one-time-secret", "utf8"));
    await expect(
      envelope.open(sealed.ciphertext, sealed.keyReference, Buffer.from("wrong", "utf8")),
    ).rejects.toBeInstanceOf(ResponseEnvelopeError);

    const tampered = Buffer.from(sealed.ciphertext);
    const finalIndex = tampered.length - 1;
    tampered[finalIndex] = (tampered[finalIndex] ?? 0) ^ 1;
    await expect(
      envelope.open(tampered, sealed.keyReference, context),
    ).rejects.toBeInstanceOf(ResponseEnvelopeError);
  });

  it("fails closed for unknown versions/references and in production", async () => {
    const envelope = createLocalResponseEnvelope("development", key);
    const sealed = await envelope.seal(Buffer.from("payload"), context);
    await expect(envelope.open(sealed.ciphertext, "local:v2", context)).rejects.toBeInstanceOf(
      ResponseEnvelopeError,
    );
    expect(() => createLocalResponseEnvelope("production", key)).toThrow(
      /forbidden in production/,
    );
  });
});
