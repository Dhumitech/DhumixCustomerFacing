import type { ResultObjectIdentity } from "./resultObjectIdentity.js";
import type { ResultObjectReceipt } from "./resultObjectStore.js";

export interface FinalizeResultArtifactInput {
  readonly identity: ResultObjectIdentity;
  readonly receipt: ResultObjectReceipt;
  readonly artifactState: "durable" | "validated";
  readonly schemaVersion: string | null;
  readonly recordCount: number | null;
  readonly expiresAt: Date | null;
}

export interface FinalizedResultArtifact {
  readonly artifactId: string;
  readonly replayed: boolean;
}

export interface ResultArtifactFinalizer {
  finalize(input: FinalizeResultArtifactInput): Promise<FinalizedResultArtifact>;
}

export class ResultArtifactFinalizeConflictError extends Error {
  public constructor() {
    super("Result Artifact identity already exists with different metadata");
    this.name = "ResultArtifactFinalizeConflictError";
  }
}
