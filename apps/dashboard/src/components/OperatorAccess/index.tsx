import type { OperatorRepositoryPermission } from "@agentic-review/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useModel } from "@umijs/max";
import { Alert, Button, Skeleton } from "antd";
import { type ReactNode, useEffect } from "react";
import { access } from "@/services/access";
import { ReviewControlHttpError } from "@/services/review-control/errors";
import { OPERATOR_ACCESS_DENIED_EVENT } from "@/services/review-control/http-client";
import { accessContextMatches, contextAllows, samePrincipal } from "./state";

export function useOperatorAccess(repositoryId?: string) {
  const { initialState, setInitialState, loading } = useModel("@@initialState");
  const principal = initialState?.currentUser.principal ?? null;
  const authenticated = initialState?.authenticated === true && principal !== null;
  const identityKey = [access.mode, principal?.issuer ?? null, principal?.subject ?? null];
  const globalQuery = useQuery({
    queryKey: [
      "operator-access",
      "context",
      ...identityKey,
      initialState?.authenticationEpoch ?? 0,
      null,
    ],
    queryFn: () => access.context(),
    enabled: authenticated,
    initialData: accessContextMatches(initialState?.operatorAccess, principal)
      ? (initialState?.operatorAccess ?? undefined)
      : undefined,
    initialDataUpdatedAt: initialState?.accessResolvedAt ?? 0,
    staleTime: 10_000,
    retry: false,
    refetchOnWindowFocus: true,
  });
  const globalContext =
    !globalQuery.isError && accessContextMatches(globalQuery.data, principal)
      ? globalQuery.data
      : undefined;
  useEffect(() => {
    if (!authenticated || loading || globalQuery.isPending) return;
    const verified = globalContext ?? null;
    void setInitialState((previous) => {
      if (
        !previous ||
        !samePrincipal(previous.currentUser.principal, principal) ||
        previous.operatorAccess === verified
      )
        return previous;
      return { ...previous, operatorAccess: verified, accessResolvedAt: globalQuery.dataUpdatedAt };
    });
  }, [
    loading,
    authenticated,
    globalContext,
    globalQuery.isPending,
    globalQuery.dataUpdatedAt,
    principal,
    setInitialState,
  ]);
  const repositoryQuery = useQuery({
    queryKey: [
      "operator-access",
      "context",
      ...identityKey,
      initialState?.authenticationEpoch ?? 0,
      repositoryId ?? "not-selected",
    ],
    queryFn: () => access.context(repositoryId),
    enabled: authenticated && globalContext !== undefined && repositoryId !== undefined,
    staleTime: 10_000,
    retry: false,
    refetchOnWindowFocus: true,
  });
  const context =
    repositoryId === undefined
      ? globalContext
      : globalContext &&
          !repositoryQuery.isError &&
          accessContextMatches(repositoryQuery.data, principal, repositoryId)
        ? repositoryQuery.data
        : undefined;
  const query = repositoryId === undefined ? globalQuery : repositoryQuery;
  const mismatch =
    (globalQuery.isSuccess && !accessContextMatches(globalQuery.data, principal)) ||
    (repositoryId !== undefined &&
      repositoryQuery.isSuccess &&
      !accessContextMatches(repositoryQuery.data, principal, repositoryId));
  const error =
    globalQuery.error ??
    (repositoryId === undefined ? null : repositoryQuery.error) ??
    (mismatch
      ? new Error("The access response does not match the signed-in operator and repository.")
      : null);
  const ready = authenticated && context !== undefined;
  const checking =
    globalQuery.isFetching || (repositoryId !== undefined && repositoryQuery.isFetching);
  const allows = (permission: OperatorRepositoryPermission) =>
    ready && contextAllows(context, permission, repositoryId);
  return {
    ready,
    checking,
    authenticated,
    error,
    principal,
    identityKey,
    context,
    platformAdministrator: ready && context?.platformAdministrator === true,
    allows,
    can: (permission: OperatorRepositoryPermission) => !checking && allows(permission),
    refresh: async () => {
      await globalQuery.refetch();
      if (repositoryId !== undefined) await repositoryQuery.refetch();
    },
    pending: authenticated && !error && (globalQuery.isPending || query.isPending),
  };
}

export function OperatorAccessGate({
  repositoryId,
  permission = "read",
  platformOnly = false,
  children,
}: {
  repositoryId?: string;
  permission?: OperatorRepositoryPermission;
  platformOnly?: boolean;
  children: ReactNode;
}) {
  const accessState = useOperatorAccess(repositoryId);
  if (accessState.pending)
    return <Skeleton active title={{ width: 220 }} paragraph={{ rows: 3 }} />;
  if (
    accessState.ready &&
    (platformOnly ? accessState.platformAdministrator : accessState.allows(permission))
  ) {
    return children;
  }
  const denied =
    accessState.error instanceof ReviewControlHttpError &&
    [403, 404].includes(accessState.error.status);
  return (
    <Alert
      showIcon
      type={accessState.error && !denied ? "error" : "info"}
      title={accessState.error && !denied ? "Access could not be verified" : "Access required"}
      description={
        accessState.error && !denied
          ? "Permissions are unavailable. Refresh to verify access before continuing."
          : platformOnly
            ? "This page requires a platform administrator. Platform access is managed in the server configuration."
            : permission === "read"
              ? "You do not have access to this repository. Ask a repository or platform administrator for access."
              : `This action requires ${permission === "review" ? "reviewer" : permission === "configure" ? "maintainer" : "repository administrator"} access or higher.`
      }
      action={
        <Button loading={accessState.checking} onClick={() => void accessState.refresh()}>
          Refresh access
        </Button>
      }
    />
  );
}

export function OperatorAccessEvents() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ["operator-access"] });
      void queryClient.invalidateQueries({ queryKey: ["managed-repositories"] });
    };
    globalThis.addEventListener(OPERATOR_ACCESS_DENIED_EVENT, refresh);
    return () => globalThis.removeEventListener(OPERATOR_ACCESS_DENIED_EVENT, refresh);
  }, [queryClient]);
  return null;
}
