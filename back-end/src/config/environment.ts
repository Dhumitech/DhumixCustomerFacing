import { addResultStorageChecks, resultStorageConfiguration, resultStorageEnvironmentShape, type ResultStorageRuntimeConfig } from "./resultStorageEnvironment.js";
export type { ResultStorageRuntimeConfig } from "./resultStorageEnvironment.js";
import { addDatabaseTlsChecks, databaseTlsConfiguration, databaseTlsEnvironmentShape } from "./databaseTlsEnvironment.js";
import { z } from "zod";

const roleName = z
  .string()
  .trim()
  .regex(/^[a-z_][a-z0-9_]{2,62}$/, "must be a valid PostgreSQL role name");

const identityLoginRole = roleName.regex(
  /^dhumi_[a-z0-9_]+_identity_login$/,
  "must follow the approved dhumi_<environment>_identity_login pattern",
);
const customerApiLoginRole = roleName.regex(
  /^dhumi_[a-z0-9_]+_customer_api_login$/,
  "must follow the approved dhumi_<environment>_customer_api_login pattern",
);
const admissionLoginRole = roleName.regex(
  /^dhumi_[a-z0-9_]+_admission_login$/,
  "must follow the approved dhumi_<environment>_admission_login pattern",
);
const resultRecorderLoginRole = roleName.regex(
  /^dhumi_[a-z0-9_]+_result_recorder_login$/,
  "must follow the approved dhumi_<environment>_result_recorder_login pattern",
);

const frontendOrigin = z.url().superRefine((value, context) => {
  const parsed = new URL(value);
  if (!(["http:", "https:"] as const).includes(parsed.protocol as "http:" | "https:")) {
    context.addIssue({ code: "custom", message: "must use http or https" });
    return;
  }

  if (parsed.origin !== value) {
    context.addIssue({ code: "custom", message: "must be an exact origin without a path" });
  }
});

// Argon2id parameters. 19456 KiB / 2 iterations / 1 lane is the OWASP minimum
// for Argon2id and is enforced as a floor: configuration may raise the cost but
// never lower it below the accepted baseline. The encoded PHC hash carries its
// own parameters, so raising these stays compatible with existing hashes and is
// applied to a stored hash on the next successful verification.
const ARGON2ID_MINIMUM_MEMORY_KIB = 19_456;
const ARGON2ID_MINIMUM_TIME_COST = 2;
const ACCESS_TOKEN_PRODUCTION_MAX_TTL_SECONDS = 3_600;
const ACCESS_TOKEN_NON_PRODUCTION_MAX_TTL_SECONDS = 1_296_000;

const legalDocumentSchema = z.object({
  document_type: z.string().trim().min(1).max(64),
  document_version: z.string().trim().min(1).max(64),
  content_hash: z.string().regex(/^[A-Fa-f0-9]{64}$/, "must be 64 hexadecimal characters"),
});

const legalCatalogueSchema = z.array(legalDocumentSchema).max(50);

