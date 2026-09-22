import { describe, expect, it } from "vitest";
import { decodeUsageEventListCursor } from "../../src/helpers/usageEventListCursor.js";
import type {
  ListUsageEventsRecord,
  ListUsageEventsRepository,
  ListUsageEventsRepositoryInput,
} from "../../src/services/usage/listUsageEventsRepository.js";
import { createListUsageEventsService } from "../../src/services/usage/listUsageEventsService.js";

const principal = {
  kind: "browser",
  userId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  tenantId: "33333333-3333-4333-8333-333333333333",
} as const;

class RecordingRepository implements ListUsageEventsRepository {
  public readonly calls: ListUsageEventsRepositoryInput[] = [];

  public constructor(public records: readonly ListUsageEventsRecord[]) {}

  public async findPage(input: ListUsageEventsRepositoryInput) {
    this.calls.push(input);
    return this.records;
  }
}

function record(index: number): ListUsageEventsRecord {
  return {
    id: `79000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    runId: `79100000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    productFamily: "scraper_library",
    meter: "amazon.result_records.observed",
    quantity: `${index}.000000`,
    unit: "records",
    outcome: "succeeded",
    observedAt: new Date(Date.UTC(2026, 7, 30, 12, 0, 59 - index)),
    cursorObservedAt: new Date(Date.UTC(2026, 7, 30, 12, 0, 59 - index))
      .toISOString()
      .replace(".000Z", ".000001Z"),
  };
}

describe("listUsageEventsService", () => {
  it("returns the default page and a time-window-bound lossless cursor", async () => {
    const repository = new RecordingRepository(
      Array.from({ length: 21 }, (_, index) => record(index + 1)),
    );
    const result = await createListUsageEventsService({ repository }).list({
      principal,
      from: "2026-08-01T00:00:00Z",
      to: "2026-09-01T00:00:00Z",
      cursor: undefined,
      limit: undefined,
      schemaErrors: [],
    });

    expect(result.data).toHaveLength(20);
    expect(result.page.has_more).toBe(true);
    expect(decodeUsageEventListCursor(result.page.next_cursor!)).toEqual({
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-09-01T00:00:00.000Z",
      observedAt: repository.records[19]!.cursorObservedAt,
      id: result.data[19]!.id,
    });
    expect(repository.calls[0]).toMatchObject({
      tenantId: principal.tenantId,
      fetchLimit: 21,
      beforeObservedAt: undefined,
      beforeId: undefined,
    });
  });

  it("rejects a cursor replayed against a different time window", async () => {
    const repository = new RecordingRepository(
      Array.from({ length: 21 }, (_, index) => record(index + 1)),
    );
    const first = await createListUsageEventsService({ repository }).list({
      principal,
      from: "2026-08-01T00:00:00Z",
      to: "2026-09-01T00:00:00Z",
      cursor: undefined,
      limit: undefined,
      schemaErrors: [],
    });

    await expect(
      createListUsageEventsService({ repository }).list({
        principal,
        from: "2026-08-02T00:00:00Z",
        to: "2026-09-01T00:00:00Z",
        cursor: first.page.next_cursor,
        limit: undefined,
        schemaErrors: [],
      }),
    ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
  });

  it("publishes only the accepted event fields", async () => {
    const privateRecord = {
      ...record(1),
      providerReferenceFingerprint: "forbidden",
      evidenceReference: "vault://forbidden",
      attemptId: "forbidden",
    };
    const result = await createListUsageEventsService({
      repository: new RecordingRepository([privateRecord]),
    }).list({
      principal,
      from: "2026-08-01T00:00:00Z",
      to: "2026-09-01T00:00:00Z",
      cursor: undefined,
      limit: "1",
      schemaErrors: [],
    });

    expect(Object.keys(result.data[0]!)).toEqual([
      "id",
      "run_id",
      "product_family",
      "meter",
      "quantity",
      "unit",
      "outcome",
      "observed_at",
    ]);
    expect(JSON.stringify(result)).not.toMatch(/forbidden|provider|vault/i);
  });

  it("fails closed for unsupported internal public enums", async () => {
    for (const override of [
      { productFamily: "provider_private" },
      { outcome: "charged" },
    ]) {
      await expect(
        createListUsageEventsService({
          repository: new RecordingRepository([{ ...record(1), ...override }]),
        }).list({
          principal,
          from: "2026-08-01T00:00:00Z",
          to: "2026-09-01T00:00:00Z",
          cursor: undefined,
          limit: undefined,
          schemaErrors: [],
        }),
      ).rejects.toMatchObject({ status: 500, code: "INTERNAL_ERROR" });
    }
  });
});
