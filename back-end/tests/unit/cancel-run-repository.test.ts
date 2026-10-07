import { customerContextFixture } from "../helpers/customerContextFixture.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  createCancelRunRepository,
  type CancelRunPersistenceInput,
} from "../../src/services/admission/cancelRunRepository.js";

function fixture(options: {
  readonly originalStarter: string | null;
  readonly alreadyRequested?: boolean;
  readonly replay?: boolean;
  readonly auditFails?: boolean;
}) {
  const input: CancelRunPersistenceInput = {
    idempotencyRecordId: randomUUID(),
    runEventId: randomUUID(),
    outboxEventId: randomUUID(),
    tenantId: randomUUID(),
    actor: { kind: "browser", userId: randomUUID() },
    actorFingerprint: Buffer.alloc(32, 1),
    requestHash: Buffer.alloc(32, 2),
    idempotencyKey: "cancel-repository-regression-0001",
    runId: randomUUID(),
    requestId: randomUUID(),
    ipFingerprint: Buffer.alloc(32, 3),
  };
  const timestamp = new Date("2026-10-06T10:00:00.000Z");
  const serviceId = randomUUID();
  const locked = {
    run_id: input.runId,
    service_id: serviceId,
    public_status: "queued",
    internal_status: "QUEUED",
    customer_error_code: null,
    retryable: false,
    created_at: timestamp,
    updated_at: timestamp,
    completed_at: null,
    next_event_sequence: "2",
    cancellation_requested: options.alreadyRequested ?? false,
    created_by_user_id: options.originalStarter,
  };
  const response = {
    id: input.runId,
    service_id: serviceId,
    status: "queued",
    error_code: null,
    retryable: false,
    created_at: timestamp.toISOString(),
    updated_at: timestamp.toISOString(),
    completed_at: null,
  };
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    const context = customerContextFixture(sql, values);
    if (context !== undefined) return context;
    let rows: readonly Record<string, unknown>[] = [];
    if (sql.includes("set_config")) rows = [{ organization_id: values[0] }];
    else if (sql.includes("INSERT INTO app.idempotency_records")) {
      rows = options.replay ? [] : [{ id: input.idempotencyRecordId }];
    } else if (sql.includes("FROM app.idempotency_records")) {
      rows = [
        {
          actor_fingerprint: input.actorFingerprint,
          request_hash: input.requestHash,
          state: "completed",
          response_status: 202,
          resource_id: input.runId,
          response_body_reference: "inline_json_v1",
          response_body: response,
        },
      ];
    } else if (sql.includes("FROM app.runs run")) rows = [locked];
    else if(sql.includes('bool_or(event_type'))rows=[{next_event_sequence:locked.next_event_sequence,cancellation_requested:locked.cancellation_requested}];
    else if (sql.includes("INSERT INTO app.audit_events") && options.auditFails) {
      throw Object.assign(new Error("fixture audit failure"), { code: "42501" });
    } else if (sql.includes("UPDATE app.idempotency_records"))
      rows = [{ response_body: values[2] }];
    return { rows, rowCount: rows.length };
  });
  const release = vi.fn();
  const pool = { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool;
  return { input, locked, response, query, release, repository: createCancelRunRepository(pool) };
}

describe("browser cancellation repository", () => {
  it.each([randomUUID(), null])(
    "audits the canceller while leaving the starter %s unchanged",
    async (originalStarter) => {
      const fake = fixture({ originalStarter });
      await expect(fake.repository.persist(fake.input)).resolves.toEqual({
        kind: "accepted",
        run: fake.response,
      });
      const statements = fake.query.mock.calls.map(([sql]) => sql);
      const audit = fake.query.mock.calls.find(([sql]) =>
        sql.includes("INSERT INTO app.audit_events"),
      );
      expect(audit?.[0]).not.toContain("actor_api_key_id");
      expect(audit?.[1]).toEqual([
        fake.input.tenantId,
        fake.input.actor.userId,
        fake.input.runId,
        "accepted",
        fake.input.requestId,
        fake.input.ipFingerprint,
        true,
      ]);
      const highestBinding = Math.max(
        ...Array.from(audit![0].matchAll(/\$(\d+)/g), (match) => Number(match[1])),
      );
      expect(highestBinding).toBe(audit?.[1]?.length);
      expect(statements.some((sql) => /(?:UPDATE|INSERT INTO) app\.runs\b/.test(sql))).toBe(false);
      expect(fake.locked.created_by_user_id).toBe(originalStarter);
      expect(statements.slice(0, 2)).toEqual(["BEGIN", "SET LOCAL ROLE dhumi_admission"]);
      expect(
        fake.query.mock.calls.find(([sql]) => sql.includes("AS user_id, set_config"))?.[1],
      ).toEqual([fake.input.actor.userId, fake.input.tenantId]);
      expect(statements.filter((sql) => sql.includes("INSERT INTO app.run_events"))).toHaveLength(
        1,
      );
      expect(
        statements.filter((sql) => sql.includes("INSERT INTO app.outbox_events")),
      ).toHaveLength(1);
      expect(statements.at(-1)).toBe("COMMIT");
      expect(fake.release).toHaveBeenCalledOnce();
    },
  );

  it("audits a second cancellation without another event or command", async () => {
    const fake = fixture({ originalStarter: randomUUID(), alreadyRequested: true });
    await expect(fake.repository.persist(fake.input)).resolves.toMatchObject({
      kind: "accepted_existing",
    });
    const statements = fake.query.mock.calls.map(([sql]) => sql);
    expect(statements.some((sql) => /INSERT INTO app\.(run_events|outbox_events)/.test(sql))).toBe(
      false,
    );
    expect(
      fake.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO app.audit_events"))?.[1],
    ).toEqual([
      fake.input.tenantId,
      fake.input.actor.userId,
      fake.input.runId,
      "accepted_existing",
      fake.input.requestId,
      fake.input.ipFingerprint,
      false,
    ]);
  });

  it("replays the original response without re-auditing or creating work", async () => {
    const fake = fixture({ originalStarter: null, replay: true });
    await expect(fake.repository.persist(fake.input)).resolves.toEqual({
      kind: "replay",
      run: fake.response,
    });
    const statements = fake.query.mock.calls.map(([sql]) => sql);
    expect(
      statements.some((sql) =>
        /INSERT INTO app\.(audit_events|run_events|outbox_events)/.test(sql),
      ),
    ).toBe(false);
    expect(statements.some((sql) => sql.includes("FROM app.runs run"))).toBe(false);
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("rolls back the event and command when auditing fails", async () => {
    const fake = fixture({ originalStarter: randomUUID(), auditFails: true });
    await expect(fake.repository.persist(fake.input)).rejects.toMatchObject({
      status: 500,
      code: "INTERNAL_ERROR",
    });
    const statements = fake.query.mock.calls.map(([sql]) => sql);
    expect(statements.some((sql) => sql.includes("INSERT INTO app.outbox_events"))).toBe(true);
    expect(statements).not.toContain("COMMIT");
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(fake.release).toHaveBeenCalledOnce();
  });
});
