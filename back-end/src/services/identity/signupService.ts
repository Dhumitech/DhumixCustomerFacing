import { randomUUID } from "node:crypto";
import type { LegalRuntimeConfig } from "../../config/environment.js";
import { validateLegalAcceptances } from "../../helpers/legalAcceptance.js";
import type { SubmittedLegalAcceptance } from "../../helpers/legalAcceptance.js";
import type { PasswordHasher } from "../../helpers/password.js";
import {
  actorFingerprint,
  canonicalRequestHash,
  legacySignupRequestHash,
  normalizeEmail,
} from "../../helpers/signupCanonicalization.js";
import { ApplicationError } from "../../utils/applicationError.js";
import type { DatabaseLegalAcceptance, SignupRepository } from "./signupRepository.js";

export interface SignupRequest {
  readonly email: string;
  readonly password: string;
  readonly workspaceName?: string;
  readonly legalAcceptances: readonly SubmittedLegalAcceptance[];
  readonly idempotencyKey: string;
  readonly requestId: string | null;
}

export interface SignupService {
  submit(request: SignupRequest): Promise<void>;
}

export interface SignupServiceDependencies {
  readonly repository: SignupRepository;
  readonly passwordHasher: PasswordHasher;
  readonly legal: LegalRuntimeConfig;
}

export function createSignupService(dependencies: SignupServiceDependencies): SignupService {
  const { repository, passwordHasher, legal } = dependencies;

  return {
    async submit(request: SignupRequest): Promise<void> {
      const validation = validateLegalAcceptances(legal, request.legalAcceptances);
      if (!validation.ok) {
        throw new ApplicationError({
          status: 422,
          code: "VALIDATION_ERROR",
          title: "Request validation failed",
          errors: validation.errors,
        });
      }

      const emailNormalized = normalizeEmail(request.email);

      // Hash every valid request before persistence; duplicate detection never
      // replaces an existing password and retains the same cost/rate controls.
      const passwordHash = await passwordHasher.hash(request.password);

      const requestHash = canonicalRequestHash({
        emailNormalized,
        legalAcceptances: validation.accepted,
      });

      // Keep the existing legal-catalogue validation and hash translation.
      const legalAcceptances: DatabaseLegalAcceptance[] = validation.accepted.map((acceptance) => ({
        document_type: acceptance.documentType,
        document_version: acceptance.documentVersion,
        document_hash_hex: acceptance.contentHash,
        disclosure_version: legal.disclosureVersion,
      }));

      // Persistence commits the outcome before it is mapped to an HTTP error,
      // so duplicate rejection is audited and idempotent retries are stable.
      const outcome = await repository.createSignup({
        emailNormalized,
        passwordHash,
        legalAcceptances,
        idempotencyKey: request.idempotencyKey,
        requestHash,
        actorFingerprint: actorFingerprint(emailNormalized),
        requestId: request.requestId ?? randomUUID(),
        ...(request.workspaceName === undefined
          ? {}
          : {
              legacyRequestHash: legacySignupRequestHash({
                emailNormalized,
                workspaceName: request.workspaceName.trim(),
                legalAcceptances: validation.accepted,
              }),
            }),
      });
      if (outcome.kind === "existing") {
        throw new ApplicationError({
          status: 409,
          code: "ACCOUNT_ALREADY_EXISTS",
          title: "Account already exists",
          detail: "An account with this email already exists. Sign in to continue. If you forgot your password, contact dhumitechnologies@gmail.com.",
        });
      }
    },
  };
}
