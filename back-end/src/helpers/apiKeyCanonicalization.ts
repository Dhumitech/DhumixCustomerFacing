import { createHash } from "node:crypto";
import { API_SCOPES, type ApiScope } from "./apiKeyMaterial.js";

export const CREATE_API_KEY_OPERATION = "api_keys.create";
const API_SCOPE_SET: ReadonlySet<string> = new Set(API_SCOPES);

export interface ApiKeyCreateBody {
  readonly name?: unknown;
  readonly scopes?: unknown;
  readonly expires_at?: unknown;
}

export interface CanonicalApiKeyCreate {
  readonly name: string;
  readonly scopes: readonly ApiScope[];
  readonly expiresAt: Date | null;
}

export interface ApiKeyCreated {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly ApiScope[];
  readonly state: "active";
  readonly created_at: string;
  readonly last_used_at: null;
  readonly expires_at: string | null;
  readonly revoked_at: null;
  readonly secret: string;
}

export interface ValidationIssue {
  readonly field: string;
  readonly message: string;
}

export type CanonicalizationResult =
  | { readonly valid: true; readonly value: CanonicalApiKeyCreate }
  | { readonly valid: false; readonly issues: readonly ValidationIssue[] };

export function canonicalizeApiKeyCreate(
  body: ApiKeyCreateBody,
  now: Date,
): CanonicalizationResult {
  const issues: ValidationIssue[] = [];
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (typeof body.name !== "string" || name.length < 1 || [...name].length > 100) {
    issues.push({ field: "name", message: "must contain between 1 and 100 characters" });
  }

  const inputScopes = Array.isArray(body.scopes) ? body.scopes : [];
  const scopes = inputScopes.filter(
    (scope): scope is ApiScope => typeof scope === "string" && API_SCOPE_SET.has(scope),
  );
  if (
    !Array.isArray(body.scopes) ||
    scopes.length === 0 ||
    scopes.length !== inputScopes.length ||
    new Set(scopes).size !== scopes.length
  ) {
    issues.push({ field: "scopes", message: "must be a non-empty unique set of accepted scopes" });
  }

  let expiresAt: Date | null = null;
  if (body.expires_at !== undefined && body.expires_at !== null) {
    if (typeof body.expires_at !== "string") {
      issues.push({ field: "expires_at", message: "must be null or a future date-time" });
    } else {
      const parsed = new Date(body.expires_at);
      if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= now.getTime()) {
        issues.push({ field: "expires_at", message: "must be a future date-time" });
      } else {
        expiresAt = parsed;
      }
    }
  }

  if (issues.length > 0) return { valid: false, issues };
  return {
    valid: true,
    value: {
      name,
      scopes: Object.freeze([...scopes].sort()),
      expiresAt,
    },
  };
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function apiKeyActorFingerprint(userId: string): Buffer {
  return sha256(`dhumi:api-key-actor:v1:${userId}`);
}

export function apiKeyRequestHash(value: CanonicalApiKeyCreate): Buffer {
  return sha256(
    JSON.stringify({
      version: 1,
      operation: CREATE_API_KEY_OPERATION,
      name: value.name,
      scopes: value.scopes,
      expires_at: value.expiresAt?.toISOString() ?? null,
    }),
  );
}

export interface ApiKeyEnvelopeContext {
  readonly tenantId: string;
  readonly idempotencyRecordId: string;
  readonly apiKeyId: string;
}

export function apiKeyEnvelopeAad(context: ApiKeyEnvelopeContext): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      tenant_id: context.tenantId,
      operation: CREATE_API_KEY_OPERATION,
      idempotency_record_id: context.idempotencyRecordId,
      api_key_id: context.apiKeyId,
    }),
    "utf8",
  );
}

export function serializeApiKeyCreated(value: ApiKeyCreated): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

export function parseApiKeyCreated(serialized: Buffer): ApiKeyCreated {
  let value: unknown;
  try {
    value = JSON.parse(serialized.toString("utf8"));
  } catch (error) {
    throw new TypeError("The response envelope did not contain valid JSON", { cause: error });
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("The response envelope did not contain an API-key response");
  }
  const candidate = value as Record<string, unknown>;
  const scopes = candidate.scopes;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.prefix !== "string" ||
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    !scopes.every((scope) => typeof scope === "string" && API_SCOPE_SET.has(scope)) ||
    candidate.state !== "active" ||
    typeof candidate.created_at !== "string" ||
    candidate.last_used_at !== null ||
    !(candidate.expires_at === null || typeof candidate.expires_at === "string") ||
    candidate.revoked_at !== null ||
    typeof candidate.secret !== "string"
  ) {
    throw new TypeError("The response envelope contained an invalid API-key response");
  }
  return candidate as unknown as ApiKeyCreated;
}
