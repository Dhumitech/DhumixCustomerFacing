import { ApplicationError } from "../../utils/applicationError.js";

export function serviceValidationFailed(
  errors: readonly { readonly field: string; readonly message: string }[],
): ApplicationError {
  return new ApplicationError({
    status: 422,
    code: "VALIDATION_ERROR",
    title: "Validation failed",
    detail: "The Service request is invalid.",
    errors,
  });
}

export function serviceInputInvalid(
  errors: readonly { readonly field: string; readonly message: string }[] = [],
): ApplicationError {
  return new ApplicationError({
    status: 422,
    code: "SERVICE_INPUT_INVALID",
    title: "Service input invalid",
    detail: "The Service configuration is not accepted by the selected Template.",
    ...(errors.length > 0 ? { errors } : {}),
  });
}

export function serviceUnavailable(cause?: unknown): ApplicationError {
  return new ApplicationError({
    status: 503,
    code: "SERVICE_UNAVAILABLE",
    title: "Service unavailable",
    detail: "The selected Service Template is not currently available.",
    cause,
  });
}

export function serviceIdempotencyConflict(): ApplicationError {
  return new ApplicationError({
    status: 409,
    code: "IDEMPOTENCY_CONFLICT",
    title: "Idempotency conflict",
    detail: "The Idempotency-Key is already associated with a different request.",
  });
}

export function serviceStateConflict(): ApplicationError {
  return new ApplicationError({
    status: 409,
    code: "STATE_CONFLICT",
    title: "State conflict",
    detail: "A Service with this name already exists.",
  });
}

export function serviceNotFound(): ApplicationError {
  return new ApplicationError({
    status: 404,
    code: "RESOURCE_NOT_FOUND",
    title: "Resource not found",
  });
}
