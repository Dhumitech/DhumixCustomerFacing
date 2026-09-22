import {
  serializeMarketplaceFilterRequest,
  type MarketplaceReviewedFilterField,
} from "../brightdata/marketplace/marketplaceFilterRequest.js";
import type {
  MarketplaceQualificationPreflightRepository,
} from "./marketplaceQualificationPreflightRepository.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$/;
const REFERENCE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s]{5,1010}$/;
const HEX_32 = /^[0-9a-f]{64}$/i;
// Bright Data documents a five-minute maximum provider Filter job duration.
// The qualification packet must not authorize a longer provider polling job.
const MAX_POLL_DEADLINE_MS = 300_000;
const MAX_SELECTED_FIELDS = 100;
const EXPECTED_EVIDENCE = Object.freeze([
  "authorization_audit",
  "request",
  "protected_snapshot_reference",
  "poll_checkpoints",
  "raw_artifact",
  "normalized_artifact",
  "checksums",
  "cost",
  "execution_audit",
] as const);

export class MarketplaceQualificationPreflightError extends Error {
  public readonly code = "MARKETPLACE_QUALIFICATION_PREFLIGHT_INVALID";

  public constructor() {
    super("Marketplace qualification preflight input is invalid");
    this.name = "MarketplaceQualificationPreflightError";
  }
}

type PrepareInput = Readonly<{
  packetId: string;
  candidateId: string;
  environment: "local" | "test";
  filter: unknown;
  selectedFields: readonly string[];
  recordsLimit: number;
  maximumEstimatedCostMicros: number;
  currencyCode: "USD";
  maximumProviderSubmissions: 1;
  automaticSubmissionRetries: 0;
  pollDeadlineMs: number;
  actor: string;
}>;

type AuthorizeInput = Readonly<{
  packetId: string;
  requestFingerprint: string;
  recordsLimit: number;
  maximumEstimatedCostMicros: number;
  currencyCode: "USD";
  maximumProviderSubmissions: 1;
  automaticSubmissionRetries: 0;
  authorizationReference: string;
  authorizationHash: string;
  issuer: string;
  effectiveAt: Date;
  expiresAt: Date;
}>;

function fail(): never {
  throw new MarketplaceQualificationPreflightError();
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  return value as Readonly<Record<string, unknown>>;
}

