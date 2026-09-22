import { describe, expect, it } from "vitest";
import { decodeServiceListCursor } from "../../src/helpers/serviceListCursor.js";
import type {
  ListServicesRecord,
  ListServicesRepository,
  ListServicesRepositoryInput,
} from "../../src/services/customerServices/listServicesRepository.js";
import { createListServicesService } from "../../src/services/customerServices/listServicesService.js";
import { ApplicationError } from "../../src/utils/applicationError.js";

const principal = {
  kind: "browser",
  userId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  tenantId: "33333333-3333-4333-8333-333333333333",
} as const;

class RecordingRepository implements ListServicesRepository {
  public readonly calls: ListServicesRepositoryInput[] = [];

  public constructor(
    public records: readonly ListServicesRecord[],
    public failWith?: Error,
  ) {}

  public async list(input: ListServicesRepositoryInput): Promise<readonly ListServicesRecord[]> {
    this.calls.push(input);
    if (this.failWith !== undefined) throw this.failWith;
    return this.records;
  }
}

function record(index: number): ListServicesRecord {
  return {
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    name: `Saved Service ${index}`,
    templateSlug: `template-${String(index).padStart(2, "0")}`,
    templateVersion: index + 1,
    version: index + 2,
    family: index % 2 === 0 ? "marketplace_dataset" : "scraper_library",
    state: index % 3 === 0 ? "disabled" : "active",
    createdAt: new Date(Date.UTC(2026, 7, 24, 12, 0, 0, 100 - index)),
  };
}

describe("listServicesService", () => {
  it("returns the default page and a cursor for the last visible Service", async () => {
    const records = Array.from({ length: 21 }, (_, index) => record(index));
    const repository = new RecordingRepository(records);

    const result = await createListServicesService({ repository }).list({
      principal,
      cursor: undefined,
      limit: undefined,
      schemaErrors: [],
    });

    expect(repository.calls).toEqual([
      {
        tenantId: principal.tenantId,
        cursor: undefined,
        fetchLimit: 21,
      },
    ]);
    expect(result.data).toHaveLength(20);
    expect(result.page.has_more).toBe(true);
    expect(decodeServiceListCursor(result.page.next_cursor!)).toEqual({
      createdAt: records[19]!.createdAt.toISOString(),
      id: records[19]!.id,
    });
    expect(result.data[0]).toEqual({
      id: records[0]!.id,
      name: records[0]!.name,
      template_slug: records[0]!.templateSlug,
      template_version: records[0]!.templateVersion,
      version: records[0]!.version,
      family: records[0]!.family,
      state: records[0]!.state,
      created_at: records[0]!.createdAt.toISOString(),
    });
  });

  it("uses an explicit limit and passes the decoded keyset without authority", async () => {
    const firstRepository = new RecordingRepository([record(0), record(1)]);
    const first = await createListServicesService({ repository: firstRepository }).list({
      principal,
      cursor: undefined,
      limit: "1",
      schemaErrors: [],
    });
    const repository = new RecordingRepository([]);

    await createListServicesService({ repository }).list({
      principal,
      cursor: first.page.next_cursor,
      limit: "5",
      schemaErrors: [],
    });

    expect(repository.calls).toEqual([
      {
        tenantId: principal.tenantId,
        cursor: {
          createdAt: record(0).createdAt.toISOString(),
          id: record(0).id,
        },
        fetchLimit: 6,
      },
    ]);
  });

  it("projects exactly eight public fields and omits configuration/private state", async () => {
    const internal = {
      ...record(0),
      tenantId: "forbidden-tenant",
      validatedConfiguration: { provider_resource: "forbidden" },
      schemaHash: "forbidden-hash",
      createdByUserId: "forbidden-user",
    };
    const result = await createListServicesService({
      repository: new RecordingRepository([internal]),
    }).list({
      principal,
      cursor: undefined,
      limit: undefined,
      schemaErrors: [],
    });

    expect(Object.keys(result.data[0]!).sort()).toEqual([
      "created_at",
      "family",
      "id",
      "name",
      "state",
      "template_slug",
      "template_version",
      "version",
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /tenant|configuration|schema_hash|created_by|provider/i,
    );
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
        createListServicesService({ repository }).list({ principal, ...invalid }),
      ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
      expect(repository.calls).toHaveLength(0);
    }
  });

  it("returns the accepted empty page", async () => {
    const result = await createListServicesService({
      repository: new RecordingRepository([]),
    }).list({
      principal,
      cursor: undefined,
      limit: undefined,
      schemaErrors: [],
    });

    expect(result).toEqual({
      data: [],
      page: { next_cursor: null, has_more: false },
    });
  });

  it("preserves safe repository ApplicationErrors", async () => {
    const failure = new ApplicationError({
      status: 500,
      code: "INTERNAL_ERROR",
      title: "Internal server error",
    });
    const repository = new RecordingRepository([], failure);

    await expect(
      createListServicesService({ repository }).list({
        principal,
        cursor: undefined,
        limit: undefined,
        schemaErrors: [],
      }),
    ).rejects.toBe(failure);
  });
});
