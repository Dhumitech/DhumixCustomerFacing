import { describe, expect, it } from "vitest";
import type { PublicCatalogTemplateRecord } from "../../src/services/catalogue/catalogTemplate.js";
import type {
  GetCatalogTemplateRepository,
  GetCatalogTemplateRepositoryInput,
} from "../../src/services/catalogue/getCatalogTemplateRepository.js";
import { createGetCatalogTemplateService } from "../../src/services/catalogue/getCatalogTemplateService.js";
import { ApplicationError } from "../../src/utils/applicationError.js";

const principal = {
  kind: "browser",
  userId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  tenantId: "33333333-3333-4333-8333-333333333333",
} as const;

const presentation = {
  domain_slug: "amazon-com",
  domain_name: "amazon.com",
  category: "e-commerce",
  icon_key: "amazon",
  operation_group: "Amazon products",
  operation_name: "Collect by URL",
  display_priority: 1,
} as const;

function record(
  overrides: Partial<PublicCatalogTemplateRecord> = {},
): PublicCatalogTemplateRecord {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    slug: "amazon-products",
    family: "marketplace_dataset",
    templateState: "published",
    version: 2,
    name: "Amazon products",
    description: "Approved product catalogue template",
    availabilityState: "available",
    presentation,
    configurationSchema: { type: "object", additionalProperties: false },
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    ...overrides,
  };
}

class RecordingRepository implements GetCatalogTemplateRepository {
  public readonly calls: GetCatalogTemplateRepositoryInput[] = [];
  public failure: ApplicationError | undefined;

  public constructor(public result: PublicCatalogTemplateRecord | undefined) {}

  public async findBySlug(
    input: GetCatalogTemplateRepositoryInput,
  ): Promise<PublicCatalogTemplateRecord | undefined> {
    this.calls.push(input);
    if (this.failure !== undefined) throw this.failure;
    return this.result;
  }
}

function request(...slugInput: [] | [unknown]) {
  return {
    principal,
    slug: slugInput.length === 0 ? "amazon-products" : slugInput[0],
    schemaErrors: [],
  };
}

describe("getCatalogTemplateService", () => {
  it("uses only the trusted Tenant and returns exactly the public projection", async () => {
    const internal = {
      ...record(),
      adapterVersionId: "forbidden-adapter",
      launchEvidenceId: "forbidden-evidence",
      datasetId: "forbidden-provider-resource",
    };
    const repository = new RecordingRepository(internal);

    const result = await createGetCatalogTemplateService({ repository }).get(request());

    expect(repository.calls).toEqual([
      { tenantId: principal.tenantId, slug: "amazon-products" },
    ]);
    expect(result).toEqual({
      slug: "amazon-products",
      version: 2,
      family: "marketplace_dataset",
      name: "Amazon products",
      description: "Approved product catalogue template",
      availability: "available",
      presentation,
      configuration_schema: internal.configurationSchema,
      input_schema: internal.inputSchema,
    });
    expect(Object.keys(result)).toHaveLength(9);
    expect(JSON.stringify(result)).not.toMatch(
      /adapter|evidence|dataset_id|snapshot_id|provider_resource/i,
    );
  });

  it("overrides a disabled Template to temporarily unavailable", async () => {
    const result = await createGetCatalogTemplateService({
      repository: new RecordingRepository(
        record({ templateState: "disabled", availabilityState: "coming_soon" }),
      ),
    }).get(request());

    expect(result.availability).toBe("temporarily_unavailable");
  });

  it.each([
    ["missing", undefined],
    ["too short", "ab"],
    ["too long", "a".repeat(101)],
    ["upper case", "Amazon-products"],
    ["leading hyphen", "-amazon"],
    ["trailing hyphen", "amazon-"],
    ["repeated hyphen", "amazon--products"],
    ["non-string", ["amazon-products"]],
  ])("maps %s slug syntax to the same generic 404 before persistence", async (_label, slug) => {
    const repository = new RecordingRepository(record());

    await expect(
      createGetCatalogTemplateService({ repository }).get(request(slug)),
    ).rejects.toMatchObject({
      status: 404,
      code: "RESOURCE_NOT_FOUND",
      title: "Resource not found",
      detail: null,
    });
    expect(repository.calls).toHaveLength(0);
  });

  it("maps attached path validation and an invisible record to the identical 404", async () => {
    const invalidRepository = new RecordingRepository(record());
    const missingRepository = new RecordingRepository(undefined);
    const invalid = createGetCatalogTemplateService({ repository: invalidRepository }).get({
      ...request(),
      schemaErrors: [{ field: "/slug", message: "must match pattern" }],
    });
    const missing = createGetCatalogTemplateService({ repository: missingRepository }).get(
      request(),
    );

    await expect(invalid).rejects.toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND" });
    await expect(missing).rejects.toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND" });
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

    await expect(
      createGetCatalogTemplateService({ repository }).get(request()),
    ).rejects.toBe(repository.failure);
  });
});
