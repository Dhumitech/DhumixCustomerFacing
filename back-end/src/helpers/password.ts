import { hash, verify } from "@node-rs/argon2";
import type { PasswordHashConfig } from "../config/environment.js";

/**
 * Argon2id password hashing. Parameters and their rationale are recorded in
 * `docs/decisions/0002-argon2id-password-hashing.md`.
 *
 * Versioning is carried by the encoded PHC string itself, which records the
 * parameters a hash was created with, so raising the cost later stays
 * compatible with stored hashes.
 */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(encoded: string, password: string): Promise<boolean>;
  needsRehash(encoded: string): boolean;
}

/** `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>` */
const PHC_PATTERN = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/;

interface EncodedParameters {
  readonly memoryKib: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

export function readEncodedParameters(encoded: string): EncodedParameters | undefined {
  const match = PHC_PATTERN.exec(encoded);
  if (match === null) {
    return undefined;
  }

  return {
    memoryKib: Number(match[1]),
    timeCost: Number(match[2]),
    parallelism: Number(match[3]),
  };
}

const ARGON2ID_PREFIX = "$argon2id$";

export function createPasswordHasher(config: PasswordHashConfig): PasswordHasher {
  // `algorithm` is deliberately omitted. The library's `Algorithm` export is an
  // ambient const enum, which `verbatimModuleSyntax` cannot import, and its
  // default is already Argon2id. Relying on a library default for a security
  // choice is only acceptable with an assertion, so every produced hash is
  // checked below rather than trusted.
  const options = {
    memoryCost: config.memoryKib,
    timeCost: config.timeCost,
    parallelism: config.parallelism,
  } as const;

  return {
    async hash(password: string): Promise<string> {
      const encoded = await hash(password, options);
      if (!encoded.startsWith(ARGON2ID_PREFIX)) {
        throw new Error("Password hashing did not produce an Argon2id hash");
      }
      return encoded;
    },

    async verify(encoded: string, password: string): Promise<boolean> {
      // A malformed or foreign hash is a failed verification, never an
      // exception that could be distinguished from a wrong password.
      try {
        return await verify(encoded, password);
      } catch {
        return false;
      }
    },

    needsRehash(encoded: string): boolean {
      const stored = readEncodedParameters(encoded);
      if (stored === undefined) {
        return true;
      }

      return (
        stored.memoryKib !== config.memoryKib ||
        stored.timeCost !== config.timeCost ||
        stored.parallelism !== config.parallelism
      );
    },
  };
}
