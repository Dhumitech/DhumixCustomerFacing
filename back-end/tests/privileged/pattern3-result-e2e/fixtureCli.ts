import { readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Pool } from "pg";
import { loadRuntimeConfig } from "../../../src/config/environment.js";
import {
  PATTERN3_FIXTURE_VERSION,
  cleanupPattern3Fixture,
  inspectPattern3Fixture,
  preparePattern3Fixture,
  type Pattern3FixtureManifest,
} from "./pattern3ResultFixture.js";

type Action = "prepare" | "inspect" | "cleanup" | "http";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

function manifestPath(): string {
  const configured = requiredEnvironment("PATTERN3_FIXTURE_MANIFEST_PATH");
  if (!isAbsolute(configured)) throw new Error("Fixture manifest path must be absolute");
  const target = resolve(configured);
  const temporaryRoot = resolve(tmpdir());
  if (!target.toLowerCase().startsWith(`${temporaryRoot.toLowerCase()}\\`)) {
    throw new Error("Fixture manifest must remain under the operating-system temporary directory");
  }
  return target;
}

function postmanEnvironmentPath(path: string): string {
  return path.replace(/\.json$/i, "") + ".postman_environment.json";
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function validateManifest(value: unknown): Pattern3FixtureManifest {
  if (typeof value !== "object" || value === null) throw new Error("Fixture manifest is invalid");
  const manifest = value as Partial<Pattern3FixtureManifest>;
  if (
    manifest.version !== PATTERN3_FIXTURE_VERSION ||
    manifest.databaseName !== "dhumi_test" ||
    !manifest.owner?.email.startsWith("pattern3-owner-") ||
    !manifest.otherTenant?.email.startsWith("pattern3-other-") ||
    !isUuid(manifest.owner.userId) ||
    !isUuid(manifest.owner.tenantId) ||
    !isUuid(manifest.otherTenant.userId) ||
    !isUuid(manifest.otherTenant.tenantId) ||
    !manifest.ids ||
    !Object.values(manifest.ids).every(isUuid) ||
    !manifest.result ||
    !isUuid(manifest.result.artifactId) ||
    manifest.result.objectKey !==
      `tenants/${manifest.owner.tenantId}/runs/${manifest.ids.runId}/attempts/${manifest.ids.attemptId}/normalized/v1/result` ||
    !manifest.rawResult ||
    !isUuid(manifest.rawResult.artifactId) ||
    manifest.rawResult.objectKey !==
      `tenants/${manifest.owner.tenantId}/runs/${manifest.ids.runId}/attempts/${manifest.ids.attemptId}/raw/v1/result`
  ) {
    throw new Error("Fixture manifest failed its safety validation");
  }
  return manifest as Pattern3FixtureManifest;
}

async function readManifest(path: string): Promise<Pattern3FixtureManifest> {
  return validateManifest(JSON.parse(await readFile(path, "utf8")) as unknown);
}

async function writePostmanEnvironment(
  path: string,
  manifest: Pattern3FixtureManifest,
): Promise<void> {
  const environment = {
    id: randomUUID(),
    name: `Dhumi Pattern 3 Local - ${manifest.ids.runId.slice(0, 8)}`,
    values: [
      { key: "pattern3_base_url", value: manifest.baseUrl, enabled: true, type: "default" },
      { key: "pattern3_owner_email", value: manifest.owner.email, enabled: true, type: "default" },
      { key: "pattern3_owner_password", value: manifest.owner.password, enabled: true, type: "secret" },
      { key: "pattern3_other_email", value: manifest.otherTenant.email, enabled: true, type: "default" },
      { key: "pattern3_other_password", value: manifest.otherTenant.password, enabled: true, type: "secret" },
      { key: "pattern3_run_id", value: manifest.ids.runId, enabled: true, type: "default" },
      { key: "pattern3_expected_body", value: manifest.result.expectedBody, enabled: true, type: "default" },
      { key: "pattern3_expected_checksum", value: manifest.result.checksumHex, enabled: true, type: "default" },
      { key: "pattern3_expected_byte_count", value: String(manifest.result.byteCount), enabled: true, type: "default" },
      { key: "pattern3_raw_expected_body", value: manifest.rawResult.expectedBody, enabled: true, type: "default" },
      { key: "pattern3_raw_expected_checksum", value: manifest.rawResult.checksumHex, enabled: true, type: "default" },
      { key: "pattern3_raw_expected_byte_count", value: String(manifest.rawResult.byteCount), enabled: true, type: "default" },
      { key: "pattern3_owner_access_token", value: "", enabled: true, type: "secret" },
      { key: "pattern3_other_access_token", value: "", enabled: true, type: "secret" },
      { key: "pattern3_download_url", value: "", enabled: true, type: "secret" },
      { key: "pattern3_raw_download_url", value: "", enabled: true, type: "secret" },
    ],
    _postman_variable_scope: "environment",
    _postman_exported_at: new Date().toISOString(),
    _postman_exported_using: "Dhumi Pattern 3 fixture",
  };
  await writeFile(path, `${JSON.stringify(environment, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

interface ResultResponse {
  readonly run_id: string;
  readonly content_type: string;
  readonly byte_count: number;
  readonly checksum: string;
  readonly download_url: string;
  readonly download_expires_at: string;
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json()) as unknown;
  if (typeof body !== "object" || body === null) {
    throw new Error(`HTTP ${response.status} did not return a JSON object`);
  }
  return body as Record<string, unknown>;
}

async function signIn(baseUrl: string, identity: { email: string; password: string }): Promise<string> {
  const response = await fetch(`${baseUrl}/v1/auth/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email: identity.email, password: identity.password }),
  });
  const body = await responseJson(response);
  if (response.status !== 200 || body.token_type !== "Bearer" || typeof body.access_token !== "string") {
    throw new Error(`Dhumi sign-in failed with HTTP ${response.status}`);
  }
  return body.access_token;
}

