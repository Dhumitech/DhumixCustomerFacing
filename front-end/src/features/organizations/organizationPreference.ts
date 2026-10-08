const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Decode only a navigation namespace. Server authentication remains authoritative. */
export function preferenceUserId(accessToken?: string): string | null {
  try {
    const payload = JSON.parse(
      atob(
        (accessToken?.split(".")[1] ?? "")
          .replace(/-/g, "+")
          .replace(/_/g, "/"),
      ),
    );
    return typeof payload.sub === "string" && UUID.test(payload.sub)
      ? payload.sub
      : null;
  } catch {
    return null;
  }
}
export function rememberedOrganization(userId: string | null): string | null {
  if (!userId || !UUID.test(userId)) return null;
  try {
    const value = localStorage.getItem(`dhumi.organization.${userId}`);
    return value && UUID.test(value) ? value : null;
  } catch {
    return null;
  }
}
export function rememberOrganization(
  userId: string | null,
  organizationId: string,
) {
  if (!userId || !UUID.test(userId) || !UUID.test(organizationId)) return;
  try {
    localStorage.setItem(`dhumi.organization.${userId}`, organizationId);
  } catch {
    /* Storage is optional; the authorized URL still selects the organization. */
  }
}
