import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { withIdentityTransaction } from "../database/transactions.js";
import { ApplicationError } from "../../utils/applicationError.js";

export interface DatabaseLegalAcceptance {
  readonly document_type: string;
  readonly document_version: string;
  readonly document_hash_hex: string;
  readonly disclosure_version: string | null;
}
export interface SignupRepositoryInput {
  readonly emailNormalized: string;
  readonly passwordHash: string;
  readonly legalAcceptances: readonly DatabaseLegalAcceptance[];
  readonly idempotencyKey: string;
  readonly requestHash: Buffer;
  /** Exact v1 hash for replay of a completed pre-0071 request only. */
  readonly legacyRequestHash?: Buffer;
  readonly actorFingerprint: Buffer;
  readonly requestId: string;
}
export type SignupOutcome =
  | { readonly kind: "completed"; readonly userId: string | null; readonly replayed: boolean }
  | { readonly kind: "existing"; readonly replayed: boolean }
  | { readonly kind: "in_progress" };
export interface SignupRepository {
  createSignup(input: SignupRepositoryInput): Promise<SignupOutcome>;
}
interface ClaimRow {
  readonly id: string;
  readonly request_hash: Buffer;
  readonly state: string;
  readonly resource_type: string | null;
  readonly related_resource_id: string | null;
  readonly response_status: number | null;
  readonly response_body_reference: string | null;
}
function equalHash(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}
export function createSignupRepository(pool: Pool): SignupRepository {
  return {
    async createSignup(input): Promise<SignupOutcome> {
      try {
        return await withIdentityTransaction(pool, async (database) => {
          const claimed = await database.query<ClaimRow>(
            `INSERT INTO app.idempotency_records
               (actor_fingerprint, operation_code, idempotency_key,
                request_hash, expires_at)
             VALUES ($1, 'auth.signup', $2, $3, clock_timestamp() + interval '24 hours')
             ON CONFLICT (actor_fingerprint, operation_code, idempotency_key)
               WHERE organization_id IS NULL DO NOTHING RETURNING *`,
            [input.actorFingerprint, input.idempotencyKey, input.requestHash],
          );
          let claim = claimed.rows[0];
          if (claim === undefined) {
            const existing = await database.query<ClaimRow>(
              `SELECT id, request_hash, state, resource_type, related_resource_id,
                      response_status, response_body_reference
               FROM app.idempotency_records
               WHERE organization_id IS NULL AND actor_fingerprint = $1
                 AND operation_code = 'auth.signup' AND idempotency_key = $2 FOR UPDATE`,
              [input.actorFingerprint, input.idempotencyKey],
            );
            claim = existing.rows[0];
            if (claim === undefined) throw new Error("Signup idempotency claim not found");
            const historicalReplay =
              claim.state === "completed" &&
              claim.response_status === 202 &&
              claim.response_body_reference === "auth-accepted:v1" &&
              (claim.resource_type === "tenant" || claim.resource_type === "signup_request") &&
              input.legacyRequestHash !== undefined &&
              equalHash(claim.request_hash, input.legacyRequestHash);
            if (!equalHash(claim.request_hash, input.requestHash) && !historicalReplay) {
              throw new ApplicationError({
                status: 409,
                code: "IDEMPOTENCY_CONFLICT",
                title: "Idempotency conflict",
                detail: "This Idempotency-Key was already used with a different request.",
              });
            }
            if (claim.state === "completed") {
              if (claim.response_status === 409 && claim.response_body_reference === "auth-account-exists:v1") {
                return { kind: "existing", replayed: true };
              }
              return { kind: "completed", userId: claim.related_resource_id, replayed: true };
            }
            return { kind: "in_progress" };
          }
          // A conflict never overwrites an existing password or legal evidence.
          const userId = randomUUID();
          const inserted = await database.query<{ id: string }>(
            `INSERT INTO app.users (id, email_normalized, password_hash)
             VALUES ($1, $2, $3) ON CONFLICT (email_normalized) DO NOTHING RETURNING id`,
            [userId, input.emailNormalized, input.passwordHash],
          );
          const created = inserted.rows[0]?.id;
          let auditUserId = created;
          if (created === undefined) {
            const existing = await database.query<{ id: string }>(
              `SELECT id FROM app.users WHERE email_normalized = $1`,
              [input.emailNormalized],
            );
            auditUserId = existing.rows[0]?.id;
            if (auditUserId === undefined)
              throw new Error("Existing signup identity not found after conflict");
          } else {
            await database.query("SELECT set_config('app.user_id', $1, true)", [created]);
            for (const acceptance of input.legalAcceptances) {
              await database.query(
                `INSERT INTO app.legal_acceptances
                   (user_id, document_type, document_version, document_hash, disclosure_version, trace_id)
                 VALUES ($1, $2, $3, decode($4, 'hex'), $5, $6)`,
                [
                  created,
                  acceptance.document_type,
                  acceptance.document_version,
                  acceptance.document_hash_hex,
                  acceptance.disclosure_version,
                  input.requestId,
                ],
              );
            }
          }
          // Signup proves no mailbox ownership: the target user is not an actor.
          await database.query(
            `INSERT INTO app.audit_events
               (action, target_type, target_id, outcome, trace_id)
             VALUES ($1, 'user', $2, $4, $3)`,
            [
              created === undefined ? "identity.signup_existing" : "identity.signup",
              auditUserId,
              input.requestId,
              created === undefined ? "rejected_existing" : "accepted",
            ],
          );
          // Target explicitly retires the unused signup notification outbox.
          await database.query(
            `UPDATE app.idempotency_records SET state = 'completed', response_status = $3,
               resource_type = 'signup_request', resource_id = NULL, related_resource_id = $2,
               response_body_reference = $4, completed_at = clock_timestamp()
             WHERE id = $1`,
            [claim.id, created ?? null, created === undefined ? 409 : 202,
              created === undefined ? "auth-account-exists:v1" : "auth-accepted:v2"],
          );
          return created === undefined
            ? { kind: "existing", replayed: false }
            : { kind: "completed", userId: created, replayed: false };
        });
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "57014"
        ) {
          throw new ApplicationError({
            status: 429,
            code: "PLATFORM_CAPACITY_LIMIT",
            title: "Too many requests",
            detail: "The request could not be completed in time. Retry shortly.",
            cause: error,
          });
        }
        throw new ApplicationError({
          status: 500,
          code: "INTERNAL_ERROR",
          title: "Internal server error",
          cause: error,
        });
      }
    },
  };
}
