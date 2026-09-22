import type { Readable } from "node:stream";
import type { ResultObjectIdentity } from "./resultObjectIdentity.js";

export interface PutResultObjectInput {
  readonly identity: ResultObjectIdentity;
  readonly bytes: Readable;
  readonly contentType: string;
  readonly contentEncoding: string | null;
  readonly maxBytes: number;
}

export interface ResultObjectReceipt {
  readonly objectKey: string;
  readonly contentType: string;
  readonly contentEncoding: string | null;
  readonly byteCount: number;
  readonly checksumHex: string;
  readonly eTag: string;
}

export interface OpenResultObjectOutcome {
  readonly receipt: ResultObjectReceipt;
  readonly bytes: Readable;
}

export interface ResultObjectStore {
  putImmutable(input: PutResultObjectInput): Promise<ResultObjectReceipt>;
  head(identity: ResultObjectIdentity): Promise<ResultObjectReceipt | null>;
  open(identity: ResultObjectIdentity, maxBytes: number): Promise<OpenResultObjectOutcome>;
}

export class ResultObjectConflictError extends Error {
  public constructor() {
    super("Different bytes or metadata already exist for this result identity");
    this.name = "ResultObjectConflictError";
  }
}

export class ResultObjectLimitExceededError extends Error {
  public constructor() {
    super("Result object exceeded its accepted byte limit");
    this.name = "ResultObjectLimitExceededError";
  }
}

export class ResultObjectIntegrityError extends Error {
  public constructor(message = "Stored result object failed integrity validation", cause?: unknown) {
    super(message, { cause });
    this.name = "ResultObjectIntegrityError";
  }
}
