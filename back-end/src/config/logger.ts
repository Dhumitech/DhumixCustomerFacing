import type { LoggerOptions } from "pino";

const REDACTED = "[REDACTED]";
const SAFE_PROVIDER_REASONS = new Set([
  "PROVIDER_HTTP_400",
  "PROVIDER_HTTP_402",
  "PROVIDER_HTTP_404",
  "PROVIDER_SNAPSHOT_NOT_READY",
  "PROVIDER_STATUS_UNKNOWN",
  "PROVIDER_HTTP_422",
  "PROVIDER_RESPONSE_SHAPE_INVALID",
  "PROVIDER_SNAPSHOT_REFERENCE_MISSING",
  "PROVIDER_SNAPSHOT_REFERENCE_INVALID",
  "PROVIDER_RESULT_MEDIA_TYPE_INVALID",
  "PROVIDER_RESULT_BODY_MISSING",
  "PROVIDER_RESULT_ENCODING_INVALID",
  "PROVIDER_RESULT_LENGTH_INVALID",
  "PROVIDER_RESULT_TOO_LARGE",
  "PROVIDER_CONTROL_MEDIA_TYPE_INVALID",
  "PROVIDER_CONTROL_BODY_MISSING",
  "PROVIDER_CONTROL_LENGTH_INVALID",
  "PROVIDER_CONTROL_TOO_LARGE",
  "PROVIDER_CONTROL_JSON_INVALID",
]);

interface LoggerRuntimeConfig {
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  readonly nodeEnv: "development" | "test" | "production";
}

interface FastifyLogRequest {
  readonly method?: string;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly host?: string;
  readonly ip?: string;
  readonly socket?: { readonly remotePort?: number };
}

interface SafeErrorLogContext {
  readonly error: {
    readonly type: string;
    readonly code?: string;
    readonly safeReason?: string;
    readonly observedByteCount?: number;
    readonly maximumByteCount?: number;
    readonly stack?: string;
  };
}

