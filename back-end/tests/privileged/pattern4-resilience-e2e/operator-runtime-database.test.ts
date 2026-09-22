import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadDeadLetterRecoveryConfig } from "../../../src/config/pattern4Environment.js";
import { createOperatorPool } from "../../../src/services/database/pools.js";
import { verifyOperatorPool } from "../../../src/services/database/roleVerification.js";
import { withOperatorTransaction } from "../../../src/services/database/transactions.js";

const enabled = process.env.RUN_PATTERN4_RESILIENCE_DATABASE_MATRIX === "true";
const config = enabled ? loadDeadLetterRecoveryConfig() : undefined;
const pool = config ? createOperatorPool(config.database, () => undefined) : undefined;

if (enabled && config?.database.database !== "dhumi_test") {
  throw new Error("Pattern 4 operator proof may run only against dhumi_test");
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Pattern 4 operator configuration is unavailable");
  return value;
}

describe.skipIf(!enabled)("Pattern 4 restricted operator runtime", () => {
  beforeAll(async () => {
    const runtime = required(config);
    await verifyOperatorPool(required(pool), runtime.database.credential.user);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("assumes only dhumi_operator and can execute the controlled recovery function", async () => {
    const result = await withOperatorTransaction(required(pool), (database) =>
      database.query<{
        readonly current_role: string;
        readonly can_recover: boolean;
        readonly can_create_role: boolean;
      }>(`
        SELECT
          current_role,
          has_function_privilege(
            current_role,
            'app.recover_dead_lettered_run_command(uuid,text)',
            'EXECUTE'
          ) AS can_recover,
          has_database_privilege(current_role, current_database(), 'CREATE') AS can_create_role
      `),
    );

    expect(result.rows[0]).toEqual({
      current_role: "dhumi_operator",
      can_recover: true,
      can_create_role: false,
    });
  });
});
