import { createHash, randomUUID } from "node:crypto";
import type { CsrfService } from "../../helpers/csrf.js";
import { canonicalSha256 } from "../../helpers/canonicalJson.js";
import { tenantActorFingerprint } from "../../helpers/tenantActorFingerprint.js";
import { ApplicationError } from "../../utils/applicationError.js";
import { csrfValidationFailed } from "../identity/sessionErrors.js";
import type { MarketplacePreviewService } from "../marketplacePreview/marketplacePreviewService.js";
import type { TrustedTenantPrincipal } from "../tenantAccess/trustedTenantPrincipal.js";
import {
  MarketplaceSampleDownloadNotFoundError,
  MarketplaceSampleDownloadPersistenceError,
  MarketplaceSampleDownloadRateLimitedError,
  MarketplaceSampleDownloadStaleError,
  type MarketplaceSampleDownloadFormat,
  type MarketplaceSampleDownloadRepository,
  type MarketplaceSampleDownloadRecord,
} from "./marketplaceSampleDownloadRepository.js";
import {
  MarketplaceSampleDownloadIntegrityError,
  MarketplaceSampleDownloadUnavailableError,
  type MarketplaceSampleDownloadStore,
} from "./marketplaceSampleDownloadStore.js";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface MarketplaceSampleDownloadBody {
  readonly expected_sample_version?: unknown;
  readonly selected_fields?: unknown;
  readonly filter?: unknown;
  readonly sort?: unknown;
  readonly format?: unknown;
  readonly record_limit?: unknown;
}

export interface MarketplaceSampleDownloadResponse {
  readonly sample_version: number;
  readonly format: MarketplaceSampleDownloadFormat;
  readonly record_count: number;
  readonly content_type: string;
  readonly byte_count: number;
  readonly checksum: string;
  readonly download_url: string;
  readonly download_expires_at: string;
}

export interface MarketplaceSampleDownloadService {
  authorize(input: {
    readonly principal: TrustedTenantPrincipal;
    readonly slug: unknown;
    readonly csrfToken: string | undefined;
    readonly idempotencyKey: string | undefined;
    readonly body: MarketplaceSampleDownloadBody;
    readonly schemaErrors: readonly { readonly field: string; readonly message: string }[];
    readonly requestId: string | null;
    readonly ipFingerprint: Buffer | null;
  }): Promise<MarketplaceSampleDownloadResponse>;
}

interface Dependencies {
  readonly preview: MarketplacePreviewService;
  readonly repository: MarketplaceSampleDownloadRepository;
  readonly store: MarketplaceSampleDownloadStore;
  readonly csrf: CsrfService;
  readonly maxRecords: number;
  readonly maxBytes: number;
  readonly rateLimitMax: number;
  readonly rateWindowSeconds: number;
  readonly downloadTtlSeconds: number;
  readonly createId?: () => string;
  readonly now?: () => Date;
}

