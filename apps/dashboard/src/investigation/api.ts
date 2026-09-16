import {
  ActionContextV1Schema,
  DateTimeSchema,
  EntityIdSchema,
  InvestigationActionIntentV1Schema,
  InvestigationArtifactMetadataV1Schema,
  InvestigationAttemptV1Schema,
  type InvestigationBudget,
  type InvestigationCreateActionIntentRequest,
  type InvestigationCreateTaskRequestV1,
  InvestigationFindingsPageV1Schema,
  InvestigationLoopCheckpointV1Schema,
  InvestigationReportHeaderV1Schema,
  InvestigationRepositorySchema,
  InvestigationResultV1Schema,
  InvestigationSubjectV1Schema,
  InvestigationTaskV1Schema,
  Sha256Schema,
} from "@agentic-review/contracts";
import { type Static, Type } from "@sinclair/typebox";
import { authApi } from "./auth-api";
import { createSampleInvestigationApi } from "./sample-adapter";
import { createSessionScopedSampleApi } from "./sample-workspace-access";
import {
  createHttpTransport,
  type InvestigationTransport,
  notifyInvestigationSessionExpired,
  queryString,
} from "./transport";

const object = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
export const RepositorySchema = InvestigationRepositorySchema;
export const WorkItemSchema = object({
  id: EntityIdSchema,
  repositoryId: EntityIdSchema,
  kind: Type.Union([Type.Literal("pull_request"), Type.Literal("issue")]),
  number: Type.Integer({ minimum: 1 }),
  title: Type.String({ minLength: 1 }),
  body: Type.String(),
  state: Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("merged")]),
  subject: InvestigationSubjectV1Schema,
  updatedAt: DateTimeSchema,
});
export type Repository = Static<typeof RepositorySchema>;
export type WorkItem = Static<typeof WorkItemSchema>;

const githubUserId = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const RepositoryWebhookSettingsSchema = object({
  repositoryId: EntityIdSchema,
  enabled: Type.Boolean(),
  reviewerUserId: Type.Union([githubUserId, Type.Null()]),
  allowedActorUserIds: Type.Array(githubUserId, { uniqueItems: true, maxItems: 1024 }),
  version: Type.Integer({ minimum: 0 }),
  receiverConfigured: Type.Boolean(),
});
export type RepositoryWebhookSettings = Static<typeof RepositoryWebhookSettingsSchema>;
export type UpdateRepositoryWebhookSettingsInput = Pick<
  RepositoryWebhookSettings,
  "version" | "enabled" | "reviewerUserId" | "allowedActorUserIds"
>;

export const TaskDetailSchema = object({
  task: InvestigationTaskV1Schema,
  attempts: Type.Array(InvestigationAttemptV1Schema),
  checkpoint: Type.Union([InvestigationLoopCheckpointV1Schema, Type.Null()]),
  latestReport: Type.Union([InvestigationReportHeaderV1Schema, Type.Null()]),
  children: Type.Array(InvestigationTaskV1Schema),
});
export type TaskDetail = Static<typeof TaskDetailSchema>;

export type CreateTaskInput = InvestigationCreateTaskRequestV1;
export type PrepareActionInput = InvestigationCreateActionIntentRequest;

