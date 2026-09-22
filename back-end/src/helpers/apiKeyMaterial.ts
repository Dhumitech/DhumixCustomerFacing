import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const API_SCOPES = [
  "catalog:read",
  "services:read",
  "services:write",
  "runs:read",
  "runs:write",
  "results:read",
  "usage:read",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export interface ApiKeyMaterial {
  readonly prefix: string;
  readonly secret: string;
  readonly hash: Buffer;
}

export type RandomBytes = (size: number) => Buffer;

export interface ParsedApiKeyCredential {
  readonly prefix: string;
  readonly hash: Buffer;
}

const API_KEY_PATTERN = /^(dhk_v1_([A-Za-z0-9_-]{16}))\.([A-Za-z0-9_-]{43})$/;
const DUMMY_API_KEY_HASH = createHash("sha256")
  .update("dhumi-api-key-dummy-verifier", "utf8")
  .digest();

function isCanonicalBase64Url(value: string, byteLength: number): boolean {
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === byteLength && decoded.toString("base64url") === value;
  } catch {
    return false;
  }
}

/** ADR 0007 credential material. Only the hash and display-safe prefix persist. */
export function createApiKeyMaterial(random: RandomBytes = randomBytes): ApiKeyMaterial {
  const lookup = random(12).toString("base64url");
  const secretPart = random(32).toString("base64url");
  if (lookup.length !== 16 || secretPart.length !== 43) {
    throw new Error("The cryptographic random source returned an invalid byte count");
  }

  const prefix = `dhk_v1_${lookup}`;
  const secret = `${prefix}.${secretPart}`;
  return {
    prefix,
    secret,
    hash: createHash("sha256").update(secret, "utf8").digest(),
  };
}

/** Parses only the canonical ADR-0007 credential serialization. */
export function parseApiKeyCredential(value: string): ParsedApiKeyCredential | undefined {
  const match = API_KEY_PATTERN.exec(value);
  if (match === null) return undefined;

  const prefix = match[1];
  const lookup = match[2];
  const secretPart = match[3];
  if (
    prefix === undefined ||
    lookup === undefined ||
    secretPart === undefined ||
    !isCanonicalBase64Url(lookup, 12) ||
    !isCanonicalBase64Url(secretPart, 32)
  ) {
    return undefined;
  }

  return {
    prefix,
    hash: createHash("sha256").update(value, "utf8").digest(),
  };
}

/**
 * Compares fixed-width verifier material without a data-dependent early return.
 * Missing or malformed stored hashes are replaced with an internal dummy value.
 */
export function apiKeyHashMatches(
  presentedHash: Buffer,
  storedHash: Buffer | undefined,
): boolean {
  const presented = presentedHash.length === 32 ? presentedHash : DUMMY_API_KEY_HASH;
  const stored = storedHash?.length === 32 ? storedHash : DUMMY_API_KEY_HASH;
  const equal = timingSafeEqual(presented, stored);
  return presentedHash.length === 32 && storedHash?.length === 32 && equal;
}