function problem(status: number, code: "VALIDATION_ERROR" | "RESOURCE_NOT_FOUND" | "STATE_CONFLICT" |
  "PLATFORM_CAPACITY_LIMIT" | "SERVICE_UNAVAILABLE", title: string, detail?: string,
  errors?: readonly { readonly field: string; readonly message: string }[]) {
  return new ApplicationError({ status, code, title, ...(detail ? { detail } : {}), ...(errors ? { errors } : {}) });
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined
    ? ""
    : typeof value === "string" ? value : JSON.stringify(value);
  // CSV is for spreadsheet viewing; JSON retains the exact sample value.
  // A leading tab inside a quoted cell prevents Excel from evaluating formula-like input.
  const formulaLike = /^[\s\u0000-\u001f]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/u.test(text) ||
    /^[\t\r\n]/u.test(text);
  const safeText = formulaLike ? `\t${text}` : text;
  return formulaLike || /[",;\t\r\n]/u.test(safeText)
    ? `"${safeText.replaceAll('"', '""')}"`
    : safeText;
}

function serialize(
  rows: readonly Readonly<Record<string, unknown>>[],
  fields: readonly string[],
  format: MarketplaceSampleDownloadFormat,
): Buffer {
  if (format === "json") return Buffer.from(`${JSON.stringify(rows, null, 2)}\n`, "utf8");
  const lines = [fields.map(csvCell).join(","), ...rows.map((row) => fields.map((field) => csvCell(row[field])).join(","))];
  return Buffer.from(`${lines.join("\r\n")}\r\n`, "utf8");
}

function safeUrl(url: string, transport: "https" | "loopback-http"): void {
  const parsed = new URL(url);
  const local = transport === "loopback-http" && parsed.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (!((transport === "https" && parsed.protocol === "https:") || local) ||
      parsed.username !== "" || parsed.password !== "") throw new Error("Unsafe sample-download URL");
}

export function createMarketplaceSampleDownloadService(
  dependencies: Dependencies,
): MarketplaceSampleDownloadService {
  if (![dependencies.maxRecords, dependencies.maxBytes, dependencies.rateLimitMax,
    dependencies.rateWindowSeconds, dependencies.downloadTtlSeconds]
    .every((value) => Number.isSafeInteger(value) && value > 0) || dependencies.maxRecords > 100) {
    throw new TypeError("Marketplace sample-download configuration is invalid");
  }
  const createId = dependencies.createId ?? randomUUID;
  const now = dependencies.now ?? (() => new Date());
  const service: MarketplaceSampleDownloadService = {
    async authorize(input) {
      if (input.principal.kind === "browser" &&
          (input.csrfToken === undefined || !dependencies.csrf.verify(input.principal.sessionId, input.csrfToken))) {
        throw csrfValidationFailed();
      }
      const issues = [...input.schemaErrors];
      if (typeof input.slug !== "string" || !SLUG.test(input.slug)) {
        throw problem(404, "RESOURCE_NOT_FOUND", "Resource not found");
      }
      if (input.idempotencyKey === undefined || !IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
        issues.push({ field: "idempotency-key", message: "must be 16-128 accepted characters" });
      }
      const recordLimit = input.body.record_limit;
      if (typeof recordLimit !== "number" || !Number.isSafeInteger(recordLimit) ||
          recordLimit < 1 || recordLimit > dependencies.maxRecords) {
        issues.push({ field: "/record_limit", message: `must be an integer between 1 and ${dependencies.maxRecords}` });
      }
      if (input.body.format !== "json" && input.body.format !== "csv") {
        issues.push({ field: "/format", message: 'must be equal to "json" or "csv"' });
      }
      if (issues.length > 0) {
        throw problem(422, "VALIDATION_ERROR", "Validation failed",
          "The Marketplace sample-download request is invalid.", issues);
      }

      const format = input.body.format as MarketplaceSampleDownloadFormat;
      const projection = await dependencies.preview.query({
        principal: input.principal,
        slug: input.slug,
        csrfToken: input.csrfToken,
        body: {
          expected_sample_version: input.body.expected_sample_version,
          selected_fields: input.body.selected_fields,
          filter: input.body.filter,
          sort: input.body.sort,
          page: { limit: recordLimit },
        },
        schemaErrors: [],
      });
      const bytes = serialize(projection.rows, projection.selected_fields, format);
      if (bytes.byteLength > dependencies.maxBytes) {
        throw problem(413, "PLATFORM_CAPACITY_LIMIT", "Payload too large",
          "The authorized stored-sample projection exceeds the configured download byte limit.");
      }
      const checksum = createHash("sha256").update(bytes).digest();
      const requestHash = canonicalSha256({
        operation: "marketplace.sample_download.authorize.v1",
        slug: input.slug,
        expected_sample_version: projection.sample_version,
        selected_fields: projection.selected_fields,
        filter: input.body.filter,
        sort: input.body.sort ?? [],
        format,
        record_limit: recordLimit,
      });
      const projectionFingerprint = canonicalSha256({
        template_slug: projection.template_slug,
        template_version: projection.template_version,
        sample_version: projection.sample_version,
        selected_fields: projection.selected_fields,
        rows: projection.rows,
      });
      const authorizationId = createId();
      const extension = format;
      const contentType = format === "json" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8";
      const fileName = `${input.slug}-sample-v${projection.sample_version}.${extension}`;
      const objectKey = `marketplace/sample-downloads/${input.principal.tenantId}/${authorizationId}/${checksum.toString("hex")}.${extension}`;
      let createdRecord: MarketplaceSampleDownloadRecord | undefined;
      try {
        const reservation = await dependencies.repository.reserve({
          authorizationId,
          tenantId: input.principal.tenantId,
          actor: input.principal.kind === "browser"
            ? { kind: "browser", userId: input.principal.userId }
            : { kind: "api_key", apiKeyId: input.principal.apiKeyId },
          actorFingerprint: tenantActorFingerprint(input.principal),
          idempotencyKey: input.idempotencyKey as string,
          requestHash,
          templateSlug: input.slug,
          expectedSampleVersion: projection.sample_version,
          format,
          selectedFields: projection.selected_fields,
          projectionFingerprint,
          recordLimit: recordLimit as number,
          recordCount: projection.rows.length,
          objectKey,
          contentType,
          fileName,
          byteCount: bytes.byteLength,
          checksum,
          rateLimitMax: dependencies.rateLimitMax,
          rateWindowSeconds: dependencies.rateWindowSeconds,
        });
        if (reservation.kind === "conflict") {
          throw problem(409, "STATE_CONFLICT", "Idempotency conflict",
            "This Idempotency-Key was already used with a different request.");
        }
        if (reservation.kind === "replay" && reservation.record.state !== "authorized") {
          throw problem(503, "SERVICE_UNAVAILABLE", "Service unavailable",
            "The previous sample-download authorization did not complete.");
        }
        const record = reservation.record;
        if (reservation.kind === "created") createdRecord = record;
        const issuedAt = now();
        const authorizationExpiresAt = reservation.kind === "created"
          ? new Date(issuedAt.valueOf() + dependencies.downloadTtlSeconds * 1000)
          : record.downloadExpiresAt;
        if (authorizationExpiresAt === null ||
            authorizationExpiresAt.valueOf() <= issuedAt.valueOf()) {
          throw problem(409, "STATE_CONFLICT", "Authorization expired",
            "This sample-download authorization expired. Start a new download request.");
        }
        const receipt = reservation.kind === "created"
          ? await dependencies.store.putImmutable({
              objectKey: record.objectKey,
              tenantId: input.principal.tenantId,
              authorizationId: record.authorizationId,
              bytes,
              contentType: record.contentType,
              fileName: record.fileName,
              maxBytes: dependencies.maxBytes,
            })
          : {
              objectKey: record.objectKey,
              contentType: record.contentType,
              fileName: record.fileName,
              byteCount: record.byteCount,
              checksumHex: record.checksumHex,
            };
        const signed = await dependencies.store.authorize({
          receipt,
          tenantId: input.principal.tenantId,
          authorizationId: record.authorizationId,
          expiresAt: authorizationExpiresAt,
          maxTtlSeconds: dependencies.downloadTtlSeconds,
        });
        if (!(signed.expiresAt instanceof Date) ||
            signed.expiresAt.valueOf() !== authorizationExpiresAt.valueOf()) {
          throw new MarketplaceSampleDownloadIntegrityError();
        }
        safeUrl(signed.downloadUrl, signed.transport);
        if (reservation.kind === "created") {
          await dependencies.repository.complete({
            tenantId: input.principal.tenantId,
            authorizationId: record.authorizationId,
            downloadExpiresAt: signed.expiresAt,
            requestId: input.requestId,
            ipFingerprint: input.ipFingerprint,
          });
        }
        return {
          sample_version: projection.sample_version,
          format,
          record_count: record.recordCount,
          content_type: record.contentType,
          byte_count: record.byteCount,
          checksum: record.checksumHex,
          download_url: signed.downloadUrl,
          download_expires_at: signed.expiresAt.toISOString(),
        };
      } catch (error) {
        if (createdRecord !== undefined) {
          try {
            // Completion may have committed even if its acknowledgement was lost.
            // The row-locked database transition fences late completion and returns
            // true only for failed reservations, never an authorized download.
            const allowed = await dependencies.repository.fail({
              tenantId: input.principal.tenantId,
              authorizationId: createdRecord.authorizationId,
            });
            if (allowed) {
              await dependencies.store.deleteIfMatching({
                tenantId: input.principal.tenantId,
                authorizationId: createdRecord.authorizationId,
                receipt: createdRecord,
              });
            }
          } catch {
            // Database/storage uncertainty is recovered by the private cleanup
            // inventory job. The original customer-safe failure remains authoritative.
          }
        }
        if (error instanceof MarketplaceSampleDownloadRateLimitedError) {
          throw problem(429, "PLATFORM_CAPACITY_LIMIT", "Too many requests",
            "The Tenant sample-download limit has been reached. Try again later.");
        }
        if (error instanceof MarketplaceSampleDownloadNotFoundError) {
          throw problem(404, "RESOURCE_NOT_FOUND", "Resource not found");
        }
        if (error instanceof MarketplaceSampleDownloadStaleError) {
          throw problem(409, "STATE_CONFLICT", "State conflict",
            "The stored sample changed. Refresh the dataset before continuing.");
        }
        if (error instanceof ApplicationError) throw error;
        if (error instanceof MarketplaceSampleDownloadUnavailableError ||
            error instanceof MarketplaceSampleDownloadIntegrityError ||
            error instanceof MarketplaceSampleDownloadPersistenceError) {
          throw problem(503, "SERVICE_UNAVAILABLE", "Service unavailable",
            "The stored sample download is temporarily unavailable.");
        }
        throw problem(503, "SERVICE_UNAVAILABLE", "Service unavailable",
          "The stored sample download is temporarily unavailable.");
      }
    },
  };
  return Object.freeze(service);
}
