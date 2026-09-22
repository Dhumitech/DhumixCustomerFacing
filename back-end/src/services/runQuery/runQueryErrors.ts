import { ApplicationError } from "../../utils/applicationError.js";

export function runQueryValidationFailed(
  errors: readonly { readonly field: string; readonly message: string }[],
): ApplicationError {
  return new ApplicationError({
    status: 422,
    code: "VALIDATION_ERROR",
    title: "Validation failed",
    detail: "The Run list request is invalid.",
    errors,
  });
}

export function runQueryNotFound(): ApplicationError {
  return new ApplicationError({
    status: 404,
    code: "RESOURCE_NOT_FOUND",
    title: "Resource not found",
  });
}

export function runResultNotReady(): ApplicationError {
  return new ApplicationError({
    status: 409,
    code: "STATE_CONFLICT",
    title: "Result not ready",
    detail: "The Run result is not ready.",
  });
}

export function runResultValidationFailed(
  errors: readonly { readonly field: string; readonly message: string }[],
): ApplicationError {
  return new ApplicationError({
    status: 422,
    code: "VALIDATION_ERROR",
    title: "Validation failed",
    detail: "The Run result request is invalid.",
    errors,
  });
}

export function runResultInconsistent(cause?: unknown): ApplicationError {
  return new ApplicationError({
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Internal server error",
    cause: cause ?? new Error("Ready Run has no valid result Artifact"),
  });
}

export function runResultSigningUnavailable(cause?: unknown): ApplicationError {
  return new ApplicationError({
    status: 503,
    code: "SERVICE_UNAVAILABLE",
    title: "Service unavailable",
    detail: "Result download is temporarily unavailable.",
    cause,
  });
}

export function runEventListValidationFailed(
  errors: readonly { readonly field: string; readonly message: string }[],
): ApplicationError {
  return new ApplicationError({
    status: 422,
    code: "VALIDATION_ERROR",
    title: "Validation failed",
    detail: "The Run event list request is invalid.",
    errors,
  });
}

export function runEventProjectionUnavailable(): ApplicationError {
  return new ApplicationError({
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Internal server error",
    cause: new Error("Run event public projection is unavailable"),
  });
}
