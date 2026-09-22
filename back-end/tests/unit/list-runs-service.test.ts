import { describe, expect, it } from "vitest";
import { decodeRunListCursor } from "../../src/helpers/runListCursor.js";
import type {
  ListRunsRecord,
  ListRunsRepository,
  ListRunsRepositoryInput,
} from "../../src/services/runQuery/listRunsRepository.js";
import { createListRunsService } from "../../src/services/runQuery/listRunsService.js";
import { ApplicationError } from "../../src/utils/applicationError.js";

const principal = {
  kind: "browser",
  userId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  tenantId: "33333333-3333-4333-8333-333333333333",
} as const;

class RecordingRepository implements ListRunsRepository {
  public readonly calls: ListRunsRepositoryInput[] = [];

  public constructor(
    public records: readonly ListRunsRecord[],
    public failWith?: Error,
  ) {}

  public async list(input: ListRunsRepositoryInput): Promise<readonly ListRunsRecord[]> {
    this.calls.push(input);
    if (this.failWith !== undefined) throw this.failWith;
    return this.records;
  }
}

function record(index: number): ListRunsRecord {
  const createdAt = new Date(Date.UTC(2026, 7, 25, 12, 0, 0, 100 - index));
  return {
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    serviceId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    status: index % 2 === 0 ? "queued" : "ready",
    customerErrorCode: index % 3 === 0 ? "SAFE_CUSTOMER_ERROR" : null,
    retryable: index % 3 === 0,
    createdAt,
    updatedAt: new Date(createdAt.valueOf() + 1_000),
    completedAt: index % 2 === 0 ? null : new Date(createdAt.valueOf() + 2_000),
  };
}

