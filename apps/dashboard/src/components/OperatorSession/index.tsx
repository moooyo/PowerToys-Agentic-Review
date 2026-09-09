import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useModel } from "@umijs/max";
import { Skeleton } from "antd";
import { type ReactNode, useEffect, useState } from "react";
import { OperatorAccessEvents } from "@/components/OperatorAccess";
import { access } from "@/services/access";
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
  const { initialState, loading } = useModel("@@initialState");
  // This boundary wraps the entire route tree, including navigation and selection state.
  // Authentication refreshes must not display data cached for the previous session.
  if (loading && !initialState)
    return (
      <div role="status" aria-label="Verifying operator session">
        <Skeleton active paragraph={{ rows: 4 }} />
      </div>
    );
  return (
    <>
      {loading ? (
        <div role="status" aria-label="Verifying operator session">
          <Skeleton active paragraph={{ rows: 4 }} />
        </div>
      ) : null}
      <div hidden={loading} inert={loading} aria-hidden={loading}>
        <SessionQueries key={operatorSessionKey(initialState, access.mode)}>
          {children}
        </SessionQueries>
      </div>
    </>
  );
}
