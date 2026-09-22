export interface ResultUrlSigningInput {
  readonly objectKey: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly contentType: string;
  readonly byteCount: number;
  readonly checksumHex: string;
}

export interface SignedDownloadUrl {
  readonly downloadUrl: string;
  readonly expiresAt: Date;
  /** HTTPS is mandatory except for an explicitly declared loopback Azurite URL. */
  readonly transport: "https" | "loopback-http";
}

/** Object-storage boundary. Implementations must verify the object before signing. */
export interface ResultUrlSigner {
  sign(input: ResultUrlSigningInput): Promise<SignedDownloadUrl>;
}

export class ResultUrlSigningUnavailableError extends Error {
  public constructor(cause?: unknown) {
    super("Result URL signing is unavailable", { cause });
    this.name = "ResultUrlSigningUnavailableError";
  }
}

export function isResultUrlSigningUnavailableError(
  error: unknown,
): error is ResultUrlSigningUnavailableError {
  return (
    error instanceof ResultUrlSigningUnavailableError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "ResultUrlSigningUnavailableError")
  );
}

/**
 * Honest composition used until an approved private object-storage adapter is
 * configured. It never returns a placeholder or provider URL.
 */
export function createUnavailableResultUrlSigner(): ResultUrlSigner {
  return {
    async sign(): Promise<never> {
      throw new ResultUrlSigningUnavailableError();
    },
  };
}