describe("listRunsService", () => {
  it("returns the default page and a status-bound cursor", async () => {
    const records = Array.from({ length: 21 }, (_, index) => record(index));
    const repository = new RecordingRepository(records);

    const result = await createListRunsService({ repository }).list({
      principal,
      status: undefined,
      cursor: undefined,
      limit: undefined,
      schemaErrors: [],
    });

    expect(repository.calls).toEqual([
      {
        tenantId: principal.tenantId,
        statusFilter: null,
        serviceIdFilter: null,
        cursor: undefined,
        fetchLimit: 21,
      },
    ]);
    expect(result.data).toHaveLength(20);
    expect(result.page.has_more).toBe(true);
    expect(decodeRunListCursor(result.page.next_cursor!)).toEqual({
      statusFilter: null,
      serviceIdFilter: null,
      createdAt: records[19]!.createdAt.toISOString(),
      id: records[19]!.id,
    });
  });

  it("binds a filtered cursor to the same exact status", async () => {
    const firstRepository = new RecordingRepository([record(0), record(1)]);
    const first = await createListRunsService({ repository: firstRepository }).list({
      principal,
      status: "queued",
      cursor: undefined,
      limit: "1",
      schemaErrors: [],
    });
    const repository = new RecordingRepository([]);

    await createListRunsService({ repository }).list({
      principal,
      status: "queued",
      cursor: first.page.next_cursor,
      limit: "5",
      schemaErrors: [],
    });

    expect(repository.calls).toEqual([
      {
        tenantId: principal.tenantId,
        statusFilter: "queued",
        serviceIdFilter: null,
        cursor: {
          statusFilter: "queued",
          serviceIdFilter: null,
          createdAt: record(0).createdAt.toISOString(),
          id: record(0).id,
        },
        fetchLimit: 6,
      },
    ]);

    await expect(
      createListRunsService({ repository: new RecordingRepository([]) }).list({
        principal,
        status: "ready",
        cursor: first.page.next_cursor,
        limit: "5",
        schemaErrors: [],
      }),
    ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
  });

  it("binds service_id to the repository and to the page cursor", async () => {
    const selectedServiceId = record(0).serviceId;
    const firstRepository = new RecordingRepository([record(0), record(1)]);
    const first = await createListRunsService({ repository: firstRepository }).list({
      principal,
      status: undefined,
      serviceId: selectedServiceId,
      cursor: undefined,
      limit: "1",
      schemaErrors: [],
    });

    expect(firstRepository.calls[0]).toMatchObject({
      serviceIdFilter: selectedServiceId,
    });
    expect(decodeRunListCursor(first.page.next_cursor!)).toMatchObject({
      serviceIdFilter: selectedServiceId,
    });

    await expect(
      createListRunsService({ repository: new RecordingRepository([]) }).list({
        principal,
        status: undefined,
        serviceId: record(2).serviceId,
        cursor: first.page.next_cursor,
        limit: "1",
        schemaErrors: [],
      }),
    ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
  });

  it("projects exactly the approved public fields and omits progress/private state", async () => {
    const internal = {
      ...record(1),
      tenantId: "forbidden-tenant",
      serviceVersionId: "forbidden-version",
      progressMessage: "unapproved source",
      internalStatus: "COMPLETED",
      validatedInput: { provider_resource: "forbidden" },
      providerMappingId: "forbidden-provider",
    };
    const result = await createListRunsService({
      repository: new RecordingRepository([internal]),
    }).list({
      principal,
      status: undefined,
      cursor: undefined,
      limit: undefined,
      schemaErrors: [],
    });

    expect(result.data[0]).toEqual({
      id: internal.id,
      service_id: internal.serviceId,
      status: internal.status,
      error_code: internal.customerErrorCode,
      retryable: internal.retryable,
      created_at: internal.createdAt.toISOString(),
      updated_at: internal.updatedAt.toISOString(),
      completed_at: internal.completedAt?.toISOString() ?? null,
    });
    expect(Object.keys(result.data[0]!).sort()).toEqual([
      "completed_at",
      "created_at",
      "error_code",
      "id",
      "retryable",
      "service_id",
      "status",
      "updated_at",
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /tenant|service_version|progress|internal|validated|provider/i,
    );
  });

  it("rejects schema, status, limit, cursor, and filter-mismatch failures before SQL", async () => {
    const queuedCursor = Buffer.from(
      JSON.stringify({
        version: 1,
        kind: "runs",
        status_filter: "queued",
        created_at: record(0).createdAt.toISOString(),
        id: record(0).id,
      }),
      "utf8",
    ).toString("base64url");
    const cases = [
      { status: "unknown", cursor: undefined, limit: undefined, schemaErrors: [] },
      { status: ["queued"], cursor: undefined, limit: undefined, schemaErrors: [] },
      { status: undefined, cursor: undefined, limit: "0", schemaErrors: [] },
      { status: undefined, cursor: undefined, limit: "101", schemaErrors: [] },
      { status: undefined, cursor: undefined, limit: "1.5", schemaErrors: [] },
      {
        status: undefined,
        serviceId: "not-a-uuid",
        cursor: undefined,
        limit: undefined,
        schemaErrors: [],
      },
      { status: undefined, cursor: ["one", "two"], limit: undefined, schemaErrors: [] },
      { status: undefined, cursor: "not-a-cursor", limit: undefined, schemaErrors: [] },
      { status: "ready", cursor: queuedCursor, limit: undefined, schemaErrors: [] },
      {
        status: undefined,
        cursor: undefined,
        limit: undefined,
        schemaErrors: [{ field: "querystring", message: "must not contain extra" }],
      },
    ] as const;

    for (const invalid of cases) {
      const repository = new RecordingRepository([]);
      await expect(
        createListRunsService({ repository }).list({ principal, ...invalid }),
      ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
      expect(repository.calls).toHaveLength(0);
    }
  });

  it("returns the accepted empty page", async () => {
    const result = await createListRunsService({
      repository: new RecordingRepository([]),
    }).list({
      principal,
      status: undefined,
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

    await expect(
      createListRunsService({
        repository: new RecordingRepository([], failure),
      }).list({
        principal,
        status: undefined,
        cursor: undefined,
        limit: undefined,
        schemaErrors: [],
      }),
    ).rejects.toBe(failure);
  });
});
