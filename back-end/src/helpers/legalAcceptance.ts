import type { LegalRuntimeConfig } from "../config/environment.js";
import type { CanonicalLegalAcceptance } from "./signupCanonicalization.js";
import type { ProblemField } from "../utils/applicationError.js";

/** Exactly the shape the public contract accepts. */
export interface SubmittedLegalAcceptance {
  readonly document_type: string;
  readonly document_version: string;
  readonly content_hash: string;
  readonly accepted: true;
}

export type LegalValidation =
  | { readonly ok: true; readonly accepted: readonly CanonicalLegalAcceptance[] }
  | { readonly ok: false; readonly errors: readonly ProblemField[] };

function toCanonical(acceptance: SubmittedLegalAcceptance): CanonicalLegalAcceptance {
  return {
    documentType: acceptance.document_type,
    documentVersion: acceptance.document_version,
    contentHash: acceptance.content_hash.toLowerCase(),
  };
}

/**
 * Validates submitted legal acceptances against the approved catalogue.
 *
 * Two checks, not one. JSON Schema only enforces that between one and ten
 * acceptances arrived, so a customer can accept the Terms alone and pass
 * validation. Matching each submission is therefore insufficient: the required
 * set must also be complete.
 *
 * `document_type` is free text in PostgreSQL and no constraint enforces a
 * particular set, so this is the only place either rule exists.
 *
 * An empty catalogue disables matching. That state is reachable in development
 * and test only; `loadRuntimeConfig` refuses to start in production while the
 * catalogue is empty.
 */
export function validateLegalAcceptances(
  legal: LegalRuntimeConfig,
  submitted: readonly SubmittedLegalAcceptance[],
): LegalValidation {
  const errors: ProblemField[] = [];
  const seenTypes = new Set<string>();

  for (const acceptance of submitted) {
    if (seenTypes.has(acceptance.document_type)) {
      errors.push({
        field: "legal_acceptances",
        message: `document_type ${acceptance.document_type} was submitted more than once`,
      });
      continue;
    }
    seenTypes.add(acceptance.document_type);

    if (legal.documents.length === 0) {
      continue;
    }

    const match = legal.documents.find(
      (document) =>
        document.documentType === acceptance.document_type &&
        document.documentVersion === acceptance.document_version &&
        document.contentHash === acceptance.content_hash.toLowerCase(),
    );

    if (match === undefined) {
      // Deliberately does not say which of type, version or hash was wrong.
      // The catalogue is public information, but a precise mismatch reason
      // invites probing for which document versions are currently accepted.
      errors.push({
        field: "legal_acceptances",
        message: `no approved legal document matches document_type ${acceptance.document_type}`,
      });
    }
  }

  for (const requiredType of legal.requiredDocumentTypes) {
    if (!seenTypes.has(requiredType)) {
      errors.push({
        field: "legal_acceptances",
        message: `document_type ${requiredType} must be accepted`,
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, accepted: submitted.map(toCanonical) };
}
