import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  getAmazonOperationDefinition,
  type AmazonOperationDefinition,
} from "../brightdata/amazon/amazonOperationDefinitions.js";
import { getAmazonPreciseOutputContract } from "../brightdata/amazon/amazonOutputContracts.js";
import { serializeAmazonProviderRequest } from "../brightdata/amazon/amazonOperationSerializer.js";
import {
  AmazonResultNormalizationError,
  inspectAmazonProviderResult,
  normalizeAmazonProviderResult,
} from "../brightdata/amazon/amazonResultNormalizer.js";
import {
  BrightDataBoundaryError,
  type BrightDataExecutionMode,
  type BrightDataBoundarySafeReason,
  type BrightDataIntegrationClient,
} from "../brightdata/brightDataIntegrationClient.js";
import {
  providerMappingAad,
} from "../brightdata/providerExecutionPlanRepository.js";
import type { ProviderReferenceProtector } from "../brightdata/providerReferenceProtector.js";
import type { SecretProvider } from "../secrets/secretProvider.js";
import type {
  AmazonQualificationRepository,
  QualificationCandidatePlan,
} from "./amazonQualificationRepository.js";
import type {
  QualificationEvidenceReceipt,
  QualificationEvidenceStore,
} from "./qualificationEvidenceStore.js";
import { QualificationProviderRequestBudgetError } from
  "./providerRequestBudgetClient.js";

const ACTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface AmazonQualificationService {
  discover(input: {
    readonly confirmedLiveRequest: true;
    readonly environment: "local" | "test";
    readonly actor: string;
    readonly restrictedReference: string;
    readonly signal: AbortSignal;
  }): Promise<Readonly<{
    importId: string;
    candidateCount: number;
    candidates: readonly Readonly<{ candidateId: string; name: string }>[];
    evidenceObjectKey: string;
    evidenceChecksum: string;
  }>>;
  reviewCandidate(input: {
    readonly candidateId: string;
    readonly decision: "approve" | "reject";
    readonly actor: string;
  }): Promise<void>;
  qualify(input: {
    readonly confirmedBillableRequest: true;
    readonly environment: "local" | "test";
    readonly candidateId: string;
    readonly operationCode: string;
    readonly executionMode: BrightDataExecutionMode;
    readonly validatedInput: Readonly<Record<string, unknown>>;
    readonly actor: string;
    readonly signal: AbortSignal;
  }): Promise<Readonly<{
    qualificationId: string;
    operationCode: string;
    submissionMode: "inline" | "snapshot";
    responseObjectKey: string;
    responseChecksum: string;
    byteCount: number;
    recordCount: number;
    reviewState: "pending";
  }>>;
  accept(input: {
    readonly qualificationId: string;
    readonly commercialConfigVersion: string;
    readonly configVersion: string;
    readonly restrictedReference: string;
    readonly evidenceHashHex: string;
    readonly reviewer: string;
    readonly expiresAt: Date | null;
  }): Promise<Readonly<{
    mappingId: string;
    launchEvidenceId: string;
    mappingState: "disabled";
  }>>;
  reject(input: {
    readonly qualificationId: string;
    readonly reason: string;
    readonly reviewer: string;
  }): Promise<void>;
}

