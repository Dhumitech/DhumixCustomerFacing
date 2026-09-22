import { useQuery } from "@tanstack/react-query";
import {
  catalogueApi,
  servicesApi,
  workspaceApi,
} from "../../api/customerReads";
import { useSession } from "../../session/useSession";

const READ_STALE_TIME_MS = 60_000;

export function useWorkspaceQuery() {
  const { identityEmail, isAuthenticated } = useSession();
  return useQuery({
    queryKey: ["workspace", identityEmail],
    queryFn: workspaceApi.get,
    enabled: isAuthenticated,
    staleTime: READ_STALE_TIME_MS,
  });
}

export function useScraperLibraryQuery() {
  const { identityEmail, isAuthenticated } = useSession();
  return useQuery({
    queryKey: ["catalogue", "scraper-library", identityEmail],
    queryFn: catalogueApi.listScraperLibrary,
    enabled: isAuthenticated,
    staleTime: READ_STALE_TIME_MS,
  });
}

export function useTemplateQuery(slug: string | null) {
  const { identityEmail, isAuthenticated } = useSession();
  return useQuery({
    queryKey: ["catalogue", "template", identityEmail, slug],
    queryFn: () => catalogueApi.getTemplate(slug as string),
    enabled: isAuthenticated && slug !== null,
    staleTime: READ_STALE_TIME_MS,
  });
}

export function useServicesQuery() {
  const { identityEmail, isAuthenticated } = useSession();
  return useQuery({
    queryKey: ["services", identityEmail],
    queryFn: servicesApi.list,
    enabled: isAuthenticated,
    staleTime: READ_STALE_TIME_MS,
  });
}