const forbiddenRuntimeLoginRoles = new Set([
  "postgres",
  "dhumi_owner",
  "dhumi_customer_api",
  "dhumi_identity",
  "dhumi_admission",
  "dhumi_job_manager",
  "dhumi_result_recorder",
  "dhumi_outbox_dispatcher",
  "dhumi_envelope_janitor",
  "dhumi_operator",
]);

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().trim().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(1).default(0),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    FRONTEND_ORIGIN: frontendOrigin,

    DATABASE_HOST: z.string().trim().min(1),
    DATABASE_PORT: z.coerce.number().int().min(1).max(65_535).default(5432),
    DATABASE_NAME: z.string().trim().regex(/^[a-z_][a-z0-9_]{2,62}$/),
    DATABASE_IDENTITY_USER: identityLoginRole,
    DATABASE_IDENTITY_PASSWORD: z.string().min(20, "must contain at least 20 characters"),
    DATABASE_CUSTOMER_API_USER: customerApiLoginRole,
    DATABASE_CUSTOMER_API_PASSWORD: z.string().min(20, "must contain at least 20 characters"),
    DATABASE_ADMISSION_USER: admissionLoginRole,
    DATABASE_ADMISSION_PASSWORD: z.string().min(20, "must contain at least 20 characters"),
    DATABASE_POOL_MIN: z.coerce.number().int().min(0).max(10).default(0),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
    DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
    DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(15_000),
    DATABASE_QUERY_TIMEOUT_MS: z.coerce.number().int().min(100).max(180_000).default(20_000),
    DATABASE_IDLE_TRANSACTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(600_000)
      .default(30_000),
    ...databaseTlsEnvironmentShape,

    // Approved legal documents as a JSON array. Deliberately empty by default:
    // real document versions and content hashes come from approved legal text
    // and must never be invented. Production refuses to start while it is empty.
    LEGAL_DOCUMENTS: z.string().default("[]"),
    LEGAL_DISCLOSURE_VERSION: z.string().trim().max(64).optional(),

    PASSWORD_ARGON2_MEMORY_KIB: z.coerce
      .number()
      .int()
      .min(ARGON2ID_MINIMUM_MEMORY_KIB, "must not be below the accepted Argon2id baseline")
      .max(1_048_576)
      .default(ARGON2ID_MINIMUM_MEMORY_KIB),
    PASSWORD_ARGON2_TIME_COST: z.coerce
      .number()
      .int()
      .min(ARGON2ID_MINIMUM_TIME_COST, "must not be below the accepted Argon2id baseline")
      .max(16)
      .default(ARGON2ID_MINIMUM_TIME_COST),
    PASSWORD_ARGON2_PARALLELISM: z.coerce.number().int().min(1).max(4).default(1),

    // Browser session. The signing secret is a reference to a value supplied by
    // the environment or a secret manager; it is never a literal in any file.
    ACCESS_TOKEN_SECRET: z.string().min(32, "must contain at least 32 characters"),
    ACCESS_TOKEN_ISSUER: z.string().trim().min(1).max(200),
    ACCESS_TOKEN_AUDIENCE: z.string().trim().min(1).max(200),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(ACCESS_TOKEN_NON_PRODUCTION_MAX_TTL_SECONDS)
      .default(900),
    // auth_sessions carries CHECK (expires_at > issued_at), so a refresh
    // lifetime of zero or less fails at insert. The floor here prevents that
    // reaching the database at all.
    REFRESH_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(300)
      .max(7_776_000)
      .default(1_209_600),

    SESSION_COOKIE_NAME: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,64}$/).default("dhumi_refresh"),
    SESSION_COOKIE_SAMESITE: z.enum(["strict", "lax", "none"]).default("strict"),
    SESSION_COOKIE_PATH: z.string().trim().startsWith("/").default("/v1/auth"),
    SESSION_COOKIE_DOMAIN: z.string().trim().optional(),

    // Demo environment configuration, not approved platform limits.
    SIGNIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(1_000).default(10),
    SIGNIN_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(900_000),
    REFRESH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10_000).default(30),
    REFRESH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(900_000),
    // Lockout timings are PENDING-VERIFICATION in 05_Security/01.
    SIGNIN_LOCKOUT_THRESHOLD: z.coerce.number().int().min(3).max(100).default(10),
    SIGNIN_LOCKOUT_WINDOW_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(900_000),

    // Demo environment configuration, not an approved platform limit.
    // Project Specs 06_Operations/01 keeps published limits PENDING-VERIFICATION
    // until signed rate evidence and load tests exist.
    SIGNUP_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(1_000).default(5),
    SIGNUP_RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(86_400_000)
      .default(900_000),

    // Local/test worker secret adapter input. The Customer API does not consume
    // it; production must use a managed secret provider.
    BRIGHTDATA_API_KEY: z.string().trim().min(20).max(512).optional(),

    ...resultStorageEnvironmentShape,
    RESULT_DOWNLOAD_PROXY_URL: z.preprocess(value => value === "" ? undefined : value, z.url().optional()),
    // Dhumi-owned stored-sample safety controls. These are deliberately not
    // derived from provider purchase/export limits.
    MARKETPLACE_SAMPLE_DOWNLOAD_MAX_RECORDS: z.coerce.number().int().min(1).max(100).default(100),
    MARKETPLACE_SAMPLE_DOWNLOAD_MAX_BYTES: z.coerce.number().int().min(1_024).max(10_485_760).default(1_048_576),
    MARKETPLACE_SAMPLE_DOWNLOAD_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10_000).default(10),
    MARKETPLACE_SAMPLE_DOWNLOAD_RATE_WINDOW_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3_600),
  })
  .superRefine((value, context) => {
    if (value.RESULT_DOWNLOAD_PROXY_URL && value.RESULT_DOWNLOAD_PROXY_URL !== `${value.FRONTEND_ORIGIN}/blob`)
      context.addIssue({ code: "custom", path: ["RESULT_DOWNLOAD_PROXY_URL"], message: "must match FRONTEND_ORIGIN plus /blob" });
    if (forbiddenRuntimeLoginRoles.has(value.DATABASE_IDENTITY_USER)) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_IDENTITY_USER"],
        message: "must be a restricted runtime LOGIN role",
      });
    }

    if (forbiddenRuntimeLoginRoles.has(value.DATABASE_CUSTOMER_API_USER)) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_CUSTOMER_API_USER"],
        message: "must be a restricted runtime LOGIN role",
      });
    }

    if (forbiddenRuntimeLoginRoles.has(value.DATABASE_ADMISSION_USER)) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_ADMISSION_USER"],
        message: "must be a restricted runtime LOGIN role",
      });
    }
    if (value.DATABASE_IDENTITY_USER === value.DATABASE_CUSTOMER_API_USER) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_CUSTOMER_API_USER"],
        message: "must be different from DATABASE_IDENTITY_USER",
      });
    }

    if (
      value.DATABASE_ADMISSION_USER === value.DATABASE_IDENTITY_USER ||
      value.DATABASE_ADMISSION_USER === value.DATABASE_CUSTOMER_API_USER
    ) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_ADMISSION_USER"],
        message: "must be different from the Identity and Customer API LOGIN roles",
      });
    }

    if (value.DATABASE_POOL_MIN > value.DATABASE_POOL_MAX) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_POOL_MIN"],
        message: "must not exceed DATABASE_POOL_MAX",
      });
    }

    if (value.NODE_ENV === "production" && value.DATABASE_SSL_MODE !== "verify-full") {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_SSL_MODE"],
        message: "must be verify-full in production",
      });
    }

    if (
      value.NODE_ENV === "production" &&
      value.ACCESS_TOKEN_TTL_SECONDS > ACCESS_TOKEN_PRODUCTION_MAX_TTL_SECONDS
    ) {
      context.addIssue({
        code: "custom",
        path: ["ACCESS_TOKEN_TTL_SECONDS"],
        message: "must not exceed 3600 seconds in production",
      });
    }

    addDatabaseTlsChecks(value, context);

    if (value.NODE_ENV === "production" && value.BRIGHTDATA_API_KEY !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["BRIGHTDATA_API_KEY"],
        message: "environment credential fallback is forbidden in production",
      });
    }

    addResultStorageChecks(value, context);
  });

const resultRecorderEnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    DATABASE_HOST: z.string().trim().min(1),
    DATABASE_PORT: z.coerce.number().int().min(1).max(65_535).default(5432),
    DATABASE_NAME: z.string().trim().regex(/^[a-z_][a-z0-9_]{2,62}$/),
    DATABASE_RESULT_RECORDER_USER: resultRecorderLoginRole,
    DATABASE_RESULT_RECORDER_PASSWORD: z
      .string()
      .min(20, "must contain at least 20 characters"),
    DATABASE_POOL_MIN: z.coerce.number().int().min(0).max(10).default(0),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(10).default(2),
    DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
    DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(15_000),
    DATABASE_QUERY_TIMEOUT_MS: z.coerce.number().int().min(100).max(180_000).default(20_000),
    DATABASE_IDLE_TRANSACTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(600_000)
      .default(30_000),
    ...databaseTlsEnvironmentShape,
    ...resultStorageEnvironmentShape,
    RESULT_STORAGE_DRIVER: z.enum(["azurite", "azure_blob"]),
  })
  .superRefine((value, context) => {
    if (forbiddenRuntimeLoginRoles.has(value.DATABASE_RESULT_RECORDER_USER)) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_RESULT_RECORDER_USER"],
        message: "must be a restricted runtime LOGIN role",
      });
    }
    if (value.DATABASE_POOL_MIN > value.DATABASE_POOL_MAX) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_POOL_MIN"],
        message: "must not exceed DATABASE_POOL_MAX",
      });
    }
    addResultStorageChecks(value, context);
    addDatabaseTlsChecks(value, context);
  });

