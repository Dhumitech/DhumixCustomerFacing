import { addResultStorageChecks, resultStorageConfiguration, resultStorageEnvironmentShape } from "./resultStorageEnvironment.js";
import { addDatabaseTlsChecks, databaseTlsConfiguration, databaseTlsEnvironmentShape } from "./databaseTlsEnvironment.js";
import { z } from "zod";
import { serviceBusEnvironmentShape, addServiceBusChecks, serviceBusConfiguration, type ServiceBusRuntimeConfig } from "./serviceBusEnvironment.js";
import { redisConnectionKind } from "./redisEnvironment.js";
export type { ServiceBusEmulatorRuntimeConfig } from "./serviceBusEnvironment.js";
import {
  ConfigurationError,
  type DatabaseCredentialConfig,
  type ResultStorageRuntimeConfig,
} from "./environment.js";

const logLevel = z
  .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
  .default("info");
const databaseRole = z
  .string()
  .trim()
  .regex(/^[a-z_][a-z0-9_]{2,62}$/);
const outboxDispatcherLoginRole = databaseRole.regex(
  /^dhumi_[a-z0-9_]+_outbox_dispatcher_login$/,
  "must follow the approved dhumi_<environment>_outbox_dispatcher_login pattern",
);
const jobManagerLoginRole = databaseRole.regex(
  /^dhumi_[a-z0-9_]+_job_manager_login$/,
  "must follow the approved dhumi_<environment>_job_manager_login pattern",
);
const operatorLoginRole = databaseRole.regex(
  /^dhumi_[a-z0-9_]+_operator_login$/,
  "must follow the approved dhumi_<environment>_operator_login pattern",
);
const localProviderReferenceKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

const databaseShape = {
  DATABASE_HOST: z.string().trim().min(1),
  DATABASE_PORT: z.coerce.number().int().min(1).max(65_535).default(5432),
  DATABASE_NAME: z.string().trim().regex(/^[a-z_][a-z0-9_]{2,62}$/),
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
};

const serviceBusShape = serviceBusEnvironmentShape;

function addSharedWorkerChecks(
  value: {
    readonly NODE_ENV: "development" | "test" | "production";
    readonly DATABASE_POOL_MIN: number;
    readonly DATABASE_POOL_MAX: number;
    readonly DATABASE_SSL_MODE: "disable" | "verify-full";
    readonly DATABASE_SSL_CA_FILE?: string | undefined;
    readonly DATABASE_SSL_CA_BASE64?: string | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (value.DATABASE_POOL_MIN > value.DATABASE_POOL_MAX) {
    context.addIssue({
      code: "custom",
      path: ["DATABASE_POOL_MIN"],
      message: "must not exceed DATABASE_POOL_MAX",
    });
  }
  addDatabaseTlsChecks(value, context);
  if (value.NODE_ENV === "production" && value.DATABASE_SSL_MODE !== "verify-full") {
    context.addIssue({ code: "custom", path: ["DATABASE_SSL_MODE"], message: "must be verify-full in production" });
  }
}

const outboxDispatcherSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: logLevel,
    ...databaseShape,
    DATABASE_OUTBOX_DISPATCHER_USER: outboxDispatcherLoginRole,
    DATABASE_OUTBOX_DISPATCHER_PASSWORD: z.string().min(20),
    ...serviceBusShape,
    OUTBOX_DISPATCHER_ID: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/),
    OUTBOX_DISPATCHER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
    OUTBOX_DISPATCHER_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
    OUTBOX_DISPATCHER_CLAIM_TTL_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(600_000)
      .default(60_000),
  })
  .superRefine((value, context) => { addSharedWorkerChecks(value, context); addServiceBusChecks(value, context, "sender"); });

const deadLetterRecoverySchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: logLevel,
    ...databaseShape,
    DATABASE_OPERATOR_USER: operatorLoginRole,
    DATABASE_OPERATOR_PASSWORD: z.string().min(20),
    ...serviceBusShape,
  })
  .superRefine((value, context) => { addSharedWorkerChecks(value, context); addServiceBusChecks(value, context, "receiver"); });

const jobManagerSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: logLevel,
    ...databaseShape,
    DATABASE_JOB_MANAGER_USER: jobManagerLoginRole,
    DATABASE_JOB_MANAGER_PASSWORD: z.string().min(20),
    DATABASE_RESULT_RECORDER_USER: z
      .string()
      .trim()
      .regex(/^dhumi_[a-z0-9_]+_result_recorder_login$/),
    DATABASE_RESULT_RECORDER_PASSWORD: z.string().min(20),
    ...serviceBusShape,
    JOB_MANAGER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
    JOB_MANAGER_ATTEMPT_LEASE_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(300_000)
      .default(60_000),
    JOB_MANAGER_RENEW_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(20_000),
    REDIS_URL: z.url(),
    REDIS_LEASE_PREFIX: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9:_-]{0,63}$/)
      .default("dhumi:run-capacity"),
    REDIS_CAPACITY_LEASE_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(300_000)
      .default(60_000),
    ...resultStorageEnvironmentShape,
    RESULT_STORAGE_DRIVER: z.enum(["azurite", "azure_blob"]),
    RUN_EXECUTOR_DRIVER: z.enum(["controlled", "bright_data"]).default("controlled"),
    SHARED_SCRAPER_PIPELINE_ENABLED: z.enum(["true", "false"]).default("false"),
    PROVIDER_SECRET_DRIVER: z.literal("environment").default("environment"),
    PROVIDER_REFERENCE_LOCAL_KEY: localProviderReferenceKey.optional(),
    BRIGHTDATA_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(65_000),
    BRIGHTDATA_CONTROL_RESPONSE_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(1_048_576)
      .default(65_536),
    BRIGHTDATA_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60_000)
      .default(2_000),
    BRIGHTDATA_POLL_MAX_ELAPSED_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(86_400_000)
      .default(900_000),
    BRIGHTDATA_POLL_MAX_CONSECUTIVE_FAILURES: z.coerce.number().int().min(1).max(100).default(5),
  })
  .superRefine((value, context) => {
    addSharedWorkerChecks(value, context);
    addServiceBusChecks(value, context, "receiver");
    if (value.JOB_MANAGER_RENEW_INTERVAL_MS * 2 >= value.JOB_MANAGER_ATTEMPT_LEASE_MS) {
      context.addIssue({
        code: "custom",
        path: ["JOB_MANAGER_RENEW_INTERVAL_MS"],
        message: "must be less than half of JOB_MANAGER_ATTEMPT_LEASE_MS",
      });
    }
    try { redisConnectionKind(value.REDIS_URL, value.NODE_ENV); } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["REDIS_URL"],
        message: error instanceof Error ? error.message : "Invalid Redis connection",
      });
    }
    addResultStorageChecks(value, context);
    if (value.RUN_EXECUTOR_DRIVER === "bright_data" && value.PROVIDER_REFERENCE_LOCAL_KEY === undefined) {
      context.addIssue({
        code: "custom",
        path: ["PROVIDER_REFERENCE_LOCAL_KEY"],
        message: "is required for the local Bright Data executor",
      });
    }
    if (value.BRIGHTDATA_POLL_INTERVAL_MS >= value.BRIGHTDATA_POLL_MAX_ELAPSED_MS) {
      context.addIssue({
        code: "custom",
        path: ["BRIGHTDATA_POLL_INTERVAL_MS"],
        message: "must be less than BRIGHTDATA_POLL_MAX_ELAPSED_MS",
      });
    }
  });

export interface Pattern4DatabaseRuntimeConfig {
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

export interface OutboxDispatcherRuntimeConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  readonly database: Pattern4DatabaseRuntimeConfig;
  readonly serviceBus: ServiceBusRuntimeConfig;
  readonly dispatcherId: string;
  readonly batchSize: number;
  readonly intervalMs: number;
  readonly claimTtlMs: number;
}

export interface JobManagerRuntimeConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  readonly database: Pattern4DatabaseRuntimeConfig;
  readonly resultRecorderDatabase: Pattern4DatabaseRuntimeConfig;
  readonly serviceBus: ServiceBusRuntimeConfig;
  readonly concurrency: number;
  readonly attemptLeaseMs: number;
  readonly renewIntervalMs: number;
  readonly redisUrl: string;
  readonly redisLeasePrefix: string;
  readonly redisCapacityLeaseMs: number;
  readonly resultStorage: ResultStorageRuntimeConfig & { readonly driver: "azurite" | "azure_blob" };
  readonly executor:
    | { readonly driver: "controlled" }
    | {
        readonly driver: "bright_data";
        readonly sharedScraperPipelineEnabled: boolean;
        readonly secretDriver: "environment";
        readonly providerReferenceLocalKey: string;
        readonly requestTimeoutMs: number;
        readonly controlResponseMaxBytes: number;
        readonly pollIntervalMs: number;
        readonly pollMaxElapsedMs: number;
        readonly pollMaxConsecutiveFailures: number;
      };
}

export interface DeadLetterRecoveryRuntimeConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  readonly database: Pattern4DatabaseRuntimeConfig;
  readonly serviceBus: ServiceBusRuntimeConfig;
}

function configurationIssues(error: z.ZodError): string {
  return [
    ...new Set(
      error.issues.map((issue) => `${issue.path.join(".") || "environment"} (${issue.message})`),
    ),
  ].join("; ");
}

