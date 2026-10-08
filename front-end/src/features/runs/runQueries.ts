import { useLocation } from "react-router";
import { selectedOrganization } from "../../api/organizationScope";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { runsApi, serviceExecutionApi } from "../../api/customerRuns";
import type { RunStatus } from "../../api/generated";
import { useSession } from "../../session/useSession";

const POLL_INTERVAL_MS = 2_000;
const TERMINAL_STATUSES = new Set<RunStatus>([
  "ready",
  "failed",
  "cancelled",
  "expired",
]);

export function useServiceQuery(serviceId: string | null) {
  const { identityEmail, isAuthenticated } = useSession();
  const organizationId = selectedOrganization(useLocation().pathname);
  return useQuery({
    queryKey: ["service", identityEmail, organizationId, serviceId],
    queryFn: () => serviceExecutionApi.get(serviceId as string, organizationId),
    enabled: isAuthenticated && !!organizationId && serviceId !== null,
    staleTime: 30_000,
  });
}

export function useCreateServiceMutation() {
  const organizationId = selectedOrganization(useLocation().pathname);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof serviceExecutionApi.create>[0]) =>
      serviceExecutionApi.create(input, organizationId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["services"] });
    },
  });
}

export function useRunsQuery(
  filters: { readonly status?: RunStatus; readonly serviceId?: string } = {},
) {
  const { identityEmail, isAuthenticated } = useSession();
  const organizationId = selectedOrganization(useLocation().pathname);
  return useQuery({
    queryKey: [
      "runs",
      identityEmail,
      organizationId,
      filters.status ?? "all",
      filters.serviceId ?? "all",
    ],
    queryFn: () => runsApi.list(filters, organizationId),
    enabled: isAuthenticated && !!organizationId,
    refetchInterval: (query) =>
      query.state.data?.data.some((run) => !TERMINAL_STATUSES.has(run.status))
        ? POLL_INTERVAL_MS
        : false,
  });
}

export function useRunQuery(runId: string | null) {
  const { identityEmail, isAuthenticated } = useSession();
  const organizationId = selectedOrganization(useLocation().pathname);
  return useQuery({
    queryKey: ["run", identityEmail, organizationId, runId],
    queryFn: () => runsApi.get(runId as string, organizationId),
    enabled: isAuthenticated && !!organizationId && runId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && TERMINAL_STATUSES.has(status) ? false : POLL_INTERVAL_MS;
    },
  });
}

export function useRunEventsQuery(runId: string | null, status?: RunStatus) {
  const { identityEmail, isAuthenticated } = useSession();
  const organizationId = selectedOrganization(useLocation().pathname);
  return useQuery({
    queryKey: ["run-events", identityEmail, organizationId, runId],
    queryFn: () => runsApi.events(runId as string, organizationId),
    enabled:
      isAuthenticated &&
      !!organizationId &&
      runId !== null &&
      status !== undefined,
    refetchInterval:
      status && TERMINAL_STATUSES.has(status) ? false : POLL_INTERVAL_MS,
  });
}

function useRunMutationInvalidation() {
  const queryClient = useQueryClient();
  return async (runId: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["run"] }),
      queryClient.invalidateQueries({ queryKey: ["run-events"] }),
      queryClient.invalidateQueries({ queryKey: ["runs"] }),
    ]);
    return runId;
  };
}

export function useCreateRunMutation() {
  const organizationId = selectedOrganization(useLocation().pathname);
  const invalidate = useRunMutationInvalidation();
  return useMutation({
    mutationFn: (request: {
      readonly serviceId: string;
      readonly input: Record<string, unknown>;
    }) => runsApi.create(request.serviceId, request.input, organizationId),
    onSuccess: (run) => invalidate(run.run_id),
  });
}

export function useCancelRunMutation() {
  const organizationId = selectedOrganization(useLocation().pathname);
  const invalidate = useRunMutationInvalidation();
  return useMutation({
    mutationFn: (runId: string) => runsApi.cancel(runId, organizationId),
    onSuccess: (run) => invalidate(run.id),
  });
}

export function useRetryRunMutation() {
  const organizationId = selectedOrganization(useLocation().pathname);
  const invalidate = useRunMutationInvalidation();
  return useMutation({
    mutationFn: (runId: string) => runsApi.retry(runId, organizationId),
    onSuccess: (run) => invalidate(run.run_id),
  });
}

export function useRunResultMutation() {
  const organizationId = selectedOrganization(useLocation().pathname);
  return useMutation({
    mutationFn: (request: Parameters<typeof runsApi.result>[0]) =>
      runsApi.result(request, organizationId),
  });
}
