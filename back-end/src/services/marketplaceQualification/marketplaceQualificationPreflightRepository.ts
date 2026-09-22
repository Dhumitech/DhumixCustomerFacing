import type { Pool, QueryResultRow } from "pg";
import { withOperatorTransaction } from "../database/transactions.js";

export type MarketplaceQualificationAuthorizationState =
  | "not_authorized"
  | "authorized"
  | "consumed"
  | "revoked";

export interface MarketplaceQualificationContext {
  readonly candidateId: string;
  readonly templateVersionId: string;
  readonly filterAdapterVersionId: string;
  readonly providerResourceFingerprint: Buffer;
  readonly outputSchema: Readonly<Record<string, unknown>>;
}

export interface MarketplaceQualificationPreflightRepository {
  resolveContext(input: {
    readonly candidateId: string;
    readonly environment: "local" | "test";
  }): Promise<MarketplaceQualificationContext>;
  prepare(input: {
    readonly packetId: string;
    readonly candidateId: string;
    readonly templateVersionId: string;
    readonly filterAdapterVersionId: string;
    readonly environment: "local" | "test";
    readonly providerResourceFingerprint: Buffer;
    readonly exactRequest: Readonly<Record<string, unknown>>;
    readonly maximumEstimatedCostMicros: number;
    readonly currencyCode: "USD";
    readonly maximumProviderSubmissions: 1;
    readonly automaticSubmissionRetries: 0;
    readonly pollDeadlineMs: number;
    readonly expectedArtifactKinds: readonly ["raw", "normalized"];
    readonly expectedEvidence: readonly string[];
    readonly actor: string;
  }): Promise<{
    readonly packetId: string;
    readonly requestFingerprint: Buffer;
    readonly authorizationState: "not_authorized";
  }>;
  authorize(input: {
    readonly packetId: string;
    readonly requestFingerprint: Buffer;
    readonly recordsLimit: number;
    readonly maximumEstimatedCostMicros: number;
    readonly currencyCode: "USD";
    readonly maximumProviderSubmissions: 1;
    readonly automaticSubmissionRetries: 0;
    readonly authorizationReference: string;
    readonly authorizationHash: Buffer;
    readonly issuer: string;
    readonly effectiveAt: Date;
    readonly expiresAt: Date;
  }): Promise<{ readonly authorizationState: "authorized" }>;
}

interface ContextRow extends QueryResultRow {
  readonly candidate_id: string;
  readonly template_version_id: string;
  readonly filter_adapter_version_id: string;
  readonly provider_resource_fingerprint: Buffer;
  readonly output_schema: unknown;
}

interface PacketRow extends QueryResultRow {
  readonly packet_id: string;
  readonly request_fingerprint: Buffer;
  readonly authorization_state: "not_authorized";
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Marketplace qualification context contained an invalid output schema");
  }
  return value as Readonly<Record<string, unknown>>;
}

function fingerprint(value: unknown): Buffer {
  if (!Buffer.isBuffer(value) || value.byteLength !== 32) {
    throw new Error("Marketplace qualification context contained an invalid fingerprint");
  }
  return value;
}

export function createMarketplaceQualificationPreflightRepository(
  pool: Pool,
): MarketplaceQualificationPreflightRepository {
  return Object.freeze({
    async resolveContext(
      input: Parameters<MarketplaceQualificationPreflightRepository["resolveContext"]>[0],
    ) {
      return withOperatorTransaction(pool, async (database) => {
        const result = await database.query<ContextRow>(
          "SELECT * FROM app.resolve_marketplace_qualification_context($1,$2)",
          [input.candidateId, input.environment],
        );
        const row = result.rows[0];
        if (row === undefined) {
          throw Object.assign(new Error("Marketplace qualification context was not found"), {
            code: "P0002",
          });
        }
        return Object.freeze({
          candidateId: row.candidate_id,
          templateVersionId: row.template_version_id,
          filterAdapterVersionId: row.filter_adapter_version_id,
          providerResourceFingerprint: fingerprint(row.provider_resource_fingerprint),
          outputSchema: object(row.output_schema),
        });
      });
    },

    async prepare(input: Parameters<MarketplaceQualificationPreflightRepository["prepare"]>[0]) {
      return withOperatorTransaction(pool, async (database) => {
        const result = await database.query<PacketRow>(
          "SELECT * FROM app.prepare_marketplace_qualification_packet($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
          [
            input.packetId,
            input.candidateId,
            input.templateVersionId,
            input.filterAdapterVersionId,
            input.environment,
            input.providerResourceFingerprint,
            JSON.stringify(input.exactRequest),
            input.maximumEstimatedCostMicros,
            input.currencyCode,
            input.maximumProviderSubmissions,
            input.automaticSubmissionRetries,
            input.pollDeadlineMs,
            input.expectedEvidence,
            input.actor,
          ],
        );
        const row = result.rows[0];
        if (row === undefined || row.packet_id !== input.packetId ||
            row.authorization_state !== "not_authorized") {
          throw new Error("Marketplace qualification packet was not prepared");
        }
        return Object.freeze({
          packetId: row.packet_id,
          requestFingerprint: fingerprint(row.request_fingerprint),
          authorizationState: row.authorization_state,
        });
      });
    },

    async authorize(input: Parameters<MarketplaceQualificationPreflightRepository["authorize"]>[0]) {
      return withOperatorTransaction(pool, async (database) => {
        const result = await database.query<{ authorization_state: "authorized" }>(
          "SELECT app.authorize_marketplace_qualification_packet($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) AS authorization_state",
          [
            input.packetId,
            input.requestFingerprint,
            input.recordsLimit,
            input.maximumEstimatedCostMicros,
            input.currencyCode,
            input.maximumProviderSubmissions,
            input.automaticSubmissionRetries,
            input.authorizationReference,
            input.authorizationHash,
            input.issuer,
            input.effectiveAt,
            input.expiresAt,
          ],
        );
        if (result.rows[0]?.authorization_state !== "authorized") {
          throw new Error("Marketplace qualification authorization was not recorded");
        }
        return Object.freeze({ authorizationState: "authorized" as const });
      });
    },
  });
}
