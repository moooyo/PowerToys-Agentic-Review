import type {
  OperatorAccessContext,
  OperatorPrincipal,
  OperatorRepositoryPermission,
} from "@agentic-review/contracts";

export const samePrincipal = (left: OperatorPrincipal | null, right: OperatorPrincipal | null) =>
  left !== null && right !== null && left.issuer === right.issuer && left.subject === right.subject;

export function accessContextMatches(
  context: OperatorAccessContext | undefined | null,
  principal: OperatorPrincipal | null,
  repositoryId?: string,
): context is OperatorAccessContext {
  return (
    context != null &&
    samePrincipal(context.principal, principal) &&
    (repositoryId === undefined
      ? context.repository === null
      : context.repository?.repositoryId === repositoryId)
  );
}

export function contextAllows(
  context: OperatorAccessContext | undefined | null,
  permission: OperatorRepositoryPermission,
  repositoryId?: string,
): boolean {
  if (!context) return false;
  if (context.platformAdministrator) return true;
  // The global context confirms a session, not membership of any particular repository.
  if (repositoryId === undefined) return permission === "read" && context.repository === null;
  return (
    context.repository?.repositoryId === repositoryId &&
    context.repository.permissions.includes(permission)
  );
}
