import type { Readable } from "node:stream";
import { createResultObjectKey, type ResultObjectIdentity } from "./resultObjectIdentity.js";
import type { ResultArtifactFinalizer } from "./resultArtifactFinalizer.js";
import {
  ResultObjectIntegrityError,
  type ResultObjectReceipt,
  type ResultObjectStore,
} from "./resultObjectStore.js";

export interface IngestResultInput {
  readonly identity: ResultObjectIdentity;
  readonly bytes: Readable;
  readonly contentType: string;
  readonly contentEncoding: string | null;
  readonly schemaVersion: string | null;
  readonly recordCount: number | null;
  readonly expiresAt: Date | null;
}

export interface IngestResultOutcome {
  readonly receipt: ResultObjectReceipt;
  readonly artifactId: string;
  readonly replayed: boolean;
}

export interface ResultIngestionService {
  ingest(input: IngestResultInput): Promise<IngestResultOutcome>;
}

export interface ResultIngestionDependencies {
  readonly store: ResultObjectStore;
  readonly finalizer: ResultArtifactFinalizer;
  readonly maxBytes: number;
}

function verifyReceipt(
  identity: ResultObjectIdentity,
  receipt: ResultObjectReceipt,
): void {
  if (
    receipt.objectKey !== createResultObjectKey(identity) ||
    !Number.isSafeInteger(receipt.byteCount) ||
    receipt.byteCount < 0 ||
    !/^[0-9a-f]{64}$/.test(receipt.checksumHex) ||
    receipt.eTag === ""
  ) {
    throw new ResultObjectIntegrityError("Object store returned an invalid receipt");
  }
}

export function createResultIngestionService(
  dependencies: ResultIngestionDependencies,
): ResultIngestionService {
  if (!Number.isSafeInteger(dependencies.maxBytes) || dependencies.maxBytes < 1) {
    throw new TypeError("maxBytes must be a positive safe integer");
  }

  return {
    async ingest(input): Promise<IngestResultOutcome> {
      if (
        (input.recordCount !== null &&
          (!Number.isSafeInteger(input.recordCount) || input.recordCount < 0)) ||
        (input.identity.kind === "raw" && input.recordCount !== null)
      ) {
        throw new TypeError("recordCount must be null for raw results or a non-negative safe integer");
      }
      const receipt = await dependencies.store.putImmutable({
        identity: input.identity,
        bytes: input.bytes,
        contentType: input.contentType,
        contentEncoding: input.contentEncoding,
        maxBytes: dependencies.maxBytes,
      });
      verifyReceipt(input.identity, receipt);

      const finalized = await dependencies.finalizer.finalize({
        identity: input.identity,
        receipt,
        artifactState: input.identity.kind === "raw" ? "durable" : "validated",
        schemaVersion: input.schemaVersion,
        recordCount: input.recordCount,
        expiresAt: input.expiresAt,
      });
      return { receipt, ...finalized };
    },
  };
}
