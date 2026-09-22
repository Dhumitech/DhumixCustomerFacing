import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ProviderReferenceProtectionError,
  createLocalProviderReferenceProtector,
} from "../../src/services/brightdata/providerReferenceProtector.js";

const context = Buffer.from(
  "provider-mapping:11111111-1111-4111-8111-111111111111",
  "utf8",
);

describe("LocalProviderReferenceProtector", () => {
  it("round-trips a private provider identifier and produces a keyed fingerprint", async () => {
    const protector = createLocalProviderReferenceProtector(
      "test",
      randomBytes(32).toString("base64url"),
    );

    const sealed = await protector.protect("gd_private_provider_identifier", context);

    expect(sealed.ciphertext.toString("utf8")).not.toContain("gd_private");
    expect(sealed.fingerprint).toHaveLength(32);
    await expect(
      protector.reveal(sealed.ciphertext, sealed.fingerprint, context),
    ).resolves.toBe("gd_private_provider_identifier");
  });

  it("rejects copied or tampered ciphertext without disclosing the value", async () => {
    const protector = createLocalProviderReferenceProtector(
      "development",
      randomBytes(32).toString("base64url"),
    );
    const sealed = await protector.protect("s_private_snapshot", context);
    const tampered = Buffer.from(sealed.ciphertext);
    const finalByte = tampered.length - 1;
    tampered[finalByte] = (tampered[finalByte] ?? 0) ^ 1;

    await expect(
      protector.reveal(tampered, sealed.fingerprint, context),
    ).rejects.toBeInstanceOf(ProviderReferenceProtectionError);
    await expect(
      protector.reveal(
        sealed.ciphertext,
        sealed.fingerprint,
        Buffer.from("different-context", "utf8"),
      ),
    ).rejects.toBeInstanceOf(ProviderReferenceProtectionError);
  });

  it("rejects fingerprint mismatch and production use", async () => {
    const key = randomBytes(32).toString("base64url");
    const protector = createLocalProviderReferenceProtector("test", key);
    const sealed = await protector.protect("gd_private", context);

    await expect(
      protector.reveal(sealed.ciphertext, Buffer.alloc(32), context),
    ).rejects.toBeInstanceOf(ProviderReferenceProtectionError);
    expect(() => createLocalProviderReferenceProtector("production", key)).toThrow(
      /forbidden in production/,
    );
  });
});
