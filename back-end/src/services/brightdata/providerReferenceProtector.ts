import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const SERIALIZATION_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 512;

export interface ProtectedProviderReference {
  readonly ciphertext: Buffer;
  readonly fingerprint: Buffer;
}

export interface ProviderReferenceProtector {
  protect(plaintext: string, authenticatedContext: Buffer): Promise<ProtectedProviderReference>;
  reveal(
    ciphertext: Buffer,
    fingerprint: Buffer,
    authenticatedContext: Buffer,
  ): Promise<string>;
}

export class ProviderReferenceProtectionError extends Error {
  public constructor(
    message = "Private provider reference protection failed",
    cause?: unknown,
  ) {
    super(
      message,
      cause === undefined ? undefined : { cause },
    );
    this.name = "ProviderReferenceProtectionError";
  }
}

function fingerprint(key: Buffer, plaintext: Buffer, context: Buffer): Buffer {
  return createHmac("sha256", key)
    .update("dhumi:provider-reference-fingerprint:v1\0", "utf8")
    .update(context)
    .update(Buffer.from([0]))
    .update(plaintext)
    .digest();
}

function validatePlaintext(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  if (value.trim() !== value || bytes.byteLength < 1 || bytes.byteLength > MAX_PLAINTEXT_BYTES) {
    throw new ProviderReferenceProtectionError();
  }
  return bytes;
}

function validateContext(value: Buffer): void {
  if (value.byteLength < 1 || value.byteLength > 1024) {
    throw new ProviderReferenceProtectionError();
  }
}

export function createLocalProviderReferenceProtector(
  nodeEnv: "development" | "test" | "production",
  keyBase64Url: string,
): ProviderReferenceProtector {
  if (nodeEnv === "production") {
    throw new ProviderReferenceProtectionError(
      "The local provider-reference adapter is forbidden in production",
    );
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(keyBase64Url)) {
    throw new ProviderReferenceProtectionError();
  }
  const key = Buffer.from(keyBase64Url, "base64url");
  if (key.byteLength !== 32 || key.toString("base64url") !== keyBase64Url) {
    throw new ProviderReferenceProtectionError();
  }

  return {
    async protect(plaintext, authenticatedContext): Promise<ProtectedProviderReference> {
      try {
        validateContext(authenticatedContext);
        const serialized = validatePlaintext(plaintext);
        const nonce = randomBytes(NONCE_BYTES);
        const cipher = createCipheriv("aes-256-gcm", key, nonce);
        cipher.setAAD(authenticatedContext);
        const encrypted = Buffer.concat([cipher.update(serialized), cipher.final()]);
        return {
          ciphertext: Buffer.concat([
            Buffer.from([SERIALIZATION_VERSION]),
            nonce,
            cipher.getAuthTag(),
            encrypted,
          ]),
          fingerprint: fingerprint(key, serialized, authenticatedContext),
        };
      } catch (error) {
        if (error instanceof ProviderReferenceProtectionError) throw error;
        throw new ProviderReferenceProtectionError(undefined, error);
      }
    },

    async reveal(ciphertext, expectedFingerprint, authenticatedContext): Promise<string> {
      try {
        validateContext(authenticatedContext);
        if (
          ciphertext.byteLength <= 1 + NONCE_BYTES + TAG_BYTES ||
          ciphertext[0] !== SERIALIZATION_VERSION ||
          expectedFingerprint.byteLength !== 32
        ) {
          throw new Error("Malformed private provider reference");
        }
        const nonce = ciphertext.subarray(1, 1 + NONCE_BYTES);
        const tag = ciphertext.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES);
        const encrypted = ciphertext.subarray(1 + NONCE_BYTES + TAG_BYTES);
        const decipher = createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAAD(authenticatedContext);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        if (plaintext.byteLength < 1 || plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
          throw new Error("Invalid private provider reference length");
        }
        const actualFingerprint = fingerprint(key, plaintext, authenticatedContext);
        if (!timingSafeEqual(actualFingerprint, expectedFingerprint)) {
          throw new Error("Private provider reference fingerprint mismatch");
        }
        const value = plaintext.toString("utf8");
        if (!Buffer.from(value, "utf8").equals(plaintext)) {
          throw new Error("Private provider reference is not valid UTF-8");
        }
        return value;
      } catch (error) {
        throw new ProviderReferenceProtectionError(undefined, error);
      }
    },
  };
}
