import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const LOCAL_KEY_REFERENCE = "local:v1";
const SERIALIZATION_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface SealedResponseEnvelope {
  readonly ciphertext: Buffer;
  readonly keyReference: string;
}

export interface ResponseEnvelope {
  seal(plaintext: Buffer, authenticatedContext: Buffer): Promise<SealedResponseEnvelope>;
  open(
    ciphertext: Buffer,
    keyReference: string,
    authenticatedContext: Buffer,
  ): Promise<Buffer>;
}

export class ResponseEnvelopeError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResponseEnvelopeError";
  }
}

export function createLocalResponseEnvelope(
  nodeEnv: "development" | "test" | "production",
  keyBase64Url: string | null,
): ResponseEnvelope {
  if (nodeEnv === "production") {
    throw new ResponseEnvelopeError("The local response-envelope adapter is forbidden in production");
  }
  if (keyBase64Url === null || !/^[A-Za-z0-9_-]{43}$/.test(keyBase64Url)) {
    throw new ResponseEnvelopeError("A valid local response-envelope key is required");
  }
  const key = Buffer.from(keyBase64Url, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== keyBase64Url) {
    throw new ResponseEnvelopeError("The local response-envelope key must be exactly 32 bytes");
  }

  return {
    async seal(plaintext, authenticatedContext): Promise<SealedResponseEnvelope> {
      try {
        const nonce = randomBytes(NONCE_BYTES);
        const cipher = createCipheriv("aes-256-gcm", key, nonce);
        cipher.setAAD(authenticatedContext);
        const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        return {
          ciphertext: Buffer.concat([
            Buffer.from([SERIALIZATION_VERSION]),
            nonce,
            cipher.getAuthTag(),
            encrypted,
          ]),
          keyReference: LOCAL_KEY_REFERENCE,
        };
      } catch (error) {
        throw new ResponseEnvelopeError("Response sealing failed", error);
      }
    },

    async open(ciphertext, keyReference, authenticatedContext): Promise<Buffer> {
      try {
        if (keyReference !== LOCAL_KEY_REFERENCE) {
          throw new Error("Unknown response-envelope key reference");
        }
        if (
          ciphertext.length <= 1 + NONCE_BYTES + TAG_BYTES ||
          ciphertext[0] !== SERIALIZATION_VERSION
        ) {
          throw new Error("Malformed response envelope");
        }
        const nonce = ciphertext.subarray(1, 1 + NONCE_BYTES);
        const tag = ciphertext.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES);
        const encrypted = ciphertext.subarray(1 + NONCE_BYTES + TAG_BYTES);
        const decipher = createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAAD(authenticatedContext);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(encrypted), decipher.final()]);
      } catch (error) {
        throw new ResponseEnvelopeError("Response envelope authentication failed", error);
      }
    },
  };
}
