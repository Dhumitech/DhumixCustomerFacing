import type { LegalRuntimeConfig } from "../../config/environment.js";
import { validateLegalAcceptances } from "../../helpers/legalAcceptance.js";
import type { SubmittedLegalAcceptance } from "../../helpers/legalAcceptance.js";
import type { PasswordHasher } from "../../helpers/password.js";
import {
  actorFingerprint,
  canonicalRequestHash,
  normalizeEmail,
} from "../../helpers/signupCanonicalization.js";
import { ApplicationError } from "../../utils/applicationError.js";
import type { DatabaseLegalAcceptance, SignupRepository } from "./signupRepository.js";

export interface SignupRequest {
  readonly email: string;
  readonly password: string;
  readonly workspaceName: string;
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

const DEFAULT_LOCALE = "en";

export function createSignupService(
  dependencies: SignupServiceDependencies,
): SignupService {
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

      // Normalise once, before hashing. Hashing the raw value while storing a
      // trimmed one would make "  Acme  " and "Acme" produce different request
      // hashes for an identical workspace, so a client that trims on retry
      // would receive 409 IDEMPOTENCY_CONFLICT instead of a replay.
      const workspaceName = request.workspaceName.trim();
      const workspaceLength = [...workspaceName].length;
      if (workspaceLength < 2 || workspaceLength > 120) {
        throw new ApplicationError({
          status: 422,
          code: "VALIDATION_ERROR",
          title: "Request validation failed",
          errors: [
            {
              field: "workspace_name",
              message: "must contain between 2 and 120 characters after trimming",
            },
          ],
        });
      }

      // Hashed unconditionally, before the database is consulted. The
      // existing-identity branch inside app.create_signup exits early, so
      // conditional hashing would make a registered address answer measurably
      // faster and turn the generic 202 into an enumeration oracle.
      const passwordHash = await passwordHasher.hash(request.password);

      const requestHash = canonicalRequestHash({
        emailNormalized,
        workspaceName,
        legalAcceptances: validation.accepted,
      });

      // Translate the public field name into the key the database function
      // reads. This is the only place the two vocabularies meet.
      const legalAcceptances: DatabaseLegalAcceptance[] = validation.accepted.map(
        (acceptance) => ({
          document_type: acceptance.documentType,
          document_version: acceptance.documentVersion,
          document_hash_hex: acceptance.contentHash,
          disclosure_version: legal.disclosureVersion,
          locale: DEFAULT_LOCALE,
        }),
      );

      // Every committed outcome and an in-progress duplicate are all accepted.
      // The architecture requires an in-progress duplicate to return the
      // original accepted representation rather than an error.
      await repository.createSignup({
        emailNormalized,
        passwordHash,
        workspaceName,
        legalAcceptances,
        idempotencyKey: request.idempotencyKey,
        requestHash,
        actorFingerprint: actorFingerprint(emailNormalized),
        requestId: request.requestId,
      });
    },
  };
}
