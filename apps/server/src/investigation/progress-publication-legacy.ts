import type { InvestigationReportRef, InvestigationTaskV1 } from "@agentic-review/contracts";
import { investigationContentDigest } from "@agentic-review/domain";
import type { InvestigationCommentDeliveries } from "./comment-deliveries.js";
import { requireCondition } from "./errors.js";
import type {
  CommentPublication,
  PublicationClaim,
  PublicationPolicySnapshot,
  PublicationRevision,
} from "./progress-publication.js";
import type {
  InvestigationProgressTrigger,
  ProgressReplyContext,
  ProgressReplyStage,
  ProgressReplyTemplates,
} from "./progress-reply-template.js";
import type { InvestigationStore } from "./store.js";
import type {
  InvestigationGitHubIdentity,
  InvestigationProgressCommentRequest,
  InvestigationRepositoryRecord,
  InvestigationWorkItemRecord,
} from "./types.js";

interface LegacyTransition {
  readonly sequence: number;
  readonly stage: ProgressReplyStage;
  readonly updatedAt: string;
  readonly failure: string | null;
  readonly reportRef: InvestigationReportRef | null;
  readonly reportDigest: string | null;
}

interface LegacyProgressReplyRecord {
  readonly id: string;
  readonly taskId: string;
  readonly taskKind: InvestigationTaskV1["kind"];
  readonly taskCreatedAt: string;
  readonly repository: InvestigationRepositoryRecord;
  readonly workItem: InvestigationWorkItemRecord;
  readonly trigger: InvestigationProgressTrigger;
  readonly settingsVersion: number;
  readonly templateVersion: number;
  readonly authorizedById: string;
  readonly templates: ProgressReplyTemplates;
  readonly resultTemplate: string;
  readonly received: LegacyTransition;
  readonly desired: LegacyTransition;
  readonly published: {
    readonly transition: LegacyTransition;
    readonly body: string;
    readonly externalId: string;
  } | null;
  readonly operation: {
    readonly transition: LegacyTransition;
    readonly request: InvestigationProgressCommentRequest;
    readonly dispatched: boolean;
  } | null;
  readonly githubIdentity: InvestigationGitHubIdentity | null;
  readonly state: "pending" | "sending" | "sent" | "blocked" | "failed" | "unknown";
  readonly reason: string | null;
  readonly pendingId: string;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly claim: PublicationClaim | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface MigrationOptions {
  readonly store: InvestigationStore;
  readonly deliveries: InvestigationCommentDeliveries;
  readonly now: () => Date;
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const date = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value));
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const nullableText = (value: unknown): boolean => value === null || typeof value === "string";

function transition(value: unknown): value is LegacyTransition {
  return (
    object(value) &&
    integer(value.sequence) &&
    ["received", "started", "failed", "completed"].includes(value.stage as string) &&
    date(value.updatedAt) &&
    nullableText(value.failure) &&
    nullableText(value.reportDigest) &&
    (value.reportRef === null ||
      (object(value.reportRef) &&
        text(value.reportRef.id) &&
        integer(value.reportRef.version) &&
        text(value.reportRef.digest)))
  );
}

