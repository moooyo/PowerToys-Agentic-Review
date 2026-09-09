import {
  defaultNotificationPageSize,
  getNotificationListIssues,
  getNotificationListQueryIssues,
  getNotificationOverviewIssues,
  getNotificationStateChangeIssues,
  getNotificationStateChangeRequestIssues,
  getNotificationSummaryIssues,
  maximumNotificationResponseUtf8Bytes,
  type NotificationListQuery,
  NotificationListQuerySchema,
  NotificationListResponseSchema,
  type NotificationOverviewQuery,
  NotificationOverviewQuerySchema,
  NotificationOverviewResponseSchema,
  type NotificationStateChangeRequest,
  NotificationStateChangeRequestSchema,
  NotificationStateChangeResponseSchema,
  NotificationSummaryResponseSchema,
  type OperatorPrincipal,
} from "@agentic-review/contracts";
import {
  DashboardHttpClient,
  type DashboardHttpClientOptions,
} from "../review-control/http-client";
import type { NotificationAdapter } from "./adapter";
import {
  notificationActor,
  notificationId,
  notificationRequest,
  notificationResponse,
} from "./validation";

const globalPath = "/api/v1/operator/notifications";
const repositoryPath = (repositoryId: string) =>
  `/api/v1/operator/repositories/${notificationId(repositoryId)}/notifications`;

export class HttpNotificationAdapter implements NotificationAdapter {
  readonly mode = "connected" as const;
  private readonly client: DashboardHttpClient;
  constructor(options: DashboardHttpClientOptions = {}) {
    this.client = new DashboardHttpClient(options);
  }
  private read(path: string, operation: string, signal?: AbortSignal) {
    return this.client.get(path, operation, {
      signal,
      maxResponseBytes: maximumNotificationResponseUtf8Bytes,
    });
  }
  async overview(
    input: NotificationOverviewQuery,
    principal: OperatorPrincipal,
    signal?: AbortSignal,
  ) {
    const operation = "read notification overview",
      actor = notificationActor(principal);
    const query = notificationRequest(NotificationOverviewQuerySchema, input, operation);
    const parameters = new URLSearchParams({
      page: String(query.page ?? 1),
      pageSize: String(query.pageSize ?? defaultNotificationPageSize),
    });
    return notificationResponse(
      NotificationOverviewResponseSchema,
      await this.read(`${globalPath}/overview?${parameters}`, operation, signal),
      operation,
      (value) => getNotificationOverviewIssues(value, { actor, query }),
    );
  }
  async summary(
    repositoryId: string | undefined,
    principal: OperatorPrincipal,
    signal?: AbortSignal,
  ) {
    const operation = "read notification summary",
      actor = notificationActor(principal);
    const suffix =
      repositoryId === undefined
        ? ""
        : `?${new URLSearchParams({ repositoryId: notificationId(repositoryId) })}`;
    return notificationResponse(
      NotificationSummaryResponseSchema,
      await this.read(`${globalPath}/summary${suffix}`, operation, signal),
      operation,
      (value) => getNotificationSummaryIssues(value, { actor, repositoryId: repositoryId ?? null }),
    );
  }
  async list(
    repositoryId: string,
    input: NotificationListQuery,
    principal: OperatorPrincipal,
    signal?: AbortSignal,
  ) {
    const operation = "read notifications",
      actor = notificationActor(principal);
    const query = notificationRequest(
      NotificationListQuerySchema,
      input,
      operation,
      getNotificationListQueryIssues,
    );
    const parameters = new URLSearchParams({
      limit: String(query.limit ?? defaultNotificationPageSize),
      state: query.state ?? "all",
      workItemKind: query.workItemKind ?? "all",
    });
    if (query.cursor !== undefined) parameters.set("cursor", query.cursor);
    return notificationResponse(
      NotificationListResponseSchema,
      await this.read(`${repositoryPath(repositoryId)}?${parameters}`, operation, signal),
      operation,
      (value) => getNotificationListIssues(value, { repositoryId, actor, query }),
    );
  }
  async change(
    repositoryId: string,
    input: NotificationStateChangeRequest,
    principal: OperatorPrincipal,
  ) {
    const operation = "update personal notification state",
      actor = notificationActor(principal);
    const request = notificationRequest(
      NotificationStateChangeRequestSchema,
      input,
      operation,
      getNotificationStateChangeRequestIssues,
    );
    return notificationResponse(
      NotificationStateChangeResponseSchema,
      await this.client.post(`${repositoryPath(repositoryId)}/state`, operation, request),
      operation,
      (value) => getNotificationStateChangeIssues(value, request, { repositoryId, actor }),
    );
  }
}