function safeErrorCode(error: Error): string | undefined {
  const code = (error as Error & { readonly code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : undefined;
}

function safeErrorType(name: string): string {
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) ? name : "Error";
}

function safeErrorReason(error: Error): string | undefined {
  const reason = (error as Error & { readonly safeReason?: unknown }).safeReason;
  return typeof reason === "string" && SAFE_PROVIDER_REASONS.has(reason)
    ? reason
    : undefined;
}

function safeByteBoundary(error: Error, safeReason: string | undefined): Readonly<{
  observedByteCount: number;
  maximumByteCount: number;
}> | undefined {
  if (safeReason !== "PROVIDER_CONTROL_TOO_LARGE") return undefined;
  const candidate = error as Error & {
    readonly observedByteCount?: unknown;
    readonly maximumByteCount?: unknown;
  };
  if (
    !Number.isSafeInteger(candidate.observedByteCount) ||
    (candidate.observedByteCount as number) < 0 ||
    !Number.isSafeInteger(candidate.maximumByteCount) ||
    (candidate.maximumByteCount as number) < 1
  ) {
    return undefined;
  }
  return {
    observedByteCount: candidate.observedByteCount as number,
    maximumByteCount: candidate.maximumByteCount as number,
  };
}

function stackFramesOnly(stack: string | undefined): string | undefined {
  if (stack === undefined) return undefined;
  const firstLineEnd = stack.indexOf("\n");
  return firstLineEnd === -1 ? undefined : stack.slice(firstLineEnd + 1);
}

/**
 * Retains error type/code/frames for diagnosis while deliberately omitting
 * messages and causes, which may contain credentials or database values.
 */
export function safeErrorLogContext(error: unknown): SafeErrorLogContext {
  if (!(error instanceof Error)) {
    return { error: { type: "NonErrorThrown" } };
  }
  const code = safeErrorCode(error);
  const safeReason = safeErrorReason(error);
  const byteBoundary = safeByteBoundary(error, safeReason);
  const stack = stackFramesOnly(error.stack);
  return {
    error: {
      type: safeErrorType(error.name),
      ...(code === undefined ? {} : { code }),
      ...(safeReason === undefined ? {} : { safeReason }),
      ...(byteBoundary ?? {}),
      ...(stack === undefined ? {} : { stack }),
    },
  };
}

function requestPath(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const queryStart = url.indexOf("?");
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

function serializeRequest(request: FastifyLogRequest): Readonly<Record<string, unknown>> {
  return {
    method: request.method,
    url: requestPath(request.url),
    version: request.headers?.["accept-version"],
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

export function createLoggerOptions(
  config: LoggerRuntimeConfig,
  service = "dhumi-customer-facing-backend",
): LoggerOptions {
  return {
    level: config.logLevel,
    serializers: { req: serializeRequest },
    redact: {
      paths: [
        "verification.code", "body.code", "req.body.code", "email_link_token", "*.email_link_token", "req.body.email_link_token",
        "invite_token", "*.invite_token", "req.body.invite_token", "join_code", "*.join_code", "req.body.join_code",
        "new_password", "*.new_password", "req.body.new_password", "OTP_SECRET", "*.OTP_SECRET", "ACS_EMAIL_ACCESS_KEY", "*.ACS_EMAIL_ACCESS_KEY",
        "otpSecret", "*.otpSecret", "acsAccessKey", "*.acsAccessKey",
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers['x-csrf-token']",
        "res.headers.set-cookie",
        "authorization",
        "*.authorization",
        "*.*.authorization",
        "*.*.*.authorization",
        "cookie",
        "set-cookie",
        "password",
        "password_hash",
        "access_token",
        "refresh_token",
        "csrf_token",
        "api_key",
        "apiKey",
        "vaultSecretReference",
        "vault_secret_reference",
        "datasetId",
        "dataset_id",
        "snapshotReference",
        "snapshot_reference",
        "keyHash",
        "key_hash",
        "presentedHash",
        "presented_hash",
        "secret",
        "response_envelope_ciphertext",
        "response_envelope_key_reference",
        "config.responseEnvelope.localKeyBase64Url",
        "responseEnvelope.localKeyBase64Url",
        "config.brightDataCanary.apiKey",
        "brightDataCanary.apiKey",
        "config.resultStorage.connectionString",
        "resultStorage.connectionString",
        "RESULT_STORAGE_CONNECTION_STRING",
        "AZURE_CLIENT_SECRET", "*.AZURE_CLIENT_SECRET",
        "SERVICE_BUS_SENDER_CLIENT_SECRET", "*.SERVICE_BUS_SENDER_CLIENT_SECRET",
        "SERVICE_BUS_RECEIVER_CLIENT_SECRET", "*.SERVICE_BUS_RECEIVER_CLIENT_SECRET",
        "SERVICE_BUS_CONNECTION_STRING", "*.SERVICE_BUS_CONNECTION_STRING",
        "REDIS_URL", "*.REDIS_URL", "redisUrl", "config.redisUrl",
        "serviceBus.credential.clientSecret", "config.serviceBus.credential.clientSecret",
        "serviceBus.connectionString", "config.serviceBus.connectionString",
        "clientSecret", "*.clientSecret", "azure.clientSecret",
        "resultStorage.azure.clientSecret", "config.resultStorage.azure.clientSecret",
        "brightdata_api_key",
        "BRIGHTDATA_API_KEY",
        "PROVIDER_REFERENCE_LOCAL_KEY",
        "config.executor.providerReferenceLocalKey",
        "executor.providerReferenceLocalKey",
        "providerResourceCiphertext",
        "providerResourceFingerprint",
        "sourceProviderReferenceCiphertext",
        "sourceProviderReferenceFingerprint",
        "config.database.identity.password",
        "config.database.customerApi.password",
        "config.database.credential.password",
        "database.identity.password",
        "database.customerApi.password",
        "database.credential.password",
        "*.password",
        "*.*.password",
        "*.*.*.password",
        "*.csrf_token",
        "*.*.csrf_token",
        "*.*.*.csrf_token",
        "*.secret",
        "*.*.secret",
        "*.*.*.secret",
        "*.keyHash",
        "*.*.keyHash",
        "*.*.*.keyHash",
        "*.key_hash",
        "*.*.key_hash",
        "*.*.*.key_hash",
        "*.presentedHash",
        "*.*.presentedHash",
        "*.*.*.presentedHash",
        "*.presented_hash",
        "*.*.presented_hash",
        "*.*.*.presented_hash",
        "*.response_envelope_ciphertext",
        "*.*.response_envelope_ciphertext",
        "*.*.*.response_envelope_ciphertext",
        "*.response_envelope_key_reference",
        "*.*.response_envelope_key_reference",
        "*.*.*.response_envelope_key_reference",
        "*.apiKey",
        "*.*.apiKey",
        "*.*.*.apiKey",
        "*.vaultSecretReference",
        "*.*.vaultSecretReference",
        "*.*.*.vaultSecretReference",
        "*.vault_secret_reference",
        "*.*.vault_secret_reference",
        "*.*.*.vault_secret_reference",
        "*.datasetId",
        "*.*.datasetId",
        "*.*.*.datasetId",
        "*.dataset_id",
        "*.*.dataset_id",
        "*.*.*.dataset_id",
        "*.snapshotReference",
        "*.*.snapshotReference",
        "*.*.*.snapshotReference",
        "*.snapshot_reference",
        "*.*.snapshot_reference",
        "*.*.*.snapshot_reference",
      ],
      censor: REDACTED,
    },
    base: {
      service,
      environment: config.nodeEnv,
    },
  };
}