function databaseConfiguration(
  value:
    | z.infer<typeof outboxDispatcherSchema>
    | z.infer<typeof jobManagerSchema>
    | z.infer<typeof deadLetterRecoverySchema>,
  credential: DatabaseCredentialConfig,
): Pattern4DatabaseRuntimeConfig {
  return Object.freeze({
    host: value.DATABASE_HOST,
    port: value.DATABASE_PORT,
    database: value.DATABASE_NAME,
    credential: Object.freeze(credential),
    poolMin: value.DATABASE_POOL_MIN,
    poolMax: value.DATABASE_POOL_MAX,
    connectionTimeoutMs: value.DATABASE_CONNECTION_TIMEOUT_MS,
    idleTimeoutMs: value.DATABASE_IDLE_TIMEOUT_MS,
    statementTimeoutMs: value.DATABASE_STATEMENT_TIMEOUT_MS,
    queryTimeoutMs: value.DATABASE_QUERY_TIMEOUT_MS,
    idleTransactionTimeoutMs: value.DATABASE_IDLE_TRANSACTION_TIMEOUT_MS,
    ssl: databaseTlsConfiguration(value, ConfigurationError),
  });
}

export function loadOutboxDispatcherConfig(
  source: NodeJS.ProcessEnv = process.env,
): OutboxDispatcherRuntimeConfig {
  const parsed = outboxDispatcherSchema.safeParse(source);
  if (!parsed.success) throw new ConfigurationError(configurationIssues(parsed.error));
  const value = parsed.data;
  return Object.freeze({
    nodeEnv: value.NODE_ENV,
    logLevel: value.LOG_LEVEL,
    database: databaseConfiguration(value, {
      user: value.DATABASE_OUTBOX_DISPATCHER_USER,
      password: value.DATABASE_OUTBOX_DISPATCHER_PASSWORD,
    }),
    serviceBus: serviceBusConfiguration(value, "sender"),
    dispatcherId: value.OUTBOX_DISPATCHER_ID,
    batchSize: value.OUTBOX_DISPATCHER_BATCH_SIZE,
    intervalMs: value.OUTBOX_DISPATCHER_INTERVAL_MS,
    claimTtlMs: value.OUTBOX_DISPATCHER_CLAIM_TTL_MS,
  });
}

export function loadJobManagerConfig(
  source: NodeJS.ProcessEnv = process.env,
): JobManagerRuntimeConfig {
  const parsed = jobManagerSchema.safeParse(source);
  if (!parsed.success) throw new ConfigurationError(configurationIssues(parsed.error));
  const value = parsed.data;
  const executor: JobManagerRuntimeConfig["executor"] =
    value.RUN_EXECUTOR_DRIVER === "controlled"
      ? Object.freeze({ driver: "controlled" as const })
      : Object.freeze({
          driver: "bright_data" as const,
          sharedScraperPipelineEnabled: value.SHARED_SCRAPER_PIPELINE_ENABLED === "true",
          secretDriver: value.PROVIDER_SECRET_DRIVER,
          providerReferenceLocalKey: value.PROVIDER_REFERENCE_LOCAL_KEY as string,
          requestTimeoutMs: value.BRIGHTDATA_REQUEST_TIMEOUT_MS,
          controlResponseMaxBytes: value.BRIGHTDATA_CONTROL_RESPONSE_MAX_BYTES,
          pollIntervalMs: value.BRIGHTDATA_POLL_INTERVAL_MS,
          pollMaxElapsedMs: value.BRIGHTDATA_POLL_MAX_ELAPSED_MS,
          pollMaxConsecutiveFailures: value.BRIGHTDATA_POLL_MAX_CONSECUTIVE_FAILURES,
        });
  return Object.freeze({
    nodeEnv: value.NODE_ENV,
    logLevel: value.LOG_LEVEL,
    database: databaseConfiguration(value, {
      user: value.DATABASE_JOB_MANAGER_USER,
      password: value.DATABASE_JOB_MANAGER_PASSWORD,
    }),
    resultRecorderDatabase: databaseConfiguration(value, {
      user: value.DATABASE_RESULT_RECORDER_USER,
      password: value.DATABASE_RESULT_RECORDER_PASSWORD,
    }),
    serviceBus: serviceBusConfiguration(value, "receiver"),
    concurrency: value.JOB_MANAGER_CONCURRENCY,
    attemptLeaseMs: value.JOB_MANAGER_ATTEMPT_LEASE_MS,
    renewIntervalMs: value.JOB_MANAGER_RENEW_INTERVAL_MS,
    redisUrl: value.REDIS_URL,
    redisLeasePrefix: value.REDIS_LEASE_PREFIX,
    redisCapacityLeaseMs: value.REDIS_CAPACITY_LEASE_MS,
    resultStorage: resultStorageConfiguration(value) as JobManagerRuntimeConfig["resultStorage"],
    executor,
  });
}

export function loadDeadLetterRecoveryConfig(
  source: NodeJS.ProcessEnv = process.env,
): DeadLetterRecoveryRuntimeConfig {
  const parsed = deadLetterRecoverySchema.safeParse(source);
  if (!parsed.success) throw new ConfigurationError(configurationIssues(parsed.error));
  const value = parsed.data;
  return Object.freeze({
    nodeEnv: value.NODE_ENV,
    logLevel: value.LOG_LEVEL,
    database: databaseConfiguration(value, {
      user: value.DATABASE_OPERATOR_USER,
      password: value.DATABASE_OPERATOR_PASSWORD,
    }),
    serviceBus: serviceBusConfiguration(value, "receiver"),
  });
}