function readLegacy(input: unknown): LegacyProgressReplyRecord {
  requireCondition(
    object(input),
    409,
    "progress_reply_legacy_invalid",
    "The retained progress comment record is invalid.",
  );
  const record = input;
  requireCondition(
    record.schemaVersion !== 2 &&
      text(record.id) &&
      text(record.taskId) &&
      ["pr-review", "issue-investigate"].includes(record.taskKind as string) &&
      date(record.taskCreatedAt) &&
      object(record.repository) &&
      text(record.repository.id) &&
      text(record.repository.fullName) &&
      integer(record.repository.githubRepositoryId) &&
      object(record.workItem) &&
      text(record.workItem.id) &&
      record.workItem.repositoryId === record.repository.id &&
      ["issue", "pull_request"].includes(record.workItem.kind as string) &&
      integer(record.workItem.number) &&
      record.workItem.number > 0 &&
      (record.workItem.githubWorkItemId === undefined ||
        (integer(record.workItem.githubWorkItemId) && record.workItem.githubWorkItemId > 0)) &&
      object(record.trigger) &&
      ["issues", "pull_request"].includes(record.trigger.eventName as string) &&
      integer(record.trigger.actorUserId) &&
      integer(record.trigger.assigneeUserId) &&
      integer(record.settingsVersion) &&
      integer(record.templateVersion) &&
      text(record.authorizedById) &&
      object(record.templates) &&
      ["received", "started", "failed", "completed"].every(
        (stage) => typeof (record.templates as Record<string, unknown>)[stage] === "string",
      ) &&
      typeof record.resultTemplate === "string" &&
      transition(record.received) &&
      transition(record.desired) &&
      (record.published === null ||
        (object(record.published) &&
          transition(record.published.transition) &&
          typeof record.published.body === "string" &&
          text(record.published.externalId))) &&
      (record.operation === null ||
        (object(record.operation) &&
          transition(record.operation.transition) &&
          object(record.operation.request) &&
          text(record.operation.request.marker) &&
          typeof record.operation.request.body === "string" &&
          nullableText(record.operation.request.externalId) &&
          nullableText(record.operation.request.previousBody) &&
          typeof record.operation.dispatched === "boolean")) &&
      (record.githubIdentity === null ||
        (object(record.githubIdentity) &&
          integer(record.githubIdentity.githubUserId) &&
          text(record.githubIdentity.githubLogin))) &&
      ["pending", "sending", "sent", "blocked", "failed", "unknown"].includes(
        record.state as string,
      ) &&
      nullableText(record.reason) &&
      text(record.pendingId) &&
      integer(record.attempts) &&
      typeof record.nextAttemptAt === "number" &&
      Number.isFinite(record.nextAttemptAt) &&
      (record.claim === null ||
        (object(record.claim) &&
          text(record.claim.ownerId) &&
          text(record.claim.token) &&
          typeof record.claim.expiresAt === "number" &&
          Number.isFinite(record.claim.expiresAt))) &&
      date(record.createdAt) &&
      date(record.updatedAt),
    409,
    "progress_reply_legacy_invalid",
    "The retained progress comment record is invalid.",
  );
  return structuredClone(record) as unknown as LegacyProgressReplyRecord;
}

function status(transition: LegacyTransition): NonNullable<ProgressReplyContext["status"]> {
  if (transition.stage === "received") return "queued";
  if (transition.stage === "started") return "running";
  if (transition.stage === "completed") return "completed";
  if (transition.failure === "The task was cancelled before completion.") return "cancelled";
  if (
    transition.failure ===
    "The task was interrupted before completion. It can be resumed when a worker is available."
  )
    return "interrupted";
  if (
    transition.failure ===
    "The task could not continue because a required prerequisite was unavailable. Review the task details before retrying."
  )
    return "blocked";
  return "failed";
}