export function createInvestigationApi(transport: InvestigationTransport) {
  return {
    repositories: () =>
      transport("/api/repositories", object({ items: Type.Array(RepositorySchema) })),
    repositoryWebhookSettings: (repositoryId: string) =>
      transport(
        `/api/repositories/${encodeURIComponent(repositoryId)}/webhook-settings`,
        RepositoryWebhookSettingsSchema,
      ),
    updateRepositoryWebhookSettings: (
      repositoryId: string,
      input: UpdateRepositoryWebhookSettingsInput,
    ) =>
      transport(
        `/api/repositories/${encodeURIComponent(repositoryId)}/webhook-settings`,
        RepositoryWebhookSettingsSchema,
        { method: "PUT", body: input },
      ),
    workItems: (repositoryId?: string, kind?: "pull_request" | "issue") =>
      transport(
        `/api/work-items${queryString({ repositoryId, kind })}`,
        object({ items: Type.Array(WorkItemSchema) }),
      ),
    workItem: (id: string) =>
      transport(`/api/work-items/${encodeURIComponent(id)}`, WorkItemSchema),
    importWorkItem: (
      repositoryId: string,
      input: { kind: "pull_request" | "issue"; number: number },
    ) =>
      transport(
        `/api/repositories/${encodeURIComponent(repositoryId)}/import-work-item`,
        object({
          workItem: WorkItemSchema,
          snapshotRef: object({ id: EntityIdSchema, digest: Sha256Schema }),
          commentsCount: Type.Integer({ minimum: 0 }),
        }),
        { method: "POST", body: input },
      ),
    tasks: (workItemId?: string) =>
      transport(
        `/api/tasks${queryString({ workItemId })}`,
        object({ items: Type.Array(InvestigationTaskV1Schema) }),
      ),
    task: (id: string) => transport(`/api/tasks/${encodeURIComponent(id)}`, TaskDetailSchema),
    createTask: (input: CreateTaskInput) =>
      transport("/api/tasks", InvestigationTaskV1Schema, { method: "POST", body: input }),
    resumeTask: (id: string, idempotencyKey: string, budget?: InvestigationBudget) =>
      transport(`/api/tasks/${encodeURIComponent(id)}/resume`, InvestigationTaskV1Schema, {
        method: "POST",
        body: { idempotencyKey, ...(budget ? { budget } : {}) },
      }),
    cancelTask: (id: string) =>
      transport(`/api/tasks/${encodeURIComponent(id)}/cancel`, InvestigationTaskV1Schema, {
        method: "POST",
        body: {},
      }),
    report: (id: string) =>
      transport(`/api/reports/${encodeURIComponent(id)}`, InvestigationReportHeaderV1Schema),
    findings: (id: string, cursor?: string, limit = 25) =>
      transport(
        `/api/reports/${encodeURIComponent(id)}/findings${queryString({ cursor, limit })}`,
        InvestigationFindingsPageV1Schema,
      ),
    exportReport: (id: string) =>
      transport(`/api/reports/${encodeURIComponent(id)}/export`, InvestigationResultV1Schema),
    artifact: (id: string, signal?: AbortSignal) =>
      transport(`/api/artifacts/${encodeURIComponent(id)}`, InvestigationArtifactMetadataV1Schema, {
        signal,
      }),
    actionContext: (workItemId: string, reportId?: string) =>
      transport(
        `/api/work-items/${encodeURIComponent(workItemId)}/action-context${queryString({ reportId })}`,
        ActionContextV1Schema,
      ),
    prepareAction: (input: PrepareActionInput) =>
      transport("/api/action-intents", InvestigationActionIntentV1Schema, {
        method: "POST",
        body: input,
      }),
    actionIntent: (id: string) =>
      transport(`/api/action-intents/${encodeURIComponent(id)}`, InvestigationActionIntentV1Schema),
    confirmAction: (id: string, version: number, payloadDigest: string) =>
      transport(
        `/api/action-intents/${encodeURIComponent(id)}/confirm`,
        InvestigationActionIntentV1Schema,
        { method: "POST", body: { version, payloadDigest } },
      ),
    reconcileAction: (id: string) =>
      transport(
        `/api/action-intents/${encodeURIComponent(id)}/reconcile`,
        InvestigationActionIntentV1Schema,
        { method: "POST", body: {} },
      ),
  };
}

export type InvestigationApi = ReturnType<typeof createInvestigationApi>;
export const investigationApi: InvestigationApi =
  process.env.NODE_ENV === "development"
    ? createSessionScopedSampleApi(
        createSampleInvestigationApi(),
        () => authApi.session(),
        notifyInvestigationSessionExpired,
      )
    : createInvestigationApi(createHttpTransport());
