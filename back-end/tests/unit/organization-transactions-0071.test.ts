import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  withBrowseTransaction,
  withOrganizationReadTransaction,
  withOrganizationWriteTransaction,
  withAdmissionOrganizationTransaction,
} from "../../src/services/database/transactions.js";
import { createServiceRepository } from "../../src/services/customerServices/createServiceRepository.js";
import { createRunRepository } from "../../src/services/admission/createRunRepository.js";
import { createRetryRunRepository } from "../../src/services/admission/retryRunRepository.js";
import { createCancelRunRepository } from "../../src/services/admission/cancelRunRepository.js";
import { createMarketplaceExpertEnquiryRepository } from "../../src/services/marketplaceExpertEnquiry/marketplaceExpertEnquiryRepository.js";
import { createMarketplaceSampleDownloadRepository } from "../../src/services/marketplaceSampleDownload/marketplaceSampleDownloadRepository.js";
import { createGetRunResultRepository } from "../../src/services/runQuery/getRunResultRepository.js";
import { createGetCatalogTemplateRepository } from "../../src/services/catalogue/getCatalogTemplateRepository.js";
import { createListCatalogTemplatesRepository } from "../../src/services/catalogue/listCatalogTemplatesRepository.js";
import { createMarketplacePreviewRepository } from "../../src/services/marketplacePreview/marketplacePreviewRepository.js";
import { customerContextFixture } from "../helpers/customerContextFixture.js";

const userId = randomUUID();
const tenantId = randomUUID();
const scope = { userId, tenantId };
type Call = { sql: string; values: readonly unknown[] };
function database(
  deny?: "user" | "organization" | "membership" | "context",
  resource?: (call: Call) => readonly Record<string, unknown>[],
) {
  const calls: Call[] = [];
  const release = vi.fn();
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    const call = { sql, values };
    calls.push(call);
    if (
      (deny === "user" && sql.startsWith("SELECT id FROM app.users")) ||
      (deny === "organization" && sql.startsWith("SELECT id FROM app.organizations")) ||
      (deny === "membership" && sql.startsWith("SELECT user_id FROM app.organization_members")) ||
      (deny === "context" && sql.includes("AS user_id, set_config"))
    )
      return { rows: [], rowCount: 0 };
    const context = customerContextFixture(sql, values);
    if (context) return context;
    const rows = resource?.(call) ?? [];
    return { rows, rowCount: rows.length };
  });
  return {
    calls,
    query,
    release,
    pool: { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool,
  };
}

