import { describe, expect, it } from "vitest";
import type { LegalRuntimeConfig } from "../../src/config/environment.js";
import { validateLegalAcceptances } from "../../src/helpers/legalAcceptance.js";
import type { SubmittedLegalAcceptance } from "../../src/helpers/legalAcceptance.js";
import { createPasswordHasher, readEncodedParameters } from "../../src/helpers/password.js";
import {
  actorFingerprint,
  canonicalRequestHash,
  normalizeEmail,
} from "../../src/helpers/signupCanonicalization.js";

const BASELINE = { memoryKib: 19_456, timeCost: 2, parallelism: 1 } as const;

const TERMS_HASH = "a".repeat(64);
const PRIVACY_HASH = "b".repeat(64);
const USE_HASH = "c".repeat(64);

function legalConfig(documents: LegalRuntimeConfig["documents"]): LegalRuntimeConfig {
  return {
    documents,
    requiredDocumentTypes: [...new Set(documents.map((d) => d.documentType))].sort(),
    disclosureVersion: null,
  };
}

const FULL_CATALOGUE = legalConfig([
  { documentType: "terms", documentVersion: "v1", contentHash: TERMS_HASH },
  { documentType: "privacy", documentVersion: "v1", contentHash: PRIVACY_HASH },
  { documentType: "acceptable_use", documentVersion: "v1", contentHash: USE_HASH },
]);

function acceptance(
  type: string,
  version: string,
  contentHash: string,
): SubmittedLegalAcceptance {
  return {
    document_type: type,
    document_version: version,
    content_hash: contentHash,
    accepted: true,
  };
}

function allThree(): SubmittedLegalAcceptance[] {
  return [
    acceptance("terms", "v1", TERMS_HASH),
    acceptance("privacy", "v1", PRIVACY_HASH),
    acceptance("acceptable_use", "v1", USE_HASH),
  ];
}

describe("normalizeEmail", () => {
  it("trims and lower-cases so the database check constraint holds", () => {
    const normalized = normalizeEmail("  Customer@Example.TEST  ");
    expect(normalized).toBe("customer@example.test");
    expect(normalized).toBe(normalized.toLowerCase());
  });

  it("preserves dots and plus-tags", () => {
    expect(normalizeEmail("first.last+dhumi@example.test")).toBe(
      "first.last+dhumi@example.test",
    );
  });
});

describe("canonicalRequestHash", () => {
  const base = {
    emailNormalized: "customer@example.test",
    workspaceName: "Acme",
    legalAcceptances: [
      { documentType: "terms", documentVersion: "v1", contentHash: TERMS_HASH },
      { documentType: "privacy", documentVersion: "v1", contentHash: PRIVACY_HASH },
    ],
  };

  it("is stable for the same request", () => {
    expect(canonicalRequestHash(base)).toEqual(canonicalRequestHash(base));
  });

  it("ignores the order of legal acceptances", () => {
    const reordered = { ...base, legalAcceptances: [...base.legalAcceptances].reverse() };
    expect(canonicalRequestHash(reordered)).toEqual(canonicalRequestHash(base));
  });

  it("ignores the deprecated workspace name", () => {
    const changed = { ...base, workspaceName: "Acme Two" };
    expect(canonicalRequestHash(changed)).toEqual(canonicalRequestHash(base));
  });

  it("changes when an accepted document version changes", () => {
    const changed = {
      ...base,
      legalAcceptances: [
        { documentType: "terms", documentVersion: "v2", contentHash: TERMS_HASH },
        base.legalAcceptances[1] as (typeof base.legalAcceptances)[number],
      ],
    };
    expect(canonicalRequestHash(changed)).not.toEqual(canonicalRequestHash(base));
  });

  it("produces a 32 byte digest", () => {
    expect(canonicalRequestHash(base)).toHaveLength(32);
  });
});

describe("actorFingerprint", () => {
  it("is stable and 32 bytes", () => {
    const fingerprint = actorFingerprint("customer@example.test");
    expect(fingerprint).toHaveLength(32);
    expect(fingerprint).toEqual(actorFingerprint("customer@example.test"));
  });

  it("differs between identities", () => {
    expect(actorFingerprint("one@example.test")).not.toEqual(
      actorFingerprint("two@example.test"),
    );
  });

  it("does not contain the address in clear", () => {
    expect(actorFingerprint("customer@example.test").toString("utf8")).not.toContain(
      "customer@example.test",
    );
  });
});

