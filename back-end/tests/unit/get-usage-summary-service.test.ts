import { describe, expect, it } from "vitest";
import type {
  GetUsageSummaryRepository,
  GetUsageSummaryRepositoryInput,
  UsageSummaryRecord,
} from "../../src/services/usage/getUsageSummaryRepository.js";
import { createGetUsageSummaryService } from "../../src/services/usage/getUsageSummaryService.js";

const principal = {
  kind: "browser",
  userId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  tenantId: "33333333-3333-4333-8333-333333333333",
} as const;

class RecordingRepository implements GetUsageSummaryRepository {
  public readonly calls: GetUsageSummaryRepositoryInput[] = [];

  public constructor(public record: UsageSummaryRecord) {}

  public async get(input: GetUsageSummaryRepositoryInput) {
    this.calls.push(input);
    return this.record;
  }
}

describe("getUsageSummaryService", () => {
  it("returns the exact normalized informational summary", async () => {
    const repository = new RecordingRepository({
      items: [
        {
          meter: "amazon.result_records.observed",
          quantity: "93.000000",
          unit: "records",
        },
      ],
      updatedAt: new Date("2026-08-31T10:00:00.000Z"),
      state: "observed",
    });
    const result = await createGetUsageSummaryService({ repository }).get({
      principal,
      from: "2026-08-01T00:00:00+00:00",
      to: "2026-09-01T00:00:00Z",
      schemaErrors: [],
    });

    expect(result).toEqual({
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-09-01T00:00:00.000Z",
      items: [
        {
          meter: "amazon.result_records.observed",
          quantity: 93,
          unit: "records",
        },
      ],
      updated_at: "2026-08-31T10:00:00.000Z",
      state: "observed",
    });
    expect(repository.calls[0]).toMatchObject({ tenantId: principal.tenantId });
    expect(repository.calls[0]).toMatchObject({
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-09-01T00:00:00.000Z",
    });
  });

  it("rejects invalid and reversed ranges before reaching PostgreSQL", async () => {
    const cases = [
      { from: undefined, to: "2026-09-01T00:00:00Z" },
      { from: "2026-08-01", to: "2026-09-01T00:00:00Z" },
      {
        from: "2026-09-01T00:00:00Z",
        to: "2026-08-01T00:00:00Z",
      },
    ];
    for (const range of cases) {
      const repository = new RecordingRepository({
        items: [],
        updatedAt: new Date(),
        state: "observed",
      });
      await expect(
        createGetUsageSummaryService({ repository }).get({
          principal,
          ...range,
          schemaErrors: [],
        }),
      ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
      expect(repository.calls).toHaveLength(0);
    }
  });

  it("preserves PostgreSQL microsecond precision while normalizing the zone", async () => {
    const repository = new RecordingRepository({
      items: [],
      updatedAt: new Date("2026-08-31T10:00:00.000Z"),
      state: "observed",
    });
    const result = await createGetUsageSummaryService({ repository }).get({
      principal,
      from: "2026-08-30T14:27:06.123456+05:30",
      to: "2026-08-30T08:57:06.123457Z",
      schemaErrors: [],
    });
    expect(result.from).toBe("2026-08-30T08:57:06.123456Z");
    expect(result.to).toBe("2026-08-30T08:57:06.123457Z");
    expect(repository.calls[0]).toMatchObject({
      from: "2026-08-30T08:57:06.123456Z",
      to: "2026-08-30T08:57:06.123457Z",
    });
  });

  it("fails closed for invalid internal quantities or reconciliation states", async () => {
    for (const record of [
      {
        items: [{ meter: "m", quantity: "NaN", unit: "records" }],
        updatedAt: new Date(),
        state: "observed",
      },
      { items: [], updatedAt: new Date(), state: "provider_final" },
    ]) {
      await expect(
        createGetUsageSummaryService({
          repository: new RecordingRepository(record),
        }).get({
          principal,
          from: "2026-08-01T00:00:00Z",
          to: "2026-09-01T00:00:00Z",
          schemaErrors: [],
        }),
      ).rejects.toMatchObject({ status: 500, code: "INTERNAL_ERROR" });
    }
  });
});
