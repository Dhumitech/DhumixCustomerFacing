import { describe, expect, it } from "vitest";
import { decodeRunEventListCursor } from "../../src/helpers/runEventListCursor.js";
import type {
  ListRunEventsRecord,
  ListRunEventsRepository,
  ListRunEventsRepositoryInput,
} from "../../src/services/runQuery/listRunEventsRepository.js";
import { createListRunEventsService } from "../../src/services/runQuery/listRunEventsService.js";
import { ApplicationError } from "../../src/utils/applicationError.js";

const RUN_ID = "74000000-0000-4000-8000-000000000001";
const OTHER_RUN_ID = "74000000-0000-4000-8000-000000000002";
const principal = {
  kind: "browser",
  userId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  tenantId: "33333333-3333-4333-8333-333333333333",
} as const;

class RecordingRepository implements ListRunEventsRepository {
  public readonly calls: ListRunEventsRepositoryInput[] = [];

  public constructor(
    public records: readonly ListRunEventsRecord[] | undefined,
    public failWith?: Error,
  ) {}

  public async findPage(
    input: ListRunEventsRepositoryInput,
  ): Promise<readonly ListRunEventsRecord[] | undefined> {
    this.calls.push(input);
    if (this.failWith !== undefined) throw this.failWith;
    return this.records;
  }
}

