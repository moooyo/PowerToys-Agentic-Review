import type { OperatorAccessContext, OperatorPrincipal } from "@agentic-review/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { accessContextMatches, contextAllows } from "@/components/OperatorAccess/state";

export function publicationAccessRefreshVerified(
  client: QueryClient,
  scope: {
    repositoryId: string;
    principal: OperatorPrincipal | null;
    identityKey: readonly unknown[];
    authenticationEpoch: number;
  },
): boolean {
  const prefix = ["operator-access", "context", ...scope.identityKey, scope.authenticationEpoch];
  const global = client.getQueryState<OperatorAccessContext>([...prefix, null]);
  const repository = client.getQueryState<OperatorAccessContext>([...prefix, scope.repositoryId]);
  return (
    global?.status === "success" &&
    global.fetchStatus === "idle" &&
    repository?.status === "success" &&
    repository.fetchStatus === "idle" &&
    accessContextMatches(global.data, scope.principal) &&
    accessContextMatches(repository.data, scope.principal, scope.repositoryId) &&
    contextAllows(repository.data, "read", scope.repositoryId)
  );
}
