import { ApplicationError } from "../../utils/applicationError.js";

export function runValidationFailed(
  errors: readonly { readonly field: string; readonly message: string }[],
): ApplicationError {
  return new ApplicationError({
    status: 422,
    code: "VALIDATION_ERROR",
    title: "Validation failed",
    detail: "The Run request is invalid.",
    errors,
  });
}

export function runInputInvalid(
  errors: readonly { readonly field: string; readonly message: string }[] = [],
): ApplicationError {
  return new ApplicationError({
    status: 422,
    code: "SERVICE_INPUT_INVALID",
    title: "Service input invalid",
    detail: "The Run input is not accepted by the pinned Template version.",
    ...(errors.length > 0 ? { errors } : {}),
  });
}

export function runNotFound(): ApplicationError {
  return new ApplicationError({
    status: 404,
    code: "RESOURCE_NOT_FOUND",
    title: "Resource not found",
  });
}

export function runCancellationBadRequest(): ApplicationError {
  return new ApplicationError({
    status: 400,
    code: "BAD_REQUEST",
    title: "Bad request",
    detail: "The cancellation request must not include a body.",
  });
}

export function runCancellationNotFound(): ApplicationError {
  return new ApplicationError({
    status: 404,
    code: "RESOURCE_NOT_FOUND",
    title: "Resource not found",
  });
}

export function runCancellationStateConflict(): ApplicationError {
  return new ApplicationError({
    status: 409,
    code: "STATE_CONFLICT",
    title: "State conflict",
    detail: "The selected Run cannot be cancelled in its current state.",
  });
}

export function runCancellationUnavailable(cause?: unknown): ApplicationError {
  return new ApplicationError({
    status: 503,
    code: "SERVICE_UNAVAILABLE",
    title: "Service unavailable",
    detail: "Run cancellation is temporarily unavailable.",
    cause,
  });
}

export function runRetryBadRequest(): ApplicationError {
  return new ApplicationError({
    status: 400,
    code: "BAD_REQUEST",
    title: "Bad request",
    detail: "The retry request must not include a body.",
  });
}

export function runRetryNotFound(): ApplicationError {
  return new ApplicationError({
    status: 404,
    code: "RESOURCE_NOT_FOUND",
    title: "Resource not found",
  });
}

export function runRetryStateConflict(): ApplicationError {
  return new ApplicationError({
    status: 409,
    code: "STATE_CONFLICT",
    title: "State conflict",
    detail: "The selected Run cannot be retried in its current state.",
  });
}

export function runRetryUnavailable(cause?: unknown): ApplicationError {
  return new ApplicationError({
    status: 503,
    code: "SERVICE_UNAVAILABLE",
    title: "Service unavailable",
    detail: "Run retry is temporarily unavailable.",
    cause,
  });
}

export function runStateConflict(): ApplicationError {
  return new ApplicationError({
    status: 409,
    code: "STATE_CONFLICT",
    title: "State conflict",
    detail: "The selected Service cannot accept a new Run.",
  });
}

export function runIdempotencyConflict(): ApplicationError {
  return new ApplicationError({
    status: 409,
    code: "IDEMPOTENCY_CONFLICT",
    title: "Idempotency conflict",
    detail: "The Idempotency-Key is already associated with a different request.",
  });
}

export function runCapacityLimit(cause?: unknown): ApplicationError {
  return new ApplicationError({
    status: 429,
    code: "PLATFORM_CAPACITY_LIMIT",
    title: "Platform capacity limit",
    detail: "Run admission is temporarily at capacity.",
    cause,
  });
}

export function runUnavailable(cause?: unknown): ApplicationError {
  return new ApplicationError({
    status: 503,
    code: "SERVICE_UNAVAILABLE",
    title: "Service unavailable",
    detail: "Run admission is temporarily unavailable.",
    cause,
  });
}
