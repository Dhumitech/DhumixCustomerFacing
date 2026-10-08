import { selectedOrganization } from "../../api/organizationScope";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "react-router";
import {
  catalogueApi,
  servicesApi,
  workspaceApi,
} from "../../api/customerReads";
import { useSession } from "../../session/useSession";

const READ_STALE_TIME_MS = 60_000;

export function useWorkspaceQuery() {
  const { identityEmail, isAuthenticated } = useSession();
  const organizationId = selectedOrganization(useLocation().pathname);
  return useQuery({
    queryKey: ["workspace", identityEmail, organizationId],
    queryFn: () => workspaceApi.get(organizationId),
    enabled: isAuthenticated && !!organizationId,
    staleTime: READ_STALE_TIME_MS,
  });
}

export function useScraperLibraryQuery() {
  const { identityEmail, isAuthenticated } = useSession();
  const organizationId = selectedOrganization(useLocation().pathname);
  return useQuery({
    queryKey: ["catalogue", "scraper-library", identityEmail, organizationId],
    queryFn: () => catalogueApi.listScraperLibrary(organizationId),
    enabled: isAuthenticated,
    staleTime: READ_STALE_TIME_MS,
  });
}

export function useTemplateQuery(slug: string | null) {
  const { identityEmail, isAuthenticated } = useSession();
  const organizationId = selectedOrganization(useLocation().pathname);
  return useQuery({
    queryKey: ["catalogue", "template", identityEmail, organizationId, slug],
    queryFn: () => catalogueApi.getTemplate(slug as string, organizationId),
    enabled: isAuthenticated && slug !== null,
    staleTime: READ_STALE_TIME_MS,
  });
}

export function useServicesQuery() {
  const { identityEmail, isAuthenticated } = useSession();
  const organizationId = selectedOrganization(useLocation().pathname);
  return useQuery({
    queryKey: ["services", identityEmail, organizationId],
    queryFn: () => servicesApi.list(organizationId),
    enabled: isAuthenticated && !!organizationId,
    staleTime: READ_STALE_TIME_MS,
  });
}
