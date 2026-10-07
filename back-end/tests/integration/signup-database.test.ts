import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import { createPasswordHasher } from "../../src/helpers/password.js";
import type { SubmittedLegalAcceptance } from "../../src/helpers/legalAcceptance.js";
import { createDatabasePools } from "../../src/services/database/pools.js";
import { withIdentityTransaction } from "../../src/services/database/transactions.js";
import { createSignupRepository } from "../../src/services/identity/signupRepository.js";
import { createSignupService } from "../../src/services/identity/signupService.js";
import type { SignupService } from "../../src/services/identity/signupService.js";
import { actorFingerprint } from "../../src/helpers/signupCanonicalization.js";
import { ApplicationError } from "../../src/utils/applicationError.js";

const databaseTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";

const config = databaseTestsEnabled ? loadRuntimeConfig() : undefined;

if (databaseTestsEnabled && config?.database.database !== "dhumi_test") {
  throw new Error("Signup database tests may run only against dhumi_test");
}

const pools = databaseTestsEnabled && config ? createDatabasePools(config.database, () => {}) : undefined;

afterAll(async () => {
  await pools?.close();
});

function service(): SignupService {
  if (pools === undefined || config === undefined) {
    throw new Error("database pools are not configured");
  }
  return createSignupService({
    repository: createSignupRepository(pools.identity),
    passwordHasher: createPasswordHasher(config.passwordHash),
    legal: config.legal,
  });
}

function acceptances(): SubmittedLegalAcceptance[] {
  return [
    {
      document_type: "terms",
      document_version: "signup-int-v1",
      content_hash: "a".repeat(64),
      accepted: true,
    },
  ];
}

interface Counts {
  readonly users: number;
  readonly tenants: number;
  readonly access: number;
}

async function countsFor(identityPool: Pool, emailNormalized: string): Promise<Counts> {
  return withIdentityTransaction(identityPool, async (database) => {
    const identity = await database.query<{ id: string }>(
      "SELECT id FROM app.users WHERE email_normalized = $1", [emailNormalized],
    );
    if (identity.rows[0] !== undefined) {
      await database.query("SELECT set_config('app.user_id', $1, true)", [identity.rows[0].id]);
    }
    const result = await database.query<{
      users: string;
      tenants: string;
      access: string;
    }>(
      `
        SELECT
          (SELECT count(*) FROM app.users u WHERE u.email_normalized = $1) AS users,
          (SELECT count(*) FROM app.tenants t
             JOIN app.tenant_user_access a ON a.tenant_id = t.id
             JOIN app.users u2 ON u2.id = a.user_id
            WHERE u2.email_normalized = $1) AS tenants,
          (SELECT count(*) FROM app.tenant_user_access a2
             JOIN app.users u3 ON u3.id = a2.user_id
            WHERE u3.email_normalized = $1 AND a2.state = 'active') AS access
      `,
      [emailNormalized],
    );
    const row = result.rows[0];
    return {
      users: Number(row?.users ?? -1),
      tenants: Number(row?.tenants ?? -1),
      access: Number(row?.access ?? -1),
    };
  });
}

function uniqueEmail(): string {
  return `signup-int-${randomUUID()}@example.test`;
}

