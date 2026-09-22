import { Pool, type PoolConfig } from "pg";
import type {
  DatabaseCredentialConfig,
  DatabaseRuntimeConfig,
  EnvelopeJanitorDatabaseRuntimeConfig,
  ResultRecorderDatabaseRuntimeConfig,
} from "../../config/environment.js";
import type { Pattern4DatabaseRuntimeConfig } from "../../config/pattern4Environment.js";

export interface DatabasePools {
  readonly identity: Pool;
  readonly customerApi: Pool;
  readonly admission: Pool;
  close(): Promise<void>;
}

export type DatabasePoolName = "identity" | "customerApi" | "admission";
export type DatabasePoolErrorHandler = (poolName: DatabasePoolName, error: Error) => void;

type SharedDatabasePoolConfig = Omit<
  EnvelopeJanitorDatabaseRuntimeConfig,
  "credential"
>;

function createPoolConfig(
  config: SharedDatabasePoolConfig,
  credential: DatabaseCredentialConfig,
  applicationName: string,
): PoolConfig {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: credential.user,
    password: credential.password,
    application_name: applicationName,
    min: config.poolMin,
    max: config.poolMax,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    idleTimeoutMillis: config.idleTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    query_timeout: config.queryTimeoutMs,
    idle_in_transaction_session_timeout: config.idleTransactionTimeoutMs,
    ssl: config.ssl,
    allowExitOnIdle: false,
  };
}

export function createEnvelopeJanitorPool(
  config: EnvelopeJanitorDatabaseRuntimeConfig,
  onUnexpectedError: (error: Error) => void,
): Pool {
  const pool = new Pool(
    createPoolConfig(config, config.credential, "dhumi-envelope-janitor"),
  );
  pool.on("error", onUnexpectedError);
  return pool;
}

export function createResultRecorderPool(
  config: ResultRecorderDatabaseRuntimeConfig,
  onUnexpectedError: (error: Error) => void,
): Pool {
  const pool = new Pool(
    createPoolConfig(config, config.credential, "dhumi-result-recorder"),
  );
  pool.on("error", onUnexpectedError);
  return pool;
}

export function createOutboxDispatcherPool(
  config: Pattern4DatabaseRuntimeConfig,
  onUnexpectedError: (error: Error) => void,
): Pool {
  const pool = new Pool(
    createPoolConfig(config, config.credential, "dhumi-outbox-dispatcher"),
  );
  pool.on("error", onUnexpectedError);
  return pool;
}

export function createJobManagerPool(
  config: Pattern4DatabaseRuntimeConfig,
  onUnexpectedError: (error: Error) => void,
): Pool {
  const pool = new Pool(createPoolConfig(config, config.credential, "dhumi-job-manager"));
  pool.on("error", onUnexpectedError);
  return pool;
}

export function createOperatorPool(
  config: Pattern4DatabaseRuntimeConfig,
  onUnexpectedError: (error: Error) => void,
  applicationName = "dhumi-dlq-operator",
): Pool {
  const pool = new Pool(createPoolConfig(config, config.credential, applicationName));
  pool.on("error", onUnexpectedError);
  return pool;
}

export function createDatabasePools(
  config: DatabaseRuntimeConfig,
  onUnexpectedError: DatabasePoolErrorHandler,
): DatabasePools {
  const identity = new Pool(createPoolConfig(config, config.identity, "dhumi-identity"));
  const customerApi = new Pool(
    createPoolConfig(config, config.customerApi, "dhumi-customer-api"),
  );
  const admission = new Pool(
    createPoolConfig(config, config.admission, "dhumi-admission"),
  );

  // pg emits errors from idle clients through the Pool EventEmitter. Without
  // listeners, Node treats them as uncaught errors. The pool removes the
  // broken client; the application records the safe operational signal.
  identity.on("error", (error) => onUnexpectedError("identity", error));
  customerApi.on("error", (error) => onUnexpectedError("customerApi", error));
  admission.on("error", (error) => onUnexpectedError("admission", error));

  return {
    identity,
    customerApi,
    admission,
    async close(): Promise<void> {
      await Promise.all([identity.end(), customerApi.end(), admission.end()]);
    },
  };
}
