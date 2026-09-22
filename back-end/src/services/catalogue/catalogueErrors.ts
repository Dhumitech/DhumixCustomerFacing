import { ApplicationError } from "../../utils/applicationError.js";

export function catalogueValidationFailed(
  errors: readonly { readonly field: string; readonly message: string }[],
): ApplicationError {
  return new ApplicationError({
    status: 422,
    code: "VALIDATION_ERROR",
    title: "Validation failed",
    detail: "The catalogue request is invalid.",
    errors,
  });
}

export function catalogTemplateNotFound(): ApplicationError {
  return new ApplicationError({
    status: 404,
    code: "RESOURCE_NOT_FOUND",
    title: "Resource not found",
  });
}
