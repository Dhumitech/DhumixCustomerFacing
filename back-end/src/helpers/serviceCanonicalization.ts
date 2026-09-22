import { canonicalSha256 } from "./canonicalJson.js";
import type { TrustedTenantPrincipal } from "../services/tenantAccess/trustedTenantPrincipal.js";
import { tenantActorFingerprint } from "./tenantActorFingerprint.js";

const TEMPLATE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ServiceCreateBody {
  readonly template_slug?: unknown;
  readonly name?: unknown;
  readonly configuration?: unknown;
}

export interface CanonicalServiceCreate {
  readonly templateSlug: string;
  readonly name: string;
  readonly configuration: Readonly<Record<string, unknown>>;
}

export type CanonicalServiceCreateResult =
  | { readonly valid: true; readonly value: CanonicalServiceCreate }
  | {
      readonly valid: false;
      readonly issues: readonly { readonly field: string; readonly message: string }[];
    };

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function canonicalizeServiceCreate(body: ServiceCreateBody): CanonicalServiceCreateResult {
  const issues: { field: string; message: string }[] = [];
  const templateSlug = body.template_slug;
  const name = body.name;
  const configuration = body.configuration;

  if (typeof templateSlug !== "string" || !TEMPLATE_SLUG_PATTERN.test(templateSlug)) {
    issues.push({ field: "template_slug", message: "must be a canonical Template slug" });
  }

  if (typeof name !== "string") {
    issues.push({ field: "name", message: "must be a string" });
  } else {
    const codePoints = Array.from(name).length;
    if (codePoints < 1 || codePoints > 120) {
      issues.push({ field: "name", message: "must contain between 1 and 120 characters" });
    } else if (name.trim().length === 0) {
      issues.push({ field: "name", message: "must not contain only whitespace" });
    }
  }

  if (!isJsonObject(configuration)) {
    issues.push({ field: "configuration", message: "must be a JSON object" });
  }

  if (issues.length > 0) return { valid: false, issues };
  return {
    valid: true,
    value: {
      templateSlug: templateSlug as string,
      name: name as string,
      configuration: configuration as Readonly<Record<string, unknown>>,
    },
  };
}

export function serviceRequestHash(request: CanonicalServiceCreate): Buffer {
  return canonicalSha256({
    configuration: request.configuration,
    name: request.name,
    operation: "services.create.v1",
    template_slug: request.templateSlug,
  });
}

export function serviceActorFingerprint(principal: TrustedTenantPrincipal): Buffer {
  return tenantActorFingerprint(principal, "legacy-service");
}