/** Migrates retained evidence only. The caller persists the returned publication in the same transaction. */
export function migrateLegacyProgressReply(
  input: unknown,
  options: MigrationOptions,
): CommentPublication {
  const migrate = (): CommentPublication => {
    const legacy = readLegacy(input);
    const now = options.now().toISOString();
    const policy: PublicationPolicySnapshot = {
      settingsVersion: legacy.settingsVersion,
      templateVersion: legacy.templateVersion,
      templates: legacy.templates,
      resultTemplate: legacy.resultTemplate,
    };
    const revision = (value: LegacyTransition): PublicationRevision => {
      const digest = investigationContentDigest({ publicationId: legacy.id, transition: value });
      return {
        ...value,
        id: `legacy-revision:${digest}`,
        sourceEventId: `legacy-transition:${digest}`,
        context: {
          status: status(value),
          scope: { kind: legacy.workItem.kind },
          receivedAt: legacy.received.updatedAt,
          ...(value.stage === "started" ? { startedAt: value.updatedAt } : {}),
        },
        policy,
        legacy: true,
      };
    };
    const base = {
      commentId: legacy.id,
      mode: "progress" as const,
      repositoryId: legacy.repository.id,
      repositoryFullName: legacy.repository.fullName,
      workItemId: legacy.workItem.id,
      workItemKind: legacy.workItem.kind,
      workItemNumber: legacy.workItem.number,
      taskId: legacy.taskId,
      settingsVersion: legacy.settingsVersion,
      templateVersion: legacy.templateVersion,
      attemptNumber: 0,
    };
    const snapshotId = (kind: "published" | "operation") =>
      `comment-delivery:legacy:${investigationContentDigest({ publicationId: legacy.id, kind })}`;
    const published = legacy.published;
    const confirmed =
      published === null
        ? null
        : {
            revision: revision(published.transition),
            body: published.body,
            externalId: published.externalId,
            attemptId: options.deliveries.importLegacy({
              ...base,
              id: snapshotId("published"),
              reportId: published.transition.reportRef?.id ?? null,
              operation:
                published.transition.sequence === legacy.received.sequence ? "create" : "update",
              body: published.body,
              externalId: published.externalId,
              startedAt: published.transition.updatedAt,
              finishedAt: null,
              state: "succeeded",
              effect: "applied",
            }).id,
            // The old record retained the transition time, not the delivery confirmation time.
            confirmedAt: null,
          };
    const ambiguous =
      legacy.operation?.dispatched === true || ["sending", "unknown"].includes(legacy.state);
    const retainedOperation = legacy.operation;
    const operation =
      retainedOperation === null
        ? null
        : {
            revision: revision(retainedOperation.transition),
            request: retainedOperation.request,
            attemptId: ambiguous
              ? options.deliveries.importLegacy({
                  ...base,
                  id: snapshotId("operation"),
                  reportId: retainedOperation.transition.reportRef?.id ?? null,
                  operation: retainedOperation.request.externalId === null ? "create" : "update",
                  body: retainedOperation.request.body,
                  externalId: retainedOperation.request.externalId,
                  startedAt: retainedOperation.transition.updatedAt,
                  finishedAt: null,
                  state: "unknown",
                  effect: "unknown",
                }).id
              : null,
            dispatched: ambiguous,
            finished: ambiguous,
          };
    const state = ambiguous
      ? "unconfirmed"
      : legacy.state === "blocked"
        ? "paused"
        : legacy.state === "failed"
          ? "needs_attention"
          : confirmed !== null && confirmed.revision.sequence === legacy.desired.sequence
            ? "synced"
            : "pending";
    const retryable = state === "pending" || (state === "unconfirmed" && operation !== null);
    const grant = {
      authorizationEpoch: legacy.settingsVersion,
      authorizedById: legacy.authorizedById,
    };
    const retainedTransitions = [
      legacy.desired,
      published?.transition,
      retainedOperation?.transition,
    ];
    const firstStart = retainedTransitions.find(
      (value) => value?.stage === "started" && value.sequence === 1,
    );
    const lastAttempt = operation?.attemptId === null || operation === null ? confirmed : operation;
    return {
      schemaVersion: 2,
      id: legacy.id,
      receiptId: null,
      taskId: legacy.taskId,
      taskKind: legacy.taskKind,
      taskCreatedAt: legacy.taskCreatedAt,
      repository: legacy.repository,
      target: {
        id: legacy.workItem.id,
        repositoryId: legacy.workItem.repositoryId,
        kind: legacy.workItem.kind,
        number: legacy.workItem.number,
        ...(legacy.workItem.githubWorkItemId === undefined
          ? {}
          : { githubWorkItemId: legacy.workItem.githubWorkItemId }),
      },
      workItemId: legacy.workItem.id,
      trigger: legacy.trigger,
      marker:
        retainedOperation?.request.marker ?? `<!-- agentic-review-progress:${legacy.taskId} -->`,
      receivedAt: legacy.received.updatedAt,
      firstStartedAt: firstStart?.updatedAt ?? null,
      desired: revision(legacy.desired),
      confirmed,
      operation,
      githubIdentity: legacy.githubIdentity,
      grant,
      grantHistory: [{ ...grant, at: now, actorId: legacy.authorizedById, source: "legacy" }],
      state,
      reasonCode: ambiguous
        ? "dispatched_without_receipt"
        : legacy.state === "blocked"
          ? "legacy_blocked"
          : legacy.state === "failed"
            ? "legacy_failed"
            : null,
      requiresAttention: ["unconfirmed", "paused", "needs_attention"].includes(state),
      pendingId: legacy.pendingId,
      // Legacy processor attempts also included preparation and readback; they are not write counts.
      writeAttempts: 0,
      readAttempts: 0,
      nextAttemptAt: retryable ? legacy.nextAttemptAt : null,
      lastAttemptAt: lastAttempt?.revision.updatedAt ?? null,
      lastAttemptId: lastAttempt?.attemptId ?? null,
      nextPhaseAt: 0,
      reconcileRequested: false,
      claim: legacy.claim,
      historyAvailableSince: now,
      createdAt: legacy.createdAt,
      updatedAt: legacy.updatedAt,
    };
  };
  return options.store.inTransaction ? migrate() : options.store.transaction(migrate);
}
