import Ajv2020Module, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import {
  AMAZON_OPERATION_DEFINITIONS,
  getAmazonOperationDefinition,
  type AmazonOperationDefinition,
  type AmazonTargetFieldDefinition,
  type AmazonUrlRole,
} from "./amazonOperationDefinitions.js";

const AMAZON_MARKETPLACE_DOMAINS = new Set([
  "amazon.com",
  "amazon.ca",
  "amazon.com.mx",
  "amazon.com.br",
  "amazon.co.uk",
  "amazon.de",
  "amazon.fr",
  "amazon.it",
  "amazon.es",
  "amazon.nl",
  "amazon.se",
  "amazon.pl",
  "amazon.com.be",
  "amazon.co.jp",
  "amazon.in",
  "amazon.com.au",
  "amazon.sg",
  "amazon.ae",
  "amazon.sa",
  "amazon.com.tr",
  "amazon.eg",
]);
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const MAX_STRING_LENGTH = 8192;
const MAX_STRING_ARRAY_ITEMS = 1000;

export class AmazonOperationContractError extends Error {
  public constructor(cause?: unknown) {
    super(
      "Pinned Amazon operation contract was invalid",
      cause === undefined ? undefined : { cause },
    );
    this.name = "AmazonOperationContractError";
  }
}

export interface SerializedAmazonProviderRequest {
  readonly targets: readonly Readonly<Record<string, unknown>>[];
  readonly fixedQuery:
    | Readonly<{ mode: "collect" }>
    | Readonly<{ mode: "discover"; discoverBy: string }>;
}

const Ajv2020 = Ajv2020Module as unknown as new (
  options: Readonly<Record<string, unknown>>,
) => { compile(document: object): ValidateFunction };
const addFormats = addFormatsModule as unknown as (
  compiler: { compile(document: object): ValidateFunction },
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
const validators = new Map(
  AMAZON_OPERATION_DEFINITIONS.map((definition) => [
    definition.operationCode,
    ajv.compile(definition.inputSchema),
  ]),
);

function isAmazonMarketplaceHost(hostname: string): boolean {
  for (const domain of AMAZON_MARKETPLACE_DOMAINS) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) return true;
  }
  return false;
}

function hasPathSegment(url: URL, segment: string): boolean {
  return url.pathname
    .split("/")
    .filter(Boolean)
    .some((value) => value.toLowerCase() === segment);
}

function requireUrlRole(url: URL, role: AmazonUrlRole): void {
  const path = url.pathname.toLowerCase();
  switch (role) {
    case "amazon_url":
      return;
    case "amazon_origin":
      if (url.pathname !== "/" || url.search !== "") throw new AmazonOperationContractError();
      return;
    case "product_url":
      if (!/(?:^|\/)dp\/[a-z0-9]{8,20}(?:\/|$)/iu.test(path) &&
          !/(?:^|\/)gp\/product\/[a-z0-9]{8,20}(?:\/|$)/iu.test(path)) {
        throw new AmazonOperationContractError();
      }
      return;
    case "category_url":
      if (
        !hasPathSegment(url, "s") &&
        !hasPathSegment(url, "b") &&
        !url.searchParams.has("node") &&
        !url.searchParams.has("bbn")
      ) {
        throw new AmazonOperationContractError();
      }
      return;
    case "best_sellers_url":
      if (!path.includes("/zgbs/") && !path.includes("best-sellers")) {
        throw new AmazonOperationContractError();
      }
      return;
    case "brand_url":
      if (!path.includes("/stores/")) throw new AmazonOperationContractError();
      return;
    case "seller_url":
      if (!hasPathSegment(url, "sp") || !url.searchParams.has("seller")) {
        throw new AmazonOperationContractError();
      }
      return;
  }
}

function canonicalUrl(value: unknown, role: AmazonUrlRole | undefined): string {
  if (typeof value !== "string" || role === undefined) {
    throw new AmazonOperationContractError();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new AmazonOperationContractError(error);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== "" ||
    !isAmazonMarketplaceHost(url.hostname.toLowerCase())
  ) {
    throw new AmazonOperationContractError();
  }
  requireUrlRole(url, role);
  return url.toString();
}

function canonicalString(value: unknown): string {
  if (typeof value !== "string") throw new AmazonOperationContractError();
  const canonical = value.trim();
  if (
    canonical.length < 1 ||
    canonical.length > MAX_STRING_LENGTH ||
    CONTROL_CHARACTER.test(canonical)
  ) {
    throw new AmazonOperationContractError();
  }
  return canonical;
}

function canonicalField(field: AmazonTargetFieldDefinition, value: unknown): unknown {
  switch (field.kind) {
    case "url":
      return canonicalUrl(value, field.urlRole);
    case "string":
      return canonicalString(value);
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new AmazonOperationContractError();
      }
      return value;
    case "boolean":
      if (typeof value !== "boolean") throw new AmazonOperationContractError();
      return value;
    case "string_array":
      if (!Array.isArray(value) || value.length > MAX_STRING_ARRAY_ITEMS) {
        throw new AmazonOperationContractError();
      }
      return Object.freeze(value.map(canonicalString));
  }
}

function sameProviderPolicy(
  actual:
    | Readonly<{ mode: "collect" }>
    | Readonly<{ mode: "discover"; discoverBy: string }>,
  expected: AmazonOperationDefinition["providerRequest"],
): boolean {
  return (
    actual.mode === expected.mode &&
    (actual.mode === "collect" ||
      (expected.mode === "discover" && actual.discoverBy === expected.discoverBy))
  );
}

function serializeTargets(
  definition: AmazonOperationDefinition,
  validatedInput: Readonly<Record<string, unknown>>,
): readonly Readonly<Record<string, unknown>>[] {
  const validate = validators.get(definition.operationCode);
  if (validate === undefined || !validate(validatedInput)) {
    throw new AmazonOperationContractError();
  }
  const targets = validatedInput.targets;
  if (!Array.isArray(targets)) throw new AmazonOperationContractError();

  return Object.freeze(
    targets.map((candidate) => {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
        throw new AmazonOperationContractError();
      }
      const target = candidate as Readonly<Record<string, unknown>>;
      const serialized: Record<string, unknown> = {};
      for (const field of definition.targetFields) {
        const value = target[field.name];
        if (value === undefined) {
          if (field.required) throw new AmazonOperationContractError();
          continue;
        }
        serialized[field.name] = canonicalField(field, value);
      }
      return Object.freeze(serialized);
    }),
  );
}

export function serializeAmazonProviderRequest(input: {
  readonly operationCode: string;
  readonly validatedInput: Readonly<Record<string, unknown>>;
  readonly providerRequest:
    | Readonly<{ mode: "collect" }>
    | Readonly<{ mode: "discover"; discoverBy: string }>;
}): SerializedAmazonProviderRequest {
  const definition = getAmazonOperationDefinition(input.operationCode);
  if (
    definition === undefined ||
    !sameProviderPolicy(input.providerRequest, definition.providerRequest)
  ) {
    throw new AmazonOperationContractError();
  }

  return Object.freeze({
    targets: serializeTargets(definition, input.validatedInput),
    fixedQuery:
      definition.providerRequest.mode === "collect"
        ? Object.freeze({ mode: "collect" as const })
        : Object.freeze({
            mode: "discover" as const,
            discoverBy: definition.providerRequest.discoverBy,
          }),
  });
}
