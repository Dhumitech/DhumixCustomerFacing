import { providerMappingAad } from
  "../brightdata/providerExecutionPlanRepository.js";
import type { ProviderReferenceProtector } from
  "../brightdata/providerReferenceProtector.js";
import type { MarketplaceExportCandidateRepository } from
  "./marketplaceExportCandidateRepository.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$/;

export class MarketplaceExportCandidateError extends Error {
  public constructor(
    public readonly code:
      | "MARKETPLACE_EXPORT_CANDIDATE_INPUT_INVALID"
      | "MARKETPLACE_EXPORT_CANDIDATE_FAILED",
    cause?: unknown,
  ) {
    super(
      "Marketplace export candidate registration failed",
      cause === undefined ? undefined : { cause },
    );
    this.name = "MarketplaceExportCandidateError";
  }
}

interface Dependencies {
  readonly repository: MarketplaceExportCandidateRepository;
  readonly protector: ProviderReferenceProtector;
  readonly expectedEnvironment: "local" | "test";
}

function catalogueAad(environment: "local" | "test", resourceCode: "linkedin.posts"): Buffer {
  return Buffer.from(
    `dhumi:marketplace-catalogue:v1:${environment}:${resourceCode}`,
    "utf8",
  );
}

function validate(input: {
  readonly packetId: string;
  readonly mappingId: string;
  readonly actor: string;
  readonly evidenceReference: string;
  readonly reason: string;
}): void {
  if (!UUID.test(input.packetId) || !UUID.test(input.mappingId) ||
      !ACTOR.test(input.actor) ||
      input.evidenceReference.trim() !== input.evidenceReference ||
      input.evidenceReference.length < 8 || input.evidenceReference.length > 1024 ||
      input.reason.trim() !== input.reason || input.reason.length < 8 ||
      input.reason.length > 512) {
    throw new MarketplaceExportCandidateError("MARKETPLACE_EXPORT_CANDIDATE_INPUT_INVALID");
  }
}

export function createMarketplaceExportCandidateService(dependencies: Dependencies) {
  return Object.freeze({
    async register(input: {
      readonly packetId: string;
      readonly mappingId: string;
      readonly actor: string;
      readonly evidenceReference: string;
      readonly reason: string;
    }) {
      validate(input);
      try {
        const source = await dependencies.repository.resolveSource({
          packetId: input.packetId,
          mappingId: input.mappingId,
        });
        if (source.environment !== dependencies.expectedEnvironment) {
          throw new MarketplaceExportCandidateError("MARKETPLACE_EXPORT_CANDIDATE_FAILED");
        }
        const providerResource = await dependencies.protector.reveal(
          source.providerResourceCiphertext,
          source.providerResourceFingerprint,
          catalogueAad(source.environment, source.resourceCode),
        );
        const protectedMappingResource = await dependencies.protector.protect(
          providerResource,
          providerMappingAad(input.mappingId),
        );
        const registered = await dependencies.repository.register({
          ...input,
          providerResourceCiphertext: protectedMappingResource.ciphertext,
          providerResourceFingerprint: protectedMappingResource.fingerprint,
        });
        return Object.freeze({
          packet_id: input.packetId,
          mapping_id: registered.mappingId,
          template_slug: registered.templateSlug,
          template_version: registered.templateVersion,
          mapping_state: registered.mappingState,
          disposition: registered.disposition,
          customer_execution_enabled: false as const,
          provider_calls: 0 as const,
        });
      } catch (cause) {
        if (cause instanceof MarketplaceExportCandidateError) throw cause;
        throw new MarketplaceExportCandidateError("MARKETPLACE_EXPORT_CANDIDATE_FAILED", cause);
      }
    },
  });
}