describe.skipIf(!databaseTestsEnabled)("signup against PostgreSQL", () => {
  it("creates exactly one User and no organization or membership", async () => {
    const email = uniqueEmail();
    await service().submit({
      email,
      password: "a-sufficiently-long-password",
      workspaceName: "Signup Integration",
      legalAcceptances: acceptances(),
      idempotencyKey: `signup-int-${randomUUID()}`,
      requestId: randomUUID(),
    });

    expect(await countsFor(pools!.identity, email)).toEqual({
      users: 1,
      tenants: 0,
      access: 0,
    });
  });

  it("replays an identical user request without creating another user", async () => {
    const email = uniqueEmail();
    const key = `signup-int-${randomUUID()}`;
    const request = {
      email,
      password: "a-sufficiently-long-password",
      workspaceName: "Replay Workspace",
      legalAcceptances: acceptances(),
      idempotencyKey: key,
      requestId: randomUUID(),
    };

    await service().submit(request);
    await service().submit({ ...request, requestId: randomUUID() });

    expect(await countsFor(pools!.identity, email)).toEqual({
      users: 1,
      tenants: 0,
      access: 0,
    });
  });

  it("rejects the same key carrying a different request with 409", async () => {
    const key = `signup-int-${randomUUID()}`;
    const first = {
      email: uniqueEmail(),
      password: "a-sufficiently-long-password",
      workspaceName: "Conflict One",
      legalAcceptances: acceptances(),
      idempotencyKey: key,
      requestId: randomUUID(),
    };

    await service().submit(first);

    // Same actor fingerprint, different canonical body.
    const conflicting = { emailNormalized: first.email, passwordHash: "unused-on-replay",
      legalAcceptances: [], idempotencyKey: key, requestHash: Buffer.alloc(32, 255),
      actorFingerprint: actorFingerprint(first.email), requestId: randomUUID() };

    await expect(createSignupRepository(pools!.identity).createSignup(conflicting)).rejects.toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
    });
    await expect(createSignupRepository(pools!.identity).createSignup(conflicting)).rejects.toBeInstanceOf(ApplicationError);
  });

  it("accepts an existing email without creating organization access", async () => {
    const email = uniqueEmail();
    await service().submit({
      email,
      password: "a-sufficiently-long-password",
      workspaceName: "First Workspace",
      legalAcceptances: acceptances(),
      idempotencyKey: `signup-int-${randomUUID()}`,
      requestId: randomUUID(),
    });

    // A different Idempotency-Key, so this is a genuine second submission.
    await service().submit({
      email,
      password: "a-different-sufficiently-long-password",
      workspaceName: "Second Workspace",
      legalAcceptances: acceptances(),
      idempotencyKey: `signup-int-${randomUUID()}`,
      requestId: randomUUID(),
    });

    expect(await countsFor(pools!.identity, email)).toEqual({
      users: 1,
      tenants: 0,
      access: 0,
    });
  });

  it("creates exactly one User under concurrent identical submissions", async () => {
    const email = uniqueEmail();
    const request = {
      email,
      password: "a-sufficiently-long-password",
      workspaceName: "Concurrent Workspace",
      legalAcceptances: acceptances(),
      idempotencyKey: `signup-int-${randomUUID()}`,
      requestId: randomUUID(),
    };

    const results = await Promise.allSettled([
      service().submit({ ...request }),
      service().submit({ ...request }),
      service().submit({ ...request }),
    ]);

    // Every concurrent caller must observe an accepted outcome. A blocked
    // duplicate reads the completed idempotency record after the winner
    // commits, so none of them may surface an error.
    expect(results.filter((result) => result.status === "rejected")).toEqual([]);

    expect(await countsFor(pools!.identity, email)).toEqual({
      users: 1,
      tenants: 0,
      access: 0,
    });
  });

  it("treats a whitespace-padded workspace name as the same request", async () => {
    const email = uniqueEmail();
    const key = `signup-int-${randomUUID()}`;
    const base = {
      email,
      password: "a-sufficiently-long-password",
      legalAcceptances: acceptances(),
      idempotencyKey: key,
      requestId: randomUUID(),
    };

    await service().submit({ ...base, workspaceName: "  Padded Workspace  " });

    // The retry sends the trimmed value a client would normally submit. The
    // canonical request hash must match, so this replays instead of raising
    // IDEMPOTENCY_CONFLICT.
    await service().submit({ ...base, workspaceName: "Padded Workspace" });

    expect(await countsFor(pools!.identity, email)).toEqual({
      users: 1,
      tenants: 0,
      access: 0,
    });
  });

  it("ignores an empty deprecated workspace value", async () => {
    const email = uniqueEmail();
    await service().submit({ email, password: "a-sufficiently-long-password",
      workspaceName: "", legalAcceptances: acceptances(),
      idempotencyKey: 'signup-int-'+randomUUID(), requestId: randomUUID() });
    expect(await countsFor(pools!.identity, email)).toEqual({ users: 1, tenants: 0, access: 0 });
  });

  it("normalises the email so a differently cased address is the same identity", async () => {
    const email = uniqueEmail();
    await service().submit({
      email: email.toUpperCase(),
      password: "a-sufficiently-long-password",
      workspaceName: "Case Workspace",
      legalAcceptances: acceptances(),
      idempotencyKey: `signup-int-${randomUUID()}`,
      requestId: randomUUID(),
    });

    expect(await countsFor(pools!.identity, email.toLowerCase())).toEqual({
      users: 1,
      tenants: 0,
      access: 0,
    });
  });
});
