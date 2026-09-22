import Ajv2020Module, {
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { canonicalSha256 } from "./canonicalJson.js";

const MAX_PUBLIC_ERRORS = 12;

export interface ServiceConfigurationValidationInput {
  readonly templateVersionId: string;
  readonly schema: unknown;
  readonly configuration: Readonly<Record<string, unknown>>;
}

export type ServiceConfigurationValidationResult =
  | { readonly valid: true; readonly schemaHash: Buffer }
  | {
      readonly valid: false;
      readonly schemaHash: Buffer;
      readonly issues: readonly { readonly field: string; readonly message: string }[];
    };

export interface ServiceConfigurationValidator {
  validate(input: ServiceConfigurationValidationInput): ServiceConfigurationValidationResult;
}

export class StoredServiceSchemaError extends Error {
  public constructor(cause?: unknown) {
    super("The selected Service schema is unavailable", { cause });
    this.name = "StoredServiceSchemaError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectsRemoteReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(rejectsRemoteReference);
  if (!isObject(value)) return false;

  for (const [key, nested] of Object.entries(value)) {
    if (key === "$ref" && (typeof nested !== "string" || !nested.startsWith("#"))) {
      return true;
    }
    if (rejectsRemoteReference(nested)) return true;
  }
  return false;
}

function publicField(error: ErrorObject): string {
  if (error.keyword === "required") {
    const property = error.params.missingProperty;
    if (typeof property === "string") {
      return `${error.instancePath}/${property}`.replace(/\/+/g, "/");
    }
  }
  return error.instancePath === "" ? "/" : error.instancePath;
}

function publicMessage(error: ErrorObject): string {
  switch (error.keyword) {
    case "required":
      return "is required";
    case "additionalProperties":
      return "contains an unsupported property";
    case "type":
      return "has an invalid type";
    case "format":
      return "has an invalid format";
    case "enum":
      return "must use an accepted value";
    default:
      return "does not satisfy the Template schema";
  }
}

export function createServiceConfigurationValidator(): ServiceConfigurationValidator {
  const Ajv2020 = Ajv2020Module as unknown as new (
    options: Readonly<Record<string, unknown>>,
  ) => { compile(schema: object): ValidateFunction };
  const addFormats = addFormatsModule as unknown as (
    compiler: { compile(schema: object): ValidateFunction },
  ) => void;
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    addUsedSchema: false,
    loadSchema: undefined,
  });
  addFormats(ajv);
  const cache = new Map<string, ValidateFunction>();

  return {
    validate(input): ServiceConfigurationValidationResult {
      if (!isObject(input.schema) || rejectsRemoteReference(input.schema)) {
        throw new StoredServiceSchemaError();
      }

      const schemaHash = canonicalSha256(input.schema);
      const cacheKey = `${input.templateVersionId}:${schemaHash.toString("hex")}`;
      let validate = cache.get(cacheKey);
      if (validate === undefined) {
        let compiled: ValidateFunction;
        try {
          compiled = ajv.compile(input.schema);
        } catch (error) {
          throw new StoredServiceSchemaError(error);
        }
        cache.set(cacheKey, compiled);
        validate = compiled;
      }

      if (validate(input.configuration)) return { valid: true, schemaHash };
      const issues = (validate.errors ?? []).slice(0, MAX_PUBLIC_ERRORS).map((error) => ({
        field: publicField(error),
        message: publicMessage(error),
      }));
      return { valid: false, schemaHash, issues };
    },
  };
}