async function authorizeAndDownload(
  manifest: Pattern3FixtureManifest,
  ownerToken: string,
  representation: "normalized" | "raw",
): Promise<{ readonly resultStatus: number; readonly downloadStatus: number }> {
  const expected = representation === "raw" ? manifest.rawResult : manifest.result;
  const resultResponse = await fetch(
    `${manifest.baseUrl}/v1/runs/${manifest.ids.runId}/result?representation=${representation}`,
    {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${ownerToken}`,
      },
    },
  );
  const resultBody = await responseJson(resultResponse) as unknown as ResultResponse;
  if (
    resultResponse.status !== 200 ||
    resultBody.run_id !== manifest.ids.runId ||
    resultBody.content_type !== expected.contentType ||
    resultBody.byte_count !== expected.byteCount ||
    resultBody.checksum !== expected.checksumHex ||
    typeof resultBody.download_url !== "string" ||
    new Date(resultBody.download_expires_at).valueOf() <= Date.now()
  ) {
    throw new Error(
      `Authorized ${representation} result response failed integrity checks (HTTP ${resultResponse.status})`,
    );
  }

  const signedDownload = await fetch(resultBody.download_url);
  const downloaded = Buffer.from(await signedDownload.arrayBuffer());
  if (
    signedDownload.status !== 200 ||
    !downloaded.equals(Buffer.from(expected.expectedBody, "utf8"))
  ) {
    throw new Error(
      `Signed Azurite ${representation} download did not return the exact fixture bytes`,
    );
  }
  return {
    resultStatus: resultResponse.status,
    downloadStatus: signedDownload.status,
  };
}

async function exerciseHttpBoundary(
  privilegedPool: Pool,
  config: ReturnType<typeof loadRuntimeConfig>,
  baseUrl: string,
): Promise<void> {
  const manifest = await preparePattern3Fixture(privilegedPool, config, baseUrl);
  try {
    const resultUrl = `${manifest.baseUrl}/v1/runs/${manifest.ids.runId}/result?representation=raw`;
    const unauthenticated = await fetch(resultUrl, { headers: { accept: "application/json" } });
    const unauthenticatedBody = await responseJson(unauthenticated);
    if (
      unauthenticated.status !== 401 ||
      unauthenticatedBody.code !== "AUTHENTICATION_REQUIRED" ||
      JSON.stringify(unauthenticatedBody).includes("download_url")
    ) {
      throw new Error("Unauthenticated result boundary did not fail closed");
    }

    const ownerToken = await signIn(manifest.baseUrl, manifest.owner);
    const normalizedHttp = await authorizeAndDownload(
      manifest,
      ownerToken,
      "normalized",
    );
    const rawHttp = await authorizeAndDownload(manifest, ownerToken, "raw");

    const otherToken = await signIn(manifest.baseUrl, manifest.otherTenant);
    const isolated = await fetch(resultUrl, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${otherToken}`,
      },
    });
    const isolatedBody = await responseJson(isolated);
    if (
      isolated.status !== 404 ||
      isolatedBody.code !== "RESOURCE_NOT_FOUND" ||
      JSON.stringify(isolatedBody).includes(manifest.rawResult.checksumHex)
    ) {
      throw new Error("Cross-Tenant result request did not remain invisible");
    }

    const normalizedInspection = await inspectPattern3Fixture(
      privilegedPool,
      config,
      manifest,
      "normalized",
    );
    const rawInspection = await inspectPattern3Fixture(
      privilegedPool,
      config,
      manifest,
      "raw",
    );
    if (
      normalizedInspection.downloadAuthorizationAudits !== 1 ||
      rawInspection.downloadAuthorizationAudits !== 1
    ) {
      throw new Error(
        "Live HTTP proof did not create one authorization audit per representation",
      );
    }
    process.stdout.write(
      `${JSON.stringify({
        status: "verified-and-cleaned",
        http: {
          unauthenticatedStatus: unauthenticated.status,
          normalizedResultStatus: normalizedHttp.resultStatus,
          normalizedDownloadStatus: normalizedHttp.downloadStatus,
          rawResultStatus: rawHttp.resultStatus,
          rawDownloadStatus: rawHttp.downloadStatus,
          crossTenantStatus: isolated.status,
        },
        runId: manifest.ids.runId,
        normalized: normalizedInspection,
        raw: rawInspection,
      }, null, 2)}\n`,
    );
  } finally {
    await cleanupPattern3Fixture(privilegedPool, config, manifest);
  }
}

