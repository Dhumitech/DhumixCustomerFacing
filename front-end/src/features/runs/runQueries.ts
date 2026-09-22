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
  return useQuery({
    queryKey: ["service", identityEmail, serviceId],
    queryFn: () => serviceExecutionApi.get(serviceId as string),
    enabled: isAuthenticated && serviceId !== null,
    staleTime: 30_000,
  });
}

export function useCreateServiceMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: serviceExecutionApi.create,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["services"] });
    },
  });
}

export function useRunsQuery(
  filters: { readonly status?: RunStatus; readonly serviceId?: string } = {},
) {
  const { identityEmail, isAuthenticated } = useSession();
  return useQuery({
    queryKey: [
      "runs",
      identityEmail,
      filters.status ?? "all",
      filters.serviceId ?? "all",
    ],
    queryFn: () => runsApi.list(filters),
    enabled: isAuthenticated,
    refetchInterval: (query) =>
      query.state.data?.data.some((run) => !TERMINAL_STATUSES.has(run.status))
        ? POLL_INTERVAL_MS
        : false,
  });
}

export function useRunQuery(runId: string | null) {
  const { identityEmail, isAuthenticated } = useSession();
  return useQuery({
    queryKey: ["run", identityEmail, runId],
    queryFn: () => runsApi.get(runId as string),
    enabled: isAuthenticated && runId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && TERMINAL_STATUSES.has(status) ? false : POLL_INTERVAL_MS;
    },
  });
}

export function useRunEventsQuery(runId: string | null, status?: RunStatus) {
  const { identityEmail, isAuthenticated } = useSession();
  return useQuery({
    queryKey: ["run-events", identityEmail, runId],
    queryFn: () => runsApi.events(runId as string),
    enabled: isAuthenticated && runId !== null && status !== undefined,
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
  const invalidate = useRunMutationInvalidation();
  return useMutation({
    mutationFn: (request: {
      readonly serviceId: string;
      readonly input: Record<string, unknown>;
    }) => runsApi.create(request.serviceId, request.input),
    onSuccess: (run) => invalidate(run.run_id),
  });
}

export function useCancelRunMutation() {
  const invalidate = useRunMutationInvalidation();
  return useMutation({
    mutationFn: runsApi.cancel,
    onSuccess: (run) => invalidate(run.id),
  });
}

export function useRetryRunMutation() {
  const invalidate = useRunMutationInvalidation();
  return useMutation({
    mutationFn: runsApi.retry,
    onSuccess: (run) => invalidate(run.run_id),
  });
}

export function useRunResultMutation() {
  return useMutation({ mutationFn: runsApi.result });
}
