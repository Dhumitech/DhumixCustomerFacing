import { describe, expect, it } from "vitest";
import {
  loadDeadLetterRecoveryConfig,
  loadJobManagerConfig,
  loadOutboxDispatcherConfig,
} from "../../src/config/pattern4Environment.js";

const emulatorConnection =
  "Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;" +
  "SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;";

function common(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_HOST: "localhost",
    DATABASE_PORT: "5432",
    DATABASE_NAME: "dhumi_test",
    DATABASE_SSL_MODE: "disable",
    SERVICE_BUS_DRIVER: "emulator",
    SERVICE_BUS_CONNECTION_STRING: emulatorConnection,
    SERVICE_BUS_RUN_COMMAND_QUEUE: "dhumi-run-commands",
  };
}

function addJobManagerConfiguration(source: NodeJS.ProcessEnv): void {
  source.DATABASE_JOB_MANAGER_USER = "dhumi_test_job_manager_login";
  source.DATABASE_JOB_MANAGER_PASSWORD = "manager-password-at-least-20-characters";
  source.DATABASE_RESULT_RECORDER_USER = "dhumi_test_result_recorder_login";
  source.DATABASE_RESULT_RECORDER_PASSWORD = "recorder-password-at-least-20-characters";
  source.REDIS_URL = "redis://127.0.0.1:6379";
  source.RESULT_STORAGE_DRIVER = "azurite";
  source.RESULT_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
  source.RESULT_STORAGE_CONTAINER = "dhumi-results";
}

