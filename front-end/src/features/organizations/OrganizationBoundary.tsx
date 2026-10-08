import { useEffect, type PropsWithChildren } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  organizationPath,
  selectedOrganization,
} from "../../api/organizationScope";
import { useSession } from "../../session/useSession";
import { BrandMark } from "../../components/ui/BrandMark";
import { OrganizationPanel } from "./OrganizationPanel";
import { useOrganizationsQuery } from "./organizationQueries";
import {
  preferenceUserId,
  rememberedOrganization,
  rememberOrganization,
} from "./organizationPreference";

/** Resolve active membership before mounting any organization resource query. */
export function OrganizationBoundary({ children }: PropsWithChildren) {
  const location = useLocation(),
    navigate = useNavigate();
  const { session } = useSession();
  const organizations = useOrganizationsQuery();
  const requested = selectedOrganization(location.pathname);
  const userId = preferenceUserId(session?.access_token);
  const items = organizations.data?.organizations ?? [];
  const valid = items.some((org) => org.id === requested);
  useEffect(() => {
    if (!organizations.isSuccess || items.length === 0) return;
    if (requested && valid) {
      rememberOrganization(userId, requested);
      return;
    }
    const preferred = rememberedOrganization(userId);
    const id = items.find((org) => org.id === preferred)?.id ?? items[0].id;
    const path = requested ? "/workspace/scrapers" : location.pathname;
    navigate(organizationPath(path, id), { replace: true });
  }, [
    organizations.isSuccess,
    items,
    requested,
    valid,
    userId,
    location.pathname,
    navigate,
  ]);
  if (organizations.isError)
    return (
      <main className="organization-entry">
        <BrandMark />
        <section className="organization-panel">
          <h1>Organizations could not be loaded</h1>
          <p>Check your connection and try again.</p>
          <button type="button" onClick={() => void organizations.refetch()}>
            Try again
          </button>
        </section>
      </main>
    );
  if (organizations.isPending || (items.length > 0 && !valid))
    return (
      <main className="organization-entry">
        <BrandMark />
        <p role="status">Opening your organization…</p>
      </main>
    );
  if (!valid)
    return (
      <main className="organization-entry">
        <BrandMark />
        <OrganizationPanel mandatory />
      </main>
    );
  return children;
}