describe("password hashing", () => {
  const hasher = createPasswordHasher(BASELINE);

  it("produces an Argon2id hash carrying the configured parameters", async () => {
    const encoded = await hasher.hash("correct horse battery staple");

    expect(encoded.startsWith("$argon2id$")).toBe(true);
    expect(readEncodedParameters(encoded)).toEqual({
      memoryKib: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
  });

  it("salts, so the same password hashes differently every time", async () => {
    const first = await hasher.hash("correct horse battery staple");
    const second = await hasher.hash("correct horse battery staple");
    expect(first).not.toBe(second);
  });

  it("verifies a correct password and rejects a wrong one", async () => {
    const encoded = await hasher.hash("correct horse battery staple");
    expect(await hasher.verify(encoded, "correct horse battery staple")).toBe(true);
    expect(await hasher.verify(encoded, "wrong password entirely")).toBe(false);
  });

  it("returns false rather than throwing on a malformed stored hash", async () => {
    expect(await hasher.verify("not-a-hash", "anything")).toBe(false);
    expect(await hasher.verify("", "anything")).toBe(false);
  });

  it("does not need a rehash at the configured cost", async () => {
    const encoded = await hasher.hash("correct horse battery staple");
    expect(hasher.needsRehash(encoded)).toBe(false);
  });

  it("needs a rehash once the configured cost is raised", async () => {
    const encoded = await hasher.hash("correct horse battery staple");
    const stronger = createPasswordHasher({ ...BASELINE, memoryKib: 65_536 });
    expect(stronger.needsRehash(encoded)).toBe(true);
  });

  it("treats an unreadable hash as needing a rehash", () => {
    expect(hasher.needsRehash("$2b$12$legacybcryptvalue")).toBe(true);
  });
});

describe("validateLegalAcceptances", () => {
  it("accepts a complete, matching submission", () => {
    const result = validateLegalAcceptances(FULL_CATALOGUE, allThree());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.accepted).toHaveLength(3);
    }
  });

  it("rejects a submission missing a required document", () => {
    const partial = allThree().filter((entry) => entry.document_type !== "privacy");
    const result = validateLegalAcceptances(FULL_CATALOGUE, partial);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.message.includes("privacy"))).toBe(true);
    }
  });

  it("rejects a document version that is not in the catalogue", () => {
    const wrongVersion = allThree();
    wrongVersion[0] = acceptance("terms", "v99", TERMS_HASH);

    const result = validateLegalAcceptances(FULL_CATALOGUE, wrongVersion);
    expect(result.ok).toBe(false);
  });

  it("rejects a content hash that does not match the approved document", () => {
    const wrongHash = allThree();
    wrongHash[0] = acceptance("terms", "v1", "d".repeat(64));

    const result = validateLegalAcceptances(FULL_CATALOGUE, wrongHash);
    expect(result.ok).toBe(false);
  });

  it("rejects the same document type submitted twice", () => {
    const duplicated = [...allThree(), acceptance("terms", "v1", TERMS_HASH)];

    const result = validateLegalAcceptances(FULL_CATALOGUE, duplicated);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.message.includes("more than once"))).toBe(
        true,
      );
    }
  });

  it("accepts either version when the catalogue carries two", () => {
    const twoVersions = legalConfig([
      { documentType: "terms", documentVersion: "v1", contentHash: TERMS_HASH },
      { documentType: "terms", documentVersion: "v2", contentHash: PRIVACY_HASH },
    ]);

    expect(validateLegalAcceptances(twoVersions, [acceptance("terms", "v1", TERMS_HASH)]).ok).toBe(
      true,
    );
    expect(
      validateLegalAcceptances(twoVersions, [acceptance("terms", "v2", PRIVACY_HASH)]).ok,
    ).toBe(true);
  });

  it("compares content hashes without case sensitivity", () => {
    const upper = allThree();
    upper[0] = acceptance("terms", "v1", TERMS_HASH.toUpperCase());

    expect(validateLegalAcceptances(FULL_CATALOGUE, upper).ok).toBe(true);
  });

  it("skips matching when the catalogue is empty, which production forbids", () => {
    const empty = legalConfig([]);
    const result = validateLegalAcceptances(empty, [acceptance("terms", "v1", TERMS_HASH)]);

    expect(result.ok).toBe(true);
  });
});
