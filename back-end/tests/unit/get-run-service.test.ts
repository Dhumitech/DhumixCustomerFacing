import { describe, expect, it } from "vitest";
import type {
  GetRunRecord,
  GetRunRepository,
  GetRunRepositoryInput,
} from "../../src/services/runQuery/getRunRepository.js";
import { createGetRunService } from "../../src/services/runQuery/getRunService.js";
import { ApplicationError } from "../../src/utils/applicationError.js";

const principal = {
  kind: "browser",
  userId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  tenantId: "33333333-3333-4333-8333-333333333333",
} as const;
const runId = "44444444-4444-4444-8444-444444444444";
const serviceId = "55555555-5555-4555-8555-555555555555";

function record(overrides: Partial<GetRunRecord> = {}): GetRunRecord {
  return {
    id: runId,
    serviceId,
    status: "failed",
    customerErrorCode: "UPSTREAM_UNAVAILABLE",
    retryable: true,
    createdAt: new Date("2026-08-25T12:00:00.000Z"),
    updatedAt: new Date("2026-08-25T12:05:00.000Z"),
    completedAt: new Date("2026-08-25T12:05:00.000Z"),
    ...overrides,
  };
}

class RecordingRepository implements GetRunRepository {
  public readonly calls: GetRunRepositoryInput[] = [];
  public failure: ApplicationError | undefined;

  public constructor(public result: GetRunRecord | undefined) {}

  public async findById(input: GetRunRepositoryInput): Promise<GetRunRecord | undefined> {
    this.calls.push(input);
    if (this.failure !== undefined) throw this.failure;
    return this.result;
  }
}

function request(...idInput: [] | [unknown]) {
  return {
    principal,
    runId: idInput.length === 0 ? runId : idInput[0],
    schemaErrors: [],
  };
}

describe("getRunService", () => {
  it("uses only the trusted Tenant and maps the exact public Run", async () => {
    const repository = new RecordingRepository(record());

    const result = await createGetRunService({ repository }).get(request());

    expect(repository.calls).toEqual([
      { tenantId: principal.tenantId, userId: principal.userId, runId },
    ]);
    expect(result).toEqual({
      id: runId,
      service_id: serviceId,
      status: "failed",
      error_code: "UPSTREAM_UNAVAILABLE",
      retryable: true,
      created_at: "2026-08-25T12:00:00.000Z",
      updated_at: "2026-08-25T12:05:00.000Z",
      completed_at: "2026-08-25T12:05:00.000Z",
    });
    expect(result).not.toHaveProperty("progress_message");
    expect(Object.keys(result)).toHaveLength(8);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["not a UUID", "not-a-uuid"],
    ["wrong UUID version", "44444444-4444-0444-8444-444444444444"],
    ["wrong UUID variant", "44444444-4444-4444-7444-444444444444"],
    ["non-string", [runId]],
  ])("maps %s identifiers to generic 404 before persistence", async (_label, id) => {
    const repository = new RecordingRepository(record());

    await expect(createGetRunService({ repository }).get(request(id))).rejects.toMatchObject({
      status: 404,
      code: "RESOURCE_NOT_FOUND",
      title: "Resource not found",
      detail: null,
    });
    expect(repository.calls).toHaveLength(0);
  });

  it("maps attached validation and an invisible row to the identical 404", async () => {
    const invalidRepository = new RecordingRepository(record());
    const missingRepository = new RecordingRepository(undefined);

    const invalid = createGetRunService({ repository: invalidRepository }).get({
      ...request(),
      schemaErrors: [{ field: "/run_id", message: "must match format uuid" }],
    });
    const invisible = createGetRunService({ repository: missingRepository }).get(request());

    await expect(invalid).rejects.toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND" });
    await expect(invisible).rejects.toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND" });
    expect(invalidRepository.calls).toHaveLength(0);
    expect(missingRepository.calls).toHaveLength(1);
  });

  it("preserves a safe application failure from the repository", async () => {
    const repository = new RecordingRepository(undefined);
    repository.failure = new ApplicationError({
      status: 500,
      code: "INTERNAL_ERROR",
      title: "Internal server error",
    });

    await expect(createGetRunService({ repository }).get(request())).rejects.toBe(
      repository.failure,
    );
  });
});
