import type { Pool } from "pg";
import { RUN_PUBLIC_STATUS_SQL } from '../../helpers/runPublicStatus.js';
import { ApplicationError } from "../../utils/applicationError.js";
import {
  withOrganizationReadTransaction,
  withOrganizationWriteTransaction,
} from "../database/transactions.js";

export type RunResultRepresentation = "normalized" | "raw";

export interface GetRunResultRepositoryInput {
  readonly userId: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly representation: RunResultRepresentation;
}

export interface GetRunResultAuditInput {
  readonly tenantId: string;
  readonly runId: string;
  readonly artifactId: string;
  readonly representation: RunResultRepresentation;
  readonly actor: { readonly kind: "browser"; readonly userId: string };
  readonly requestId: string | null;
  readonly ipFingerprint: Buffer | null;
}

export interface RunResultArtifactRecord {
  readonly artifactId: string;
  readonly objectKey: string;
  readonly contentType: string;
  /** PostgreSQL bigint is intentionally kept as text until safe conversion. */
  readonly byteCount: string;
  readonly checksum: Buffer;
}

export type GetRunResultRepositoryOutcome =
  | { readonly kind: "not_found" }
  | { readonly kind: "not_ready" }
  | { readonly kind: "missing_artifact" }
  | { readonly kind: "ready"; readonly artifact: RunResultArtifactRecord };

export interface GetRunResultRepository {
  findResult(input: GetRunResultRepositoryInput): Promise<GetRunResultRepositoryOutcome>;
  recordDownloadAuthorization(input: GetRunResultAuditInput): Promise<void>;
}

interface RunStateRow {
  readonly public_status: "queued" | "running" | "ready" | "failed" | "cancelled" | "expired";
}

interface ResultArtifactRow {
  readonly id: string;
  readonly object_key: string;
  readonly content_type: string;
  readonly byte_count: string;
  readonly checksum: Buffer;
}

function internalFailure(cause: unknown): ApplicationError {
  return new ApplicationError({
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Internal server error",
    cause,
  });
}

function artifactState(representation: RunResultRepresentation): "validated" | "durable" {
  return representation === "normalized" ? "validated" : "durable";
}

export function createGetRunResultRepository(pool: Pool): GetRunResultRepository {
  return {
    async findResult(input): Promise<GetRunResultRepositoryOutcome> {
      try {
        return await withOrganizationReadTransaction(
          pool,
          { tenantId: input.tenantId, userId: input.userId },
          async (database) => {
            const run = await database.query<RunStateRow>(
              `
              SELECT ${RUN_PUBLIC_STATUS_SQL} AS public_status
              FROM app.runs run
              WHERE run.organization_id = $1
                AND run.id = $2::uuid
              LIMIT 1
            `,
              [input.tenantId, input.runId],
            );
            const state = run.rows[0];
            if (state === undefined) return { kind: "not_found" };
            if (state.public_status !== "ready") return { kind: "not_ready" };

            const artifact = await database.query<ResultArtifactRow>(
              `
              SELECT
                id,
                object_key,
                content_type,
                byte_count::text AS byte_count,
                checksum
              FROM app.artifacts
              WHERE organization_id = $1
                AND run_id = $2::uuid
                AND kind = $3
                AND state = $4
                AND (expires_at IS NULL OR expires_at > statement_timestamp())
              ORDER BY artifact_version DESC, created_at DESC, id DESC
              LIMIT 1
            `,
              [
                input.tenantId,
                input.runId,
                input.representation,
                artifactState(input.representation),
              ],
            );
            const row = artifact.rows[0];
            return row === undefined
              ? { kind: "missing_artifact" }
              : {
                  kind: "ready",
                  artifact: {
                    artifactId: row.id,
                    objectKey: row.object_key,
                    contentType: row.content_type,
                    byteCount: row.byte_count,
                    checksum: row.checksum,
                  },
                };
          },
        );
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw internalFailure(error);
      }
    },

    async recordDownloadAuthorization(input): Promise<void> {
      try {
        await withOrganizationWriteTransaction(
          pool,
          { tenantId: input.tenantId, userId: input.actor.userId },
          async (database) => {
            const result = await database.query(
              `
              INSERT INTO app.audit_events (
                organization_id,
                actor_user_id,
                action,
                target_type,
                target_id,
                outcome,
                trace_id,
                ip_fingerprint,
                safe_diff
              )
              SELECT
                $1,
                $4,
                'artifacts.download_authorize',
                'artifact',
                artifact.id,
                'authorized',
                $5::uuid,
                $6,
                jsonb_build_object(
                  'run_id', $2::uuid,
                  'delivery_method', 'signed_object_url',
                  'representation', $7::text
                )
              FROM app.artifacts AS artifact
              JOIN app.runs AS run
                ON run.organization_id = artifact.organization_id
               AND run.id = artifact.run_id
              WHERE artifact.organization_id = $1
                AND artifact.run_id = $2::uuid
                AND artifact.id = $3::uuid
                AND artifact.kind = $7
                AND artifact.state = $8
                AND (artifact.expires_at IS NULL OR artifact.expires_at > statement_timestamp())
                AND run.internal_status = 'COMPLETED'
            `,
              [
                input.tenantId,
                input.runId,
                input.artifactId,
                input.actor.userId,
                input.requestId,
                input.ipFingerprint,
                input.representation,
                artifactState(input.representation),
              ],
            );
            // The Customer API capability is intentionally append-only on
            // audit_events. Do not add RETURNING here: PostgreSQL requires
            // SELECT privilege on returned columns, which would broaden that
            // capability solely to confirm an INSERT. The command row count is
            // sufficient to detect a stale authorization atomically.
            if (result.rowCount !== 1) {
              throw new Error("Result authorization became stale before audit recording");
            }
          },
        );
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw internalFailure(error);
      }
    },
  };
}
