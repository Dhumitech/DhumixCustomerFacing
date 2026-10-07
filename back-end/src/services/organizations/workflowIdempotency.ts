import { randomUUID } from "node:crypto";
import type { DatabaseExecutor } from "../../types/database.js";
import { ApplicationError } from "../../utils/applicationError.js";
import { digest, equalDigest } from "./organizationSecurity.js";

export type WorkflowResponse = Record<string, unknown>;
/** Secrets are never stored in request/response JSON. Callers supply safe fingerprints. */
export async function claimWorkflow(database: DatabaseExecutor, input: {
  userId: string; organizationId?: string; operation: string; key: string; fingerprint: unknown;
}): Promise<{ id: string; replay: WorkflowResponse | null }> {
  const hash = digest(JSON.stringify(input.fingerprint));
  const actor = digest(`browser-user:${input.userId}`);
  const inserted = await database.query<{ id: string }>(
    `INSERT INTO app.idempotency_records
      (id, organization_id, actor_fingerprint, operation_code, idempotency_key, request_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp() + interval '24 hours')
     ON CONFLICT DO NOTHING RETURNING id`,
    [randomUUID(), input.organizationId ?? null, actor, input.operation, input.key, hash],
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id, replay: null };
  const existing = await database.query<{ id: string; request_hash: Buffer; state: string; response_body: WorkflowResponse | null }>(
    `SELECT id, request_hash, state, response_body FROM app.idempotency_records
     WHERE organization_id IS NOT DISTINCT FROM $1::uuid AND actor_fingerprint = $2
       AND operation_code = $3 AND idempotency_key = $4 FOR UPDATE`,
    [input.organizationId ?? null, actor, input.operation, input.key],
  );
  const row = existing.rows[0];
  if (!row || !equalDigest(row.request_hash, hash))
    throw new ApplicationError({ status: 409, code: "IDEMPOTENCY_CONFLICT", title: "Idempotency conflict" });
  if (row.state !== "completed" || !row.response_body)
    throw new ApplicationError({ status: 409, code: "STATE_CONFLICT", title: "Request is incomplete" });
  return { id: row.id, replay: row.response_body };
}
export async function completeWorkflow(database: DatabaseExecutor, id: string, status: number, response: WorkflowResponse): Promise<void> {
  await database.query(
    `UPDATE app.idempotency_records SET state = 'completed', response_status = $2, response_body = $3::jsonb,
      response_body_reference = 'organization-workflow:v1', completed_at = clock_timestamp() WHERE id = $1`,
    [id, status, JSON.stringify(response)],
  );
}
