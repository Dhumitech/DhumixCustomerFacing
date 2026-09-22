import { ApplicationError } from "../../utils/applicationError.js";

/** Non-enumerating authorization failure shared by non-browser principals. */
export function accessDenied(): ApplicationError {
  return new ApplicationError({
    status: 403,
    code: "ACCESS_DENIED",
    title: "Access denied",
    detail: "The authenticated principal cannot access this resource.",
  });
}

/** One non-enumerating failure for every unavailable Tenant authorization. */
export function workspaceUnavailable(): ApplicationError {
  return new ApplicationError({
    status: 403,
    code: "ACCESS_DENIED",
    title: "Workspace unavailable",
    detail: "This account has no active workspace.",
  });
}
