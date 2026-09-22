import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type PropsWithChildren, useEffect, useRef } from "react";
import { SessionProvider } from "../session/SessionProvider";
import { useSession } from "../session/useSession";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false },
  },
});

function TenantQueryBoundary({ children }: PropsWithChildren) {
  const { identityEmail, isAuthenticated } = useSession();
  const previousIdentity = useRef(identityEmail);

  useEffect(() => {
    if (
      !isAuthenticated ||
      (previousIdentity.current !== null &&
        previousIdentity.current !== identityEmail)
    ) {
      queryClient.clear();
    }
    previousIdentity.current = identityEmail;
  }, [identityEmail, isAuthenticated]);

  return children;
}

export function AppProviders({ children }: PropsWithChildren) {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <TenantQueryBoundary>{children}</TenantQueryBoundary>
      </SessionProvider>
    </QueryClientProvider>
  );
}