async function main(): Promise<void> {
  const action = process.argv[2]?.toLowerCase() as Action | undefined;
  if (action !== "prepare" && action !== "inspect" && action !== "cleanup" && action !== "http") {
    throw new Error("Action must be prepare, inspect, cleanup, or http");
  }

  const path = manifestPath();
  const environmentPath = postmanEnvironmentPath(path);
  const config = loadRuntimeConfig();
  const privilegedPool = new Pool({
    connectionString: requiredEnvironment("PRIVILEGED_TEST_DATABASE_URL"),
    password: requiredEnvironment("PGPASSWORD"),
    application_name: "dhumi-pattern3-postman-fixture",
    max: 2,
  });

  try {
    if (action === "http") {
      const baseUrl = process.env.PATTERN3_BASE_URL ?? `http://${config.host}:${config.port}`;
      await exerciseHttpBoundary(privilegedPool, config, baseUrl.replace(/\/$/, ""));
      return;
    }

    if (action === "prepare") {
      await readFile(path, "utf8")
        .then(() => {
          throw new Error("A Pattern 3 fixture already exists; inspect or clean it first");
        })
        .catch((error: unknown) => {
          const code =
            typeof error === "object" && error !== null && "code" in error
              ? (error as { readonly code?: unknown }).code
              : undefined;
          if (code !== "ENOENT") throw error;
        });
      const baseUrl = process.env.PATTERN3_BASE_URL ?? `http://${config.host}:${config.port}`;
      const manifest = await preparePattern3Fixture(privilegedPool, config, baseUrl);
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await writePostmanEnvironment(environmentPath, manifest);
      process.stdout.write(
        `${JSON.stringify({
          status: "prepared",
          runId: manifest.ids.runId,
          artifactId: manifest.result.artifactId,
          byteCount: manifest.result.byteCount,
          checksum: manifest.result.checksumHex,
          rawArtifactId: manifest.rawResult.artifactId,
          rawByteCount: manifest.rawResult.byteCount,
          rawChecksum: manifest.rawResult.checksumHex,
          postmanEnvironmentPath: environmentPath,
        }, null, 2)}\n`,
      );
      return;
    }

    const manifest = await readManifest(path);
    if (action === "inspect") {
      const normalized = await inspectPattern3Fixture(
        privilegedPool,
        config,
        manifest,
        "normalized",
      );
      const raw = await inspectPattern3Fixture(
        privilegedPool,
        config,
        manifest,
        "raw",
      );
      if (
        normalized.downloadAuthorizationAudits < 1 ||
        raw.downloadAuthorizationAudits < 1
      ) {
        throw new Error(
          "No successful Postman download authorization audit was found for each representation",
        );
      }
      process.stdout.write(
        `${JSON.stringify({ status: "verified", normalized, raw }, null, 2)}\n`,
      );
      return;
    }

    await cleanupPattern3Fixture(privilegedPool, config, manifest);
    await Promise.all([
      rm(path, { force: true }),
      rm(environmentPath, { force: true }),
    ]);
    process.stdout.write(`${JSON.stringify({ status: "cleaned", runId: manifest.ids.runId })}\n`);
  } finally {
    await privilegedPool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown Pattern 3 fixture failure";
  process.stderr.write(`Pattern 3 fixture failed: ${message}\n`);
  process.exitCode = 1;
});
