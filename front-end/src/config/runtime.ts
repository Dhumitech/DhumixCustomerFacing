import type { LegalAcceptanceInput } from "../api/generated";

const DEFAULT_LOCAL_API_ORIGIN = "http://localhost:3000";
const HASH_PATTERN = /^[A-Fa-f0-9]{64}$/;

function readApiOrigin(value: string | undefined): string {
  const candidate = value?.trim() || (import.meta.env.PROD ? window.location.origin : DEFAULT_LOCAL_API_ORIGIN);
  const parsed = new URL(candidate);

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.origin !== candidate
  ) {
    throw new Error(
      "VITE_DHUMI_API_BASE_URL must be an exact HTTP or HTTPS origin.",
    );
  }

  return candidate;
}

function isLegalAcceptance(value: unknown): value is LegalAcceptanceInput {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.document_type === "string" &&
    candidate.document_type.length > 0 &&
    typeof candidate.document_version === "string" &&
    candidate.document_version.length > 0 &&
    typeof candidate.content_hash === "string" &&
    HASH_PATTERN.test(candidate.content_hash) &&
    candidate.accepted === true
  );
}

function readLegalAcceptances(
  value: string | undefined,
): readonly LegalAcceptanceInput[] {
  if (!value?.trim()) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      "VITE_SIGNUP_LEGAL_ACCEPTANCES_JSON must contain valid JSON.",
    );
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      "VITE_SIGNUP_LEGAL_ACCEPTANCES_JSON must contain at least one document.",
    );
  }

  if (!parsed.every(isLegalAcceptance)) {
    throw new Error(
      "VITE_SIGNUP_LEGAL_ACCEPTANCES_JSON does not match the Dhumi legal-acceptance contract.",
    );
  }

  return Object.freeze(parsed.map((item) => Object.freeze({ ...item })));
}

export const runtimeConfig = Object.freeze({
  apiOrigin: readApiOrigin(import.meta.env.VITE_DHUMI_API_BASE_URL),
  signupLegalAcceptances: readLegalAcceptances(
    import.meta.env.VITE_SIGNUP_LEGAL_ACCEPTANCES_JSON,
  ),
});
