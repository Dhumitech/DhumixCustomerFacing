export interface MarketplaceSampleReceipt {
  readonly objectKey: string;
  readonly contentType: string;
  readonly byteCount: number;
  readonly checksumHex: string;
  readonly eTag: string;
}

export interface OpenMarketplaceSampleOutcome {
  readonly receipt: MarketplaceSampleReceipt;
  readonly bytes: Buffer;
}

export interface MarketplaceSampleStore {
  putImmutable(input: {
    readonly objectKey: string;
    readonly bytes: Buffer;
    readonly contentType: string;
    readonly maxBytes: number;
  }): Promise<MarketplaceSampleReceipt>;
  open(objectKey: string, maxBytes: number): Promise<OpenMarketplaceSampleOutcome>;
  deleteAndVerify(objectKey: string): Promise<{
    readonly disposition: "deleted" | "already_absent";
  }>;
}

export class MarketplaceSampleConflictError extends Error {
  public constructor() {
    super("Marketplace sample identity already contains different bytes or metadata");
    this.name = "MarketplaceSampleConflictError";
  }
}

export class MarketplaceSampleIntegrityError extends Error {
  public constructor(cause?: unknown) {
    super(
      "Marketplace sample object failed integrity validation",
      cause === undefined ? undefined : { cause },
    );
    this.name = "MarketplaceSampleIntegrityError";
  }
}
