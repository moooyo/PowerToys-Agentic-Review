import { Skeleton } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { OperatorAccessEvents } from "@/components/OperatorAccess";
import { access } from "@/services/access";
import { useOperatorSession } from "@/state/session";
import { operatorSessionKey } from "./state";

function SessionQueries({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 10_000 } },
      }),
  );
  useEffect(() => () => queryClient.clear(), [queryClient]);
  return (
    <QueryClientProvider client={queryClient}>
      <OperatorAccessEvents />
      {children}
    </QueryClientProvider>
  );
}

export function OperatorSessionBoundary({ children }: { children: ReactNode }) {
  const { initialState, loading } = useOperatorSession();
  // This boundary wraps the entire route tree, including navigation and selection state.
  // Authentication refreshes must not display data cached for the previous session.
  if (loading && !initialState)
    return (
      <div role="status" aria-label="Verifying operator session">
        <Skeleton variant="rounded" height={200} />
      </div>
    );
  return (
    <>
      {loading ? (
        <div role="status" aria-label="Verifying operator session">
          <Skeleton variant="rounded" height={200} />
        </div>
      ) : null}
      <div id="dashboard-session" hidden={loading} inert={loading} aria-hidden={loading}>
        <SessionQueries key={operatorSessionKey(initialState, access.mode)}>
          {children}
        </SessionQueries>
      </div>
    </>
  );
}