interface Dependencies {
  readonly repository: AmazonQualificationRepository;
  readonly evidenceStore: QualificationEvidenceStore;
  readonly client: BrightDataIntegrationClient;
  readonly secretProvider: SecretProvider;
  readonly protector: ProviderReferenceProtector;
  readonly evidenceMaxBytes: number;
  readonly pollIntervalMs: number;
  readonly pollMaxElapsedMs: number;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export class AmazonQualificationError extends Error {
  public readonly code: string;
  public readonly outcome: "failed" | "uncertain";
  public readonly safeReason?: BrightDataBoundarySafeReason;
  public readonly observedByteCount?: number;
  public readonly maximumByteCount?: number;

  public constructor(
    code: string,
    outcome: "failed" | "uncertain" = "failed",
    cause?: unknown,
    safeReason?: BrightDataBoundarySafeReason,
    byteBoundary?: Readonly<{
      observedByteCount: number;
      maximumByteCount: number;
    }>,
  ) {
    super(
      "Amazon provider qualification could not be completed",
      cause === undefined ? undefined : { cause },
    );
    this.name = "AmazonQualificationError";
    this.code = code;
    this.outcome = outcome;
    if (safeReason !== undefined) this.safeReason = safeReason;
    if (byteBoundary !== undefined) {
      this.observedByteCount = byteBoundary.observedByteCount;
      this.maximumByteCount = byteBoundary.maximumByteCount;
    }
  }
}

function candidateAad(candidateId: string): Buffer {
  return Buffer.from(`dhumi:catalog-candidate:v1:${candidateId}`, "utf8");
}

function qualificationSnapshotAad(qualificationId: string): Buffer {
  return Buffer.from(`dhumi:provider-qualification-snapshot:v1:${qualificationId}`, "utf8");
}

function validateActor(actor: string): void {
  if (!ACTOR_PATTERN.test(actor)) throw new AmazonQualificationError("QUALIFICATION_INPUT_INVALID");
}

function validateUuid(value: string): void {
  if (!UUID_PATTERN.test(value)) throw new AmazonQualificationError("QUALIFICATION_INPUT_INVALID");
}

function definitionFor(operationCode: string): AmazonOperationDefinition {
  const definition = getAmazonOperationDefinition(operationCode);
  if (definition === undefined) throw new AmazonQualificationError("QUALIFICATION_OPERATION_UNKNOWN");
  return definition;
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

async function boundedBuffer(bytes: Readable, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of bytes) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += part.byteLength;
      if (total > maximum) {
        bytes.destroy();
        throw new AmazonQualificationError("QUALIFICATION_RESPONSE_TOO_LARGE");
      }
      chunks.push(part);
    }
  } catch (error) {
    if (error instanceof AmazonQualificationError) throw error;
    throw new AmazonQualificationError("QUALIFICATION_RESPONSE_READ_FAILED", "failed", error);
  }
  return Buffer.concat(chunks, total);
}

async function defaultWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const aborted = (): void => {
      clearTimeout(timer);
      reject(new AmazonQualificationError("QUALIFICATION_ABORTED"));
    };
    if (signal.aborted) return aborted();
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function checksumBuffer(receipt: QualificationEvidenceReceipt): Buffer {
  return Buffer.from(receipt.checksumHex, "hex");
}

function outputPolicy(
  definition: AmazonOperationDefinition,
  executionMode: BrightDataExecutionMode,
): Readonly<Record<string, unknown>> {
  const contract = getAmazonPreciseOutputContract(definition.operationCode);
  if (contract === undefined) {
    throw new AmazonQualificationError("QUALIFICATION_OUTPUT_CONTRACT_UNAVAILABLE");
  }
  return Object.freeze({
    provider_submission: Object.freeze({ endpoint: executionMode }),
    provider_request:
      definition.providerRequest.mode === "collect"
        ? Object.freeze({ mode: "collect", limit_per_input: null })
        : Object.freeze({
            mode: "discover",
            discover_by: definition.providerRequest.discoverBy,
            limit_per_input: null,
          }),
    snapshot: Object.freeze({
      enabled: true,
      cancel_enabled: false,
      multipart_enabled: false,
      format: "json",
    }),
    normalizer_code: contract.normalizerCode,
    normalizer_version: contract.normalizerVersion,
    normalized_schema_version: contract.schemaVersion,
  });
}