function record(
  sequence: number,
  eventType = sequence % 2 === 0 ? "queued" : "accepted",
): ListRunEventsRecord {
  return {
    id: `75000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    sequence: String(sequence),
    eventType,
    occurredAt: new Date(Date.UTC(2026, 7, 25, 12, 0, sequence)),
  };
}

describe("listRunEventsService", () => {
  it("returns the default page and a Run-bound lossless cursor", async () => {
    const records = Array.from({ length: 21 }, (_, index) => record(index + 1));
    const repository = new RecordingRepository(records);

    const result = await createListRunEventsService({ repository }).list({
      principal,
      runId: RUN_ID,
      cursor: undefined,
      limit: undefined,
      schemaErrors: [],
    });

    expect(repository.calls).toEqual([
      {
        tenantId: principal.tenantId,
        userId: principal.userId,
        runId: RUN_ID,
        afterSequence: undefined,
        fetchLimit: 21,
      },
    ]);
    expect(result.data).toHaveLength(20);
    expect(result.page.has_more).toBe(true);
    expect(decodeRunEventListCursor(result.page.next_cursor!)).toEqual({
      runId: RUN_ID,
      sequence: "20",
    });
  });

  it("projects every accepted and legacy event into controlled public copy", async () => {
    const mappings = [
      ["accepted", "accepted", "Run accepted."],
      ["queued", "queued", "Run queued."],
      ["started", "started", "Run started."],
      ["submitted", "started", "Run started."],
      ["provider.accepted", "started", "Run started."],
      ["progress", "progress", "Run is in progress."],
      ["processing", "progress", "Run is in progress."],
      ["reconciliation_scheduled", "progress", "Run recovery is in progress."],
      ["normalization_reprocessing_started", "progress", "Run result processing restarted."],
      ["processing_recovered", "progress", "Run result processing recovered."],
      ["result_received", "result_received", "Run result received."],
      ["completed", "completed", "Run completed."],
      ["failed", "failed", "Run failed."],
      ["provider.failed", "failed", "Run failed."],
      ["cancellation_requested", "cancellation_requested", "Cancellation requested."],
      ["cancelled", "cancelled", "Run cancelled."],
      ["expired", "expired", "Run expired."],
    ] as const;
    const records = mappings.map(([stored], index) => ({
      ...record(index + 1, stored),
      safePayload: { provider_secret: `forbidden-${stored}` },
      evidenceReference: `vault://forbidden/${stored}`,
      source: "provider-private",
    }));

    const result = await createListRunEventsService({
      repository: new RecordingRepository(records),
    }).list({
      principal,
      runId: RUN_ID,
      cursor: undefined,
      limit: undefined,
      schemaErrors: [],
    });

    expect(result.data).toEqual(
      mappings.map(([, type, message], index) => ({
        id: records[index]!.id,
        type,
        message,
        occurred_at: records[index]!.occurredAt.toISOString(),
      })),
    );
    expect(JSON.stringify(result)).not.toMatch(/forbidden|provider-private|vault:\/\//i);
  });

  it("fails closed when an internal producer event has no public projection", async () => {
    for (const eventType of ["provider.raw_secret", "toString", "__proto__"]) {
      await expect(
        createListRunEventsService({
          repository: new RecordingRepository([record(1, eventType)]),
        }).list({
          principal,
          runId: RUN_ID,
          cursor: undefined,
          limit: undefined,
          schemaErrors: [],
        }),
      ).rejects.toMatchObject({ status: 500, code: "INTERNAL_ERROR" });
    }
  });

  it("rejects malformed path/query/cursor input before SQL with the declared error", async () => {
    const encoded = (value: unknown) =>
      Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    const otherRunCursor = encoded({
      version: 1,
      kind: "run_events",
      run_id: OTHER_RUN_ID,
      sequence: "1",
    });
    const cases = [
      {
        request: {
          runId: "not-a-uuid",
          cursor: undefined,
          limit: undefined,
          schemaErrors: [],
        },
        expected: { status: 404, code: "RESOURCE_NOT_FOUND" },
      },
      {
        request: {
          runId: RUN_ID,
          cursor: undefined,
          limit: undefined,
          schemaErrors: [{ field: "/run_id", message: "must match format uuid" }],
        },
        expected: { status: 404, code: "RESOURCE_NOT_FOUND" },
      },
      {
        request: {
          runId: RUN_ID,
          cursor: undefined,
          limit: undefined,
          schemaErrors: [{ field: "querystring", message: "must not contain extra" }],
        },
        expected: { status: 422, code: "VALIDATION_ERROR" },
      },
      {
        request: { runId: RUN_ID, cursor: undefined, limit: "0", schemaErrors: [] },
        expected: { status: 422, code: "VALIDATION_ERROR" },
      },
      {
        request: { runId: RUN_ID, cursor: undefined, limit: "01", schemaErrors: [] },
        expected: { status: 422, code: "VALIDATION_ERROR" },
      },
      {
        request: {
          runId: RUN_ID,
          cursor: "not-a-cursor",
          limit: undefined,
          schemaErrors: [],
        },
        expected: { status: 422, code: "VALIDATION_ERROR" },
      },
      {
        request: {
          runId: RUN_ID,
          cursor: otherRunCursor,
          limit: undefined,
          schemaErrors: [],
        },
        expected: { status: 422, code: "VALIDATION_ERROR" },
      },
    ] as const;

    for (const current of cases) {
      const repository = new RecordingRepository([]);
      await expect(
        createListRunEventsService({ repository }).list({
          principal,
          ...current.request,
        }),
      ).rejects.toMatchObject(current.expected);
      expect(repository.calls).toHaveLength(0);
    }
  });

  it("returns 404 for an invisible Run and an accepted empty page for an owned Run", async () => {
    await expect(
      createListRunEventsService({
        repository: new RecordingRepository(undefined),
      }).list({
        principal,
        runId: RUN_ID,
        cursor: undefined,
        limit: undefined,
        schemaErrors: [],
      }),
    ).rejects.toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND" });

    const result = await createListRunEventsService({
      repository: new RecordingRepository([]),
    }).list({
      principal,
      runId: RUN_ID,
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
      createListRunEventsService({
        repository: new RecordingRepository([], failure),
      }).list({
        principal,
        runId: RUN_ID,
        cursor: undefined,
        limit: undefined,
        schemaErrors: [],
      }),
    ).rejects.toBe(failure);
  });
});
