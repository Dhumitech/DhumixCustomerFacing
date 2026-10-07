import type { Readable } from "node:stream";
import Ajv2020Module, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { z } from "zod";
import { canonicalJson, canonicalSha256 } from "../../helpers/canonicalJson.js";

const field = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,127}$/)
  .refine((value) => !["constructor", "prototype", "__proto__", "dataset_id", "snapshot_id", "api_key", "authorization", "organization_id"].includes(value));
const processingSchema = z.object({
  version: z.literal(1), revision: z.number().int().positive(),
  urls: z.array(z.object({
    field,
    hosts: z.array(z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/)).min(1).max(32),
    pathPrefixes: z.array(z.string().regex(/^\/[a-zA-Z0-9/_-]*$/)).min(1).max(32),
    allowFragment: z.boolean(),
  }).strict()).max(32),
  request: z.object({
    endpoint: z.enum(["scrape", "trigger"]), mode: z.enum(["collect", "discover"]),
    discoverBy: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(),
    limitPerInput: z.number().int().positive().nullable().optional(),
    fields: z.array(field).min(1).max(128),
    snapshot: z.object({ enabled: z.boolean(), cancelEnabled: z.boolean(),
      multipartEnabled: z.literal(false), format: z.literal("json") }).strict(),
  }).strict(),
  projectedFields: z.array(field).min(1).max(128),
  schemaVersion: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/),
  usage: z.object({ meterCode: z.string().regex(/^[a-z][a-z0-9_.-]{2,127}$/), unit: z.literal("records") }).strict(),
  maxRecords: z.number().int().min(1).max(1_000_000),
}).strict().superRefine((value, context) => {
  if ((value.request.mode === "discover") !== (value.request.discoverBy !== undefined)) {
    context.addIssue({ code: "custom", message: "Discovery mode and selector must agree" });
  }
  if (value.request.endpoint === "trigger" && !value.request.snapshot.enabled) {
    context.addIssue({ code: "custom", message: "Trigger requires snapshot handling" });
  }
  if (value.request.snapshot.cancelEnabled && !value.request.snapshot.enabled) {
    context.addIssue({ code: "custom", message: "Cancellation requires snapshot handling" });
  }
  if (new Set(value.request.fields).size !== value.request.fields.length ||
    new Set(value.projectedFields).size !== value.projectedFields.length ||
    new Set(value.urls.map((rule) => rule.field)).size !== value.urls.length) {
    context.addIssue({ code: "custom", message: "Descriptor fields must be unique" });
  }
});

export interface ScraperOperationContract {
  readonly operationCode: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly processing: z.infer<typeof processingSchema>;
}
export class ScraperContractError extends Error {
  public constructor() { super("Pinned scraper processing contract is unavailable"); this.name = "ScraperContractError"; }
}
export class ScraperInputError extends Error {
  public constructor() { super("Scraper input does not satisfy its pinned contract"); this.name = "ScraperInputError"; }
}
export class ScraperResultError extends Error {
  public constructor(public readonly classification: "all_inputs_failed" | "mixed_results" | "invalid_result" = "invalid_result") {
    super("Scraper result does not satisfy its pinned contract"); this.name = "ScraperResultError";
  }
}

