import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import { createDatabasePools } from "../../src/services/database/pools.js";
import {
  withIdentityTransaction,
  withTenantTransaction,
} from "../../src/services/database/transactions.js";
import { createTenantAuthorizationRepository } from "../../src/services/tenantAccess/tenantAuthorizationRepository.js";
import { createTenantAuthorizationService } from "../../src/services/tenantAccess/tenantAuthorizationService.js";
import { createWorkspaceRepository } from "../../src/services/workspace/workspaceRepository.js";
import { createWorkspaceService } from "../../src/services/workspace/workspaceService.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const config = enabled ? loadRuntimeConfig() : undefined;

if (enabled && config?.database.database !== "dhumi_test") {
  throw new Error("Workspace database tests may run only against dhumi_test");
}

const pools = enabled && config ? createDatabasePools(config.database, () => {}) : undefined;

afterAll(async () => {
  await pools?.close();
});

function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("database integration configuration is unavailable");
  }
  return value;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

interface WorkspaceFixture {
  readonly userId: string;
  readonly tenantId: string;
  readonly workspaceName: string;
}

interface SignupRow {
  readonly user_id: string | null;
  readonly tenant_id: string | null;
}

async function createWorkspaceFixture(label: string): Promise<WorkspaceFixture> {
  const nonce = randomUUID();
  const workspaceName = `Workspace integration ${label} ${nonce.slice(0, 8)}`;
  const row = await withIdentityTransaction(must(pools).identity, async (database) => {
    const result = await database.query<SignupRow>(
      `
        SELECT user_id, tenant_id
        FROM app.create_signup($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
      `,
      [
        `workspace-int-${nonce}@example.test`,
        "$argon2id$workspace-integration-fixture-not-a-real-password",
        workspaceName,
        JSON.stringify([
          {
            document_type: "terms",
            document_version: "workspace-int-v1",
            document_hash_hex: sha256(`workspace-legal-${nonce}`).toString("hex"),
            disclosure_version: "workspace-int-v1",
            locale: "en",
          },
        ]),
        `workspace-int-${nonce}`,
        sha256(`workspace-request-${nonce}`),
        sha256(`workspace-actor-${nonce}`),
        randomUUID(),
      ],
    );
    return result.rows[0];
  });

  if (row?.user_id === null || row?.user_id === undefined || row.tenant_id === null || row.tenant_id === undefined) {
    throw new Error("Could not establish a workspace database fixture");
  }
  return { userId: row.user_id, tenantId: row.tenant_id, workspaceName };
}

function sessionIdentity(fixture: WorkspaceFixture) {
  return {
    userId: fixture.userId,
    sessionId: randomUUID(),
    issuedTenantId: fixture.tenantId,
  };
}

function tenantAuthorization() {
  return createTenantAuthorizationService({
    repository: createTenantAuthorizationRepository(must(pools).identity),
  });
}

function workspace() {
  return createWorkspaceService({
    repository: createWorkspaceRepository(must(pools).customerApi),
  });
}

async function expectWorkspaceUnavailable(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    status: 403,
    code: "ACCESS_DENIED",
  });
}

async function mutateFixture(
  sql: string,
  values: readonly unknown[],
): Promise<void> {
  await withIdentityTransaction(must(pools).identity, async (database) => {
    await database.query(sql, values);
  });
}

describe.skipIf(!enabled)("workspace against PostgreSQL", () => {
  it("authorizes with the Identity role and reads the exact active workspace through Customer API RLS", async () => {
    const fixture = await createWorkspaceFixture("happy");
    const trustedTenant = await tenantAuthorization().authorizeBrowserTenant(
      sessionIdentity(fixture),
    );

    await expect(workspace().getWorkspace({ kind: "browser", ...trustedTenant })).resolves.toMatchObject({
      id: fixture.tenantId,
      name: fixture.workspaceName,
      state: "active",
      createdAt: expect.any(Date),
    });
  });

  it("does not grant the Customer API role access to Identity rows", async () => {
    const fixture = await createWorkspaceFixture("least-privilege");

    await expect(
      withTenantTransaction(must(pools).customerApi, fixture.tenantId, async (database) =>
        database.query("SELECT id FROM app.users LIMIT 1"),
      ),
    ).rejects.toThrow();
  });

  it("denies a cross-Tenant User/Tenant pair even when the RLS context names a real Tenant", async () => {
    const tenantA = await createWorkspaceFixture("tenant-a");
    const tenantB = await createWorkspaceFixture("tenant-b");

    await expectWorkspaceUnavailable(
      workspace().getWorkspace({
        kind: "browser",
        userId: tenantA.userId,
        sessionId: randomUUID(),
        tenantId: tenantB.tenantId,
      }),
    );
  });

  it("rejects suspended Users, revoked access, and suspended Tenants before RLS context is created", async () => {
    const cases = [
      {
        name: "suspended User",
        sql: "UPDATE app.users SET state = 'suspended' WHERE id = $1",
        values: (fixture: WorkspaceFixture) => [fixture.userId],
      },
      {
        name: "revoked access",
        sql: "UPDATE app.tenant_user_access SET state = 'revoked' WHERE user_id = $1 AND tenant_id = $2",
        values: (fixture: WorkspaceFixture) => [fixture.userId, fixture.tenantId],
      },
      {
        name: "suspended Tenant",
        sql: "UPDATE app.tenants SET state = 'suspended' WHERE id = $1",
        values: (fixture: WorkspaceFixture) => [fixture.tenantId],
      },
    ] as const;

    for (const testCase of cases) {
      const fixture = await createWorkspaceFixture(testCase.name);
      await mutateFixture(testCase.sql, testCase.values(fixture));
      await expectWorkspaceUnavailable(
        tenantAuthorization().authorizeBrowserTenant(sessionIdentity(fixture)),
      );
    }
  });

  it("fails closed when access changes after authorization but before the final RLS read", async () => {
    const fixture = await createWorkspaceFixture("authorization-race");
    const trustedTenant = await tenantAuthorization().authorizeBrowserTenant(
      sessionIdentity(fixture),
    );

    await mutateFixture(
      "UPDATE app.tenant_user_access SET state = 'revoked' WHERE user_id = $1 AND tenant_id = $2",
      [fixture.userId, fixture.tenantId],
    );

    await expectWorkspaceUnavailable(workspace().getWorkspace({ kind: "browser", ...trustedTenant }));
  });

  it("fails closed instead of selecting one of multiple active Tenant relationships", async () => {
    const fixture = await createWorkspaceFixture("ambiguous");
    await withIdentityTransaction(must(pools).identity, async (database) => {
      const secondTenant = await database.query<{ id: string }>(
        "INSERT INTO app.tenants (display_name) VALUES ($1) RETURNING id",
        ["Ambiguous second workspace"],
      );
      await database.query(
        `
          INSERT INTO app.tenant_user_access (tenant_id, user_id, access_role)
          VALUES ($1, $2, 'owner')
        `,
        [secondTenant.rows[0]?.id, fixture.userId],
      );
    });

    await expectWorkspaceUnavailable(
      tenantAuthorization().authorizeBrowserTenant(sessionIdentity(fixture)),
    );
  });
});
