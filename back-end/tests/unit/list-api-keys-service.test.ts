import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeApiKeyListCursor,
  encodeApiKeyListCursor,
} from "../../src/helpers/apiKeyListCursor.js";
import type {
  ListApiKeysRepository,
  ListApiKeysRepositoryInput,
  ListApiKeysRecord,
} from "../../src/services/apiKeys/listApiKeysRepository.js";
import { createListApiKeysService } from "../../src/services/apiKeys/listApiKeysService.js";

const identity = {
  userId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  tenantId: "33333333-3333-4333-8333-333333333333",
};

class RecordingRepository implements ListApiKeysRepository {
  public readonly calls: ListApiKeysRepositoryInput[] = [];

  public constructor(public records: readonly ListApiKeysRecord[]) {}

  public async list(input: ListApiKeysRepositoryInput): Promise<readonly ListApiKeysRecord[]> {
    this.calls.push(input);
    return this.records;
  }
}

function record(index: number): ListApiKeysRecord {
  return {
    id: randomUUID(),
    name: `Key ${index}`,
    prefix: `dhk_v1_${String(index).padStart(16, "A")}`,
    scopes: ["runs:read"],
    state: "active",
    createdAt: new Date(Date.UTC(2026, 7, 24, 0, 0, 30 - index)),
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
  };
}

describe("listApiKeysService", () => {
  it("returns the default page and a cursor for the last visible record", async () => {
    const records = Array.from({ length: 21 }, (_, index) => record(index));
    const repository = new RecordingRepository(records);

    const result = await createListApiKeysService({ repository }).list({
      identity,
      cursor: undefined,
      limit: undefined,
      schemaErrors: [],
    });

    expect(repository.calls).toEqual([
      { tenantId: identity.tenantId, cursor: undefined, fetchLimit: 21 },
    ]);
    expect(result.data).toHaveLength(20);
    expect(result.page.has_more).toBe(true);
    expect(result.page.next_cursor).not.toBeNull();
    expect(decodeApiKeyListCursor(result.page.next_cursor!)).toEqual({
      createdAt: records[19]!.createdAt.toISOString(),
      id: records[19]!.id,
    });
    expect(result.data[0]).toEqual({
      id: records[0]!.id,
      name: "Key 0",
      prefix: records[0]!.prefix,
      scopes: ["runs:read"],
      state: "active",
      created_at: records[0]!.createdAt.toISOString(),
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
    });
  });

  it("rejects schema, limit, and cursor failures before persistence", async () => {
    const cases = [
      { cursor: undefined, limit: "0", schemaErrors: [] },
      { cursor: undefined, limit: "101", schemaErrors: [] },
      { cursor: undefined, limit: "1.5", schemaErrors: [] },
      { cursor: ["one", "two"], limit: undefined, schemaErrors: [] },
      { cursor: "not-a-cursor", limit: undefined, schemaErrors: [] },
      {
        cursor: undefined,
        limit: undefined,
        schemaErrors: [{ field: "querystring", message: "must not contain extra" }],
      },
    ] as const;

    for (const invalid of cases) {
      const repository = new RecordingRepository([]);
      await expect(
        createListApiKeysService({ repository }).list({ identity, ...invalid }),
      ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
      expect(repository.calls).toHaveLength(0);
    }
  });

  it("uses the requested cursor and limit and returns a terminal page without a cursor", async () => {
    const boundary = {
      createdAt: "2026-08-24T00:00:00.000Z",
      id: "55555555-5555-4555-8555-555555555555",
    } as const;
    const repository = new RecordingRepository([record(1), record(2)]);

    const result = await createListApiKeysService({ repository }).list({
      identity,
      cursor: encodeApiKeyListCursor(boundary),
      limit: "2",
      schemaErrors: [],
    });

    expect(repository.calls).toEqual([
      { tenantId: identity.tenantId, cursor: boundary, fetchLimit: 3 },
    ]);
    expect(result.data).toHaveLength(2);
    expect(result.page).toEqual({ next_cursor: null, has_more: false });
  });

  it("returns the non-enumerating empty page when no key is visible", async () => {
    const result = await createListApiKeysService({
      repository: new RecordingRepository([]),
    }).list({ identity, cursor: undefined, limit: undefined, schemaErrors: [] });

    expect(result).toEqual({
      data: [],
      page: { next_cursor: null, has_more: false },
    });
  });
});
