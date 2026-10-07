import { isAbsolute } from "node:path";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { ConfigurationError } from "./environment.js";
import type { Pattern4DatabaseRuntimeConfig } from "./pattern4Environment.js";

const positiveInteger = z.coerce.number().int().positive();

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test"]),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    DATABASE_HOST: z.string().trim().min(1),
    DATABASE_PORT: z.coerce.number().int().min(1).max(65535),
    DATABASE_NAME: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/),
    DATABASE_OPERATOR_USER: z.string().regex(/^dhumi_[a-z0-9_]+_operator_login$/),
    DATABASE_OPERATOR_PASSWORD: z.string().min(20),
    DATABASE_POOL_MIN: z.coerce.number().int().min(0).default(0),
    DATABASE_POOL_MAX: positiveInteger.default(2),
    DATABASE_CONNECTION_TIMEOUT_MS: positiveInteger.default(5000),
    DATABASE_IDLE_TIMEOUT_MS: positiveInteger.default(10000),
    DATABASE_STATEMENT_TIMEOUT_MS: positiveInteger.default(15000),
    DATABASE_QUERY_TIMEOUT_MS: positiveInteger.default(15000),
    DATABASE_IDLE_TRANSACTION_TIMEOUT_MS: positiveInteger.default(10000),
    DATABASE_SSL_MODE: z.enum(["disable", "verify-full"]).default("disable"),
    DATABASE_SSL_CA_FILE: z.string().trim().optional(),
  })
  .superRefine((value, context) => {
    if (value.DATABASE_POOL_MIN > value.DATABASE_POOL_MAX) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_POOL_MIN"],
        message: "must be less than or equal to DATABASE_POOL_MAX",
      });
    }
    if (value.DATABASE_SSL_MODE === "verify-full" && !value.DATABASE_SSL_CA_FILE) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_SSL_CA_FILE"],
        message: "is required when DATABASE_SSL_MODE=verify-full",
      });
    }
  });

export interface OperatorRuntimeConfig {
  readonly nodeEnv: "development" | "test";
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  readonly database: Pattern4DatabaseRuntimeConfig;
}

function sslConfiguration(value: z.infer<typeof schema>): false | {
  readonly ca: string;
  readonly rejectUnauthorized: true;
} {
  if (value.DATABASE_SSL_MODE === "disable") return false;
  const path = value.DATABASE_SSL_CA_FILE as string;
  if (!isAbsolute(path)) throw new ConfigurationError("DATABASE_SSL_CA_FILE must be absolute");
  try {
    return { ca: readFileSync(path, "utf8"), rejectUnauthorized: true };
  } catch {
    throw new ConfigurationError("DATABASE_SSL_CA_FILE could not be read");
  }
}

export function loadOperatorConfig(
  source: NodeJS.ProcessEnv = process.env,
): OperatorRuntimeConfig {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = [...new Set(parsed.error.issues.map((issue) =>
      `${issue.path.join(".") || "environment"} (${issue.message})`,
    ))].sort();
    throw new ConfigurationError(`Invalid operator environment: ${issues.join(", ")}`);
  }
  const value = parsed.data;
  return Object.freeze({
    nodeEnv: value.NODE_ENV,
    logLevel: value.LOG_LEVEL,
    database: Object.freeze({
      host: value.DATABASE_HOST,
      port: value.DATABASE_PORT,
      database: value.DATABASE_NAME,
      credential: Object.freeze({
        user: value.DATABASE_OPERATOR_USER,
        password: value.DATABASE_OPERATOR_PASSWORD,
      }),
      poolMin: value.DATABASE_POOL_MIN,
      poolMax: value.DATABASE_POOL_MAX,
      connectionTimeoutMs: value.DATABASE_CONNECTION_TIMEOUT_MS,
      idleTimeoutMs: value.DATABASE_IDLE_TIMEOUT_MS,
      statementTimeoutMs: value.DATABASE_STATEMENT_TIMEOUT_MS,
      queryTimeoutMs: value.DATABASE_QUERY_TIMEOUT_MS,
      idleTransactionTimeoutMs: value.DATABASE_IDLE_TRANSACTION_TIMEOUT_MS,
      ssl: sslConfiguration(value),
    }),
  });
}
