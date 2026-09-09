import type { OperatorPrincipal } from "@agentic-review/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Space } from "antd";
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import type { EvaluationAdapter } from "@/services/evaluations";
import { accessDenied, evaluationQueryRoot, OriginalMutation } from "./state";

export interface EvaluationPageContext {
  readonly api: EvaluationAdapter;
  readonly session: string;
  readonly repositoryId: string;
  readonly principal: OperatorPrincipal;
  readonly readable: boolean;
  readonly canConfigure: boolean;
  readonly allowsConfigure: boolean;
  readonly invalidateAccess: () => void;
}
export const EvaluationContext = createContext<EvaluationPageContext | null>(null);
export function useEvaluationPage() {
  const value = useContext(EvaluationContext);
  if (!value) throw new Error("Evaluation management requires its repository scope.");
  return value;
}
export function useEvaluationQuery<T>(
  key: readonly unknown[],
  load: (signal: AbortSignal) => Promise<T>,
  enabled = true,
  pollingInterval: number | false = false,
) {
  const page = useEvaluationPage();
  const query = useQuery({
    queryKey: [...evaluationQueryRoot, page.session, ...key],
    enabled: page.readable && enabled,
    queryFn: async ({ signal }) => {
      try {
        return await load(signal);
      } catch (error) {
        if (accessDenied(error)) page.invalidateAccess();
        throw error;
      }
    },
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchInterval:
      page.readable && enabled && pollingInterval
        ? (current) => (current.state.status === "error" ? false : pollingInterval)
        : false,
    refetchIntervalInBackground: false,
  });
  return { ...query, data: page.readable && !query.isError ? query.data : undefined };
}
export function useRefreshEvaluations() {
  const page = useEvaluationPage(),
    client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: [...evaluationQueryRoot, page.session] });
  };
}
export function useOriginalMutation<T, R>(
  execute: (request: T) => Promise<R>,
  success: (result: R) => void,
) {
  const page = useEvaluationPage();
  const owner = useMemo(() => new OriginalMutation<T>(), []);
  const state = useSyncExternalStore(owner.subscribe, owner.snapshot, owner.snapshot);
  useEffect(() => {
    owner.activate();
    return () => owner.dispose();
  }, [owner]);
  const submit = (request: T) => {
    if (!page.canConfigure) return;
    void owner.run(request, execute, success, page.invalidateAccess);
  };
  return {
    ...state,
    submit,
    reset: () => owner.reset(),
    retry: () => {
      if (state.request) submit(state.request);
    },
  };
}
export function MutationNotice({
  mutation,
  conflictTitle = "The saved revision changed",
  conflictDescription = "Your editor is preserved. Reload the saved draft before submitting another revision.",
}: {
  mutation: {
    request: unknown;
    busy: boolean;
    error: string | null;
    conflict: boolean;
    retry: () => void;
  };
  conflictTitle?: string;
  conflictDescription?: string;
}) {
  const page = useEvaluationPage();
  if (!mutation.error) return null;
  return (
    <Alert
      showIcon
      type={mutation.conflict ? "warning" : "error"}
      title={
        mutation.conflict
          ? conflictTitle
          : mutation.request
            ? "The result is not confirmed"
            : "The change was rejected"
      }
      description={
        <Space orientation="vertical">
          <span>{mutation.error}</span>
          {mutation.request ? (
            <span>
              The original change ID and content are preserved. Retry to confirm that same request.
            </span>
          ) : mutation.conflict ? (
            <span>{conflictDescription}</span>
          ) : null}
        </Space>
      }
      action={
        mutation.request ? (
          <Button disabled={!page.canConfigure} loading={mutation.busy} onClick={mutation.retry}>
            Retry original request
          </Button>
        ) : undefined
      }
    />
  );
}