export class ConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export interface DatabaseCredentialConfig {
  readonly user: string;
  readonly password: string;
}

export interface DatabaseRuntimeConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly identity: DatabaseCredentialConfig;
  readonly customerApi: DatabaseCredentialConfig;
  readonly admission: DatabaseCredentialConfig;
  readonly poolMin: number;
  readonly poolMax: number;
  readonly connectionTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly queryTimeoutMs: number;
  readonly idleTransactionTimeoutMs: number;
  readonly ssl: false | { readonly ca: string; readonly rejectUnauthorized: true };
}

export interface ResultRecorderDatabaseRuntimeConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly credential: DatabaseCredentialConfig;
  readonly poolMin: number;
  readonly poolMax: number;
  readonly connectionTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly queryTimeoutMs: number;
  readonly idleTransactionTimeoutMs: number;
  readonly ssl: false | { readonly ca: string; readonly rejectUnauthorized: true };
}

export interface LegalDocument {
  readonly documentType: string;
  readonly documentVersion: string;
  readonly contentHash: string;
}

export interface LegalRuntimeConfig {
  /** Every approved document version a signup may reference. */
  readonly documents: readonly LegalDocument[];
  /**
   * Distinct document types a signup must accept. Derived from the catalogue,
   * so listing two versions of one document does not require two acceptances.
   */
  readonly requiredDocumentTypes: readonly string[];
  /** Server-side stamp; the public contract cannot carry this field. */
  readonly disclosureVersion: string | null;
}

export interface PasswordHashConfig {
  readonly memoryKib: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

export interface RateLimitConfig {
  readonly max: number;
  readonly windowMs: number;
}

export interface AccessTokenConfig {
  readonly secret: string;
  readonly issuer: string;
  readonly audience: string;
  readonly ttlSeconds: number;
}

export interface SessionCookieConfig {
  readonly name: string;
  readonly sameSite: "strict" | "lax" | "none";
  readonly path: string;
  readonly domain: string | undefined;
  readonly secure: boolean;
}

export interface SessionConfig {
  readonly accessToken: AccessTokenConfig;
  readonly refreshTtlSeconds: number;
  readonly cookie: SessionCookieConfig;
}

export interface LockoutConfig {
  readonly threshold: number;
  readonly windowMs: number;
}

export interface MarketplaceSampleDownloadRuntimeConfig {
  readonly maxRecords: number;
  readonly maxBytes: number;
  readonly rateLimitMax: number;
  readonly rateWindowSeconds: number;
  readonly downloadTtlSeconds: number;
}

export interface RuntimeConfig {
  /** One private edge proxy only; direct runtime rejects forwarded identity. */
  readonly trustedProxyHops?: number;
  readonly nodeEnv: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  readonly frontendOrigin: string;
  readonly providerEnvironment: "local" | "test" | "production";
  readonly database: DatabaseRuntimeConfig;
  readonly legal: LegalRuntimeConfig;
  readonly passwordHash: PasswordHashConfig;
  readonly signupRateLimit: RateLimitConfig;
  readonly signInRateLimit: RateLimitConfig;
  readonly refreshRateLimit: RateLimitConfig;
  readonly session: SessionConfig;
  readonly lockout: LockoutConfig;
  readonly resultStorage: ResultStorageRuntimeConfig;
  readonly marketplaceSampleDownload: MarketplaceSampleDownloadRuntimeConfig;
}

export interface ResultRecorderRuntimeConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  readonly database: ResultRecorderDatabaseRuntimeConfig;
  readonly resultStorage: ResultStorageRuntimeConfig & { readonly driver: "azurite" | "azure_blob" };
}

function formatConfigurationIssues(error: z.ZodError): string {
  const issues = [
    ...new Set(
      error.issues.map(
        (issue) => `${issue.path.join(".") || "environment"} (${issue.message})`,
      ),
    ),
  ];
  return `Invalid environment configuration: ${issues.sort().join(", ")}`;
}

