import type {
  ConfigurationAuditAction,
  ConfigurationAuditEvent,
  ConfigurationAuditSummary,
  OperatorPrincipal,
} from "@agentic-review/contracts";

export type ConfigurationAuditScope =
  | { readonly kind: "repository"; readonly repositoryId: string }
  | { readonly kind: "global"; readonly templateId?: string };

export const configurationAuditQueryRoot = ["configuration-audit"] as const;

export const configurationAuditActionLabels: Record<ConfigurationAuditAction, string> = {
  created: "Repository created",
  updated: "Repository settings updated",
  bootstrapped: "Repository registered by bootstrap",
  template_created: "Prompt template created",
  draft_saved: "Prompt draft saved",
  prompt_published: "Prompt published",
  prompt_bound: "Prompt binding changed",
  profile_published: "Validation profile published",
  profile_bound: "Validation profile binding changed",
  bootstrap_registered: "Bootstrap prompt registered",
};

export function configurationAuditRevisionLabel(event: ConfigurationAuditSummary): string {
  if (event.version === null) return "No revision recorded";
  if (event.source === "repository") return `Repository revision ${event.version}`;
  if (event.action === "prompt_bound" || event.action === "profile_bound")
    return `Binding revision ${event.version}`;
  if (event.action === "profile_published") return `Profile version ${event.version}`;
  return `Template revision ${event.version}`;
}

export function configurationAuditRowKey(event: ConfigurationAuditSummary): string {
  return JSON.stringify([event.source, event.id]);
}

export function configurationAuditMatchesSummary(
  event: ConfigurationAuditEvent,
  summary: ConfigurationAuditSummary,
): boolean {
  return (
    event.id === summary.id &&
    event.source === summary.source &&
    event.action === summary.action &&
    event.entityId === summary.entityId &&
    event.repositoryId === summary.repositoryId &&
    event.actor.issuer === summary.actor.issuer &&
    event.actor.subject === summary.actor.subject &&
    event.createdAt === summary.createdAt &&
    event.version === summary.version
  );
}

export function configurationAuditScopeKey(scope: ConfigurationAuditScope) {
  return scope.kind === "repository"
    ? (["repository", scope.repositoryId] as const)
    : (["global", scope.templateId ?? null] as const);
}

export function configurationAuditSessionKey(
  mode: string,
  scope: ConfigurationAuditScope,
  principal: OperatorPrincipal,
  session: string,
) {
  return [
    ...configurationAuditQueryRoot,
    mode,
    ...configurationAuditScopeKey(scope),
    principal.issuer,
    principal.subject,
    session,
  ] as const;
}

export function configurationAuditListKey(
  mode: string,
  scope: ConfigurationAuditScope,
  principal: OperatorPrincipal,
  session: string,
  page: number,
  pageSize: number,
) {
  return [
    ...configurationAuditSessionKey(mode, scope, principal, session),
    "list",
    page,
    pageSize,
  ] as const;
}

export function configurationAuditDetailKey(
  mode: string,
  scope: ConfigurationAuditScope,
  principal: OperatorPrincipal,
  session: string,
  summary: ConfigurationAuditSummary,
) {
  return [
    ...configurationAuditSessionKey(mode, scope, principal, session),
    "detail",
    summary.source,
    summary.id,
    summary.action,
    summary.entityId,
    summary.repositoryId,
    summary.actor.issuer,
    summary.actor.subject,
    summary.createdAt,
    summary.version,
  ] as const;
}
