import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigurationError, loadResultRecorderConfig, loadRuntimeConfig } from "../../src/config/environment.js";
import { loadJobManagerConfig, loadOutboxDispatcherConfig } from "../../src/config/pattern4Environment.js";
import { projectDeploymentEnvironment } from "../../src/deployment/environment.js";

const certificate = rootCertificates[0]!;
const encoded = Buffer.from(certificate).toString("base64");
const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function source(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test", FRONTEND_ORIGIN: "http://localhost:5173",
    DATABASE_HOST: "database.example", DATABASE_NAME: "dhumi_test",
    DATABASE_SSL_MODE: "verify-full", DATABASE_SSL_CA_BASE64: encoded,
    DATABASE_IDENTITY_USER: "dhumi_test_identity_login", DATABASE_IDENTITY_PASSWORD: "test-only-identity-password-long-enough",
    DATABASE_CUSTOMER_API_USER: "dhumi_test_customer_api_login", DATABASE_CUSTOMER_API_PASSWORD: "test-only-customer-password-long-enough",
    DATABASE_ADMISSION_USER: "dhumi_test_admission_login", DATABASE_ADMISSION_PASSWORD: "test-only-admission-password-long-enough",
    DATABASE_OUTBOX_DISPATCHER_USER: "dhumi_test_outbox_dispatcher_login", DATABASE_OUTBOX_DISPATCHER_PASSWORD: "test-only-outbox-password-long-enough",
    DATABASE_JOB_MANAGER_USER: "dhumi_test_job_manager_login", DATABASE_JOB_MANAGER_PASSWORD: "test-only-jobs-password-long-enough",
    DATABASE_RESULT_RECORDER_USER: "dhumi_test_result_recorder_login", DATABASE_RESULT_RECORDER_PASSWORD: "test-only-recorder-password-long-enough",
    ACCESS_TOKEN_SECRET: "test-only-access-token-secret-at-least-32-chars", ACCESS_TOKEN_ISSUER: "https://dhumi.test", ACCESS_TOKEN_AUDIENCE: "dhumi-browser",
    SERVICE_BUS_DRIVER: "emulator", SERVICE_BUS_RUN_COMMAND_QUEUE: "dhumi-run-commands",
    SERVICE_BUS_CONNECTION_STRING: "Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;",
    OUTBOX_DISPATCHER_ID: "test-dispatcher", REDIS_URL: "redis://127.0.0.1:6379",
    RESULT_STORAGE_DRIVER: "azurite", RESULT_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true", RESULT_STORAGE_CONTAINER: "dhumi-results",
  };
}

const loaders = {
  api: (env: NodeJS.ProcessEnv) => loadRuntimeConfig(env).database.ssl,
  recorder: (env: NodeJS.ProcessEnv) => loadResultRecorderConfig(env).database.ssl,
  outbox: (env: NodeJS.ProcessEnv) => loadOutboxDispatcherConfig(env).database.ssl,
  jobs: (env: NodeJS.ProcessEnv) => loadJobManagerConfig(env).database.ssl,
};

describe("portable verified PostgreSQL TLS", () => {
  it.each(Object.entries(loaders))("%s loads inline CA without a file path and keeps verification enabled", (_, load) => {
    expect(load(source())).toEqual({ ca: certificate, rejectUnauthorized: true });
  });
  it("uses the same verified CA for both Job Manager pools", () => {
    const config = loadJobManagerConfig(source());
    expect(config.resultRecorderDatabase.ssl).toEqual(config.database.ssl);
  });
  it.each(["api", "outbox", "jobs"] as const)("%s receives the inline CA through scoped projection", role => {
    expect(projectDeploymentEnvironment(role, source(), {}).DATABASE_SSL_CA_BASE64).toBe(encoded);
    expect(projectDeploymentEnvironment("storage", source(), {}).DATABASE_SSL_CA_BASE64).toBeUndefined();
  });
  it.each(Object.entries(loaders))("%s preserves the absolute CA-file alternative", (_, load) => {
    const directory = mkdtempSync(join(tmpdir(), "dhumi-tls-")); temporaryDirectories.push(directory);
    const path = join(directory, "public-ca.pem"); writeFileSync(path, certificate);
    const env = source(); delete env.DATABASE_SSL_CA_BASE64; env.DATABASE_SSL_CA_FILE = path;
    expect(load(env)).toEqual({ ca: certificate, rejectUnauthorized: true });
  });
  it.each(Object.entries(loaders))("%s rejects missing trust, ambiguous trust and TLS downgrade", (_, load) => {
    const missing = source(); delete missing.DATABASE_SSL_CA_BASE64;
    expect(() => load(missing)).toThrow(ConfigurationError);
    expect(() => load({ ...source(), DATABASE_SSL_CA_FILE: "/unused/public-ca.pem" })).toThrow(/exactly one/);
    expect(() => load({ ...source(), DATABASE_SSL_MODE: "disable" })).toThrow(/verify-full/);
  });
  it.each(["not!base64", encoded.slice(0, -1), Buffer.from("not a certificate").toString("base64"),
    Buffer.from("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----").toString("base64"),
    Buffer.from(certificate + "\n-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----").toString("base64")])(
    "rejects malformed trust material without exposing its content", value => {
      try { loadRuntimeConfig({ ...source(), DATABASE_SSL_CA_BASE64: value }); throw new Error("Expected rejection"); }
      catch (error) {
        expect(error).toBeInstanceOf(ConfigurationError);
        expect((error as Error).message).not.toContain(value);
        expect((error as Error).message).not.toContain("AAAA");
      }
    },
  );
});
