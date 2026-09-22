import { canonicalSha256 } from "./canonicalJson.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RunCreateBody {
  readonly input?: unknown;
}

export interface CanonicalRunCreate {
  readonly serviceId: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export type CanonicalRunCreateResult =
  | { readonly valid: true; readonly value: CanonicalRunCreate }
  | {
      readonly valid: false;
      readonly issues: readonly { readonly field: string; readonly message: string }[];
    };

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function canonicalizeRunCreate(
  serviceId: unknown,
  body: RunCreateBody,
): CanonicalRunCreateResult {
  const issues: { field: string; message: string }[] = [];
  if (typeof serviceId !== "string" || !UUID_PATTERN.test(serviceId)) {
    issues.push({ field: "service_id", message: "must be a valid UUID" });
  }
  if (!isJsonObject(body.input)) {
    issues.push({ field: "input", message: "must be a JSON object" });
  }
  if (issues.length > 0) return { valid: false, issues };
  return {
    valid: true,
    value: {
      serviceId: (serviceId as string).toLowerCase(),
      input: body.input as Readonly<Record<string, unknown>>,
    },
  };
}

export function runRequestHash(request: CanonicalRunCreate): Buffer {
  return canonicalSha256({
    input: request.input,
    operation: "runs.create.v1",
    service_id: request.serviceId,
  });
}
