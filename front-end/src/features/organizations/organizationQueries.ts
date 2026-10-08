import { useQuery } from "@tanstack/react-query";
import { organizationsApi } from "../../api/organizations";
import { useSession } from "../../session/useSession";
import { preferenceUserId } from "./organizationPreference";

export function useOrganizationsQuery() {
  const { session, identityEmail, isAuthenticated } = useSession();
  return useQuery({
    queryKey: [
      "organizations",
      preferenceUserId(session?.access_token) ?? identityEmail,
    ],
    queryFn: organizationsApi.list,
    enabled: isAuthenticated,
    staleTime: 30_000,
  });
}
