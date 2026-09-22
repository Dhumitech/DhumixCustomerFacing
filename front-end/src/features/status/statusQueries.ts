import { useQuery } from "@tanstack/react-query";
import { platformStatusApi } from "../../api/platformStatus";

const STATUS_REFRESH_INTERVAL_MS = 60_000;

export function usePlatformStatusQuery() {
  return useQuery({
    queryKey: ["platform-status"],
    queryFn: platformStatusApi.get,
    staleTime: STATUS_REFRESH_INTERVAL_MS,
    refetchInterval: STATUS_REFRESH_INTERVAL_MS,
  });
}