export interface ScraperProcessor {
  readonly contract: ScraperOperationContract;
  readonly hash: string;
  validateInput(value: Readonly<Record<string, unknown>>): {
    readonly valid: boolean; readonly issues: readonly { readonly field: string; readonly message: string }[];
  };
  serialize(value: Readonly<Record<string, unknown>>): readonly Readonly<Record<string, unknown>>[];
  normalize(input: {
    readonly bytes: Readable; readonly byteCount: number; readonly maxBytes: number;
    readonly contentType: string; readonly contentEncoding: string | null; readonly signal?: AbortSignal;
  }): Promise<{
    readonly bytes: Buffer; readonly recordCount: number; readonly schemaVersion: string;
    readonly contentType: "application/json"; readonly contentEncoding: null;
  }>;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function localSchema(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (Array.isArray(value)) return value.every((item) => localSchema(item, depth + 1));
  if (!object(value)) return true;
  return Object.entries(value).every(([key, child]) =>
    (key !== "$ref" || (typeof child === "string" && child.startsWith("#"))) && localSchema(child, depth + 1));
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}

/** The hash binds both public schemas and the private processing rules, not just a slug. */
export function scraperContractHash(contract: ScraperOperationContract): string {
  return canonicalSha256(contract).toString("hex");
}

function parseContract(value: unknown): ScraperOperationContract {
  if (!object(value) || Object.keys(value).some((key) => !["operationCode", "inputSchema", "outputSchema", "processing"].includes(key)) ||
    typeof value.operationCode !== "string" || !/^[a-z][a-z0-9_.-]{2,127}$/.test(value.operationCode) ||
    !object(value.inputSchema) || !object(value.outputSchema) || !localSchema(value.inputSchema) || !localSchema(value.outputSchema)) {
    throw new ScraperContractError();
  }
  const rules = processingSchema.safeParse(value.processing);
  if (!rules.success || Buffer.byteLength(canonicalJson(value)) > 131_072) throw new ScraperContractError();
  const targets = object(value.inputSchema.properties) ? value.inputSchema.properties.targets : undefined;
  const target = object(targets) && object(targets.items) ? targets.items : undefined;
  const result = object(value.outputSchema.items) ? value.outputSchema.items : undefined;
  if (!object(targets) || targets.type !== "array" || !Number.isSafeInteger(targets.maxItems) ||
    Number(targets.maxItems) > 20 || Number(targets.maxItems) < 1 || targets.minItems !== 1 ||
    !target || target.type !== "object" || !object(target.properties) ||
    target.additionalProperties !== false || !result || result.type !== "object" || !object(result.properties) || result.additionalProperties !== false ||
    !Array.isArray(value.inputSchema.required) || !value.inputSchema.required.includes("targets") ||
    value.inputSchema.type !== "object" || value.inputSchema.additionalProperties !== false || value.outputSchema.type !== "array") {
    throw new ScraperContractError();
  }
  const sameFields = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length && left.every((name) => right.includes(name));
  const targetProperties = target.properties;
  if (!sameFields(rules.data.request.fields, Object.keys(targetProperties)) ||
    !sameFields(rules.data.projectedFields, Object.keys(result.properties)) ||
    rules.data.urls.some((rule) => {
      const schema = targetProperties[rule.field];
      return !rules.data.request.fields.includes(rule.field) || !object(schema) || schema.type !== "string";
    })) throw new ScraperContractError();
  return freeze(structuredClone({ operationCode: value.operationCode, inputSchema: value.inputSchema,
    outputSchema: value.outputSchema, processing: rules.data }));
}

function compile(contract: ScraperOperationContract): { readonly input: ValidateFunction; readonly output: ValidateFunction } {
  // A compiler is owned by its cached immutable contract. Eviction releases it too;
  // a global Ajv schema cache must not silently grow past the processor-cache limit.
  const Ajv = Ajv2020Module as unknown as new (options: Readonly<Record<string, unknown>>) => { compile(schema: object): ValidateFunction };
  const formats = addFormatsModule as unknown as (compiler: { compile(schema: object): ValidateFunction }) => void;
  const ajv = new Ajv({ strict: true, allErrors: false, coerceTypes: false,
    useDefaults: false, removeAdditional: false, addUsedSchema: false });
  formats(ajv);
  try { return { input: ajv.compile(contract.inputSchema), output: ajv.compile(contract.outputSchema) }; }
  catch { throw new ScraperContractError(); }
}

async function readRaw(input: Parameters<ScraperProcessor["normalize"]>[0]): Promise<Buffer> {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || !Number.isSafeInteger(input.byteCount) ||
    input.byteCount < 1 || input.byteCount > input.maxBytes || input.contentEncoding !== null ||
    !["application/json", "text/plain"].includes(input.contentType.toLowerCase())) {
    input.bytes.destroy(); throw new ScraperResultError();
  }
  // The durable receipt supplies the exact bounded size: one buffer, no chunk
  // list plus Buffer.concat copy. A mismatched or truncated receipt fails closed.
  const raw = Buffer.allocUnsafe(input.byteCount);
  let offset = 0;
  try {
    input.signal?.throwIfAborted();
    for await (const chunk of input.bytes) {
      input.signal?.throwIfAborted();
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      if (offset + part.byteLength > raw.length) throw new ScraperResultError();
      part.copy(raw, offset); offset += part.byteLength;
    }
    if (offset !== raw.length) throw new ScraperResultError();
    return raw;
  } catch (error) { input.bytes.destroy(); input.signal?.throwIfAborted(); throw error instanceof ScraperResultError ? error : new ScraperResultError(); }
}

