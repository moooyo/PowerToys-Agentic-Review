import type {
  NotificationList,
  NotificationListQuery,
  NotificationOverview,
  NotificationOverviewQuery,
  NotificationStateChange,
  NotificationStateChangeRequest,
  NotificationSummary,
  OperatorPrincipal,
} from "@agentic-review/contracts";

export interface NotificationAdapter {
  readonly mode: "connected";
  overview(
    query: NotificationOverviewQuery,
    actor: OperatorPrincipal,
    signal?: AbortSignal,
  ): Promise<NotificationOverview>;
  summary(
    repositoryId: string | undefined,
    actor: OperatorPrincipal,
    signal?: AbortSignal,
  ): Promise<NotificationSummary>;
  list(
    repositoryId: string,
    query: NotificationListQuery,
    actor: OperatorPrincipal,
    signal?: AbortSignal,
  ): Promise<NotificationList>;
  change(
    repositoryId: string,
    request: NotificationStateChangeRequest,
    actor: OperatorPrincipal,
  ): Promise<NotificationStateChange>;
}