describe("0071 organization transaction guard", () => {
  it("cannot silently turn an organization read into global browsing when scope is missing", async () => {
    const db = database();
    await expect(withOrganizationReadTransaction(db.pool, {userId} as typeof scope, async () => {}))
      .rejects.toThrow("An organization is required");
    expect(db.pool.connect).not.toHaveBeenCalled();
  });
  it.each([
    ["customer", withOrganizationWriteTransaction, "dhumi_customer_api"],
    ["admission", withAdmissionOrganizationTransaction, "dhumi_admission"],
  ] as const)(
    "%s writes bind the user and lock organization before membership and business writes",
    async (_name, transaction, role) => {
      const db = database();
      await transaction(db.pool, scope, async (database) => {
        await database.query("INSERT INTO fixture_work DEFAULT VALUES");
      });
      expect(db.calls[1]?.sql).toBe("SET LOCAL ROLE " + role);
      expect(db.calls[2]?.sql).toBe("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      expect(db.calls[3]?.values).toEqual([userId, tenantId]);
      const org = db.calls.findIndex((c) => c.sql.startsWith("SELECT id FROM app.organizations"));
      const member = db.calls.findIndex((c) =>
        c.sql.startsWith("SELECT user_id FROM app.organization_members"),
      );
      const work = db.calls.findIndex((c) => c.sql.startsWith("INSERT INTO fixture_work"));
      expect(org).toBeLessThan(member);
      expect(member).toBeLessThan(work);
      expect(db.calls[org]?.sql).toContain("FOR SHARE");
      expect(db.calls[member]?.sql).toContain("FOR SHARE");
      expect(db.calls[member]?.values).toEqual([tenantId, userId]);
      expect(db.calls.at(-1)?.sql).toBe("COMMIT");
      expect(db.release).toHaveBeenCalledWith(undefined);
      expect(db.calls.map((c) => c.sql).join("\n")).not.toMatch(
        /FOR KEY SHARE|SET LOCAL ROLE dhumi_(identity|owner)/,
      );
    },
  );
  it.each(["user", "organization", "membership", "context"] as const)(
    "denies missing/stale %s before business work and rolls back",
    async (deny) => {
      const db = database(deny);
      const work = vi.fn(async () => "must not run");
      await expect(withOrganizationWriteTransaction(db.pool, scope, work)).rejects.toBeDefined();
      expect(work).not.toHaveBeenCalled();
      expect(db.calls.at(-1)?.sql).toBe("ROLLBACK");
      if (deny === "organization")
        expect(db.calls.some((c) => c.sql.includes("FROM app.organization_members"))).toBe(false);
    },
  );
  it("rechecks protected reads in their resource transaction without write locks", async () => {
    const db = database();
    await withOrganizationReadTransaction(db.pool, scope, async (database) =>
      database.query("SELECT 'resource'"),
    );
    expect(db.calls.some((c) => c.sql.includes("FROM app.organization_members"))).toBe(true);
    expect(db.calls.map((c) => c.sql).join("\n")).not.toMatch(/FOR SHARE|FOR UPDATE/);
  });
  it("rolls back authorization locks and writes on a downstream failure", async () => {
    const db = database();
    await expect(
      withOrganizationWriteTransaction(db.pool, scope, async () => {
        throw Error("business write failed");
      }),
    ).rejects.toThrow("business write failed");
    expect(db.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(db.calls.some((c) => c.sql === "COMMIT")).toBe(false);
  });
  it("rejects forged identifiers before acquiring a connection", async () => {
    const db = database();
    for (const forged of [
      { userId: "' OR 1=1--", tenantId },
      { userId, tenantId: "not-a-uuid" },
    ]) {
      await expect(
        withOrganizationWriteTransaction(db.pool, forged, async () => {}),
      ).rejects.toBeInstanceOf(TypeError);
    }
    expect(db.pool.connect).not.toHaveBeenCalled();
  });
  it("sets independent context for two organization transactions sharing a user", async () => {
    const db = database();
    const second = randomUUID();
    await withOrganizationReadTransaction(db.pool, scope, async () => {});
    await withOrganizationReadTransaction(db.pool, { userId, tenantId: second }, async () => {});
    expect(
      db.calls.filter((c) => c.sql.includes("AS user_id, set_config")).map((c) => c.values),
    ).toEqual([
      [userId, tenantId],
      [userId, second],
    ]);
  });
});

// Minimal values are intentional: a failed guard must prevent the repository
// from inspecting/claiming/mutating any business input or resource.
const writeCases: Array<[string, (pool: Pool) => Promise<unknown>]> = [
  [
    "Service creation",
    (pool) =>
      createServiceRepository(pool).persist({
        tenantId,
        actor: { kind: "browser", userId },
      } as Parameters<ReturnType<typeof createServiceRepository>["persist"]>[0]),
  ],
  [
    "Run creation",
    (pool) =>
      createRunRepository(pool).persist({
        tenantId,
        actor: { kind: "browser", userId },
      } as Parameters<ReturnType<typeof createRunRepository>["persist"]>[0]),
  ],
  [
    "Run retry",
    (pool) =>
      createRetryRunRepository(pool).persist({
        tenantId,
        actor: { kind: "browser", userId },
      } as Parameters<ReturnType<typeof createRetryRunRepository>["persist"]>[0]),
  ],
  [
    "Run cancellation",
    (pool) =>
      createCancelRunRepository(pool).persist({
        tenantId,
        actor: { kind: "browser", userId },
      } as Parameters<ReturnType<typeof createCancelRunRepository>["persist"]>[0]),
  ],
  [
    "Expert enquiry",
    (pool) =>
      createMarketplaceExpertEnquiryRepository(pool).create({
        tenantId,
        actor: { kind: "browser", userId },
      } as Parameters<ReturnType<typeof createMarketplaceExpertEnquiryRepository>["create"]>[0]),
  ],
  [
    "Download reservation",
    (pool) =>
      createMarketplaceSampleDownloadRepository(pool).reserve({
        tenantId,
        actor: { kind: "browser", userId },
      } as Parameters<ReturnType<typeof createMarketplaceSampleDownloadRepository>["reserve"]>[0]),
  ],
  [
    "Download completion",
    (pool) =>
      createMarketplaceSampleDownloadRepository(pool).complete({ tenantId, userId } as Parameters<
        ReturnType<typeof createMarketplaceSampleDownloadRepository>["complete"]
      >[0]),
  ],
  [
    "Download failure",
    (pool) =>
      createMarketplaceSampleDownloadRepository(pool).fail({
        tenantId,
        userId,
        authorizationId: randomUUID(),
      }),
  ],
  [
    "Result URL audit",
    (pool) =>
      createGetRunResultRepository(pool).recordDownloadAuthorization({
        tenantId,
        actor: { kind: "browser", userId },
      } as Parameters<
        ReturnType<typeof createGetRunResultRepository>["recordDownloadAuthorization"]
      >[0]),
  ],
];
describe("every ordinary customer write enters the shared guard", () => {
  it.each(writeCases)(
    "%s refuses removed membership before idempotency or mutation",
    async (_name, write) => {
      const db = database("membership");
      await expect(write(db.pool)).rejects.toMatchObject({
        status: 404,
        code: "RESOURCE_NOT_FOUND",
      });
      expect(db.calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(c.sql))).toEqual([]);
      expect(db.calls.at(-1)?.sql).toBe("ROLLBACK");
      expect(db.calls.filter((c) => c.sql.includes("FOR SHARE"))).toHaveLength(2);
    },
  );
});

describe("0071 user-only browsing transaction", () => {
  it("clears organization context and never reads membership for an unselected browse", async () => {
    const db = database();
    await withBrowseTransaction(db.pool, { userId }, async (database) =>
      database.query("SELECT 'catalogue'"),
    );
    expect(db.calls.find((c) => c.sql.includes("AS user_id, set_config"))?.values).toEqual([
      userId,
      "",
    ]);
    expect(db.calls.map((c) => c.sql).join("\n")).not.toMatch(
      /app\.(organizations|organization_members)|FOR SHARE/,
    );
  });
  it("refuses inactive users before catalogue/sample SQL", async () => {
    const db = database("user");
    const work = vi.fn(async () => {});
    await expect(withBrowseTransaction(db.pool, { userId }, work)).rejects.toMatchObject({
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
    });
    expect(work).not.toHaveBeenCalled();
    expect(db.calls.at(-1)?.sql).toBe("ROLLBACK");
  });
  it("checks a supplied organization before browsing selected templates", async () => {
    const db = database("membership");
    const work = vi.fn(async () => {});
    await expect(withBrowseTransaction(db.pool, scope, work)).rejects.toMatchObject({
      status: 404,
    });
    expect(work).not.toHaveBeenCalled();
  });
  it.each(["list", "detail", "sample"] as const)(
    "%s uses the user context without manufacturing membership",
    async (kind) => {
      const db = database();
      if (kind === "list")
        expect(
          await createListCatalogTemplatesRepository(db.pool).list({
            userId,
            family: undefined,
            cursor: undefined,
            fetchLimit: 21,
          }),
        ).toEqual([]);
      if (kind === "detail")
        expect(
          await createGetCatalogTemplateRepository(db.pool).findBySlug({
            userId,
            slug: "amazon-products",
          }),
        ).toBeUndefined();
      if (kind === "sample")
        expect(
          await createMarketplacePreviewRepository(db.pool).resolve({
            userId,
            templateSlug: "linkedin-posts",
          }),
        ).toBeUndefined();
      expect(db.calls.find((c) => c.sql.includes("AS user_id, set_config"))?.values).toEqual([
        userId,
        "",
      ]);
      expect(db.calls.some((c) => c.sql.includes("FROM app.organization_members"))).toBe(false);
      expect(db.calls.at(-1)?.sql).toBe("COMMIT");
    },
  );
});
