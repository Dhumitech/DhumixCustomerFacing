import { ApplicationError } from "../../utils/applicationError.js";

export function apiKeyValidationFailed(
  errors: readonly { readonly field: string; readonly message: string }[],
): ApplicationError {
  return new ApplicationError({
    status: 422,
    code: "VALIDATION_ERROR",
    title: "Validation failed",
    detail: "The API-key request is invalid.",
    errors,
  });
}

export function apiKeyIdempotencyConflict(): ApplicationError {
  return new ApplicationError({
    status: 409,
    code: "IDEMPOTENCY_CONFLICT",
    title: "Idempotency conflict",
    detail: "This Idempotency-Key was already used with a different request.",
  });
}

export function apiKeyReplayExpired(): ApplicationError {
  return new ApplicationError({
    status: 409,
    code: "IDEMPOTENCY_REPLAY_EXPIRED",
    title: "Idempotency replay expired",
    detail: "The original API-key secret is no longer recoverable.",
  });
}

export function responseEnvelopeUnavailable(cause?: unknown): ApplicationError {
  return new ApplicationError({
    status: 503,
    code: "SERVICE_UNAVAILABLE",
    title: "Service unavailable",
    detail: "API-key creation is temporarily unavailable.",
    cause,
  });
}

export function apiKeyNotFound(): ApplicationError {
  return new ApplicationError({
    status: 404,
    code: "RESOURCE_NOT_FOUND",
    title: "Resource not found",
  });
}
