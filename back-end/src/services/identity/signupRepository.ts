import type { Pool } from "pg";
import { withIdentityTransaction } from "../database/transactions.js";
import { ApplicationError } from "../../utils/applicationError.js";

/**
 * The exact JSONB shape `app.create_signup` reads.
 *
 * `document_hash_hex` is not a typo of the public contract's `content_hash`.
 * The database function decodes this key into `legal_acceptances.document_hash`,
 * which is `bytea NOT NULL`; forwarding the public field name would decode NULL
 * and fail every signup with `23502`. The translation happens in the service.
 */
export interface DatabaseLegalAcceptance {
  readonly document_type: string;
  readonly document_version: string;
  readonly document_hash_hex: string;
  readonly disclosure_version: string | null;
  readonly locale: string;
}

export interface SignupRepositoryInput {
  readonly emailNormalized: string;
  readonly passwordHash: string;
  readonly workspaceName: string;
  readonly legalAcceptances: readonly DatabaseLegalAcceptance[];
  readonly idempotencyKey: string;
  readonly requestHash: Buffer;
  readonly actorFingerprint: Buffer;
  readonly requestId: string | null;
}

/**
 * `completed` covers all three committed outcomes: a new identity, an existing
 * email, and a replayed idempotency record. They differ only in the identifiers
 * returned, which never leave the backend.
 */
export type SignupOutcome =
  | {
      readonly kind: "completed";
      readonly userId: string | null;
      readonly tenantId: string | null;
      readonly replayed: boolean;
    }
  | { readonly kind: "in_progress" };

export interface SignupRepository {
  createSignup(input: SignupRepositoryInput): Promise<SignupOutcome>;
}

interface SignupRow {
  readonly user_id: string | null;
  readonly tenant_id: string | null;
  readonly replayed: boolean;
}

function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error as { code?: unknown };
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function databaseErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

const IDEMPOTENCY_CONFLICT = new ApplicationError({
  status: 409,
  code: "IDEMPOTENCY_CONFLICT",
  title: "Idempotency conflict",
  detail: "This Idempotency-Key was already used with a different request.",
});

function internalFailure(cause: unknown): ApplicationError {
  return new ApplicationError({
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Internal server error",
    cause,
  });
}

/**
 * True only for the one `55000` condition that is a normal outcome.
 *
 * `app.create_signup` raises `55000` from three places:
 * `SIGNUP_IN_PROGRESS`, `IDEMPOTENCY_CLAIM_NOT_FOUND` and
 * `EXISTING_IDENTITY_NOT_FOUND_AFTER_CONFLICT`. Only the first is expected;
 * the other two are internal inconsistencies. Matching the SQLSTATE alone
 * would report a genuine failure to the customer as an accepted signup.
 */
function isConcurrentDuplicate(error: unknown): boolean {
  return (
    databaseErrorCode(error) === "55000" &&
    databaseErrorMessage(error).includes("SIGNUP_IN_PROGRESS")
  );
}

/** Always throws. Never returns a value to the caller. */
function throwCustomerSafeError(error: unknown): never {
  const code = databaseErrorCode(error);
  const message = databaseErrorMessage(error);

  if (code === "23505" && message.includes("IDEMPOTENCY_CONFLICT")) {
    throw IDEMPOTENCY_CONFLICT;
  }

  if (code === "57014") {
    throw new ApplicationError({
      status: 429,
      code: "PLATFORM_CAPACITY_LIMIT",
      title: "Too many requests",
      detail: "The request could not be completed in time. Retry shortly.",
      cause: error,
    });
  }

  // Anything else, including an unrecognised 55000 message, fails safe as an
  // internal error rather than being reported as success.
  throw internalFailure(error);
}

export function createSignupRepository(pool: Pool): SignupRepository {
  return {
    async createSignup(input: SignupRepositoryInput): Promise<SignupOutcome> {
      try {
        return await withIdentityTransaction(pool, async (database) => {
          const result = await database.query<SignupRow>(
            `
              SELECT user_id, tenant_id, replayed
              FROM app.create_signup($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
            `,
            [
              input.emailNormalized,
              input.passwordHash,
              input.workspaceName,
              JSON.stringify(input.legalAcceptances),
              input.idempotencyKey,
              input.requestHash,
              input.actorFingerprint,
              input.requestId,
            ],
          );

          const row = result.rows[0];
          if (row === undefined) {
            throw internalFailure(new Error("app.create_signup returned no row"));
          }

          return {
            kind: "completed" as const,
            userId: row.user_id,
            tenantId: row.tenant_id,
            replayed: row.replayed,
          };
        });
      } catch (error) {
        if (error instanceof ApplicationError) {
          throw error;
        }
        if (isConcurrentDuplicate(error)) {
          return { kind: "in_progress" };
        }
        throwCustomerSafeError(error);
      }
    },
  };
}