function parseLegalCatalogue(raw: string, nodeEnv: string): LegalRuntimeConfig["documents"] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new ConfigurationError("LEGAL_DOCUMENTS must be a valid JSON array");
  }

  const parsed = legalCatalogueSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new ConfigurationError(
      `Invalid LEGAL_DOCUMENTS: ${formatConfigurationIssues(parsed.error)}`,
    );
  }

  const seen = new Set<string>();
  for (const entry of parsed.data) {
    const identity = `${entry.document_type}@${entry.document_version}`;
    if (seen.has(identity)) {
      throw new ConfigurationError(
        `LEGAL_DOCUMENTS contains a duplicate document type and version: ${identity}`,
      );
    }
    seen.add(identity);
  }

  // Fail closed. An empty catalogue accepts whatever the customer asserts, which
  // records consent that cannot be proven against approved document text.
  if (nodeEnv === "production" && parsed.data.length === 0) {
    throw new ConfigurationError(
      "LEGAL_DOCUMENTS must list the approved legal documents in production",
    );
  }

  return parsed.data.map((entry) =>
    Object.freeze({
      documentType: entry.document_type,
      documentVersion: entry.document_version,
      contentHash: entry.content_hash.toLowerCase(),
    }),
  );
}

export function loadRuntimeConfig(source: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const parsed = environmentSchema.safeParse(source);

  if (!parsed.success) {
    throw new ConfigurationError(formatConfigurationIssues(parsed.error));
  }

  const value = parsed.data;

  if (value.NODE_ENV === "production") {
    const requiredMarketplaceControls = [
      "MARKETPLACE_SAMPLE_DOWNLOAD_MAX_RECORDS",
      "MARKETPLACE_SAMPLE_DOWNLOAD_MAX_BYTES",
      "MARKETPLACE_SAMPLE_DOWNLOAD_RATE_LIMIT_MAX",
      "MARKETPLACE_SAMPLE_DOWNLOAD_RATE_WINDOW_SECONDS",
    ] as const;
    const missing = requiredMarketplaceControls.filter((name) => source[name] === undefined);
    if (missing.length > 0) {
      throw new ConfigurationError(
        `Production Marketplace sample-download controls must be explicit: ${missing.join(", ")}`,
      );
    }
  }

  // Validate declared configuration before touching the filesystem, so a shape
  // error is reported ahead of an unreadable certificate path.
  const legalDocuments = parseLegalCatalogue(value.LEGAL_DOCUMENTS, value.NODE_ENV);
  const requiredDocumentTypes = [
    ...new Set(legalDocuments.map((document) => document.documentType)),
  ].sort();

  const ssl = databaseTlsConfiguration(value, ConfigurationError);

  return Object.freeze({
    nodeEnv: value.NODE_ENV,
    host: value.HOST,
    trustedProxyHops: value.TRUST_PROXY_HOPS,
    port: value.PORT,
    logLevel: value.LOG_LEVEL,
    frontendOrigin: value.FRONTEND_ORIGIN,
    providerEnvironment:
      value.NODE_ENV === "development" ? "local" : value.NODE_ENV,
    legal: Object.freeze({
      documents: Object.freeze(legalDocuments),
      requiredDocumentTypes: Object.freeze(requiredDocumentTypes),
      disclosureVersion: value.LEGAL_DISCLOSURE_VERSION ?? null,
    }),
    passwordHash: Object.freeze({
      memoryKib: value.PASSWORD_ARGON2_MEMORY_KIB,
      timeCost: value.PASSWORD_ARGON2_TIME_COST,
      parallelism: value.PASSWORD_ARGON2_PARALLELISM,
    }),
    signupRateLimit: Object.freeze({
      max: value.SIGNUP_RATE_LIMIT_MAX,
      windowMs: value.SIGNUP_RATE_LIMIT_WINDOW_MS,
    }),
    signInRateLimit: Object.freeze({
      max: value.SIGNIN_RATE_LIMIT_MAX,
      windowMs: value.SIGNIN_RATE_LIMIT_WINDOW_MS,
    }),
    refreshRateLimit: Object.freeze({
      max: value.REFRESH_RATE_LIMIT_MAX,
      windowMs: value.REFRESH_RATE_LIMIT_WINDOW_MS,
    }),
    session: Object.freeze({
      accessToken: Object.freeze({
        secret: value.ACCESS_TOKEN_SECRET,
        issuer: value.ACCESS_TOKEN_ISSUER,
        audience: value.ACCESS_TOKEN_AUDIENCE,
        ttlSeconds: value.ACCESS_TOKEN_TTL_SECONDS,
      }),
      refreshTtlSeconds: value.REFRESH_TOKEN_TTL_SECONDS,
      cookie: Object.freeze({
        name: value.SESSION_COOKIE_NAME,
        sameSite: value.SESSION_COOKIE_SAMESITE,
        path: value.SESSION_COOKIE_PATH,
        domain: value.SESSION_COOKIE_DOMAIN,
        // Never negotiable in production. A refresh cookie sent over plaintext
        // is a session handed to anyone on the path.
        secure: value.NODE_ENV === "production" || new URL(value.FRONTEND_ORIGIN).protocol === "https:",
      }),
    }),
    lockout: Object.freeze({
      threshold: value.SIGNIN_LOCKOUT_THRESHOLD,
      windowMs: value.SIGNIN_LOCKOUT_WINDOW_MS,
    }),
    resultStorage: resultStorageConfiguration(value),
    marketplaceSampleDownload: Object.freeze({
      maxRecords: value.MARKETPLACE_SAMPLE_DOWNLOAD_MAX_RECORDS,
      maxBytes: value.MARKETPLACE_SAMPLE_DOWNLOAD_MAX_BYTES,
      rateLimitMax: value.MARKETPLACE_SAMPLE_DOWNLOAD_RATE_LIMIT_MAX,
      rateWindowSeconds: value.MARKETPLACE_SAMPLE_DOWNLOAD_RATE_WINDOW_SECONDS,
      downloadTtlSeconds: value.RESULT_DOWNLOAD_TTL_SECONDS,
    }),
    database: Object.freeze({
      host: value.DATABASE_HOST,
      port: value.DATABASE_PORT,
      database: value.DATABASE_NAME,
      identity: Object.freeze({
        user: value.DATABASE_IDENTITY_USER,
        password: value.DATABASE_IDENTITY_PASSWORD,
      }),
      customerApi: Object.freeze({
        user: value.DATABASE_CUSTOMER_API_USER,
        password: value.DATABASE_CUSTOMER_API_PASSWORD,
      }),
      admission: Object.freeze({
        user: value.DATABASE_ADMISSION_USER,
        password: value.DATABASE_ADMISSION_PASSWORD,
      }),
      poolMin: value.DATABASE_POOL_MIN,
      poolMax: value.DATABASE_POOL_MAX,
      connectionTimeoutMs: value.DATABASE_CONNECTION_TIMEOUT_MS,
      idleTimeoutMs: value.DATABASE_IDLE_TIMEOUT_MS,
      statementTimeoutMs: value.DATABASE_STATEMENT_TIMEOUT_MS,
      queryTimeoutMs: value.DATABASE_QUERY_TIMEOUT_MS,
      idleTransactionTimeoutMs: value.DATABASE_IDLE_TRANSACTION_TIMEOUT_MS,
      ssl,
    }),
  });
}

