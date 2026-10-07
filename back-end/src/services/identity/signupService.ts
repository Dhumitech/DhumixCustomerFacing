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

      // Hash even an existing email before consulting the database, preserving
      // the generic accepted response and password-cost protection.
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

      // Every committed outcome and an in-progress duplicate are all accepted.
      // The architecture requires an in-progress duplicate to return the
      // original accepted representation rather than an error.
      await repository.createSignup({
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
    },
  };
}
