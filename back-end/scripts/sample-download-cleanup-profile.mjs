import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

// Used only during provisioning. The scheduled job receives this allowlist,
// never the API's full environment or any Bright Data credential.
export const cleanupEnvironmentKeys = Object.freeze([
  "NODE_ENV", "LOG_LEVEL", "DATABASE_HOST", "DATABASE_PORT", "DATABASE_NAME",
  "DATABASE_OPERATOR_USER", "DATABASE_OPERATOR_PASSWORD", "DATABASE_POOL_MIN",
  "DATABASE_POOL_MAX", "DATABASE_CONNECTION_TIMEOUT_MS", "DATABASE_IDLE_TIMEOUT_MS",
  "DATABASE_STATEMENT_TIMEOUT_MS", "DATABASE_QUERY_TIMEOUT_MS",
  "DATABASE_IDLE_TRANSACTION_TIMEOUT_MS", "DATABASE_SSL_MODE", "DATABASE_SSL_CA_FILE",
  "RESULT_STORAGE_DRIVER", "RESULT_STORAGE_CONNECTION_STRING", "RESULT_STORAGE_CONTAINER",
]);

export function selectCleanupEnvironment(text, expectedDatabase) {
  const source = parseEnv(text);
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(expectedDatabase) ||
      source.DATABASE_NAME !== expectedDatabase ||
      !["development", "test"].includes(source.NODE_ENV) ||
      source.RUN_EXECUTOR_DRIVER !== "controlled" || source.RESULT_STORAGE_DRIVER !== "azurite") {
    throw new Error("Cleanup provisioning requires the expected local database and controlled executor");
  }
  return { ...Object.fromEntries(cleanupEnvironmentKeys
    .filter((key) => source[key] !== undefined).map((key) => [key, source[key]])),
    // The private CLI emits its bounded summary at info level. API verbosity
    // must not suppress the job's completion evidence.
    LOG_LEVEL: "info",
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    // stdout is captured privately by the installer, never logged or printed.
    process.stdout.write(JSON.stringify(selectCleanupEnvironment(
      readFileSync(process.argv[2], "utf8"), process.argv[3],
    )));
  } catch {
    process.stderr.write("Cleanup profile extraction failed; no configuration values logged.\n");
    process.exitCode = 1;
  }
}