export function loadResultRecorderConfig(
  source: NodeJS.ProcessEnv = process.env,
): ResultRecorderRuntimeConfig {
  const parsed = resultRecorderEnvironmentSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigurationError(formatConfigurationIssues(parsed.error));
  }
  const value = parsed.data;
  const ssl = databaseTlsConfiguration(value, ConfigurationError);

  return Object.freeze({
    nodeEnv: value.NODE_ENV,
    logLevel: value.LOG_LEVEL,
    database: Object.freeze({
      host: value.DATABASE_HOST,
      port: value.DATABASE_PORT,
      database: value.DATABASE_NAME,
      credential: Object.freeze({
        user: value.DATABASE_RESULT_RECORDER_USER,
        password: value.DATABASE_RESULT_RECORDER_PASSWORD,
      }),
      poolMin: value.DATABASE_POOL_MIN,
      poolMax: value.DATABASE_POOL_MAX,
      connectionTimeoutMs: value.DATABASE_CONNECTION_TIMEOUT_MS,
      idleTimeoutMs: value.DATABASE_IDLE_TIMEOUT_MS,
      statementTimeoutMs: value.DATABASE_STATEMENT_TIMEOUT_MS,
      queryTimeoutMs: value.DATABASE_QUERY_TIMEOUT_MS,
      idleTransactionTimeoutMs: value.DATABASE_IDLE_TRANSACTION_TIMEOUT_MS,
      ssl,
    }),
    resultStorage: resultStorageConfiguration(value) as ResultRecorderRuntimeConfig["resultStorage"],
  });
}