async function inspectForQualification(input: {
  readonly operationCode: string;
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly contentEncoding: string | null;
  readonly maxBytes: number;
}): Promise<number> {
  try {
    const observation = await inspectAmazonProviderResult({
      bytes: Readable.from(input.bytes),
      contentType: input.contentType,
      contentEncoding: input.contentEncoding,
      maxBytes: input.maxBytes,
    });
    if (observation.providerErrorCount > 0) {
      throw new AmazonQualificationError("QUALIFICATION_PROVIDER_ERROR_RECORDS");
    }
    if (getAmazonPreciseOutputContract(input.operationCode) !== undefined) {
      const normalized = await normalizeAmazonProviderResult({
        operationCode: input.operationCode,
        bytes: Readable.from(input.bytes),
        contentType: input.contentType,
        contentEncoding: input.contentEncoding,
        maxBytes: input.maxBytes,
      });
      return normalized.recordCount;
    }
    return observation.recordCount;
  } catch (error) {
    if (error instanceof AmazonQualificationError) throw error;
    if (error instanceof AmazonResultNormalizationError) {
      throw new AmazonQualificationError("QUALIFICATION_PROVIDER_RESPONSE_INVALID");
    }
    throw error;
  }
}

function safeFailure(error: unknown): AmazonQualificationError {
  if (error instanceof AmazonQualificationError) return error;
  if (error instanceof QualificationProviderRequestBudgetError) {
    return new AmazonQualificationError(error.code, "failed", error);
  }
  if (error instanceof BrightDataBoundaryError) {
    return new AmazonQualificationError(
      error.code,
      error.submissionOutcome === "uncertain" ? "uncertain" : "failed",
      error,
      error.safeReason,
      error.observedByteCount === undefined || error.maximumByteCount === undefined
        ? undefined
        : {
            observedByteCount: error.observedByteCount,
            maximumByteCount: error.maximumByteCount,
          },
    );
  }
  return new AmazonQualificationError("QUALIFICATION_INTERNAL_FAILURE", "failed", error);
}