export function createScraperProcessing(options: { readonly maxCachedContracts?: number } = {}) {
  const limit = options.maxCachedContracts ?? 128;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4096) throw new TypeError("Invalid scraper contract cache limit");
  const cache = new Map<string, ScraperProcessor>();
  let compilations = 0, cacheHits = 0, parses = 0;
  return {
    prepare(value: unknown, expectedHash?: string): ScraperProcessor {
      const hash = canonicalSha256(value).toString("hex");
      if (expectedHash !== undefined && (!/^[a-f0-9]{64}$/.test(expectedHash) || hash !== expectedHash)) throw new ScraperContractError();
      const existing = cache.get(hash);
      if (existing) { cache.delete(hash); cache.set(hash, existing); cacheHits++; return existing; }
      const contract = parseContract(value);
      // Zod parsing cannot change the bytes authenticated by the mapping.
      if (scraperContractHash(contract) !== hash) throw new ScraperContractError();
      const validators = compile(contract); compilations += 2;
      const processor: ScraperProcessor = Object.freeze({
        contract, hash,
        validateInput(value: Readonly<Record<string, unknown>>) {
          if (!validators.input(value)) return { valid: false, issues: [{ field: "/", message: "does not satisfy the Template input schema" }] };
          const targets = value.targets as readonly Record<string, unknown>[];
          const issues: { field: string; message: string }[] = [];
          for (let index = 0; index < targets.length; index++) {
            for (const rule of contract.processing.urls) {
              const target = targets[index]!;
              if (!Object.hasOwn(target, rule.field)) continue;
              let valid = false;
              try {
                const url = new URL(String(target[rule.field]));
                const original = target[rule.field];
                valid = typeof original === "string" && original.trim() === original && !/[\\\x00-\x20]/.test(original) &&
                  url.protocol === "https:" && !url.username && !url.password && !url.port &&
                  rule.hosts.includes(url.hostname) && rule.pathPrefixes.some((prefix) => url.pathname.startsWith(prefix)) &&
                  (rule.allowFragment || !url.hash);
              } catch { /* Invalid URLs share the same safe validation result. */ }
              if (!valid && issues.length < 12) issues.push({ field: `/targets/${index}/${rule.field}`, message: "must use an accepted HTTPS URL for this operation" });
            }
          }
          return { valid: issues.length === 0, issues };
        },
        serialize(value: Readonly<Record<string, unknown>>) {
          if (!processor.validateInput(value).valid) throw new ScraperInputError();
          return (value.targets as readonly Record<string, unknown>[]).map((target) => Object.fromEntries(
            contract.processing.request.fields.filter((name) => Object.hasOwn(target, name)).map((name) => [name, structuredClone(target[name])]),
          ));
        },
        async normalize(input: Parameters<ScraperProcessor["normalize"]>[0]) {
          const raw = await readRaw(input);
          let records: unknown;
          parses++;
          try { records = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { throw new ScraperResultError(); }
          if (!Array.isArray(records) || records.length > contract.processing.maxRecords || records.some((record) => !object(record))) throw new ScraperResultError();
          const errors = records.reduce((count, record) => count + (Object.hasOwn(record, "error") || Object.hasOwn(record, "error_code") ? 1 : 0), 0);
          if (errors) throw new ScraperResultError(errors === records.length ? "all_inputs_failed" : "mixed_results");
          const projected = records.map((record) => Object.fromEntries(
            contract.processing.projectedFields.filter((name) => Object.hasOwn(record, name)).map((name) => [name, record[name]]),
          ));
          if (!validators.output(projected)) throw new ScraperResultError();
          input.signal?.throwIfAborted();
          const bytes = Buffer.from(JSON.stringify(projected), "utf8");
          if (bytes.byteLength > input.maxBytes) throw new ScraperResultError();
          return { bytes, recordCount: projected.length, schemaVersion: contract.processing.schemaVersion,
            contentType: "application/json" as const, contentEncoding: null };
        },
      });
      if (cache.size >= limit) cache.delete(cache.keys().next().value!);
      cache.set(hash, processor);
      return processor;
    },
    stats() { return { compilations, cacheHits, cacheEntries: cache.size, parses }; },
  };
}
