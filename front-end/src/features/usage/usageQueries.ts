import { selectedOrganization } from "../../api/organizationScope";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { type UsageTimeRange, usageApi } from "../../api/customerUsage";
import { useSession } from "../../session/useSession";

const USAGE_STALE_TIME_MS = 30_000;

export function useUsageSummaryQuery(range: UsageTimeRange) {
  const { identityEmail, isAuthenticated } = useSession();
  const organizationId = selectedOrganization();
  return useQuery({
    queryKey: ["usage", "summary", identityEmail, organizationId, range.from, range.to],
    queryFn: () => usageApi.summary(range),
    enabled: isAuthenticated && !!organizationId,
    staleTime: USAGE_STALE_TIME_MS,
  });
}

export function useUsageEventsQuery(range: UsageTimeRange) {
  const { identityEmail, isAuthenticated } = useSession();
  const organizationId = selectedOrganization();
  return useInfiniteQuery({
    queryKey: ["usage", "events", identityEmail, organizationId, range.from, range.to],
    queryFn: ({ pageParam }) =>
      usageApi.events({
        ...range,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.page.has_more && lastPage.page.next_cursor
        ? lastPage.page.next_cursor
        : undefined,
    enabled: isAuthenticated && !!organizationId,
    staleTime: USAGE_STALE_TIME_MS,
  });
}
