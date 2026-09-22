import { describe, expect, it } from "vitest";
import type {
  GetPlatformStatusRepository,
  PlatformProductStatusRecord,
} from "../../src/services/status/getPlatformStatusRepository.js";
import { createGetPlatformStatusService } from "../../src/services/status/getPlatformStatusService.js";

class StaticRepository implements GetPlatformStatusRepository {
  public constructor(
    private readonly records: readonly PlatformProductStatusRecord[],
  ) {}

  public async get(): Promise<readonly PlatformProductStatusRecord[]> {
    return this.records;
  }
}

const evaluatedAt = new Date("2026-08-31T12:30:00.000Z");

describe("getPlatformStatusService", () => {
  it("returns the exact customer-safe global projection", async () => {
    const result = await createGetPlatformStatusService({
      repository: new StaticRepository([
        {
          family: "scraper_library",
          state: "degraded",
          updatedAt: evaluatedAt,
        },
        {
          family: "marketplace_dataset",
          state: "not_enabled",
          updatedAt: evaluatedAt,
        },
      ]),
    }).get();

    expect(result).toEqual({
      state: "operational",
      products: [
        {
          family: "scraper_library",
          state: "degraded",
          updated_at: "2026-08-31T12:30:00.000Z",
        },
        {
          family: "marketplace_dataset",
          state: "not_enabled",
          updated_at: "2026-08-31T12:30:00.000Z",
        },
      ],
      updated_at: "2026-08-31T12:30:00.000Z",
    });
  });

  it("fails closed when the repository does not return the complete ordered projection", async () => {
    const invalidRecords: readonly (readonly PlatformProductStatusRecord[])[] = [
      [],
      [
        {
          family: "marketplace_dataset",
          state: "operational",
          updatedAt: evaluatedAt,
        },
        {
          family: "scraper_library",
          state: "operational",
          updatedAt: evaluatedAt,
        },
      ],
      [
        {
          family: "scraper_library",
          state: "provider_ready",
          updatedAt: evaluatedAt,
        },
        {
          family: "marketplace_dataset",
          state: "not_enabled",
          updatedAt: evaluatedAt,
        },
      ],
      [
        {
          family: "scraper_library",
          state: "operational",
          updatedAt: evaluatedAt,
        },
        {
          family: "marketplace_dataset",
          state: "not_enabled",
          updatedAt: new Date("2026-08-31T12:30:01.000Z"),
        },
      ],
    ];

    for (const records of invalidRecords) {
      await expect(
        createGetPlatformStatusService({
          repository: new StaticRepository(records),
        }).get(),
      ).rejects.toMatchObject({ status: 500, code: "INTERNAL_ERROR" });
    }
  });
});
