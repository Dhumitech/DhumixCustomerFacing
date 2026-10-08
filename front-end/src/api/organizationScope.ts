const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** URL is the request selector. A remembered preference never grants access. */
export function selectedOrganization(
  pathname = window.location.pathname,
): string | null {
  const id = /^\/o\/([^/]+)\/workspace(?:\/|$)/.exec(pathname)?.[1];
  return id && UUID.test(id) ? id : null;
}
export function organizationPath(
  path: string,
  organizationId = selectedOrganization(),
): string {
  return organizationId && path.startsWith("/workspace")
    ? `/o/${organizationId}${path}`
    : path;
}
export function organizationHeaders(
  id = selectedOrganization(),
): Record<string, string> {
  return id ? { "X-Dhumi-Organization": id } : {};
}
export const ORGANIZATION_NEEDED = "dhumi:organization-needed";
export function requestOrganization(): never {
  window.dispatchEvent(new Event(ORGANIZATION_NEEDED));
  throw new Error("Choose or create an organization, then retry this action.");
}
export function guardOrganizationAction(scope: Record<string, string>): void {
  if (!scope["X-Dhumi-Organization"]) requestOrganization();
}
