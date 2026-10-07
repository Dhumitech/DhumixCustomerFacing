import { timingSafeEqual } from "node:crypto";
import { canonicalJson, canonicalSha256 } from "../../helpers/canonicalJson.js";

export const TEMPLATE_ENGINES = ["amazon.v1", "scraper.v1"] as const;
export type TemplateEngine = (typeof TEMPLATE_ENGINES)[number];

/** Private lossless fold of the existing adapter/mapping fields. Never serialize it publicly. */
export interface TemplateExecutionDefinition {
  readonly capability_metadata: Readonly<Record<string, unknown>>;
  readonly request_schema: Readonly<Record<string, unknown>>;
  readonly result_schema: Readonly<Record<string, unknown>>;
  readonly error_schema: Readonly<Record<string, unknown>>;
  readonly operation_code: string;
  readonly output_policy: Readonly<Record<string, unknown>>;
  readonly commercial_config_version: string;
  readonly config_version: string;
}

export class TemplateExecutionDefinitionError extends Error {
  public constructor() { super("Private template execution definition is unavailable"); this.name = "TemplateExecutionDefinitionError"; }
}

const fields = ["capability_metadata", "request_schema", "result_schema", "error_schema", "operation_code", "output_policy", "commercial_config_version", "config_version"] as const;
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseTemplateExecutionDefinition(value: unknown): TemplateExecutionDefinition {
  if (!object(value) || Object.keys(value).length !== fields.length || fields.some(field => !(field in value)) ||
    !["capability_metadata", "request_schema", "result_schema", "error_schema", "output_policy"].every(field => object(value[field])) ||
    typeof value.operation_code !== "string" || !/^[a-z][a-z0-9_.-]{2,127}$/.test(value.operation_code) ||
    ![value.commercial_config_version, value.config_version].every(version => typeof version === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(version)) ||
    Buffer.byteLength(canonicalJson(value), "utf8") > 1_048_576) throw new TemplateExecutionDefinitionError();
  // Detach the immutable definition from mutable database/test result objects.
  const parsed = JSON.parse(canonicalJson(value)) as TemplateExecutionDefinition;
  function freeze(item: unknown): void {
    if (item && typeof item === "object") {
      Object.freeze(item);
      for (const child of Object.values(item)) freeze(child);
    }
  }
  freeze(parsed);
  return parsed;
}

export function templateExecutionDefinitionHash(value: unknown): Buffer {
  return canonicalSha256(parseTemplateExecutionDefinition(value));
}

/** Admission reads binding presence, never the protected dataset bytes. */
export function requireExecutableTemplateFacts(input: {
  readonly productFamily: string;
  readonly engine: string | null;
  readonly definition: unknown;
  readonly definitionSha256: Buffer | null;
  readonly datasetBound: boolean;
}): { readonly engine: TemplateEngine; readonly definition: TemplateExecutionDefinition } {
  if (input.productFamily !== 'scraper_library' || !TEMPLATE_ENGINES.includes(input.engine as TemplateEngine) ||
    !Buffer.isBuffer(input.definitionSha256) || input.definitionSha256.length !== 32 || input.datasetBound !== true) throw new TemplateExecutionDefinitionError();
  const definition = parseTemplateExecutionDefinition(input.definition);
  if (!timingSafeEqual(canonicalSha256(definition), input.definitionSha256)) throw new TemplateExecutionDefinitionError();
  return { engine: input.engine as TemplateEngine, definition };
}

/** Admission/publication must explicitly reject incomplete physical rows. */
export function requireExecutableTemplate(input: {
  readonly productFamily: string;
  readonly engine: string | null;
  readonly definition: unknown;
  readonly definitionSha256: Buffer | null;
  readonly datasetCiphertext: Buffer | null;
  readonly datasetFingerprint: Buffer | null;
}): { readonly engine: TemplateEngine; readonly definition: TemplateExecutionDefinition } {
  if (input.productFamily !== "scraper_library" || !TEMPLATE_ENGINES.includes(input.engine as TemplateEngine) ||
    !Buffer.isBuffer(input.definitionSha256) || input.definitionSha256.length !== 32 ||
    !Buffer.isBuffer(input.datasetCiphertext) || input.datasetCiphertext.length < 30 ||
    !Buffer.isBuffer(input.datasetFingerprint) || input.datasetFingerprint.length !== 32) throw new TemplateExecutionDefinitionError();
  return requireExecutableTemplateFacts({ ...input, datasetBound: true });
}