export function createAmazonQualificationService(
  dependencies: Dependencies,
): AmazonQualificationService {
  if (
    !Number.isSafeInteger(dependencies.evidenceMaxBytes) ||
    dependencies.evidenceMaxBytes < 1 ||
    !Number.isSafeInteger(dependencies.pollIntervalMs) ||
    dependencies.pollIntervalMs < 1 ||
    !Number.isSafeInteger(dependencies.pollMaxElapsedMs) ||
    dependencies.pollMaxElapsedMs < dependencies.pollIntervalMs
  ) {
    throw new AmazonQualificationError("QUALIFICATION_CONFIGURATION_INVALID");
  }
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.wait ?? defaultWait;

  async function resolveDatasetId(input: {
    readonly candidateId: string;
    readonly operationCode: string;
    readonly environment: "local" | "test";
  }): Promise<{ readonly datasetId: string; readonly plan: QualificationCandidatePlan }> {
    const plan = await dependencies.repository.resolveCandidate(input);
    const datasetId = await dependencies.protector.reveal(
      plan.candidateCiphertext,
      plan.candidateFingerprint,
      candidateAad(input.candidateId),
    );
    return { datasetId, plan };
  }

  return {
    async discover(input) {
      if (input.confirmedLiveRequest !== true) {
        throw new AmazonQualificationError("QUALIFICATION_LIVE_CONFIRMATION_REQUIRED");
      }
      validateActor(input.actor);
      const importId = randomUUID();
      await dependencies.repository.beginImport({
        importId,
        environment: input.environment,
        actor: input.actor,
        restrictedReference: input.restrictedReference,
      });
      try {
        const apiKey = await dependencies.secretProvider.getSecret("BRIGHTDATA_API_KEY");
        const discovered = await dependencies.client.listScrapers({ apiKey, signal: input.signal });
        const providerIds = new Set<string>();
        const protectedCandidates = [];
        const publicCandidates = [];
        const manifestCandidates = [];
        for (const scraper of discovered) {
          if (providerIds.has(scraper.id)) {
            throw new AmazonQualificationError("QUALIFICATION_DISCOVERY_DUPLICATE_ID");
          }
          providerIds.add(scraper.id);
          const candidateId = randomUUID();
          const protectedReference = await dependencies.protector.protect(
            scraper.id,
            candidateAad(candidateId),
          );
          protectedCandidates.push({ id: candidateId, ...protectedReference });
          publicCandidates.push(Object.freeze({ candidateId, name: scraper.name }));
          manifestCandidates.push({
            candidate_id: candidateId,
            name: scraper.name,
            provider_resource_fingerprint: protectedReference.fingerprint.toString("hex"),
          });
        }
        const manifest = jsonBytes({
          schema_version: "pattern7-scraper-discovery-v1",
          import_id: importId,
          environment: input.environment,
          candidates: manifestCandidates,
        });
        const evidenceObjectKey = `qualification/catalog-imports/${importId}/scrapers.json`;
        const receipt = await dependencies.evidenceStore.putImmutable({
          objectKey: evidenceObjectKey,
          bytes: manifest,
          contentType: "application/json",
          maxBytes: dependencies.evidenceMaxBytes,
        });
        const candidateCount = await dependencies.repository.completeImport({
          importId,
          candidates: protectedCandidates,
          evidenceObjectKey,
          evidenceChecksum: checksumBuffer(receipt),
          actor: input.actor,
        });
        return Object.freeze({
          importId,
          candidateCount,
          candidates: Object.freeze(publicCandidates),
          evidenceObjectKey,
          evidenceChecksum: receipt.checksumHex,
        });
      } catch (error) {
        const failure = safeFailure(error);
        try {
          await dependencies.repository.failImport({
            importId,
            safeErrorCode: failure.code,
            actor: input.actor,
          });
        } catch (recordError) {
          throw new AggregateError([failure, recordError], "Qualification import and failure recording failed");
        }
        throw failure;
      }
    },

    async reviewCandidate(input): Promise<void> {
      validateUuid(input.candidateId);
      validateActor(input.actor);
      await dependencies.repository.reviewCandidate(input);
    },

    async qualify(input) {
      if (input.confirmedBillableRequest !== true) {
        throw new AmazonQualificationError("QUALIFICATION_BILLABLE_CONFIRMATION_REQUIRED");
      }
      validateUuid(input.candidateId);
      validateActor(input.actor);
      if (input.executionMode !== "scrape" && input.executionMode !== "trigger") {
        throw new AmazonQualificationError("QUALIFICATION_EXECUTION_MODE_INVALID");
      }
      const definition = definitionFor(input.operationCode);
      const serialized = serializeAmazonProviderRequest({
        operationCode: input.operationCode,
        validatedInput: input.validatedInput,
        providerRequest: definition.providerRequest,
      });
      const qualificationId = randomUUID();
      const requestObjectKey = `qualification/operations/${qualificationId}/request.json`;
      const requestBytes = jsonBytes({
        schema_version: "pattern7-provider-request-v2",
        qualification_id: qualificationId,
        operation_code: input.operationCode,
        provider_execution_mode: input.executionMode,
        provider_request: serialized.fixedQuery,
        input: serialized.targets,
      });
      const requestReceipt = await dependencies.evidenceStore.putImmutable({
        objectKey: requestObjectKey,
        bytes: requestBytes,
        contentType: "application/json",
        maxBytes: dependencies.evidenceMaxBytes,
      });
      const { datasetId } = await resolveDatasetId(input);
      await dependencies.repository.beginQualification({
        qualificationId,
        candidateId: input.candidateId,
        operationCode: input.operationCode,
        environment: input.environment,
        providerExecutionMode: input.executionMode,
        requestObjectKey,
        requestChecksum: checksumBuffer(requestReceipt),
        actor: input.actor,
      });

      let snapshotCiphertext: Buffer | null = null;
      let snapshotFingerprint: Buffer | null = null;
      let submissionMode: "inline" | "snapshot" | null = null;
      let capturedResponseReceipt: QualificationEvidenceReceipt | null = null;
      try {
        const apiKey = await dependencies.secretProvider.getSecret("BRIGHTDATA_API_KEY");
        const providerInput = {
          apiKey,
          datasetId,
          targets: serialized.targets,
          fixedQuery: serialized.fixedQuery,
          limitPerInput: null,
          signal: input.signal,
        } as const;
        const submission = input.executionMode === "scrape"
          ? await dependencies.client.submit(providerInput)
          : {
              kind: "snapshot" as const,
              ...await dependencies.client.trigger(providerInput),
            };

        let responseReceipt: QualificationEvidenceReceipt;
        let recordCount: number;
        if (submission.kind === "inline") {
          submissionMode = "inline";
          const raw = await boundedBuffer(submission.bytes, dependencies.evidenceMaxBytes);
          responseReceipt = await dependencies.evidenceStore.putImmutable({
            objectKey: `qualification/operations/${qualificationId}/response.json`,
            bytes: raw,
            contentType: submission.contentType,
            maxBytes: dependencies.evidenceMaxBytes,
          });
          capturedResponseReceipt = responseReceipt;
          recordCount = await inspectForQualification({
            operationCode: input.operationCode,
            bytes: raw,
            contentType: submission.contentType,
            contentEncoding: submission.contentEncoding,
            maxBytes: dependencies.evidenceMaxBytes,
          });
        } else {
          submissionMode = "snapshot";
          const protectedSnapshot = await dependencies.protector.protect(
            submission.snapshotReference,
            qualificationSnapshotAad(qualificationId),
          );
          snapshotCiphertext = protectedSnapshot.ciphertext;
          snapshotFingerprint = protectedSnapshot.fingerprint;
          const startedAt = now();
          for (;;) {
            const progress = await dependencies.client.getProgress({
              apiKey,
              snapshotReference: submission.snapshotReference,
              signal: input.signal,
            });
            if (progress.status === "failed" || progress.status === "canceled") {
              throw new AmazonQualificationError("QUALIFICATION_PROVIDER_SNAPSHOT_FAILED");
            }
            if (progress.status === "ready") break;
            if (now() - startedAt >= dependencies.pollMaxElapsedMs) {
              throw new AmazonQualificationError("QUALIFICATION_PROVIDER_POLL_TIMEOUT");
            }
            await wait(dependencies.pollIntervalMs, input.signal);
          }
          const parts = await dependencies.client.getParts({
            apiKey,
            snapshotReference: submission.snapshotReference,
            format: "json",
            batchSize: 1000,
            signal: input.signal,
          });
          const partReceipts = [];
          recordCount = 0;
          let totalRawBytes = 0;
          for (let part = 1; part <= parts.parts; part += 1) {
            const downloaded = await dependencies.client.download({
              apiKey,
              snapshotReference: submission.snapshotReference,
              format: "json",
              batchSize: 1000,
              part,
              signal: input.signal,
            });
            const raw = await boundedBuffer(downloaded.bytes, dependencies.evidenceMaxBytes);
            totalRawBytes += raw.byteLength;
            if (totalRawBytes > dependencies.evidenceMaxBytes) {
              throw new AmazonQualificationError("QUALIFICATION_RESPONSE_TOO_LARGE");
            }
            const partReceipt = await dependencies.evidenceStore.putImmutable({
              objectKey: `qualification/operations/${qualificationId}/parts/${String(part).padStart(6, "0")}.json`,
              bytes: raw,
              contentType: downloaded.contentType,
              maxBytes: dependencies.evidenceMaxBytes,
            });
            capturedResponseReceipt = partReceipt;
            recordCount += await inspectForQualification({
              operationCode: input.operationCode,
              bytes: raw,
              contentType: downloaded.contentType,
              contentEncoding: downloaded.contentEncoding,
              maxBytes: dependencies.evidenceMaxBytes,
            });
            partReceipts.push({
              part,
              object_key: partReceipt.objectKey,
              checksum: partReceipt.checksumHex,
              byte_count: partReceipt.byteCount,
              content_type: partReceipt.contentType,
            });
          }
          const manifest = jsonBytes({
            schema_version: "pattern7-snapshot-manifest-v1",
            qualification_id: qualificationId,
            operation_code: input.operationCode,
            part_count: parts.parts,
            record_count: recordCount,
            parts: partReceipts,
          });
          responseReceipt = await dependencies.evidenceStore.putImmutable({
            objectKey: `qualification/operations/${qualificationId}/response-manifest.json`,
            bytes: manifest,
            contentType: "application/json",
            maxBytes: dependencies.evidenceMaxBytes,
          });
          capturedResponseReceipt = responseReceipt;
        }

        await dependencies.repository.completeQualification({
          qualificationId,
          state: "succeeded",
          submissionMode,
          responseObjectKey: responseReceipt.objectKey,
          responseChecksum: checksumBuffer(responseReceipt),
          responseContentType: responseReceipt.contentType,
          responseByteCount: responseReceipt.byteCount,
          recordCount,
          snapshotCiphertext,
          snapshotFingerprint,
          safeErrorCode: null,
          actor: input.actor,
        });
        return Object.freeze({
          qualificationId,
          operationCode: input.operationCode,
          submissionMode,
          responseObjectKey: responseReceipt.objectKey,
          responseChecksum: responseReceipt.checksumHex,
          byteCount: responseReceipt.byteCount,
          recordCount,
          reviewState: "pending" as const,
        });
      } catch (error) {
        const failure = safeFailure(error);
        try {
          await dependencies.repository.completeQualification({
            qualificationId,
            state: failure.outcome,
            submissionMode,
            responseObjectKey: capturedResponseReceipt?.objectKey ?? null,
            responseChecksum: capturedResponseReceipt === null
              ? null
              : checksumBuffer(capturedResponseReceipt),
            responseContentType: capturedResponseReceipt?.contentType ?? null,
            responseByteCount: capturedResponseReceipt?.byteCount ?? null,
            recordCount: null,
            snapshotCiphertext,
            snapshotFingerprint,
            safeErrorCode: failure.code,
            actor: input.actor,
          });
        } catch (recordError) {
          throw new AggregateError([failure, recordError], "Qualification and failure recording failed");
        }
        throw failure;
      }
    },

    async accept(input) {
      validateUuid(input.qualificationId);
      validateActor(input.reviewer);
      if (
        !VERSION_PATTERN.test(input.commercialConfigVersion) ||
        !VERSION_PATTERN.test(input.configVersion) ||
        !/^[0-9a-f]{64}$/.test(input.evidenceHashHex)
      ) {
        throw new AmazonQualificationError("QUALIFICATION_ACCEPTANCE_INVALID");
      }
      const plan = await dependencies.repository.resolveAcceptance(input.qualificationId);
      const definition = definitionFor(plan.operationCode);
      const pinnedOutputPolicy = outputPolicy(definition, plan.providerExecutionMode);
      const datasetId = await dependencies.protector.reveal(
        plan.candidateCiphertext,
        plan.candidateFingerprint,
        candidateAad(plan.candidateId),
      );
      const mappingId = randomUUID();
      const protectedMapping = await dependencies.protector.protect(
        datasetId,
        providerMappingAad(mappingId),
      );
      const accepted = await dependencies.repository.acceptQualification({
        qualificationId: input.qualificationId,
        mappingId,
        mappingCiphertext: protectedMapping.ciphertext,
        mappingFingerprint: protectedMapping.fingerprint,
        outputPolicy: pinnedOutputPolicy,
        commercialConfigVersion: input.commercialConfigVersion,
        configVersion: input.configVersion,
        restrictedReference: input.restrictedReference,
        evidenceHash: Buffer.from(input.evidenceHashHex, "hex"),
        reviewer: input.reviewer,
        expiresAt: input.expiresAt,
      });
      return Object.freeze({
        mappingId: accepted.mappingId,
        launchEvidenceId: accepted.launchEvidenceId,
        mappingState: "disabled" as const,
      });
    },

    async reject(input): Promise<void> {
      validateUuid(input.qualificationId);
      validateActor(input.reviewer);
      if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(input.reason)) {
        throw new AmazonQualificationError("QUALIFICATION_REJECTION_INVALID");
      }
      await dependencies.repository.rejectQualification(input);
    },
  };
}
