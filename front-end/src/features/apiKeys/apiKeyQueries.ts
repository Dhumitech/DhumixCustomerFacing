import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { apiKeysApi } from "../../api/customerApiKeys";
import type { ApiKeyCreateInput } from "../../api/generated";
import { useSession } from "../../session/useSession";

const API_KEY_STALE_TIME_MS = 30_000;

export function useApiKeysQuery() {
  const { identityEmail, isAuthenticated } = useSession();
  return useInfiniteQuery({
    queryKey: ["api-keys", identityEmail],
    queryFn: ({ pageParam }) => apiKeysApi.list(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.page.has_more && lastPage.page.next_cursor
        ? lastPage.page.next_cursor
        : undefined,
    enabled: isAuthenticated,
    staleTime: API_KEY_STALE_TIME_MS,
  });
}

export function useCreateApiKeyMutation() {
  const { identityEmail } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ApiKeyCreateInput) => apiKeysApi.create(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["api-keys", identityEmail],
      });
    },
  });
}

export function useRevokeApiKeyMutation() {
  const { identityEmail } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) => apiKeysApi.revoke(keyId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["api-keys", identityEmail],
      });
    },
  });
}
