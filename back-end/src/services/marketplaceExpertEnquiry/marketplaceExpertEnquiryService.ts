import { randomUUID } from "node:crypto";
import type { CsrfService } from "../../helpers/csrf.js";
import { canonicalSha256 } from "../../helpers/canonicalJson.js";
import { tenantActorFingerprint } from "../../helpers/tenantActorFingerprint.js";
import { ApplicationError } from "../../utils/applicationError.js";
import { csrfValidationFailed } from "../identity/sessionErrors.js";
import type { TrustedTenantPrincipal } from "../tenantAccess/trustedTenantPrincipal.js";
import {
  MarketplaceExpertEnquiryNotFoundError,
  MarketplaceExpertEnquiryPersistenceError,
  MarketplaceExpertEnquiryStaleError,
  type MarketplaceExpertEnquiryRepository,
  type MarketplaceExpertEnquiryState,
} from "./marketplaceExpertEnquiryRepository.js";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface MarketplaceExpertEnquiryBody {
  readonly expected_template_version?: unknown;
}

export interface MarketplaceExpertEnquiryResponse {
  readonly id: string;
  readonly template_slug: string;
  readonly template_version: number;
  readonly state: MarketplaceExpertEnquiryState;
  readonly submitted_at: string;
}

export interface MarketplaceExpertEnquiryService {
  submit(input: {
    readonly principal: TrustedTenantPrincipal;
    readonly slug: unknown;
    readonly csrfToken: string | undefined;
    readonly idempotencyKey: string | undefined;
    readonly body: MarketplaceExpertEnquiryBody;
    readonly schemaErrors: readonly { readonly field: string; readonly message: string }[];
    readonly requestId: string | null;
    readonly ipFingerprint: Buffer | null;
  }): Promise<MarketplaceExpertEnquiryResponse>;
}

interface Dependencies {
  readonly repository: MarketplaceExpertEnquiryRepository;
  readonly csrf: CsrfService;
  readonly createId?: () => string;
}

function problem(
  status: number,
  code: "VALIDATION_ERROR" | "RESOURCE_NOT_FOUND" | "STATE_CONFLICT" |
    "IDEMPOTENCY_CONFLICT" | "SERVICE_UNAVAILABLE",
  title: string,
  detail?: string,
  errors?: readonly { readonly field: string; readonly message: string }[],
): ApplicationError {
  return new ApplicationError({
    status,
    code,
    title,
    ...(detail === undefined ? {} : { detail }),
    ...(errors === undefined ? {} : { errors }),
  });
}

export function createMarketplaceExpertEnquiryService(
  dependencies: Dependencies,
): MarketplaceExpertEnquiryService {
  const createId = dependencies.createId ?? randomUUID;
  return Object.freeze({
    async submit(
      input: Parameters<MarketplaceExpertEnquiryService["submit"]>[0],
    ) {
      if (input.principal.kind === "browser" &&
          (input.csrfToken === undefined ||
            !dependencies.csrf.verify(input.principal.sessionId, input.csrfToken))) {
        throw csrfValidationFailed();
      }

      if (typeof input.slug !== "string" || !SLUG.test(input.slug)) {
        throw problem(404, "RESOURCE_NOT_FOUND", "Resource not found");
      }

      const issues = [...input.schemaErrors];
      if (input.idempotencyKey === undefined || !IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
        issues.push({
          field: "idempotency-key",
          message: "must be 16-128 accepted characters",
        });
      }
      const expectedTemplateVersion = input.body.expected_template_version;
      if (typeof expectedTemplateVersion !== "number" ||
          !Number.isSafeInteger(expectedTemplateVersion) || expectedTemplateVersion < 1) {
        issues.push({
          field: "/expected_template_version",
          message: "must be a positive integer",
        });
      }
      if (issues.length > 0) {
        throw problem(
          422,
          "VALIDATION_ERROR",
          "Validation failed",
          "The Marketplace expert-enquiry request is invalid.",
          issues,
        );
      }

      const requestHash = canonicalSha256({
        operation: "marketplace.expert_enquiry.create.v1",
        template_slug: input.slug,
        expected_template_version: expectedTemplateVersion,
      });

      try {
        const outcome = await dependencies.repository.create({
          enquiryId: createId(),
          tenantId: input.principal.tenantId,
          actor: input.principal.kind === "browser"
            ? { kind: "browser", userId: input.principal.userId }
            : { kind: "api_key", apiKeyId: input.principal.apiKeyId },
          actorFingerprint: tenantActorFingerprint(input.principal),
          idempotencyKey: input.idempotencyKey as string,
          requestHash,
          templateSlug: input.slug,
          expectedTemplateVersion: expectedTemplateVersion as number,
          requestId: input.requestId,
          ipFingerprint: input.ipFingerprint,
        });
        if (outcome.kind === "conflict") {
          throw problem(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Idempotency conflict",
            "This Idempotency-Key was already used with a different request.",
          );
        }
        return {
          id: outcome.record.enquiryId,
          template_slug: outcome.record.templateSlug,
          template_version: outcome.record.templateVersion,
          state: outcome.record.state,
          submitted_at: outcome.record.submittedAt.toISOString(),
        };
      } catch (error) {
        if (error instanceof MarketplaceExpertEnquiryNotFoundError) {
          throw problem(404, "RESOURCE_NOT_FOUND", "Resource not found");
        }
        if (error instanceof MarketplaceExpertEnquiryStaleError) {
          throw problem(
            409,
            "STATE_CONFLICT",
            "State conflict",
            "The Marketplace dataset changed. Refresh it before contacting an expert.",
          );
        }
        if (error instanceof ApplicationError) throw error;
        if (error instanceof MarketplaceExpertEnquiryPersistenceError) {
          throw problem(
            503,
            "SERVICE_UNAVAILABLE",
            "Service unavailable",
            "The expert request could not be recorded. Try again later.",
          );
        }
        throw problem(
          503,
          "SERVICE_UNAVAILABLE",
          "Service unavailable",
          "The expert request could not be recorded. Try again later.",
        );
      }
    },
  });
}
