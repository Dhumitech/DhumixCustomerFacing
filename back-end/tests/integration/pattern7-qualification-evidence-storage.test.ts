import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  QualificationEvidenceConflictError,
  createConfiguredQualificationEvidenceStore,
} from "../../src/services/qualification/qualificationEvidenceStore.js";

const enabled = process.env.RUN_AZURITE_INTEGRATION_TESTS === "true";

describe.skipIf(!enabled)("Pattern 7 qualification evidence storage", () => {
  it("commits exact immutable bytes and rejects conflicting replay", async () => {
    const connectionString = process.env.RESULT_STORAGE_CONNECTION_STRING;
    const containerName = process.env.RESULT_STORAGE_CONTAINER;
    if (connectionString === undefined || containerName === undefined) {
      throw new Error("Azurite Pattern 7 test configuration is missing");
    }
    const store = await createConfiguredQualificationEvidenceStore({
      connectionString,
      containerName,
    });
    const id = randomUUID();
    const objectKey = "qualification/operations/" + id + "/response.json";
    const bytes = Buffer.from('[{"pattern":7,"result":"exact"}]', "utf8");
    const first = await store.putImmutable({
      objectKey,
      bytes,
      contentType: "application/json",
      maxBytes: 1024,
    });
    const replay = await store.putImmutable({
      objectKey,
      bytes,
      contentType: "application/json",
      maxBytes: 1024,
    });
    expect(replay).toEqual(first);
    await expect(store.putImmutable({
      objectKey,
      bytes: Buffer.from('[{"different":true}]', "utf8"),
      contentType: "application/json",
      maxBytes: 1024,
    })).rejects.toBeInstanceOf(QualificationEvidenceConflictError);
  });
});
