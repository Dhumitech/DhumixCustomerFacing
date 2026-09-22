import { ApplicationError } from "../../utils/applicationError.js";

export function usageReadValidationFailed(
  errors: readonly { readonly field: string; readonly message: string }[],
): ApplicationError {
  return new ApplicationError({
    status: 422,
    code: "VALIDATION_ERROR",
    title: "Validation failed",
    detail: "The usage request is invalid.",
    errors,
  });
}

export function usageProjectionUnavailable(cause?: unknown): ApplicationError {
  return new ApplicationError({
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Internal server error",
    cause: cause ?? new Error("Usage public projection is unavailable"),
  });
}
