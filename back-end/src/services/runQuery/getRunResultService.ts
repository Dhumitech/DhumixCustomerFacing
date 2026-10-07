import {
  isResultUrlSigningUnavailableError,
  type ResultUrlSigner,
} from "../../helpers/resultUrlSigner.js";
import { ApplicationError } from "../../utils/applicationError.js";
import type { TrustedTenantPrincipal } from "../tenantAccess/trustedTenantPrincipal.js";
import { accessDenied } from "../tenantAccess/tenantAccessErrors.js";
import type { GetRunResultRepository, RunResultRepresentation } from "./getRunResultRepository.js";
import {
  runResultInconsistent,
  runResultNotReady,
  runResultSigningUnavailable,
  runResultValidationFailed,
  runQueryNotFound,
} from "./runQueryErrors.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RunResult {
  readonly run_id: string;
  readonly content_type: string;
  readonly byte_count: number;
  readonly checksum: string;
  readonly download_url: string;
  readonly download_expires_at: string;
}

export interface GetRunResultRequest {
  readonly principal: TrustedTenantPrincipal;
  readonly runId: unknown;
  readonly representation?: unknown;
  readonly schemaErrors: readonly {
    readonly field: string;
    readonly message: string;
  }[];
  readonly requestId: string | null;
  readonly ipFingerprint: Buffer | null;
}

export interface GetRunResultService {
  get(request: GetRunResultRequest): Promise<RunResult>;
}

export interface GetRunResultServiceDependencies {
  readonly repository: GetRunResultRepository;
  readonly urlSigner: ResultUrlSigner;
}

function hasPathSchemaError(errors: GetRunResultRequest["schemaErrors"]): boolean {
  return errors.some(
    (error) => error.field === "params" || error.field === "run_id" || error.field === "/run_id",
  );
}

function parseRunId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw runQueryNotFound();
  }
  return value;
}

function parseRepresentation(value: unknown): RunResultRepresentation {
  if (value === undefined) return "normalized";
  if (value === "normalized" || value === "raw") return value;
  throw runResultValidationFailed([
    {
      field: "/representation",
      message: 'must be equal to one of the allowed values: "normalized", "raw"',
    },
  ]);
}

function parseArtifactByteCount(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw runResultInconsistent();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw runResultInconsistent();
  return parsed;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function validateSignedUrl(value: string, transport: "https" | "loopback-http"): void {
  try {
    const parsed = new URL(value);
    const https = transport === "https" && parsed.protocol === "https:";
    const localAzurite =
      transport === "loopback-http" &&
      parsed.protocol === "http:" &&
      isLoopbackHost(parsed.hostname);
    if ((!https && !localAzurite) || parsed.username !== "" || parsed.password !== "") {
      throw new Error("Signed result URL must be HTTPS or declared loopback HTTP");
    }
  } catch (cause) {
    throw runResultInconsistent(cause);
  }
}

export function createGetRunResultService(
  dependencies: GetRunResultServiceDependencies,
): GetRunResultService {
  return {
    async get(request): Promise<RunResult> {
      if (request.principal.kind !== "browser") throw accessDenied();
      if (hasPathSchemaError(request.schemaErrors)) throw runQueryNotFound();
      if (request.schemaErrors.length > 0) {
        throw runResultValidationFailed(request.schemaErrors);
      }

      const runId = parseRunId(request.runId);
      const representation = parseRepresentation(request.representation);
      const outcome = await dependencies.repository.findResult({
        tenantId: request.principal.tenantId,
        userId: request.principal.userId,
        runId,
        representation,
      });
      if (outcome.kind === "not_found") throw runQueryNotFound();
      if (outcome.kind === "not_ready") throw runResultNotReady();
      if (outcome.kind === "missing_artifact") throw runResultInconsistent();

      const byteCount = parseArtifactByteCount(outcome.artifact.byteCount);
      const checksumHex = outcome.artifact.checksum.toString("hex");
      let signed;
      try {
        signed = await dependencies.urlSigner.sign({
          objectKey: outcome.artifact.objectKey,
          tenantId: request.principal.tenantId,
          runId,
          contentType: outcome.artifact.contentType,
          byteCount,
          checksumHex,
        });
      } catch (error) {
        if (isResultUrlSigningUnavailableError(error)) {
          throw runResultSigningUnavailable(error);
        }
        if (error instanceof ApplicationError) throw error;
        throw runResultInconsistent(error);
      }

      validateSignedUrl(signed.downloadUrl, signed.transport);
      if (Number.isNaN(signed.expiresAt.valueOf())) throw runResultInconsistent();

      await dependencies.repository.recordDownloadAuthorization({
        tenantId: request.principal.tenantId,
        runId,
        artifactId: outcome.artifact.artifactId,
        representation,
        actor: { kind: "browser", userId: request.principal.userId },
        requestId: request.requestId,
        ipFingerprint: request.ipFingerprint,
      });

      return {
        run_id: runId,
        content_type: outcome.artifact.contentType,
        byte_count: byteCount,
        checksum: checksumHex,
        download_url: signed.downloadUrl,
        download_expires_at: signed.expiresAt.toISOString(),
      };
    },
  };
}
