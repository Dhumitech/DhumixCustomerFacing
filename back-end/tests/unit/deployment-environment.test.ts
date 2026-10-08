import { describe, expect, it } from "vitest";
import { projectDeploymentEnvironment } from "../../src/deployment/environment.js";

const source = {
  NODE_ENV: "test", DATABASE_HOST: "database.example", DATABASE_NAME: "dhumi_shared",
  DATABASE_SSL_MODE: "verify-full", DEMO_DISABLE_OTP: "true",
  DATABASE_IDENTITY_PASSWORD: "identity-password", DATABASE_CUSTOMER_API_PASSWORD: "customer-password",
  DATABASE_ADMISSION_PASSWORD: "admission-password", DATABASE_JOB_MANAGER_PASSWORD: "jobs-password",
  DATABASE_RESULT_RECORDER_PASSWORD: "recorder-password", DATABASE_OUTBOX_DISPATCHER_PASSWORD: "outbox-password",
  DATABASE_OPERATOR_PASSWORD: "operator-password", DATABASE_ENVELOPE_JANITOR_PASSWORD: "retired-password",
  ACCESS_TOKEN_SECRET: "signing-secret", AZURE_CLIENT_SECRET: "blob-secret",
  BRIGHTDATA_API_KEY: "provider-secret", PROVIDER_REFERENCE_LOCAL_KEY: "protector-secret",
  SERVICE_BUS_CONNECTION_STRING: "queue-secret", REDIS_URL: "redis://localhost",
  POSTGRES_PASSWORD: "admin-secret", EMAIL_FROM: "unused@example.test", OTP_SECRET: "otp-secret",
  NODE_OPTIONS: "--import untrusted-code", VITE_SECRET: "must-never-enter-frontend",
};
const inherited = { PATH: "/tools", DATABASE_HOST: "wrong-database", POSTGRES_PASSWORD: "ambient-admin",
  AZURE_CLIENT_SECRET: "ambient-blob", ACCESS_TOKEN_SECRET: "ambient-session", NODE_OPTIONS: "--require untrusted" };

describe("one deployment environment projected by process", () => {
  it("keeps only API database/session/Blob credentials in the API", () => {
    const api = projectDeploymentEnvironment("api", source, inherited);
    expect(api).toMatchObject({ DATABASE_IDENTITY_PASSWORD: "identity-password", ACCESS_TOKEN_SECRET: "signing-secret", AZURE_CLIENT_SECRET: "blob-secret", DEMO_DISABLE_OTP: "true" });
    for (const name of ["BRIGHTDATA_API_KEY", "PROVIDER_REFERENCE_LOCAL_KEY", "SERVICE_BUS_CONNECTION_STRING", "REDIS_URL", "DATABASE_JOB_MANAGER_PASSWORD", "DATABASE_RESULT_RECORDER_PASSWORD", "DATABASE_OUTBOX_DISPATCHER_PASSWORD"])
      expect(api[name]).toBeUndefined();
  });
  it("gives only queue/database access to the dispatcher", () => {
    const outbox = projectDeploymentEnvironment("outbox", source, inherited);
    expect(outbox).toMatchObject({ DATABASE_OUTBOX_DISPATCHER_PASSWORD: "outbox-password", SERVICE_BUS_CONNECTION_STRING: "queue-secret" });
    for (const name of ["DATABASE_IDENTITY_PASSWORD", "ACCESS_TOKEN_SECRET", "AZURE_CLIENT_SECRET", "BRIGHTDATA_API_KEY", "PROVIDER_REFERENCE_LOCAL_KEY", "OTP_SECRET", "EMAIL_FROM", "REDIS_URL"])
      expect(outbox[name]).toBeUndefined();
  });
  it("keeps real-provider and reference secrets only in the Job Manager", () => {
    const jobs = projectDeploymentEnvironment("jobs", source, inherited);
    expect(jobs).toMatchObject({ DATABASE_JOB_MANAGER_PASSWORD: "jobs-password", DATABASE_RESULT_RECORDER_PASSWORD: "recorder-password", BRIGHTDATA_API_KEY: "provider-secret", PROVIDER_REFERENCE_LOCAL_KEY: "protector-secret", AZURE_CLIENT_SECRET: "blob-secret", SERVICE_BUS_CONNECTION_STRING: "queue-secret" });
    for (const name of ["DATABASE_IDENTITY_PASSWORD", "DATABASE_ADMISSION_PASSWORD", "DATABASE_OUTBOX_DISPATCHER_PASSWORD", "ACCESS_TOKEN_SECRET", "OTP_SECRET", "EMAIL_FROM"])
      expect(jobs[name]).toBeUndefined();
  });
  it("storage qualification receives no SQL, queue, session or provider secrets", () => {
    const storage = projectDeploymentEnvironment("storage", source, inherited);
    expect(storage.AZURE_CLIENT_SECRET).toBe("blob-secret");
    for (const name of ["DATABASE_NAME", "DATABASE_IDENTITY_PASSWORD", "ACCESS_TOKEN_SECRET", "BRIGHTDATA_API_KEY", "SERVICE_BUS_CONNECTION_STRING"])
      expect(storage[name]).toBeUndefined();
  });
  it.each(["api", "outbox", "jobs", "storage"] as const)("%s excludes admin/operator/retired credentials and executable env hooks", role => {
    const env = projectDeploymentEnvironment(role, source, inherited);
    for (const name of ["POSTGRES_PASSWORD", "DATABASE_OPERATOR_PASSWORD", "DATABASE_ENVELOPE_JANITOR_PASSWORD", "NODE_OPTIONS", "VITE_SECRET"])
      expect(env[name]).toBeUndefined();
    expect(env.PATH).toBe("/tools");
    if (role !== "storage") expect(env.DATABASE_HOST).toBe("database.example");
  });
  it("does not inherit missing application secrets or mutate either input", () => {
    const env = projectDeploymentEnvironment("api", { NODE_ENV: "test" }, inherited);
    expect(env.ACCESS_TOKEN_SECRET).toBeUndefined();
    expect(env.AZURE_CLIENT_SECRET).toBeUndefined();
    expect(source.POSTGRES_PASSWORD).toBe("admin-secret");
    expect(inherited.DATABASE_HOST).toBe("wrong-database");
  });
});
