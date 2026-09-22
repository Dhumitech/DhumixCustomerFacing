export interface MarketplaceSampleDownloadReceipt {
  readonly objectKey: string;
  readonly contentType: string;
  readonly fileName: string;
  readonly byteCount: number;
  readonly checksumHex: string;
  readonly eTag: string;
}

export interface MarketplaceSampleDownloadAuthorization {
  readonly downloadUrl: string;
  readonly expiresAt: Date;
  readonly transport: "https" | "loopback-http";
}

export interface MarketplaceSampleDownloadStore {
  putImmutable(input: {
    readonly objectKey: string;
    readonly tenantId: string;
    readonly authorizationId: string;
    readonly bytes: Buffer;
    readonly contentType: string;
    readonly fileName: string;
    readonly maxBytes: number;
  }): Promise<MarketplaceSampleDownloadReceipt>;
  authorize(input: {
    readonly receipt: Omit<MarketplaceSampleDownloadReceipt, "eTag">;
    readonly tenantId: string;
    readonly authorizationId: string;
    readonly expiresAt: Date;
    readonly maxTtlSeconds: number;
  }): Promise<MarketplaceSampleDownloadAuthorization>;
  /** Delete only this identity/receipt, conditionally on its current ETag. */
  deleteIfMatching(input: {
    readonly receipt: Omit<MarketplaceSampleDownloadReceipt, "eTag">;
    readonly tenantId: string;
    readonly authorizationId: string;
  }): Promise<"deleted" | "absent">;
}

export interface MarketplaceSampleDownloadCleanupCandidate {
  readonly tenantId: string;
  readonly authorizationId: string;
  readonly objectKey: string;
}

/** Private operator inventory, never reachable from a customer route. */
export interface MarketplaceSampleDownloadCleanupStore extends
  Pick<MarketplaceSampleDownloadStore, "deleteIfMatching"> {
  listCleanupPage(input: {
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<{
    readonly candidates: readonly MarketplaceSampleDownloadCleanupCandidate[];
    readonly ignored: number;
    readonly nextCursor: string | undefined;
  }>;
}

export class MarketplaceSampleDownloadUnavailableError extends Error {
  public constructor(cause?: unknown) {
    super("Marketplace sample download storage is unavailable", { cause });
    this.name = "MarketplaceSampleDownloadUnavailableError";
  }
}

export class MarketplaceSampleDownloadIntegrityError extends Error {
  public constructor(cause?: unknown) {
    super("Marketplace sample download failed integrity validation", { cause });
    this.name = "MarketplaceSampleDownloadIntegrityError";
  }
}

export function createUnavailableMarketplaceSampleDownloadStore(): MarketplaceSampleDownloadStore {
  return Object.freeze({
    async putImmutable(): Promise<never> {
      throw new MarketplaceSampleDownloadUnavailableError();
    },
    async authorize(): Promise<never> {
      throw new MarketplaceSampleDownloadUnavailableError();
    },
    async deleteIfMatching(): Promise<never> {
      throw new MarketplaceSampleDownloadUnavailableError();
    },
  });
}
