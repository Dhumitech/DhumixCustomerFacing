import { ApplicationError } from "../../utils/applicationError.js";

export function authenticationRequired(): ApplicationError {
  return new ApplicationError({
    status: 401,
    code: "AUTHENTICATION_REQUIRED",
    title: "Authentication required",
    detail: "Valid authentication credentials are required.",
  });
}

export function csrfValidationFailed(): ApplicationError {
  return new ApplicationError({
    status: 403,
    code: "ACCESS_DENIED",
    title: "CSRF validation failed",
    detail: "The session security token is missing or invalid.",
  });
}
