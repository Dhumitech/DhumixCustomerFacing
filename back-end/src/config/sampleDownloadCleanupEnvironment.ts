import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { ConfigurationError } from "./environment.js";
import type { Pattern4DatabaseRuntimeConfig } from "./pattern4Environment.js";

// Storage maintenance must not require or load provider secrets/execution config.
const schema = z.object({
  NODE_ENV: z.enum(["development", "test"]),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_HOST: z.string().trim().min(1),
  DATABASE_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  DATABASE_NAME: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/),
  DATABASE_OPERATOR_USER: z.string().regex(/^dhumi_[a-z0-9_]+_operator_login$/),
  DATABASE_OPERATOR_PASSWORD: z.string().min(20),
  DATABASE_POOL_MIN: z.coerce.number().int().min(0).max(10).default(0),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(10).default(2),
  DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(5000),
  DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).default(10000),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(15000),
  DATABASE_QUERY_TIMEOUT_MS: z.coerce.number().int().min(100).max(180000).default(20000),
  DATABASE_IDLE_TRANSACTION_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).default(10000),
  DATABASE_SSL_MODE: z.enum(["disable", "verify-full"]).default("disable"),
  DATABASE_SSL_CA_FILE: z.string().trim().optional(),
  RESULT_STORAGE_DRIVER: z.literal("azurite"),
  RESULT_STORAGE_CONNECTION_STRING: z.string().trim().min(1),
  RESULT_STORAGE_CONTAINER: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/),
}).superRefine((value, context) => {
  if (value.DATABASE_POOL_MIN > value.DATABASE_POOL_MAX) {
    context.addIssue({ code: "custom", path: ["DATABASE_POOL_MIN"], message: "must not exceed DATABASE_POOL_MAX" });
  }
  if (value.DATABASE_SSL_MODE === "verify-full" && value.DATABASE_SSL_CA_FILE === undefined) {
    context.addIssue({ code: "custom", path: ["DATABASE_SSL_CA_FILE"], message: "is required for verify-full" });
  }
});

export function loadSampleDownloadCleanupConfig(source: NodeJS.ProcessEnv = process.env): {
  readonly nodeEnv: "development" | "test";
  readonly logLevel: z.infer<typeof schema>["LOG_LEVEL"];
  readonly database: Pattern4DatabaseRuntimeConfig;
  readonly storage: { readonly connectionString: string; readonly containerName: string };
} {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigurationError(`Invalid sample-download cleanup environment: ${
      [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))].sort().join(", ")
    }`);
  }
  const value = parsed.data;
  let ssl: Pattern4DatabaseRuntimeConfig["ssl"] = false;
  if (value.DATABASE_SSL_MODE === "verify-full") {
    const path = value.DATABASE_SSL_CA_FILE as string;
    if (!isAbsolute(path)) throw new ConfigurationError("DATABASE_SSL_CA_FILE must be absolute");
    try {
      ssl = { ca: readFileSync(path, "utf8"), rejectUnauthorized: true };
    } catch {
      throw new ConfigurationError("DATABASE_SSL_CA_FILE could not be read");
    }
  }
  return {
    nodeEnv: value.NODE_ENV,
    logLevel: value.LOG_LEVEL,
    database: {
      host: value.DATABASE_HOST,
      port: value.DATABASE_PORT,
      database: value.DATABASE_NAME,
      credential: { user: value.DATABASE_OPERATOR_USER, password: value.DATABASE_OPERATOR_PASSWORD },
      poolMin: value.DATABASE_POOL_MIN,
      poolMax: value.DATABASE_POOL_MAX,
      connectionTimeoutMs: value.DATABASE_CONNECTION_TIMEOUT_MS,
      idleTimeoutMs: value.DATABASE_IDLE_TIMEOUT_MS,
      statementTimeoutMs: value.DATABASE_STATEMENT_TIMEOUT_MS,
      queryTimeoutMs: value.DATABASE_QUERY_TIMEOUT_MS,
      idleTransactionTimeoutMs: value.DATABASE_IDLE_TRANSACTION_TIMEOUT_MS,
      ssl,
    },
    storage: { connectionString: value.RESULT_STORAGE_CONNECTION_STRING, containerName: value.RESULT_STORAGE_CONTAINER },
  };
}