describe("Pattern 4 environment", () => {
  it("uses managed Azure Blob while retaining the independent local queue profile", () => {
    const source = common();
    addJobManagerConfiguration(source);
    Object.assign(source, { RESULT_STORAGE_DRIVER: "azure_blob", RESULT_STORAGE_CONNECTION_STRING: "",
      AZURE_STORAGE_ACCOUNT_NAME: "examplestorage123", AZURE_TENANT_ID: "11111111-1111-4111-8111-111111111111",
      AZURE_CLIENT_ID: "22222222-2222-4222-8222-222222222222", AZURE_CLIENT_SECRET: "test-only-client-secret" });
    const config = loadJobManagerConfig(source);
    expect(config.resultStorage).toMatchObject({ driver: "azure_blob", connectionString: null,
      azure: { accountName: "examplestorage123", clientSecret: "test-only-client-secret" } });
    expect(config.serviceBus.driver).toBe("emulator");
    source.AZURE_TENANT_ID = "";
    expect(() => loadJobManagerConfig(source)).toThrow(/AZURE_TENANT_ID/);
  });
  it("loads a restricted local DLQ operator configuration", () => {
    const source = common();
    source.DATABASE_OPERATOR_USER = "dhumi_test_operator_login";
    source.DATABASE_OPERATOR_PASSWORD = "operator-password-at-least-20-characters";

    expect(loadDeadLetterRecoveryConfig(source)).toMatchObject({
      serviceBus: { driver: "emulator", queueName: "dhumi-run-commands" },
      database: { credential: { user: "dhumi_test_operator_login" } },
    });
  });

  it("loads a restricted local dispatcher configuration", () => {
    const source = common();
    source.DATABASE_OUTBOX_DISPATCHER_USER = "dhumi_test_outbox_dispatcher_login";
    source.DATABASE_OUTBOX_DISPATCHER_PASSWORD = "dispatcher-password-at-least-20-characters";
    source.OUTBOX_DISPATCHER_ID = "test-dispatcher-1";

    expect(loadOutboxDispatcherConfig(source)).toMatchObject({
      dispatcherId: "test-dispatcher-1",
      batchSize: 20,
      claimTtlMs: 60_000,
      serviceBus: { driver: "emulator", queueName: "dhumi-run-commands" },
      database: { credential: { user: "dhumi_test_outbox_dispatcher_login" } },
    });
  });

  it("loads a restricted local Job Manager and validates renewal headroom", () => {
    const source = common();
    addJobManagerConfiguration(source);
    source.JOB_MANAGER_ATTEMPT_LEASE_MS = "60000";
    source.JOB_MANAGER_RENEW_INTERVAL_MS = "20000";

    expect(loadJobManagerConfig(source)).toMatchObject({
      concurrency: 2,
      attemptLeaseMs: 60_000,
      renewIntervalMs: 20_000,
      redisUrl: "redis://127.0.0.1:6379",
      database: { credential: { user: "dhumi_test_job_manager_login" } },
      resultRecorderDatabase: {
        credential: { user: "dhumi_test_result_recorder_login" },
      },
      resultStorage: { driver: "azurite", containerName: "dhumi-results" },
    });

    source.JOB_MANAGER_RENEW_INTERVAL_MS = "30000";
    expect(() => loadJobManagerConfig(source)).toThrow(/less than half/);
  });

  it("forbids emulator and remote Redis configuration in production/local workers", () => {
    const production = common();
    production.NODE_ENV = "production";
    production.DATABASE_OUTBOX_DISPATCHER_USER = "dhumi_prod_outbox_dispatcher_login";
    production.DATABASE_OUTBOX_DISPATCHER_PASSWORD = "dispatcher-password-at-least-20-characters";
    production.OUTBOX_DISPATCHER_ID = "prod-dispatcher-1";
    expect(() => loadOutboxDispatcherConfig(production)).toThrow(/forbidden in production/);

    const remoteRedis = common();
    addJobManagerConfiguration(remoteRedis);
    remoteRedis.REDIS_URL = "redis://redis.example.test:6379";
    expect(() => loadJobManagerConfig(remoteRedis)).toThrow(/loopback Redis/);
  });

  it("enables the permanent local provider boundary without another database identity", () => {
    const source = common();
    addJobManagerConfiguration(source);
    source.RUN_EXECUTOR_DRIVER = "bright_data";
    source.PROVIDER_REFERENCE_LOCAL_KEY = "A".repeat(43);
    source.BRIGHTDATA_REQUEST_TIMEOUT_MS = "65000";
    source.BRIGHTDATA_POLL_INTERVAL_MS = "1000";
    source.BRIGHTDATA_POLL_MAX_ELAPSED_MS = "60000";

    expect(loadJobManagerConfig(source)).toMatchObject({
      database: { credential: { user: "dhumi_test_job_manager_login" } },
      executor: {
        driver: "bright_data",
        secretDriver: "environment",
        providerReferenceLocalKey: "A".repeat(43),
        requestTimeoutMs: 65000,
        pollIntervalMs: 1000,
        pollMaxElapsedMs: 60000,
      },
    });
    expect(loadJobManagerConfig(source)).not.toHaveProperty("brightDataApiKey");
    expect(loadJobManagerConfig(source).executor).toHaveProperty("sharedScraperPipelineEnabled", false);
    source.SHARED_SCRAPER_PIPELINE_ENABLED = "true";
    expect(loadJobManagerConfig(source).executor).toHaveProperty("sharedScraperPipelineEnabled", true);
    source.SHARED_SCRAPER_PIPELINE_ENABLED = "false";
    expect(loadJobManagerConfig(source).executor).toHaveProperty("sharedScraperPipelineEnabled", false);
    source.SHARED_SCRAPER_PIPELINE_ENABLED = "yes";
    expect(() => loadJobManagerConfig(source)).toThrow(/SHARED_SCRAPER_PIPELINE_ENABLED/);
    delete source.SHARED_SCRAPER_PIPELINE_ENABLED;

    delete source.PROVIDER_REFERENCE_LOCAL_KEY;
    expect(() => loadJobManagerConfig(source)).toThrow(
      /PROVIDER_REFERENCE_LOCAL_KEY/,
    );
  });
});
