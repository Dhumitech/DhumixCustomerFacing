import type { Pool } from "pg";
import { withResultRecorderTenantTransaction } from "../database/transactions.js";
import {
  ResultArtifactFinalizeConflictError,
  type FinalizeResultArtifactInput,
  type FinalizedResultArtifact,
  type ResultArtifactFinalizer,
} from "./resultArtifactFinalizer.js";

interface ArtifactRow {
  readonly id: string;
  readonly object_key: string;
  readonly content_type: string;
  readonly content_encoding: string | null;
  readonly byte_count: string;
  readonly checksum_hex: string;
  readonly schema_version: string | null;
  readonly record_count: string | null;
  readonly state: "durable" | "validated" | "quarantined" | "deleted";
  readonly expires_at: Date | null;
}

function datesEqual(left: Date | null, right: Date | null): boolean {
  return left === null ? right === null : right !== null && left.valueOf() === right.valueOf();
}

function matches(input: FinalizeResultArtifactInput, row: ArtifactRow): boolean {
  return (
    row.object_key === input.receipt.objectKey &&
    row.content_type === input.receipt.contentType &&
    row.content_encoding === input.receipt.contentEncoding &&
    row.byte_count === String(input.receipt.byteCount) &&
    row.checksum_hex === input.receipt.checksumHex &&
    row.schema_version === input.schemaVersion &&
    row.record_count === (input.recordCount === null ? null : String(input.recordCount)) &&
    row.state === input.artifactState &&
    datesEqual(input.expiresAt, row.expires_at)
  );
}

export function createResultArtifactFinalizerRepository(
  pool: Pool,
): ResultArtifactFinalizer {
  return {
    async finalize(input): Promise<FinalizedResultArtifact> {
      return withResultRecorderTenantTransaction(
        pool,
        input.identity.tenantId,
        async (database) => {
          const inserted = await database.query<{ id: string }>(
            `
              INSERT INTO app.artifacts (
                organization_id,
                run_id,
                attempt_id,
                kind,
                artifact_version,
                object_key,
                content_type,
                content_encoding,
                byte_count,
                checksum,
                schema_version,
                record_count,
                state,
                expires_at
              )
              SELECT
                $1,
                run.id,
                attempt.id,
                $4,
                $5,
                $6,
                $7,
                $8,
                $9,
                decode($10, 'hex'),
                $11,
                $12,
                $13,
                $14
              FROM app.runs AS run
              JOIN app.run_attempts AS attempt
                ON attempt.organization_id = run.organization_id
               AND attempt.run_id = run.id
              WHERE run.organization_id = $1
                AND run.id = $2
                AND attempt.id = $3
              ON CONFLICT (run_id, attempt_id, kind, artifact_version) DO NOTHING
              RETURNING id
            `,
            [
              input.identity.tenantId,
              input.identity.runId,
              input.identity.attemptId,
              input.identity.kind,
              input.identity.artifactVersion,
              input.receipt.objectKey,
              input.receipt.contentType,
              input.receipt.contentEncoding,
              input.receipt.byteCount,
              input.receipt.checksumHex,
              input.schemaVersion,
              input.recordCount,
              input.artifactState,
              input.expiresAt,
            ],
          );

          const current = await database.query<ArtifactRow>(
            `
              SELECT
                id,
                object_key,
                content_type,
                content_encoding,
                byte_count::text AS byte_count,
                encode(checksum, 'hex') AS checksum_hex,
                schema_version,
                record_count::text AS record_count,
                state,
                expires_at
              FROM app.artifacts
              WHERE organization_id = $1
                AND run_id = $2
                AND attempt_id = $3
                AND kind = $4
                AND artifact_version = $5
              LIMIT 1
            `,
            [
              input.identity.tenantId,
              input.identity.runId,
              input.identity.attemptId,
              input.identity.kind,
              input.identity.artifactVersion,
            ],
          );
          const row = current.rows[0];
          if (row === undefined || !matches(input, row)) {
            throw new ResultArtifactFinalizeConflictError();
          }
          return { artifactId: row.id, replayed: inserted.rowCount === 0 };
        },
      );
    },
  };
}
