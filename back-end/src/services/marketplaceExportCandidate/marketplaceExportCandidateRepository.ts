import type { Pool, QueryResultRow } from "pg";
import { withOperatorTransaction } from "../database/transactions.js";

export interface MarketplaceExportCandidateSource {
  readonly packetId: string;
  readonly candidateId: string;
  readonly environment: "local" | "test";
  readonly resourceCode: "linkedin.posts";
  readonly providerResourceCiphertext: Buffer;
  readonly providerResourceFingerprint: Buffer;
}

export interface MarketplaceExportCandidateRegistration {
  readonly mappingId: string;
  readonly templateSlug: "linkedin-posts";
  readonly templateVersion: 2;
  readonly mappingState: "disabled";
  readonly disposition: "registered" | "replayed";
}

export interface MarketplaceExportCandidateRepository {
  resolveSource(input: {
    readonly packetId: string;
    readonly mappingId: string;
  }): Promise<MarketplaceExportCandidateSource>;
  register(input: {
    readonly packetId: string;
    readonly mappingId: string;
    readonly providerResourceCiphertext: Buffer;
    readonly providerResourceFingerprint: Buffer;
    readonly actor: string;
    readonly evidenceReference: string;
    readonly reason: string;
  }): Promise<MarketplaceExportCandidateRegistration>;
}

interface SourceRow extends QueryResultRow {
  readonly packet_id: string;
  readonly candidate_id: string;
  readonly environment: "local" | "test";
  readonly resource_code: "linkedin.posts";
  readonly provider_resource_ciphertext: Buffer;
  readonly provider_resource_fingerprint: Buffer;
}

interface RegistrationRow extends QueryResultRow {
  readonly mapping_id: string;
  readonly template_slug: "linkedin-posts";
  readonly template_version: 2;
  readonly mapping_state: "disabled";
  readonly disposition: "registered" | "replayed";
}

function bytes(value: unknown, expectedLength?: number): Buffer {
  if (!Buffer.isBuffer(value) ||
      (expectedLength === undefined ? value.byteLength <= 29 : value.byteLength !== expectedLength)) {
    throw new Error("Marketplace export candidate returned malformed protected evidence");
  }
  return value;
}

export function createMarketplaceExportCandidateRepository(
  pool: Pool,
): MarketplaceExportCandidateRepository {
  return Object.freeze({
    async resolveSource(
      input: Parameters<MarketplaceExportCandidateRepository["resolveSource"]>[0],
    ) {
      return withOperatorTransaction(pool, async (database) => {
        const result = await database.query<SourceRow>(
          "SELECT * FROM app.resolve_marketplace_export_candidate_source($1,$2)",
          [input.packetId, input.mappingId],
        );
        const row = result.rows[0];
        if (row === undefined) {
          throw Object.assign(new Error("Marketplace export candidate source was not found"), {
            code: "P0002",
          });
        }
        return Object.freeze({
          packetId: row.packet_id,
          candidateId: row.candidate_id,
          environment: row.environment,
          resourceCode: row.resource_code,
          providerResourceCiphertext: bytes(row.provider_resource_ciphertext),
          providerResourceFingerprint: bytes(row.provider_resource_fingerprint, 32),
        });
      });
    },

    async register(
      input: Parameters<MarketplaceExportCandidateRepository["register"]>[0],
    ) {
      return withOperatorTransaction(pool, async (database) => {
        const result = await database.query<RegistrationRow>(
          "SELECT * FROM app.register_marketplace_export_candidate_v1($1,$2,$3,$4,$5,$6,$7)",
          [
            input.packetId,
            input.mappingId,
            input.providerResourceCiphertext,
            input.providerResourceFingerprint,
            input.actor,
            input.evidenceReference,
            input.reason,
          ],
        );
        const row = result.rows[0];
        if (row === undefined || row.mapping_id !== input.mappingId ||
            row.template_slug !== "linkedin-posts" || row.template_version !== 2 ||
            row.mapping_state !== "disabled" ||
            (row.disposition !== "registered" && row.disposition !== "replayed")) {
          throw new Error("Marketplace export candidate registration returned an invalid result");
        }
        return Object.freeze({
          mappingId: row.mapping_id,
          templateSlug: row.template_slug,
          templateVersion: row.template_version,
          mappingState: row.mapping_state,
          disposition: row.disposition,
        });
      });
    },
  });
}