function reviewedFields(outputSchema: Readonly<Record<string, unknown>>): {
  readonly outputNames: ReadonlySet<string>;
  readonly filterFields: Readonly<Record<string, MarketplaceReviewedFilterField>>;
} {
  if (outputSchema.type !== "array") fail();
  const items = object(outputSchema.items);
  if (items.type !== "object") fail();
  const properties = object(items.properties);
  const fields: Record<string, MarketplaceReviewedFilterField> = {};
  for (const [name, rawSchema] of Object.entries(properties)) {
    const schema = object(rawSchema);
    const rawTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    const types = rawTypes.filter((type): type is MarketplaceReviewedFilterField["types"][number] =>
      ["array", "boolean", "integer", "number", "object", "string"].includes(String(type)),
    );
    if (types.length < 1) fail();
    const format = schema.format;
    fields[name] = Object.freeze({
      types: Object.freeze(types),
      ...(format === "date" || format === "date-time" || format === "uri"
        ? { format }
        : {}),
    });
  }
  if (Object.keys(fields).length < 1) fail();
  return Object.freeze({
    outputNames: new Set(Object.keys(fields)),
    filterFields: Object.freeze(fields),
  });
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export interface MarketplaceQualificationPreflightService {
  prepare(input: PrepareInput): Promise<{
    readonly packet_id: string;
    readonly request_fingerprint: string;
    readonly authorization_state: "not_authorized";
    readonly provider_calls: 0;
  }>;
  authorize(input: AuthorizeInput): Promise<{
    readonly packet_id: string;
    readonly authorization_state: "authorized";
    readonly provider_calls: 0;
  }>;
}

export function createMarketplaceQualificationPreflightService(
  repository: MarketplaceQualificationPreflightRepository,
): MarketplaceQualificationPreflightService {
  return Object.freeze({
    async prepare(input: PrepareInput) {
      if (!UUID.test(input.packetId) || !UUID.test(input.candidateId) ||
          (input.environment !== "local" && input.environment !== "test") ||
          !positiveSafeInteger(input.recordsLimit) ||
          !positiveSafeInteger(input.maximumEstimatedCostMicros) ||
          input.currencyCode !== "USD" || input.maximumProviderSubmissions !== 1 ||
          input.automaticSubmissionRetries !== 0 || !ACTOR.test(input.actor) ||
          !positiveSafeInteger(input.pollDeadlineMs) ||
          input.pollDeadlineMs > MAX_POLL_DEADLINE_MS ||
          !Array.isArray(input.selectedFields) || input.selectedFields.length < 1 ||
          input.selectedFields.length > MAX_SELECTED_FIELDS ||
          new Set(input.selectedFields).size !== input.selectedFields.length) fail();

      const context = await repository.resolveContext({
        candidateId: input.candidateId,
        environment: input.environment,
      });
      if (context.candidateId !== input.candidateId ||
          !UUID.test(context.templateVersionId) || !UUID.test(context.filterAdapterVersionId) ||
          !Buffer.isBuffer(context.providerResourceFingerprint) ||
          context.providerResourceFingerprint.byteLength !== 32) fail();

      const fields = reviewedFields(context.outputSchema);
      if (input.selectedFields.some((field) =>
        typeof field !== "string" || !fields.outputNames.has(field))) fail();
      let normalizedFilter: Readonly<Record<string, unknown>>;
      try {
        normalizedFilter = serializeMarketplaceFilterRequest({
          datasetId: "protected-dataset-reference",
          recordsLimit: input.recordsLimit,
          maximumRecords: input.recordsLimit,
          filter: input.filter,
          reviewedFields: fields.filterFields,
        }).filter;
      } catch {
        fail();
      }

      const packet = await repository.prepare({
        packetId: input.packetId,
        candidateId: input.candidateId,
        templateVersionId: context.templateVersionId,
        filterAdapterVersionId: context.filterAdapterVersionId,
        environment: input.environment,
        providerResourceFingerprint: context.providerResourceFingerprint,
        exactRequest: Object.freeze({
          records_limit: input.recordsLimit,
          selected_fields: Object.freeze([...input.selectedFields]),
          filter: normalizedFilter,
        }),
        maximumEstimatedCostMicros: input.maximumEstimatedCostMicros,
        currencyCode: input.currencyCode,
        maximumProviderSubmissions: input.maximumProviderSubmissions,
        automaticSubmissionRetries: input.automaticSubmissionRetries,
        pollDeadlineMs: input.pollDeadlineMs,
        expectedArtifactKinds: ["raw", "normalized"],
        expectedEvidence: EXPECTED_EVIDENCE,
        actor: input.actor,
      });
      return Object.freeze({
        packet_id: packet.packetId,
        request_fingerprint: packet.requestFingerprint.toString("hex"),
        authorization_state: packet.authorizationState,
        provider_calls: 0 as const,
      });
    },

    async authorize(input: AuthorizeInput) {
      if (!UUID.test(input.packetId) || !HEX_32.test(input.requestFingerprint) ||
          !positiveSafeInteger(input.recordsLimit) ||
          !positiveSafeInteger(input.maximumEstimatedCostMicros) ||
          input.currencyCode !== "USD" || input.maximumProviderSubmissions !== 1 ||
          input.automaticSubmissionRetries !== 0 ||
          !REFERENCE.test(input.authorizationReference) ||
          !HEX_32.test(input.authorizationHash) || !ACTOR.test(input.issuer) ||
          !(input.effectiveAt instanceof Date) || Number.isNaN(input.effectiveAt.getTime()) ||
          !(input.expiresAt instanceof Date) || Number.isNaN(input.expiresAt.getTime()) ||
          input.expiresAt <= input.effectiveAt) fail();
      const result = await repository.authorize({
        packetId: input.packetId,
        requestFingerprint: Buffer.from(input.requestFingerprint, "hex"),
        recordsLimit: input.recordsLimit,
        maximumEstimatedCostMicros: input.maximumEstimatedCostMicros,
        currencyCode: input.currencyCode,
        maximumProviderSubmissions: input.maximumProviderSubmissions,
        automaticSubmissionRetries: input.automaticSubmissionRetries,
        authorizationReference: input.authorizationReference,
        authorizationHash: Buffer.from(input.authorizationHash, "hex"),
        issuer: input.issuer,
        effectiveAt: input.effectiveAt,
        expiresAt: input.expiresAt,
      });
      return Object.freeze({
        packet_id: input.packetId,
        authorization_state: result.authorizationState,
        provider_calls: 0 as const,
      });
    },
  });
}
