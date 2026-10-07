import { describe, expect, it } from "vitest";
import {
  decodeCatalogTemplateListCursor,
  encodeCatalogTemplateListCursor,
} from "../../src/helpers/catalogTemplateListCursor.js";
import type {
  ListCatalogTemplatesRecord,
  ListCatalogTemplatesRepository,
  ListCatalogTemplatesRepositoryInput,
} from "../../src/services/catalogue/listCatalogTemplatesRepository.js";
import { createListCatalogTemplatesService } from "../../src/services/catalogue/listCatalogTemplatesService.js";

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

class RecordingRepository implements ListCatalogTemplatesRepository {
  public readonly calls: ListCatalogTemplatesRepositoryInput[] = [];

  public constructor(public records: readonly ListCatalogTemplatesRecord[]) {}

  public async list(
    input: ListCatalogTemplatesRepositoryInput,
  ): Promise<readonly ListCatalogTemplatesRecord[]> {
    this.calls.push(input);
    return this.records;
  }
}

function record(index: number): ListCatalogTemplatesRecord {
  const family = index % 2 === 0 ? "marketplace_dataset" : "scraper_library";
  return {
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    slug: `${family === "marketplace_dataset" ? "marketplace" : "scraper"}-${String(index).padStart(2, "0")}`,
    family,
    templateState: "published",
    version: 1,
    name: `Template ${index}`,
    description: `Description ${index}`,
    availabilityState: "available",
    presentation,
    configurationSchema: { type: "object", additionalProperties: false },
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  };
}

describe("listCatalogTemplatesService", () => {
  it("returns the default page and a cursor for the last visible Template", async () => {
    const records = Array.from({ length: 21 }, (_, index) => record(index));
    const repository = new RecordingRepository(records);

    const result = await createListCatalogTemplatesService({ repository }).list({
      principal,
      family: undefined,
      cursor: undefined,
      limit: undefined,
      schemaErrors: [],
    });

    expect(repository.calls).toEqual([
      {
        tenantId: principal.tenantId,
        userId: principal.userId,
        family: undefined,
        cursor: undefined,
        fetchLimit: 21,
      },
    ]);
    expect(result.data).toHaveLength(20);
    expect(result.page.has_more).toBe(true);
    expect(decodeCatalogTemplateListCursor(result.page.next_cursor!)).toEqual({
      familyFilter: null,
      family: records[19]!.family,
      slug: records[19]!.slug,
      id: records[19]!.id,
    });
    expect(result.data[0]).toEqual({
      slug: records[0]!.slug,
      version: 1,
      family: "marketplace_dataset",
      name: "Template 0",
      description: "Description 0",
      availability: "available",
      presentation,
      configuration_schema: records[0]!.configurationSchema,
      input_schema: records[0]!.inputSchema,
    });
  });

  it("binds the cursor to the normalized family filter", async () => {
    const cursor = encodeCatalogTemplateListCursor({
      familyFilter: "marketplace_dataset",
      family: "marketplace_dataset",
      slug: "marketplace-00",
      id: "00000000-0000-4000-8000-000000000001",
    });
    const repository = new RecordingRepository([]);

    await createListCatalogTemplatesService({ repository }).list({
      principal,
      family: "marketplace_dataset",
      cursor,
      limit: "5",
      schemaErrors: [],
    });

    expect(repository.calls).toEqual([
      {
        tenantId: principal.tenantId,
        userId: principal.userId,
        family: "marketplace_dataset",
        cursor: {
          familyFilter: "marketplace_dataset",
          family: "marketplace_dataset",
          slug: "marketplace-00",
          id: "00000000-0000-4000-8000-000000000001",
        },
        fetchLimit: 6,
      },
    ]);

    await expect(
      createListCatalogTemplatesService({
        repository: new RecordingRepository([]),
      }).list({
        principal,
        family: "scraper_library",
        cursor,
        limit: undefined,
        schemaErrors: [],
      }),
    ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
  });

  it("overrides a disabled Template to temporarily unavailable and exposes exactly public fields", async () => {
    const internal = {
      ...record(0),
      templateState: "disabled",
      availabilityState: "available",
      adapterVersionId: "forbidden-adapter-id",
      launchEvidenceId: "forbidden-evidence-id",
    } as const;
    const result = await createListCatalogTemplatesService({
      repository: new RecordingRepository([internal]),
    }).list({
      principal,
      family: undefined,
      cursor: undefined,
      limit: undefined,
      schemaErrors: [],
    });

    expect(result.data[0]).toEqual({
      slug: internal.slug,
      version: internal.version,
      family: internal.family,
      name: internal.name,
      description: internal.description,
      availability: "temporarily_unavailable",
      presentation,
      configuration_schema: internal.configurationSchema,
      input_schema: internal.inputSchema,
    });
    expect(JSON.stringify(result)).not.toMatch(/adapter|evidence|provider/i);
  });

  it("rejects schema, family, limit, cursor, and filter-binding failures before persistence", async () => {
    const mismatchedCursor = encodeCatalogTemplateListCursor({
      familyFilter: null,
      family: "marketplace_dataset",
      slug: "marketplace-00",
      id: "00000000-0000-4000-8000-000000000001",
    });
    const cases = [
      { family: "unknown", cursor: undefined, limit: undefined, schemaErrors: [] },
      { family: ["marketplace_dataset"], cursor: undefined, limit: undefined, schemaErrors: [] },
      { family: undefined, cursor: undefined, limit: "0", schemaErrors: [] },
      { family: undefined, cursor: undefined, limit: "101", schemaErrors: [] },
      { family: undefined, cursor: undefined, limit: "1.5", schemaErrors: [] },
      { family: undefined, cursor: ["one", "two"], limit: undefined, schemaErrors: [] },
      { family: undefined, cursor: "not-a-cursor", limit: undefined, schemaErrors: [] },
      {
        family: "marketplace_dataset",
        cursor: mismatchedCursor,
        limit: undefined,
        schemaErrors: [],
      },
      {
        family: undefined,
        cursor: undefined,
        limit: undefined,
        schemaErrors: [{ field: "querystring", message: "must not contain extra" }],
      },
    ] as const;

    for (const invalid of cases) {
      const repository = new RecordingRepository([]);
      await expect(
        createListCatalogTemplatesService({ repository }).list({ principal, ...invalid }),
      ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
      expect(repository.calls).toHaveLength(0);
    }
  });

  it("returns the accepted empty page", async () => {
    const result = await createListCatalogTemplatesService({
      repository: new RecordingRepository([]),
    }).list({
      principal,
      family: undefined,
      cursor: undefined,
      limit: undefined,
      schemaErrors: [],
    });

    expect(result).toEqual({
      data: [],
      page: { next_cursor: null, has_more: false },
    });
  });
});
