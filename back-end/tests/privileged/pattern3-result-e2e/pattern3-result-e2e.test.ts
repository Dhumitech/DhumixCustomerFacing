import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { loadRuntimeConfig } from "../../../src/config/environment.js";
import { createDatabasePools } from "../../../src/services/database/pools.js";
import { createGetRunResultRepository } from "../../../src/services/runQuery/getRunResultRepository.js";
import { createGetRunResultService } from "../../../src/services/runQuery/getRunResultService.js";
import { createConfiguredResultUrlSigner } from "../../../src/services/storage/resultStorageComposition.js";
import {
  cleanupPattern3Fixture,
  inspectPattern3Fixture,
  preparePattern3Fixture,
  type Pattern3FixtureManifest,
} from "./pattern3ResultFixture.js";

const enabled =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" &&
  process.env.RUN_PATTERN3_RESULT_E2E_TESTS === "true";
const config = enabled ? loadRuntimeConfig() : undefined;
const privilegedUrl = enabled ? process.env.PRIVILEGED_TEST_DATABASE_URL : undefined;
const privilegedPassword = enabled ? process.env.PGPASSWORD : undefined;

if (enabled && config?.database.database !== "dhumi_test") {
  throw new Error("Pattern 3 E2E tests may run only against dhumi_test");
}
if (enabled && (!privilegedUrl || !privilegedPassword)) {
  throw new Error("Pattern 3 E2E tests require the secure wrapper script");
}

const privilegedPool = enabled
  ? new Pool({
      connectionString: privilegedUrl,
      password: privilegedPassword,
      application_name: "dhumi-pattern3-result-e2e-tests",
      max: 2,
    })
  : undefined;
const runtimePools = enabled && config
  ? createDatabasePools(config.database, () => undefined)
  : undefined;
let fixture: Pattern3FixtureManifest | undefined;

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Pattern 3 E2E configuration is unavailable");
  return value;
}

describe.skipIf(!enabled)("Pattern 3 real PostgreSQL + Azurite result E2E", () => {
  beforeAll(async () => {
    fixture = await preparePattern3Fixture(
      must(privilegedPool),
      must(config),
      `http://${must(config).host}:${must(config).port}`,
    );
  });

  afterAll(async () => {
    try {
      if (fixture && privilegedPool && config) {
        await cleanupPattern3Fixture(privilegedPool, config, fixture);
      }
    } finally {
      await Promise.all([runtimePools?.close(), privilegedPool?.end()]);
    }
  });

  it("ingests, authorizes, signs, downloads, audits, and verifies both exact representations", async () => {
    const prepared = must(fixture);
    const service = createGetRunResultService({
      repository: createGetRunResultRepository(must(runtimePools).customerApi),
      urlSigner: await createConfiguredResultUrlSigner(must(config).resultStorage),
    });
    for (const [representation, expected, state] of [
      ["normalized", prepared.result, "validated"],
      ["raw", prepared.rawResult, "durable"],
    ] as const) {
      const result = await service.get({
        principal: {
          kind: "browser",
          userId: prepared.owner.userId,
          tenantId: prepared.owner.tenantId,
          sessionId: randomUUID(),
        },
        runId: prepared.ids.runId,
        representation,
        schemaErrors: [],
        requestId: randomUUID(),
        ipFingerprint: null,
      });

      expect(result).toMatchObject({
        run_id: prepared.ids.runId,
        content_type: expected.contentType,
        byte_count: expected.byteCount,
        checksum: expected.checksumHex,
      });
      expect(result.download_url).toContain("127.0.0.1:10000");

      const download = await fetch(result.download_url);
      expect(download.status).toBe(200);
      expect(Buffer.from(await download.arrayBuffer())).toEqual(
        Buffer.from(expected.expectedBody, "utf8"),
      );

      const inspection = await inspectPattern3Fixture(
        must(privilegedPool),
        must(config),
        prepared,
        representation,
      );
      expect(inspection).toMatchObject({
        artifact: {
          id: expected.artifactId,
          state,
          byteCount: expected.byteCount,
          checksumHex: expected.checksumHex,
        },
        object: {
          byteCount: expected.byteCount,
          checksumHex: expected.checksumHex,
          exactBytes: true,
        },
        downloadAuthorizationAudits: 1,
      });
    }

    await expect(
      service.get({
        principal: {
          kind: "browser",
          userId: prepared.otherTenant.userId,
          tenantId: prepared.otherTenant.tenantId,
          sessionId: randomUUID(),
        },
        runId: prepared.ids.runId,
        representation: "raw",
        schemaErrors: [],
        requestId: randomUUID(),
        ipFingerprint: null,
      }),
    ).rejects.toMatchObject({ status: 404 });

  });
});
