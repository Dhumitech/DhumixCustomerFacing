import type {
  AmazonOperationReleaseRepository,
  PublishedAmazonOperation,
} from "./amazonOperationReleaseRepository.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ACTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$/;
const REASON_PATTERN = /^[a-z0-9][a-z0-9_.:-]{2,127}$/;

export class AmazonOperationReleaseError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "AmazonOperationReleaseError";
  }
}

export interface PublishAmazonOperationRequest {
  readonly confirmedPublication: boolean;
  readonly expectedEnvironment: "local" | "test";
  readonly qualificationId: string;
  readonly restrictedReference: string;
  readonly evidenceHashHex: string;
  readonly reviewer: string;
  readonly reason: string;
  readonly expiresAt: Date | null;
}

export type UpgradeAmazonProductsInputContractRequest = Omit<
  PublishAmazonOperationRequest,
  "qualificationId"
>;

export interface AmazonOperationReleaseService {
  publish(input: PublishAmazonOperationRequest): Promise<PublishedAmazonOperation>;
  upgradeProductsInputContract(
    input: UpgradeAmazonProductsInputContractRequest,
  ): Promise<PublishedAmazonOperation>;
}

function requireApprovedRelease(input: {
  readonly confirmedPublication: boolean;
  readonly restrictedReference: string;
  readonly evidenceHashHex: string;
  readonly reviewer: string;
  readonly reason: string;
  readonly expiresAt: Date | null;
}): void {
  if (input.confirmedPublication !== true) {
    throw new AmazonOperationReleaseError("AMAZON_RELEASE_CONFIRMATION_REQUIRED");
  }
  if (
    input.restrictedReference.length < 8 ||
    input.restrictedReference.length > 1024 ||
    !HASH_PATTERN.test(input.evidenceHashHex) ||
    !ACTOR_PATTERN.test(input.reviewer) ||
    !REASON_PATTERN.test(input.reason) ||
    (input.expiresAt !== null && input.expiresAt.valueOf() <= Date.now())
  ) {
    throw new AmazonOperationReleaseError("AMAZON_RELEASE_INPUT_INVALID");
  }
}

export function createAmazonOperationReleaseService(
  dependencies: { readonly repository: AmazonOperationReleaseRepository },
): AmazonOperationReleaseService {
  return {
    async publish(input): Promise<PublishedAmazonOperation> {
      requireApprovedRelease(input);
      if (!UUID_PATTERN.test(input.qualificationId)) {
        throw new AmazonOperationReleaseError("AMAZON_RELEASE_INPUT_INVALID");
      }
      return dependencies.repository.publish({
        expectedEnvironment: input.expectedEnvironment,
        qualificationId: input.qualificationId,
        restrictedReference: input.restrictedReference,
        evidenceHash: Buffer.from(input.evidenceHashHex, "hex"),
        reviewer: input.reviewer,
        reason: input.reason,
        expiresAt: input.expiresAt,
      });
    },

    async upgradeProductsInputContract(input): Promise<PublishedAmazonOperation> {
      requireApprovedRelease(input);
      return dependencies.repository.upgradeProductsInputContract({
        expectedEnvironment: input.expectedEnvironment,
        restrictedReference: input.restrictedReference,
        evidenceHash: Buffer.from(input.evidenceHashHex, "hex"),
        reviewer: input.reviewer,
        reason: input.reason,
        expiresAt: input.expiresAt,
      });
    },
  };
}
