/** One private deployment file, projected into the credentials each process uses. */
export type DeploymentRole = "api" | "outbox" | "jobs" | "storage";

const database = [
  "DATABASE_HOST", "DATABASE_PORT", "DATABASE_NAME", "DATABASE_SSL_MODE",
  "DATABASE_SSL_CA_FILE", "DATABASE_SSL_CA_BASE64", "DATABASE_POOL_MIN", "DATABASE_POOL_MAX",
  "DATABASE_CONNECTION_TIMEOUT_MS", "DATABASE_IDLE_TIMEOUT_MS",
  "DATABASE_STATEMENT_TIMEOUT_MS", "DATABASE_QUERY_TIMEOUT_MS",
  "DATABASE_IDLE_TRANSACTION_TIMEOUT_MS",
] as const;
const storage = [
  "RESULT_STORAGE_DRIVER", "RESULT_STORAGE_CONTAINER", "RESULT_STORAGE_CONNECTION_STRING",
  "RESULT_DOWNLOAD_PROXY_URL", "RESULT_DOWNLOAD_TTL_SECONDS", "RESULT_MAX_BYTES",
  "AZURE_STORAGE_ACCOUNT_NAME", "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET",
] as const;
const queue = ["SERVICE_BUS_DRIVER", "SERVICE_BUS_CONNECTION_STRING", "SERVICE_BUS_RUN_COMMAND_QUEUE",
  "SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE", "SERVICE_BUS_TENANT_ID"] as const;
const credential = (name: string): string[] => [`DATABASE_${name}_USER`, `DATABASE_${name}_PASSWORD`];
const common = ["NODE_ENV", "LOG_LEVEL", "TZ"] as const;
const keys: Record<DeploymentRole, readonly string[]> = {
  api: [
    ...common, ...database, ...storage,
    ...credential("IDENTITY"), ...credential("CUSTOMER_API"), ...credential("ADMISSION"),
    "HOST", "PORT", "TRUST_PROXY_HOPS", "FRONTEND_ORIGIN", "APP_PUBLIC_URL", "APP_ENVIRONMENT",
    "DEMO_DISABLE_OTP", "ORGANIZATION_COLLABORATION_ENABLED", "ORGANIZATION_INVITE_RESEND_LIFETIME_DAYS",
    "LEGAL_DOCUMENTS", "LEGAL_DISCLOSURE_VERSION",
    "PASSWORD_ARGON2_MEMORY_KIB", "PASSWORD_ARGON2_TIME_COST", "PASSWORD_ARGON2_PARALLELISM",
    "ACCESS_TOKEN_SECRET", "ACCESS_TOKEN_ISSUER", "ACCESS_TOKEN_AUDIENCE", "ACCESS_TOKEN_TTL_SECONDS",
    "REFRESH_TOKEN_TTL_SECONDS", "SESSION_COOKIE_NAME", "SESSION_COOKIE_SAMESITE",
    "SESSION_COOKIE_PATH", "SESSION_COOKIE_DOMAIN",
    "SIGNUP_RATE_LIMIT_MAX", "SIGNUP_RATE_LIMIT_WINDOW_MS", "SIGNIN_RATE_LIMIT_MAX",
    "SIGNIN_RATE_LIMIT_WINDOW_MS", "REFRESH_RATE_LIMIT_MAX", "REFRESH_RATE_LIMIT_WINDOW_MS",
    "SIGNIN_LOCKOUT_THRESHOLD", "SIGNIN_LOCKOUT_WINDOW_MS",
    "MARKETPLACE_SAMPLE_DOWNLOAD_MAX_RECORDS", "MARKETPLACE_SAMPLE_DOWNLOAD_MAX_BYTES",
    "MARKETPLACE_SAMPLE_DOWNLOAD_RATE_LIMIT_MAX", "MARKETPLACE_SAMPLE_DOWNLOAD_RATE_WINDOW_SECONDS",
    "OTP_SECRET", "EMAIL_DRIVER", "EMAIL_FROM", "ACS_EMAIL_ENDPOINT", "ACS_EMAIL_ACCESS_KEY",
  ],
  outbox: [
    ...common, ...database, ...queue, ...credential("OUTBOX_DISPATCHER"),
    "SERVICE_BUS_SENDER_CLIENT_ID", "SERVICE_BUS_SENDER_CLIENT_SECRET",
    "OUTBOX_DISPATCHER_ID", "OUTBOX_DISPATCHER_BATCH_SIZE", "OUTBOX_DISPATCHER_INTERVAL_MS",
    "OUTBOX_DISPATCHER_CLAIM_TTL_MS",
  ],
  jobs: [
    ...common, ...database, ...queue, ...storage,
    "SERVICE_BUS_RECEIVER_CLIENT_ID", "SERVICE_BUS_RECEIVER_CLIENT_SECRET",
    ...credential("JOB_MANAGER"), ...credential("RESULT_RECORDER"),
    "JOB_MANAGER_CONCURRENCY", "JOB_MANAGER_ATTEMPT_LEASE_MS", "JOB_MANAGER_RENEW_INTERVAL_MS",
    "REDIS_URL", "REDIS_LEASE_PREFIX", "REDIS_CAPACITY_LEASE_MS",
    "RUN_EXECUTOR_DRIVER", "SHARED_SCRAPER_PIPELINE_ENABLED", "PROVIDER_SECRET_DRIVER",
    "BRIGHTDATA_API_KEY", "PROVIDER_REFERENCE_LOCAL_KEY", "BRIGHTDATA_REQUEST_TIMEOUT_MS",
    "BRIGHTDATA_CONTROL_RESPONSE_MAX_BYTES", "BRIGHTDATA_POLL_INTERVAL_MS",
    "BRIGHTDATA_POLL_MAX_ELAPSED_MS", "BRIGHTDATA_POLL_MAX_CONSECUTIVE_FAILURES",
  ],
  storage: [...common, ...storage],
};

// Inherit only OS/tooling settings. Ambient app secrets and NODE_OPTIONS cannot
// override the explicit deployment file or cross a process credential boundary.
const operatingSystemKeys = [
  "PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "WINDIR", "ComSpec", "COMSPEC",
  "PATHEXT", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramData",
] as const;

export function projectDeploymentEnvironment(
  role: DeploymentRole,
  source: Readonly<NodeJS.ProcessEnv>,
  inherited: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
  const allowed = keys[role];
  if (!allowed) throw new Error("Unknown deployment process role");
  const result: NodeJS.ProcessEnv = {};
  for (const key of operatingSystemKeys) {
    if (inherited[key] !== undefined) result[key] = inherited[key];
  }
  for (const key of allowed) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}
