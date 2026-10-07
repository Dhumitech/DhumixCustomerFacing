import { describe, expect, it } from "vitest";
import type {
  GetServiceRecord,
  GetServiceRepository,
  GetServiceRepositoryInput,
} from "../../src/services/customerServices/getServiceRepository.js";
import { createGetServiceService } from "../../src/services/customerServices/getServiceService.js";
import { ApplicationError } from "../../src/utils/applicationError.js";

const principal = {
  kind: "browser",
  userId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  tenantId: "33333333-3333-4333-8333-333333333333",
} as const;
const serviceId = "44444444-4444-4444-8444-444444444444";

function record(overrides: Partial<GetServiceRecord> = {}): GetServiceRecord {
  return {
    id: serviceId,
    name: "Saved marketplace Service",
    templateSlug: "amazon-products",
    templateVersion: 2,
    version: 3,
    family: "marketplace_dataset",
    state: "active",
    configuration: { query: "laptop", filters: { country: "US" } },
    createdAt: new Date("2026-08-25T12:00:00.000Z"),
    ...overrides,
  };
}

class RecordingRepository implements GetServiceRepository {
  public readonly calls: GetServiceRepositoryInput[] = [];
  public failure: ApplicationError | undefined;

  public constructor(public result: GetServiceRecord | undefined) {}

  public async findById(input: GetServiceRepositoryInput): Promise<GetServiceRecord | undefined> {
    this.calls.push(input);
    if (this.failure !== undefined) throw this.failure;
    return this.result;
  }
}

function request(...idInput: [] | [unknown]) {
  return {
    principal,
    serviceId: idInput.length === 0 ? serviceId : idInput[0],
    schemaErrors: [],
  };
}

describe("getServiceService", () => {
  it("uses only the trusted Tenant and returns the exact public detail", async () => {
    const configuration = { query: "laptop", nested: { country: "US" } };
    const repository = new RecordingRepository(record({ configuration }));

    const result = await createGetServiceService({ repository }).get(request());

    expect(repository.calls).toEqual([
      { tenantId: principal.tenantId, userId: principal.userId, serviceId },
    ]);
    expect(result).toEqual({
      id: serviceId,
      name: "Saved marketplace Service",
      template_slug: "amazon-products",
      template_version: 2,
      version: 3,
      family: "marketplace_dataset",
      state: "active",
      configuration,
      created_at: "2026-08-25T12:00:00.000Z",
    });
    expect(result.configuration).toBe(configuration);
    expect(Object.keys(result)).toHaveLength(9);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["not a UUID", "not-a-uuid"],
    ["wrong UUID version", "44444444-4444-0444-8444-444444444444"],
    ["wrong UUID variant", "44444444-4444-4444-7444-444444444444"],
    ["non-string", [serviceId]],
  ])("maps %s identifiers to generic 404 before persistence", async (_label, id) => {
    const repository = new RecordingRepository(record());

    await expect(createGetServiceService({ repository }).get(request(id))).rejects.toMatchObject({
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

    const invalid = createGetServiceService({ repository: invalidRepository }).get({
      ...request(),
      schemaErrors: [{ field: "/service_id", message: "must match format uuid" }],
    });
    const invisible = createGetServiceService({ repository: missingRepository }).get(request());

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

    await expect(createGetServiceService({ repository }).get(request())).rejects.toBe(
      repository.failure,
    );
  });
});
