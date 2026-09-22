import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { verifyPoolRole } from "../../src/services/database/roleVerification.js";

const capabilityRoles = [
  "dhumi_admission",
  "dhumi_customer_api",
  "dhumi_envelope_janitor",
  "dhumi_identity",
  "dhumi_job_manager",
  "dhumi_operator",
  "dhumi_outbox_dispatcher",
  "dhumi_owner",
  "dhumi_result_recorder",
];

function roleAttributes(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rolname: "dhumi_test_identity_login",
    rolinherit: false,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolbypassrls: false,
    ...overrides,
  };
}

function membershipRows(activeRoles: readonly string[]): Record<string, unknown>[] {
  return capabilityRoles.map((roleName) => ({
    role_name: roleName,
    is_member: activeRoles.includes(roleName),
  }));
}

function fakePool(
  attributes: Record<string, unknown>,
  activeRoles: readonly string[],
  assumedRole = "dhumi_identity",
): { readonly pool: Pool; readonly clientQuery: ReturnType<typeof vi.fn> } {
  const poolQuery = vi
    .fn()
    .mockResolvedValueOnce({ rows: [attributes], rowCount: 1 })
    .mockResolvedValueOnce({ rows: membershipRows(activeRoles), rowCount: capabilityRoles.length });
  const clientQuery = vi
    .fn()
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    .mockResolvedValueOnce({ rows: [{ current_role: assumedRole }], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 0 });
  const client = { query: clientQuery, release: vi.fn() };
  return {
    pool: { query: poolQuery, connect: vi.fn(async () => client) } as unknown as Pool,
    clientQuery,
  };
}

describe("verifyPoolRole", () => {
  it("accepts one safe LOGIN role with exactly one approved capability", async () => {
    const { pool, clientQuery } = fakePool(roleAttributes(), ["dhumi_identity"]);

    await expect(
      verifyPoolRole(pool, "dhumi_test_identity_login", "dhumi_identity"),
    ).resolves.toBeUndefined();
    expect(clientQuery.mock.calls.map((call) => call[0])).toEqual([
      "BEGIN",
      "SET LOCAL ROLE dhumi_identity",
      "SELECT current_role",
      "ROLLBACK",
    ]);
  });

  it("rejects a LOGIN role that inherits privileges automatically", async () => {
    const { pool } = fakePool(roleAttributes({ rolinherit: true }), ["dhumi_identity"]);

    await expect(
      verifyPoolRole(pool, "dhumi_test_identity_login", "dhumi_identity"),
    ).rejects.toThrow("unsafe attributes");
  });

  it("rejects a LOGIN role with an additional capability membership", async () => {
    const { pool } = fakePool(roleAttributes(), ["dhumi_identity", "dhumi_customer_api"]);

    await expect(
      verifyPoolRole(pool, "dhumi_test_identity_login", "dhumi_identity"),
    ).rejects.toThrow("must belong only to dhumi_identity");
  });

  it("rejects a connection authenticated as a different LOGIN role", async () => {
    const { pool } = fakePool(roleAttributes({ rolname: "unexpected_login" }), ["dhumi_identity"]);

    await expect(
      verifyPoolRole(pool, "dhumi_test_identity_login", "dhumi_identity"),
    ).rejects.toThrow("did not use the configured runtime LOGIN role");
  });

  it("accepts a safe envelope-janitor LOGIN with no other capability", async () => {
    const attributes = roleAttributes({ rolname: "dhumi_test_envelope_janitor_login" });
    const { pool, clientQuery } = fakePool(
      attributes,
      ["dhumi_envelope_janitor"],
      "dhumi_envelope_janitor",
    );

    await expect(
      verifyPoolRole(
        pool,
        "dhumi_test_envelope_janitor_login",
        "dhumi_envelope_janitor",
      ),
    ).resolves.toBeUndefined();
    expect(clientQuery.mock.calls[1]?.[0]).toBe("SET LOCAL ROLE dhumi_envelope_janitor");
  });

  it("accepts a safe admission LOGIN with no other capability", async () => {
    const attributes = roleAttributes({ rolname: "dhumi_test_admission_login" });
    const { pool, clientQuery } = fakePool(
      attributes,
      ["dhumi_admission"],
      "dhumi_admission",
    );

    await expect(
      verifyPoolRole(pool, "dhumi_test_admission_login", "dhumi_admission"),
    ).resolves.toBeUndefined();
    expect(clientQuery.mock.calls[1]?.[0]).toBe("SET LOCAL ROLE dhumi_admission");
  });

  it("accepts a safe result-recorder LOGIN with no other capability", async () => {
    const attributes = roleAttributes({ rolname: "dhumi_test_result_recorder_login" });
    const { pool, clientQuery } = fakePool(
      attributes,
      ["dhumi_result_recorder"],
      "dhumi_result_recorder",
    );

    await expect(
      verifyPoolRole(
        pool,
        "dhumi_test_result_recorder_login",
        "dhumi_result_recorder",
      ),
    ).resolves.toBeUndefined();
    expect(clientQuery.mock.calls[1]?.[0]).toBe("SET LOCAL ROLE dhumi_result_recorder");
  });

  it("accepts separate safe Pattern 4 worker LOGIN roles", async () => {
    const dispatcher = fakePool(
      roleAttributes({ rolname: "dhumi_test_outbox_dispatcher_login" }),
      ["dhumi_outbox_dispatcher"],
      "dhumi_outbox_dispatcher",
    );
    await expect(
      verifyPoolRole(
        dispatcher.pool,
        "dhumi_test_outbox_dispatcher_login",
        "dhumi_outbox_dispatcher",
      ),
    ).resolves.toBeUndefined();

    const manager = fakePool(
      roleAttributes({ rolname: "dhumi_test_job_manager_login" }),
      ["dhumi_job_manager"],
      "dhumi_job_manager",
    );
    await expect(
      verifyPoolRole(manager.pool, "dhumi_test_job_manager_login", "dhumi_job_manager"),
    ).resolves.toBeUndefined();
  });
});
