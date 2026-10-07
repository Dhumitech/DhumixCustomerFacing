const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** URL is the only selector. Never store an active organization in browser storage. */
export function selectedOrganization(pathname = window.location.pathname): string | null {
  const id = /^\/o\/([^/]+)\/workspace(?:\/|$)/.exec(pathname)?.[1];
  return id && UUID.test(id) ? id : null;
}
export function organizationPath(path: string, organizationId = selectedOrganization()): string {
  return organizationId && path.startsWith("/workspace") ? `/o/${organizationId}${path}` : path;
}
export function organizationHeaders(): Record<string, string> {
  const id = selectedOrganization();
  return id ? { "X-Dhumi-Organization": id } : {};
}
export const ORGANIZATION_NEEDED = "dhumi:organization-needed";
export function requestOrganization(): never {
  window.dispatchEvent(new Event(ORGANIZATION_NEEDED));
  throw new Error("Choose, create or join an organization, then retry this action.");
}
export function guardOrganizationAction(scope: Record<string, string>): void {
  if (window.location.pathname.startsWith("/workspace") && !scope["X-Dhumi-Organization"]) requestOrganization();
}
