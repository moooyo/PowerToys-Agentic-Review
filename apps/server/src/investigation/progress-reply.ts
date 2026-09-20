import { randomUUID } from "node:crypto";
import type {
  InvestigationAttemptV1,
  InvestigationCommentCommand,
  InvestigationCommentPublicationSummary,
  InvestigationLoopCheckpointV1,
  InvestigationResultV1,
  InvestigationTaskV1,
  InvestigationUsageSummary,
} from "@agentic-review/contracts";
import { investigationContentDigest } from "@agentic-review/domain";
import type {
  AutomaticReplyPolicy,
  InvestigationAutomaticReplySettings,
} from "./auto-reply-settings.js";
import {
  type RenderedAutomaticReply,
  renderAutomaticReplyParts,
  renderAutomaticReplySummaryParts,
} from "./auto-reply-template.js";
import { InvestigationCommentDeliveries } from "./comment-deliveries.js";
import { InvestigationRequestError, requireCondition } from "./errors.js";
import { inspectLegacyConversationReplies } from "./legacy-conversation-replies.js";
import {
  type CommentPublication,
  classifyDelivery,
  publicationEqual as equal,
  type PublicationClaim,
  type PublicationOperation,
  type PublicationRevision,
  problemState,
  publicationPolicy,
  publicationReason,
  publicationStage,
  stoppedCopy,
} from "./progress-publication.js";
import { migrateLegacyProgressReply } from "./progress-publication-legacy.js";
import {
  type InvestigationProgressTrigger,
  type ProgressReplyContext,
  type ProgressReplyStage,
  renderProgressReply,
} from "./progress-reply-template.js";
import type { InvestigationStore } from "./store.js";
import type {
  InvestigationActionTransport,
  InvestigationCommentTarget,
  InvestigationOperatorPrincipal,
  InvestigationProgressCommentDelivery,
  InvestigationRepositoryRecord,
  InvestigationWorkItemRecord,
} from "./types.js";
import {
  investigationUsagePublicationPendingKey,
  investigationUsagePublicationPendingPrefix,
} from "./usage-ledger.js";
import type { AssignmentProgressState, TrustedAssignmentAdmission } from "./webhook-intake.js";

export type ProgressReplyState = "pending" | "sending" | "sent" | "blocked" | "failed" | "unknown";
/** Compatibility view. New clients use summaries and the shared delivery history. */
export interface ProgressReplyReceipt {
  readonly id: string;
  readonly reportId: string | null;
  readonly taskId: string | null;
  readonly workItemId: string;
  readonly workItemKind: "pull_request" | "issue";
  readonly workItemNumber: number;
  readonly stage: ProgressReplyStage;
  readonly state: ProgressReplyState;
  readonly body: string | null;
  readonly externalId: string | null;
  readonly reason: string | null;
  readonly settingsVersion: number;
  readonly templateVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface InvestigationProgressRepliesOptions {
  readonly store: InvestigationStore;
  readonly settings: Pick<InvestigationAutomaticReplySettings, "policy">;
  readonly transport: InvestigationActionTransport | undefined;
  readonly deliveries?: InvestigationCommentDeliveries;
  readonly isAssignmentAuthorized?: (admission: TrustedAssignmentAdmission) => boolean;
  readonly usageSummary?: (taskId: string) => InvestigationUsageSummary;
  readonly prepareReportMedia?: (
    report: InvestigationResultV1,
    task: InvestigationTaskV1,
  ) => Promise<string>;
  readonly resolveOperator: (id: string) => InvestigationOperatorPrincipal | null;
  readonly enableExternalWrites: boolean;
  readonly now?: () => Date;
  readonly retryDelayMs?: number;
  readonly leaseDurationMs?: number;
  readonly maximumAttempts?: number;
  readonly phaseIntervalMs?: number;
  readonly usageIntervalMs?: number;
  readonly onError?: (code: string) => void;
}
interface Reference {
  readonly recordId: string;
  readonly admission?: TrustedAssignmentAdmission;
  readonly attachedTaskId?: string;
}
const oldTaskId = (taskId: string) => `progress-reply:task:${taskId}`;
const taskIndex = (taskId: string) => `progress-reply:task-index:${taskId}`;
const assignmentIndex = (receiptId: string) =>
  `progress-reply:assignment-index:${investigationContentDigest(receiptId)}`;
const repositoryPrefix = (id: string) =>
  `progress-reply:repository:${investigationContentDigest(id)}:`;
const revisionPrefix = (id: string) => `progress-reply:revision:${investigationContentDigest(id)}:`;
const pendingPrefix = "progress-reply:pending:";
const maximumPending = 1_000;
const conversationIndex = (
  repositoryId: string,
  target: InvestigationCommentTarget,
  e2e: boolean,
) =>
  `progress-reply:conversation:${investigationContentDigest([repositoryId, target.kind, target.number, e2e ? "e2e" : "static"])}`;

function actorFor(record: CommentPublication): InvestigationOperatorPrincipal {
  return {
    id: `progress-reply:${investigationContentDigest(record.repository.id).slice(0, 32)}`,
    displayName: "Investigation progress reply",
    repositoryIds: [record.repository.id],
    permissions: ["action:prepare", "action:execute"],
    actionCapabilities: ["comment"],
    allowRepositoryExecution: false,
    ...(record.githubIdentity === null ? {} : { githubIdentity: record.githubIdentity }),
  };
}
function sameTask(record: CommentPublication, task: InvestigationTaskV1): boolean {
  return (
    record.taskId === task.id &&
    record.taskKind === task.kind &&
    record.taskCreatedAt === task.createdAt &&
    equal(record.repository, task.repository) &&
    record.target.kind === task.workItem.kind &&
    record.target.number === task.workItem.number &&
    record.workItemId === task.workItem.id
  );
}
function sameTrigger(
  left: InvestigationProgressTrigger,
  right: InvestigationProgressTrigger,
): boolean {
  return (
    left.eventName === right.eventName &&
    left.actorUserId === right.actorUserId &&
    left.assigneeUserId === right.assigneeUserId &&
    left.commandCommentId === right.commandCommentId
  );
}
function publicCode(error: unknown): string {
  const code =
    error instanceof InvestigationRequestError
      ? error.code.replace(/^progress_reply_/u, "")
      : "preparation_failed";
  return /^[a-z][a-z0-9_]{0,95}$/u.test(code) ? code : "preparation_failed";
}

/** Owns one durable comment through intake, execution, delivery attempts, and safe recovery. */
export class InvestigationProgressReplies {
  readonly #ownerId = randomUUID();
  readonly #now: () => Date;
  readonly #deliveries: InvestigationCommentDeliveries;
  #started = false;
  #running: Promise<void> | undefined;
  #scheduled: NodeJS.Immediate | undefined;
  #timer: NodeJS.Timeout | undefined;
  #wakeRequested = false;

  constructor(private readonly options: InvestigationProgressRepliesOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#deliveries =
      options.deliveries ??
      new InvestigationCommentDeliveries({ store: options.store, now: this.#now });
  }
  /** Only the newly accepted canonical assignment calls this in its intake transaction. */
  enqueueAssignment(admission: TrustedAssignmentAdmission): void {
    this.#atomic(() => this.#enqueueAssignment(admission));
  }
  #enqueueAssignment(admission: TrustedAssignmentAdmission): void {
    const existing = this.#assignment(admission.id);
    if (existing !== undefined) {
      const original = this.options.store.get<Reference>(
        "idempotency",
        assignmentIndex(admission.id),
      )?.admission;
      requireCondition(
        equal(original?.repository ?? existing.repository, admission.repository) &&
          sameTrigger(original?.trigger ?? existing.trigger, admission.trigger) &&
          (original?.target ?? existing.target).kind === admission.target.kind &&
          (original?.target ?? existing.target).number === admission.target.number &&
          (original?.target ?? existing.target).githubWorkItemId ===
            admission.target.githubWorkItemId,
        409,
        "progress_reply_assignment_conflict",
        "The assignment already belongs to another comment scope.",
      );
      return;
    }
    const policy = this.#policy(admission.repository.id);
    if (policy === null || !policy.progressEnabled) return;
    requireCondition(
      equal(policy.repository, admission.repository),
      409,
      "progress_reply_repository_identity_changed",
      "The registered repository identity changed.",
    );
    const context: ProgressReplyContext = {
      ...(admission.mode === "e2e" || admission.trigger.eventName === "issue_comment"
        ? { mode: "e2e" as const }
        : {}),
      status: "preparing",
      receivedAt: admission.receivedAt,
      scope:
        admission.target.kind === "pull_request"
          ? {
              kind: "pull_request",
              ...(admission.headSha === undefined ? {} : { headSha: admission.headSha }),
            }
          : { kind: "issue" },
      nextStep: stoppedCopy("preparing", undefined, admission.mode).nextStep,
    };
    const record = this.#enroll(
      `progress-reply:assignment:${investigationContentDigest(admission.id).slice(0, 48)}`,
      admission.repository,
      admission.target,
      admission.trigger,
      admission.receivedAt,
      context,
      policy,
      admission.id,
    );
    this.options.store.put("idempotency", assignmentIndex(admission.id), {
      recordId: record.id,
      admission: structuredClone(admission),
    });
  }
  /** Compatibility enrollment for a genuinely new assignment Task; never called for recovery. */
  enqueue(task: InvestigationTaskV1, trigger: InvestigationProgressTrigger): void {
    this.#atomic(() => this.#enqueue(task, trigger));
  }
  #enqueue(task: InvestigationTaskV1, trigger: InvestigationProgressTrigger): void {
    const existing = this.#task(task.id);
    if (existing !== undefined) {
      if (existing.taskId !== task.id) return;
      requireCondition(
        sameTask(existing, task) && sameTrigger(existing.trigger, trigger),
        409,
        "progress_reply_task_conflict",
        "The task already belongs to another progress comment.",
      );
      return;
    }
    if (
      task.state !== "queued" ||
      task.parentTaskId !== null ||
      !["pr-review", "pr-e2e", "issue-investigate"].includes(task.kind)
    )
      return;
    const policy = this.#policy(task.repository.id);
    if (
      policy === null ||
      !policy.progressEnabled ||
      Date.parse(task.createdAt) < Date.parse(policy.updatedAt)
    )
      return;
    const item = this.options.store.get<InvestigationWorkItemRecord>("workItems", task.workItem.id);
    requireCondition(
      item !== undefined &&
        item.repositoryId === task.repository.id &&
        item.number === task.workItem.number &&
        item.kind === task.workItem.kind &&
        equal(policy.repository, task.repository),
      409,
      "progress_reply_work_item_identity_changed",
      "The assignment does not match the registered conversation.",
    );
    const record = this.#enroll(
      oldTaskId(task.id),
      task.repository,
      item,
      trigger,
      task.createdAt,
      {
        ...(task.kind === "pr-e2e" ? { mode: "e2e" as const } : {}),
        status: "queued",
        receivedAt: task.createdAt,
        scope: this.#scopeForTask(task),
        ...(this.options.usageSummary === undefined
          ? {}
          : { usage: this.options.usageSummary(task.id) }),
        nextStep: stoppedCopy("queued", undefined, task.kind === "pr-e2e" ? "e2e" : undefined)
          .nextStep,
      },
      policy,
      null,
    );
    if (record.receivedAt > task.createdAt) {
      this.options.store.put("idempotency", taskIndex(task.id), { recordId: record.id });
      return;
    }
    this.#attach(record, task);
    this.update(task);
  }
  /** Result-only settings use the same conversation slot, without publishing earlier phases. */
  enqueueResult(report: InvestigationResultV1, origin: InvestigationTaskV1): void {
    this.#atomic(() => {
      // Report sealing callbacks may still carry the pre-finalization Task snapshot.
      const task = this.options.store.get<InvestigationTaskV1>("tasks", origin.id);
      if (
        task === undefined ||
        task.kind !== origin.kind ||
        task.createdAt !== origin.createdAt ||
        !equal(task.repository, origin.repository) ||
        task.workItem.id !== origin.workItem.id ||
        task.state !== report.outcome ||
        task.latestReportRef?.id !== report.report.id
      )
        return;
      if (this.hasTask(task.id)) {
        this.update(task, report);
        return;
      }
      if (
        report.outcome !== "completed" ||
        report.report.completeness !== "complete" ||
        task.parentTaskId !== null ||
        !["pr-review", "pr-e2e", "issue-investigate"].includes(task.kind)
      )
        return;
      const policy = this.#policy(task.repository.id);
      if (policy === null) return;
      const target = this.options.store.get<InvestigationWorkItemRecord>(
        "workItems",
        task.workItem.id,
      );
      requireCondition(
        target !== undefined &&
          target.repositoryId === task.repository.id &&
          target.kind === task.workItem.kind &&
          target.number === task.workItem.number &&
          equal(policy.repository, task.repository),
        409,
        "progress_reply_work_item_identity_changed",
        "The report does not match the registered conversation.",
      );
      const record = this.#enroll(
        oldTaskId(task.id),
        task.repository,
        target,
        {
          eventName: task.workItem.kind === "pull_request" ? "pull_request" : "issues",
          actorUserId: 0,
          assigneeUserId: 0,
          actorLogin: "operator",
          assigneeLogin: "automation",
        },
        task.createdAt,
        {
          ...(task.kind === "pr-e2e" ? { mode: "e2e" as const } : {}),
          status: "completed",
          receivedAt: task.createdAt,
          scope: this.#scopeForTask(task),
        },
        policy,
        null,
        true,
      );
      this.options.store.put("idempotency", taskIndex(task.id), { recordId: record.id });
      if (record.receivedAt > task.createdAt) return;
      this.#attach(record, task);
      this.update(task, report);
    });
  }
  /** Attachment changes references, never the publication identity, marker, or sent body. */
  attachTask(receiptId: string, task: InvestigationTaskV1): void {
    const record = this.#assignment(receiptId);
    if (record === undefined) return;
    const reference = this.options.store.get<Reference>("idempotency", assignmentIndex(receiptId))!;
    requireCondition(
      reference.attachedTaskId === undefined || reference.attachedTaskId === task.id,
      409,
      "progress_reply_task_conflict",
      "The assignment is already attached to another task.",
    );
    if (record.receiptId !== receiptId) {
      requireCondition(
        equal(record.repository, task.repository) &&
          record.target.kind === task.workItem.kind &&
          record.target.number === task.workItem.number &&
          (record.desired.context.mode === "e2e") === (task.kind === "pr-e2e"),
        409,
        "progress_reply_task_conflict",
        "The task does not match the accepted assignment comment.",
      );
      this.options.store.put("idempotency", taskIndex(task.id), { recordId: record.id });
      this.options.store.put("idempotency", assignmentIndex(receiptId), {
        ...reference,
        attachedTaskId: task.id,
      });
      this.#deliveries.attachTask(record.id, task.id, task.workItem.id, receiptId);
      return;
    }
    if (record.taskId !== null) {
      requireCondition(
        sameTask(record, task),
        409,
        "progress_reply_task_conflict",
        "The assignment is already attached to another task.",
      );
      return;
    }
    this.#attach(record, task);
    this.options.store.put("idempotency", assignmentIndex(receiptId), {
      ...reference,
      attachedTaskId: task.id,
    });
    this.update(task);
  }
  updateAssignment(receiptId: string, state: AssignmentProgressState, reasonCode?: string): void {
    const record = this.#assignment(receiptId);
    if (record === undefined || record.receiptId !== receiptId || record.taskId !== null) return;
    const copy = stoppedCopy(
      state,
      state === "failed" ? "source_preparation_failed" : reasonCode,
      record.desired.context.mode,
    );
    if (record.desired.context.status === state && record.desired.failure === copy.failure) return;
    this.#accept(
      record,
      { ...record.desired.context, status: state, nextStep: copy.nextStep },
      copy.failure,
      null,
      `assignment:${record.desired.sequence + 1}:${state}`,
      this.#now().toISOString(),
    );
  }
  update(task: InvestigationTaskV1, report?: InvestigationResultV1): void {
    const record = this.#task(task.id);
    if (record === undefined || !this.#currentTask(record, task)) return;
    if (record.resultOnly && task.state !== "completed") return;
    try {
      const source =
        report ??
        (task.state === "completed" && task.latestReportRef !== null
          ? this.options.store.get<InvestigationResultV1>("reports", task.latestReportRef.id)
          : undefined);
      if (source !== undefined) this.#assertReport(record, task, source);
      requireCondition(
        task.state !== "completed" || source !== undefined,
        409,
        "progress_reply_report_binding_changed",
        "The completed task has no bound sealed report.",
      );
      const attempt = this.#latestAttempt(task.id);
      const stopReason = source?.report.loop.stopReason ?? attempt?.terminationReason ?? undefined;
      const copy = stoppedCopy(task.state, stopReason, record.desired.context.mode);
      const startedAt =
        record.firstStartedAt ??
        attempt?.startedAt ??
        (task.state === "running" ? task.updatedAt : undefined);
      const context: ProgressReplyContext = {
        ...record.desired.context,
        ...(this.options.usageSummary === undefined
          ? {}
          : { usage: this.options.usageSummary(task.id) }),
        status: task.state,
        scope: this.#scopeForTask(task),
        receivedAt: record.receivedAt,
        ...(startedAt === null || startedAt === undefined ? {} : { startedAt }),
        ...(attempt === undefined ? {} : { attemptNumber: attempt.number }),
        queuedForResume: task.state === "queued" && attempt !== undefined,
        nextStep: copy.nextStep,
      };
      this.#accept(
        record,
        context,
        copy.failure,
        source ?? null,
        `task:${task.id}:${task.updatedAt}:${task.state}:${attempt?.number ?? 0}:${task.latestReportRef?.digest ?? ""}:${stopReason ?? ""}:${investigationContentDigest(context.usage ?? null)}`,
        task.updatedAt,
      );
    } catch {
      this.#store({
        ...record,
        state: "needs_attention",
        reasonCode: "report_binding_changed",
        requiresAttention: true,
        nextAttemptAt: null,
        updatedAt: this.#now().toISOString(),
      });
      this.options.onError?.("progress_reply_report_binding_changed");
    }
  }
  /** Accepted checkpoints alone provide phase/model attribution; heartbeats never call this. */
  updateProgress(
    task: InvestigationTaskV1,
    checkpoint: InvestigationLoopCheckpointV1,
    attempt: InvestigationAttemptV1,
  ): void {
    const record = this.#task(task.id);
    if (
      record === undefined ||
      record.resultOnly ||
      task.state !== "running" ||
      !this.#currentTask(record, task)
    )
      return;
    const savedCheckpoint = this.options.store.get<InvestigationLoopCheckpointV1>(
      "checkpoints",
      task.id,
    );
    const savedAttempt = this.options.store.get<{ attempt: InvestigationAttemptV1 }>(
      "attempts",
      attempt.id,
    )?.attempt;
    if (
      savedCheckpoint === undefined ||
      !equal(savedCheckpoint, checkpoint) ||
      savedAttempt === undefined ||
      !equal(savedAttempt, attempt) ||
      checkpoint.taskId !== task.id ||
      checkpoint.attemptId !== attempt.id ||
      attempt.taskId !== task.id ||
      checkpoint.lastPhase === null
    )
      return;
    const context: ProgressReplyContext = {
      ...record.desired.context,
      ...(this.options.usageSummary === undefined
        ? {}
        : { usage: this.options.usageSummary(task.id) }),
      status: "running",
      phase: checkpoint.lastPhase,
      attemptNumber: attempt.number,
      trustedModels: {
        modelExecutions: structuredClone(checkpoint.runtime.modelExecutions ?? []),
        completedRounds: checkpoint.round,
        adoptedAttemptIds: structuredClone(checkpoint.adoptedAttemptIds),
      },
      nextStep: stoppedCopy("running", undefined, record.desired.context.mode).nextStep,
    };
    if (
      record.desired.context.phase === context.phase &&
      record.desired.context.attemptNumber === context.attemptNumber &&
      equal(record.desired.context.usage ?? null, context.usage ?? null)
    )
      return;
    this.#accept(
      record,
      context,
      null,
      null,
      `phase:${attempt.id}:${checkpoint.id}:${checkpoint.version}`,
      checkpoint.recordedAt,
      "phase",
    );
  }
  /** Usage changes do not advance a task's phase, attempt, lifecycle, or sealed report. */
  updateUsage(task: InvestigationTaskV1): void {
    if (this.options.usageSummary === undefined) return;
    try {
      this.#atomic(() => {
        const notificationId = investigationUsagePublicationPendingKey(task.id);
        const record = this.#task(task.id);
        if (record === undefined) {
          this.options.store.delete("idempotency", notificationId);
          return;
        }
        if (record.taskId !== task.id) {
          this.options.store.delete("idempotency", notificationId);
          return;
        }
        if (!this.#currentTask(record, task) || record.desired.context.status !== task.state)
          return;
        const usage = this.options.usageSummary!(task.id);
        if (!equal(record.desired.context.usage ?? null, usage)) {
          this.#accept(
            record,
            { ...record.desired.context, usage },
            record.desired.failure,
            this.#assertRevision(record.desired) ?? null,
            `usage:${task.id}:${task.updatedAt}:${investigationContentDigest(usage)}`,
            this.#now().toISOString(),
            "usage",
          );
        }
        this.options.store.delete("idempotency", notificationId);
      });
    } catch {
      this.options.onError?.("progress_reply_usage_update_failed");
    }
  }
  hasTask(taskId: string): boolean {
    return (
      this.options.store.has("idempotency", taskIndex(taskId)) ||
      this.options.store.has("idempotency", oldTaskId(taskId))
    );
  }
  /** Match only durable comment identities, never the requesting user's login. */
  isOwnComment(repositoryId: string, commentId: number): boolean {
    if (!Number.isSafeInteger(commentId) || commentId < 1) return false;
    const externalId = String(commentId);
    return (
      this.options.store.list<CommentPublication>(
        "idempotency",
        (record) =>
          record !== null &&
          typeof record === "object" &&
          record.schemaVersion === 2 &&
          typeof record.id === "string" &&
          record.id.startsWith("progress-reply:") &&
          record.repository?.id === repositoryId &&
          (record.confirmed?.externalId === externalId ||
            (record.operation?.dispatched === true &&
              record.operation.request.externalId === externalId)),
      ).length > 0
    );
  }
  getComment(
    actor: InvestigationOperatorPrincipal,
    id: string,
  ): InvestigationCommentPublicationSummary {
    return this.#summary(actor, this.#authorizedRecord(actor, id));
  }
  taskSummary(
    actor: InvestigationOperatorPrincipal,
    taskId: string,
  ): InvestigationCommentPublicationSummary | null {
    const task = this.options.store.get<InvestigationTaskV1>("tasks", taskId);
    requireCondition(task !== undefined, 404, "task_not_found", "The task is unavailable.");
    this.#scope(actor, task.repository.id);
    const record = this.#task(taskId);
    return record === undefined
      ? null
      : { ...this.#summary(actor, record), associatedTaskIds: [taskId] };
  }
  taskSummaries(
    actor: InvestigationOperatorPrincipal,
    taskIds: readonly string[],
  ): { items: InvestigationCommentPublicationSummary[] } {
    requireCondition(
      taskIds.length <= 100,
      400,
      "comment_summary_limit",
      "At most 100 task summaries may be requested.",
    );
    const summaries = new Map<string, InvestigationCommentPublicationSummary>();
    for (const id of new Set(taskIds)) {
      const summary = this.taskSummary(actor, id);
      if (summary === null) continue;
      summaries.set(summary.id, {
        ...summary,
        associatedTaskIds: [...(summaries.get(summary.id)?.associatedTaskIds ?? []), id],
      });
    }
    return { items: [...summaries.values()] };
  }
  list(
    actor: InvestigationOperatorPrincipal,
    repositoryId: string,
  ): { items: ProgressReplyReceipt[] } {
    this.#scope(actor, repositoryId);
    return {
      items: this.options.store
        .pagePrefix<Reference>("idempotency", repositoryPrefix(repositoryId), 20, true)
        .map((entry) => this.#view(this.#record(entry.recordId))),
    };
  }
  revisions(actor: InvestigationOperatorPrincipal, id: string): { items: PublicationRevision[] } {
    this.#authorizedRecord(actor, id);
    return {
      items: this.options.store.pagePrefix<PublicationRevision>(
        "idempotency",
        revisionPrefix(id),
        50,
        true,
      ),
    };
  }
  sync(
    actor: InvestigationOperatorPrincipal,
    id: string,
    command: InvestigationCommentCommand,
  ): InvestigationCommentPublicationSummary {
    return this.#command(actor, id, "sync", command);
  }
  reconcile(
    actor: InvestigationOperatorPrincipal,
    id: string,
    command: InvestigationCommentCommand,
  ): InvestigationCommentPublicationSummary {
    return this.#command(actor, id, "reconcile", command);
  }
  classifyProgressComment(
    repository: InvestigationRepositoryRecord,
    target: {
      readonly kind: "pull_request" | "issue";
      readonly number: number;
      readonly githubWorkItemId: number;
    },
    comment: {
      readonly externalId: string;
      readonly authorUserId: number;
      readonly body: string;
      readonly issueUrl: string;
    },
  ): { kind: "agentic_review_progress"; publicationId: string } | undefined {
    const url = `https://api.github.com/repos/${repository.fullName}/issues/${target.number}`;
    if (comment.issueUrl.toLowerCase() !== url.toLowerCase()) return undefined;
    for (const reference of this.options.store.pagePrefix<Reference>(
      "idempotency",
      repositoryPrefix(repository.id),
      1000,
      true,
    )) {
      const record = this.#record(reference.recordId);
      if (
        !equal(record.repository, repository) ||
        record.target.kind !== target.kind ||
        record.target.number !== target.number ||
        (record.target.githubWorkItemId !== undefined &&
          record.target.githubWorkItemId !== target.githubWorkItemId) ||
        record.githubIdentity?.githubUserId !== comment.authorUserId ||
        record.confirmed?.externalId !== comment.externalId
      )
        continue;
      if (
        record.confirmed.body === comment.body ||
        (record.operation?.request.externalId === comment.externalId &&
          record.operation.request.body === comment.body)
      )
        return { kind: "agentic_review_progress", publicationId: record.id };
    }
    return undefined;
  }
  start(): void {
    // Import retained snapshots before the shared history is read, including records with no outbox wake-up.
    const prefix = "progress-reply:task:";
    let afterId: string | undefined;
    while (true) {
      const page = this.options.store.pagePrefix<{ id: string; schemaVersion?: number }>(
        "idempotency",
        prefix,
        100,
        false,
        afterId,
      );
      for (const record of page) {
        requireCondition(
          typeof record.id === "string" && record.id.startsWith(prefix),
          409,
          "progress_reply_legacy_invalid",
          "The retained progress comment record has an invalid identity.",
        );
        if (record.schemaVersion !== 2) this.#record(record.id);
        afterId = record.id;
      }
      if (page.length < 100) break;
    }
    // Index retained comments before any publisher can dispatch a second conversation writer.
    this.#atomic(() => {
      for (const record of this.#publications()) {
        const registered = this.options.store.get<InvestigationRepositoryRecord>(
          "repositories",
          record.repository.id,
        );
        if (registered !== undefined && equal(registered, record.repository)) {
          try {
            this.#conversation(
              record.repository,
              record.target,
              record.desired.context.mode === "e2e",
            );
          } catch (error) {
            if (
              !(error instanceof InvestigationRequestError) ||
              error.code !== "progress_reply_work_item_identity_changed"
            )
              throw error;
            this.#store({ ...record, conversationConflict: true });
          }
        }
      }
    });
    this.#started = true;
    let usageCursor: string | undefined;
    while (true) {
      const notifications = this.options.store.pagePrefix<{ id: string; taskId: string }>(
        "idempotency",
        investigationUsagePublicationPendingPrefix,
        100,
        false,
        usageCursor,
      );
      for (const notification of notifications) {
        const task = this.options.store.get<InvestigationTaskV1>("tasks", notification.taskId);
        if (task !== undefined) this.updateUsage(task);
        usageCursor = notification.id;
      }
      if (notifications.length < 100) break;
    }
    this.#wake();
  }
  async stop(): Promise<void> {
    this.#started = false;
    if (this.#scheduled !== undefined) clearImmediate(this.#scheduled);
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#scheduled = undefined;
    this.#timer = undefined;
    await this.#running;
  }
  drain(): Promise<void> {
    if (this.#running !== undefined) return this.#running;
    this.#running = this.#drain().finally(() => {
      this.#running = undefined;
      if (this.#wakeRequested) {
        this.#wakeRequested = false;
        this.#wake();
      }
    });
    return this.#running;
  }
  #atomic<T>(fn: () => T): T {
    return this.options.store.inTransaction ? fn() : this.options.store.transaction(fn);
  }
  #authorizedRecord(actor: InvestigationOperatorPrincipal, id: string): CommentPublication {
    const raw = this.options.store.get<{ id?: unknown; repository?: { id?: unknown } }>(
      "idempotency",
      id,
    );
    requireCondition(
      raw !== undefined && raw.id === id && typeof raw.repository?.id === "string",
      404,
      "comment_not_found",
      "The comment publication is unavailable.",
    );
    this.#scope(actor, raw.repository.id);
    return this.#record(id);
  }
  #record(id: string): CommentPublication {
    const raw = this.options.store.get<{ schemaVersion?: number }>("idempotency", id);
    requireCondition(
      raw !== undefined,
      404,
      "comment_not_found",
      "The comment publication is unavailable.",
    );
    if (raw.schemaVersion === 2) return raw as CommentPublication;
    return this.#atomic(() => {
      const record = migrateLegacyProgressReply(raw, {
        store: this.options.store,
        deliveries: this.#deliveries,
        now: this.#now,
      });
      this.options.store.put("idempotency", record.id, record);
      if (record.taskId !== null)
        this.options.store.put("idempotency", taskIndex(record.taskId), { recordId: record.id });
      return this.#store(record);
    });
  }
  #task(taskId: string): CommentPublication | undefined {
    const entry = this.options.store.get<Reference>("idempotency", taskIndex(taskId));
    const record =
      entry !== undefined
        ? this.#record(entry.recordId)
        : this.options.store.has("idempotency", oldTaskId(taskId))
          ? this.#record(oldTaskId(taskId))
          : undefined;
    if (record?.retiredTo === undefined) return record;
    this.options.store.put("idempotency", taskIndex(taskId), { recordId: record.retiredTo });
    return this.#record(record.retiredTo);
  }
  #assignment(receiptId: string): CommentPublication | undefined {
    const entry = this.options.store.get<Reference>("idempotency", assignmentIndex(receiptId));
    if (entry === undefined) return undefined;
    const record = this.#record(entry.recordId);
    return record.retiredTo === undefined ? record : this.#record(record.retiredTo);
  }
  #retainAssignment(record: CommentPublication): void {
    if (record.receiptId === null || record.target.githubWorkItemId === undefined) return;
    const key = assignmentIndex(record.receiptId);
    const previous = this.options.store.get<Reference>("idempotency", key);
    if (previous?.admission !== undefined) return;
    this.options.store.put("idempotency", key, {
      recordId: record.id,
      ...(record.taskId === null ? {} : { attachedTaskId: record.taskId }),
      admission: {
        id: record.receiptId,
        repository: record.repository,
        target: { ...record.target, githubWorkItemId: record.target.githubWorkItemId },
        trigger: record.trigger,
        receivedAt: record.receivedAt,
        expectedAssigneeUserId: record.trigger.assigneeUserId,
        ...(record.desired.context.mode === "e2e" ? { mode: "e2e" as const } : {}),
        ...(record.desired.context.scope?.headSha === undefined
          ? {}
          : { headSha: record.desired.context.scope.headSha }),
      },
    } satisfies Reference);
  }
  #publications(): CommentPublication[] {
    return this.options.store
      .list<{ id: string; repository?: InvestigationRepositoryRecord }>(
        "idempotency",
        (record) =>
          typeof record?.id === "string" &&
          (record.id.startsWith("progress-reply:task:") ||
            record.id.startsWith("progress-reply:assignment:")) &&
          record.repository !== undefined,
      )
      .map((record) => this.#record(record.id));
  }
  #conversation(
    repository: InvestigationRepositoryRecord,
    target: InvestigationCommentTarget,
    e2e: boolean,
  ): CommentPublication | undefined {
    const key = conversationIndex(repository.id, target, e2e);
    const reference = this.options.store.get<Reference>("idempotency", key);
    let record = reference === undefined ? undefined : this.#record(reference.recordId);
    if (record === undefined) {
      const candidates = this.#publications().filter(
        (candidate) =>
          candidate.retiredTo === undefined &&
          equal(candidate.repository, repository) &&
          candidate.target.kind === target.kind &&
          candidate.target.number === target.number &&
          (candidate.desired.context.mode === "e2e") === e2e,
      );
      const priority = (candidate: CommentPublication) =>
        candidate.operation?.dispatched || candidate.state === "unconfirmed"
          ? 0
          : candidate.confirmed !== null
            ? 1
            : 2;
      candidates.sort(
        (left, right) =>
          priority(left) - priority(right) ||
          right.receivedAt.localeCompare(left.receivedAt) ||
          left.id.localeCompare(right.id),
      );
      record = candidates[0];
      if (record !== undefined) {
        this.options.store.put("idempotency", key, { recordId: record.id });
        if (candidates.filter((candidate) => priority(candidate) === 0).length > 1)
          record = this.#store({ ...record, conversationConflict: true });
        for (const duplicate of candidates.slice(1)) {
          this.#retainAssignment(duplicate);
          this.#store({ ...duplicate, retiredTo: record.id });
          if (duplicate.taskId !== null)
            this.options.store.put("idempotency", taskIndex(duplicate.taskId), {
              recordId: record.id,
            });
        }
        const latest = candidates.toSorted((left, right) =>
          right.receivedAt.localeCompare(left.receivedAt),
        )[0]!;
        if (latest.receivedAt > record.receivedAt) {
          this.#retainAssignment(record);
          const revision: PublicationRevision = {
            ...latest.desired,
            taskId: latest.taskId,
            workItemId: latest.workItemId,
            receiptId: latest.receiptId,
            id: `${revisionPrefix(record.id)}${String(record.desired.sequence + 1).padStart(12, "0")}`,
            sequence: record.desired.sequence + 1,
            sourceEventId: `conversation-migration:${latest.desired.id}`,
          };
          this.options.store.insert("idempotency", revision.id, revision);
          record = this.#store({
            ...record,
            desired: revision,
            receiptId: latest.receiptId,
            taskId: latest.taskId,
            taskKind: latest.taskKind,
            taskCreatedAt: latest.taskCreatedAt,
            workItemId: latest.workItemId,
            target: { ...record.target, id: latest.target.id },
            trigger: latest.trigger,
            receivedAt: latest.receivedAt,
            firstStartedAt: latest.firstStartedAt,
            resultOnly: latest.resultOnly ?? false,
            grant: latest.grant,
            grantHistory: equal(record.grant, latest.grant)
              ? record.grantHistory
              : [...record.grantHistory, ...latest.grantHistory],
            state: record.operation?.dispatched ? "unconfirmed" : "needs_attention",
            reasonCode: record.operation?.dispatched
              ? record.reasonCode
              : "synchronization_required",
            requiresAttention: true,
          });
        }
      }
    }
    if (record !== undefined)
      requireCondition(
        equal(record.repository, repository) &&
          (record.target.githubWorkItemId === undefined ||
            target.githubWorkItemId === undefined ||
            record.target.githubWorkItemId === target.githubWorkItemId),
        409,
        "progress_reply_work_item_identity_changed",
        "The conversation comment identity changed.",
      );
    return record === undefined ? undefined : this.#refreshLegacy(record);
  }
  #refreshLegacy(record: CommentPublication): CommentPublication {
    if (
      (record.confirmed !== null && !record.legacyConflict) ||
      record.operation?.dispatched ||
      record.retiredTo !== undefined
    )
      return record;
    const legacy = inspectLegacyConversationReplies({
      store: this.options.store,
      repository: record.repository,
      target: record.target,
      channel: record.desired.context.mode === "e2e" ? "e2e" : "static",
    });
    if (legacy.blocked) return this.#store({ ...record, legacyConflict: true });
    if (record.confirmed !== null)
      return this.#store({
        ...record,
        legacyConflict: false,
        state: "pending",
        reasonCode: null,
        requiresAttention: false,
        nextAttemptAt: this.#now().valueOf(),
      });
    if (legacy.confirmed === null && !record.legacyConflict) return record;
    const confirmation = legacy.confirmed;
    if (
      confirmation !== null &&
      record.operation?.attemptId !== null &&
      record.operation?.attemptId !== undefined &&
      !record.operation.finished
    )
      this.#deliveries.finish(record.operation.attemptId, {
        state: "cancelled",
        effect: "not_sent",
        reason: publicationReason("superseded"),
      });
    return this.#store({
      ...record,
      legacyConflict: false,
      ...(confirmation === null
        ? {}
        : {
            marker: confirmation.marker,
            githubIdentity: confirmation.githubIdentity,
            operation: null,
            confirmed: {
              revision: {
                ...record.desired,
                id: `${revisionPrefix(record.id)}legacy`,
                sequence: -1,
                legacy: true,
                taskId: confirmation.taskId,
                workItemId:
                  this.options.store.get<InvestigationTaskV1>("tasks", confirmation.taskId)
                    ?.workItem.id ?? null,
                receiptId: null,
                reportRef: null,
                reportDigest: null,
                sourceEventId: `legacy:${confirmation.recordId}`,
                stage: "completed",
                updatedAt: confirmation.confirmedAt,
              },
              body: confirmation.body,
              externalId: confirmation.externalId,
              attemptId: null,
              confirmedAt: confirmation.confirmedAt,
            },
          }),
      state: "pending",
      reasonCode: null,
      requiresAttention: false,
      nextAttemptAt: this.#now().valueOf(),
    });
  }
  #enroll(
    id: string,
    repository: InvestigationRepositoryRecord,
    target: InvestigationCommentTarget,
    trigger: InvestigationProgressTrigger,
    receivedAt: string,
    context: ProgressReplyContext,
    policy: AutomaticReplyPolicy,
    receiptId: string | null,
    resultOnly = false,
  ): CommentPublication {
    const existing = this.#conversation(repository, target, context.mode === "e2e");
    if (existing === undefined) {
      const created = this.#create(
        id,
        repository,
        target,
        trigger,
        receivedAt,
        context,
        policy,
        receiptId,
        resultOnly,
      );
      this.options.store.put(
        "idempotency",
        conversationIndex(repository.id, target, context.mode === "e2e"),
        { recordId: created.id },
      );
      return created;
    }
    if (receivedAt < existing.receivedAt) return existing;
    this.#retainAssignment(existing);
    const grant = {
      authorizationEpoch: policy.authorizationEpoch,
      authorizedById: policy.authorizedById,
    };
    // Keep the confirmed body, frozen in-flight operation, lease and authority while advancing the producer.
    const next = {
      ...existing,
      receiptId,
      taskId: null,
      taskKind: null,
      taskCreatedAt: null,
      workItemId: null,
      trigger: structuredClone(trigger),
      receivedAt,
      firstStartedAt: null,
      resultOnly,
      nextPhaseAt: 0,
      grant,
      grantHistory: equal(existing.grant, grant)
        ? existing.grantHistory
        : [
            ...existing.grantHistory,
            {
              ...grant,
              at: this.#now().toISOString(),
              actorId: policy.authorizedById,
              source: "enrollment" as const,
            },
          ],
      target: {
        ...existing.target,
        ...(target.githubWorkItemId === undefined
          ? {}
          : { githubWorkItemId: target.githubWorkItemId }),
      },
      operation:
        existing.operation === null
          ? null
          : {
              ...existing.operation,
              revision: {
                taskId: existing.taskId,
                workItemId: existing.workItemId,
                receiptId: existing.receiptId,
                ...existing.operation.revision,
              },
            },
    };
    this.#accept(next, context, null, null, `accepted:${receiptId ?? id}`, receivedAt);
    return this.#record(existing.id);
  }
  #policy(repositoryId: string): AutomaticReplyPolicy | null {
    try {
      return this.options.settings.policy(repositoryId);
    } catch {
      this.options.onError?.("progress_reply_policy_invalid");
      return null;
    }
  }
  #create(
    id: string,
    repository: InvestigationRepositoryRecord,
    target: InvestigationCommentTarget,
    trigger: InvestigationProgressTrigger,
    receivedAt: string,
    context: ProgressReplyContext,
    policy: AutomaticReplyPolicy,
    receiptId: string | null,
    resultOnly = false,
  ): CommentPublication {
    const now = this.#now().toISOString();
    const grant = {
      authorizationEpoch: policy.authorizationEpoch,
      authorizedById: policy.authorizedById,
    };
    const revision: PublicationRevision = {
      id: `${revisionPrefix(id)}${"0".repeat(12)}`,
      sequence: 0,
      sourceEventId: `accepted:${receiptId ?? id}`,
      stage: "received",
      context,
      updatedAt: receivedAt,
      failure: null,
      reportRef: null,
      reportDigest: null,
      policy: publicationPolicy(policy, target.kind, context.mode),
      taskId: null,
      workItemId: null,
      receiptId,
    };
    const record: CommentPublication = {
      schemaVersion: 2,
      id,
      receiptId,
      taskId: null,
      taskKind: null,
      taskCreatedAt: null,
      repository: structuredClone(repository),
      target: {
        id: target.id,
        repositoryId: target.repositoryId,
        kind: target.kind,
        number: target.number,
        ...(target.githubWorkItemId === undefined
          ? {}
          : { githubWorkItemId: target.githubWorkItemId }),
      },
      workItemId: null,
      trigger: structuredClone(trigger),
      marker: `<!-- agentic-review-progress:${receiptId === null ? id.slice("progress-reply:task:".length) : investigationContentDigest(id)} -->`,
      receivedAt,
      firstStartedAt: null,
      desired: revision,
      confirmed: null,
      operation: null,
      githubIdentity: null,
      grant,
      grantHistory: [{ ...grant, at: now, actorId: policy.authorizedById, source: "enrollment" }],
      state: "pending",
      reasonCode: null,
      requiresAttention: false,
      pendingId: `${pendingPrefix}${now}:${investigationContentDigest(id)}`,
      writeAttempts: 0,
      readAttempts: 0,
      nextAttemptAt: this.#now().valueOf(),
      lastAttemptAt: null,
      lastAttemptId: null,
      nextPhaseAt: 0,
      reconcileRequested: false,
      claim: null,
      historyAvailableSince: now,
      createdAt: now,
      updatedAt: now,
      resultOnly,
    };
    const legacy = inspectLegacyConversationReplies({
      store: this.options.store,
      repository,
      target,
      channel: context.mode === "e2e" ? "e2e" : "static",
    });
    const adopted: CommentPublication =
      legacy.confirmed === null
        ? record
        : {
            ...record,
            marker: legacy.confirmed.marker,
            githubIdentity: legacy.confirmed.githubIdentity,
            confirmed: {
              revision: {
                ...revision,
                id: `${revisionPrefix(id)}legacy`,
                sequence: -1,
                legacy: true,
                taskId: legacy.confirmed.taskId,
                workItemId:
                  this.options.store.get<InvestigationTaskV1>("tasks", legacy.confirmed.taskId)
                    ?.workItem.id ?? null,
                receiptId: null,
                reportRef: null,
                reportDigest: null,
                sourceEventId: `legacy:${legacy.confirmed.recordId}`,
                stage: "completed",
                updatedAt: legacy.confirmed.confirmedAt,
              },
              body: legacy.confirmed.body,
              externalId: legacy.confirmed.externalId,
              attemptId: null,
              confirmedAt: legacy.confirmed.confirmedAt,
            },
          };
    this.options.store.insert("idempotency", revision.id, revision);
    this.options.store.insert("idempotency", id, record);
    this.options.store.insert(
      "idempotency",
      `${repositoryPrefix(repository.id)}${now}:${investigationContentDigest(id)}`,
      { recordId: id },
    );
    if (receiptId !== null)
      this.options.store.insert("idempotency", assignmentIndex(receiptId), { recordId: id });
    const saved = this.#store({ ...adopted, ...(legacy.blocked ? { legacyConflict: true } : {}) });
    this.#wake();
    return saved;
  }
  #attach(record: CommentPublication, task: InvestigationTaskV1): void {
    requireCondition(
      equal(record.repository, task.repository) &&
        record.target.kind === task.workItem.kind &&
        record.target.number === task.workItem.number &&
        (record.desired.context.mode === "e2e") === (task.kind === "pr-e2e") &&
        (record.taskId === null || sameTask(record, task)),
      409,
      "progress_reply_task_conflict",
      "The task does not match the accepted assignment comment.",
    );
    const existing = this.#task(task.id);
    requireCondition(
      existing === undefined || existing.id === record.id,
      409,
      "progress_reply_task_conflict",
      "This task already belongs to another comment publication.",
    );
    this.options.store.put("idempotency", taskIndex(task.id), { recordId: record.id });
    this.#deliveries.attachTask(record.id, task.id, task.workItem.id, record.receiptId);
    this.#store({
      ...record,
      taskId: task.id,
      taskKind: task.kind,
      taskCreatedAt: task.createdAt,
      workItemId: task.workItem.id,
      target: { ...record.target, id: task.workItem.id },
      updatedAt: this.#now().toISOString(),
    });
  }
  #currentTask(record: CommentPublication, task: InvestigationTaskV1): boolean {
    const current = this.options.store.get<InvestigationTaskV1>("tasks", task.id);
    return (
      current !== undefined &&
      sameTask(record, task) &&
      sameTask(record, current) &&
      current.state === task.state &&
      current.updatedAt === task.updatedAt &&
      equal(current.latestReportRef, task.latestReportRef)
    );
  }
  #latestAttempt(taskId: string): InvestigationAttemptV1 | undefined {
    return this.options.store
      .list<{ attempt: InvestigationAttemptV1 }>(
        "attempts",
        (entry) => entry.attempt?.taskId === taskId,
      )
      .map((entry) => entry.attempt)
      .sort((left, right) => right.number - left.number)[0];
  }
  #scopeForTask(task: InvestigationTaskV1): NonNullable<ProgressReplyContext["scope"]> {
    const original = task.subjects.find((subject) => subject.id === task.subjectRef);
    const current = this.options.store.get<InvestigationWorkItemRecord>(
      "workItems",
      task.workItem.id,
    )?.subject;
    return task.workItem.kind === "pull_request"
      ? {
          kind: "pull_request",
          ...(original?.kind === "original_pr" ? { headSha: original.headSha } : {}),
          ...(current?.kind === "original_pr" ? { currentHeadSha: current.headSha } : {}),
        }
      : { kind: "issue" };
  }
  #accept(
    record: CommentPublication,
    context: ProgressReplyContext,
    failure: string | null,
    report: InvestigationResultV1 | null,
    sourceEventId: string,
    updatedAt: string,
    throttle: "none" | "phase" | "usage" = "none",
  ): void {
    if (record.desired.sourceEventId === sourceEventId) return;
    const eventKey = `progress-reply:event:${investigationContentDigest([record.id, sourceEventId])}`;
    if (this.options.store.has("idempotency", eventKey)) return;
    const policy = this.#policy(record.repository.id);
    const sequence = record.desired.sequence + 1;
    const revision: PublicationRevision = {
      id: `${revisionPrefix(record.id)}${String(sequence).padStart(12, "0")}`,
      sequence,
      sourceEventId,
      stage: publicationStage(context.status ?? "received"),
      context: structuredClone(context),
      updatedAt,
      failure,
      reportRef:
        report === null
          ? null
          : {
              id: report.report.id,
              version: report.report.version,
              digest: report.report.logicalContentDigest,
            },
      reportDigest: report === null ? null : investigationContentDigest(report),
      policy:
        policy === null
          ? record.desired.policy
          : publicationPolicy(policy, record.target.kind, context.mode),
      taskId: record.taskId,
      workItemId: record.workItemId,
      receiptId: record.receiptId,
    };
    this.options.store.insert("idempotency", revision.id, revision);
    this.options.store.insert("idempotency", eventKey, { revisionId: revision.id });
    const uncertain = record.operation?.dispatched === true || record.state === "unconfirmed";
    const grantValid = this.#grantValid(record, policy);
    const keepConflict = record.state === "conflict";
    const state = uncertain
      ? "unconfirmed"
      : keepConflict
        ? "conflict"
        : grantValid
          ? "pending"
          : "paused";
    const scheduledAt = uncertain
      ? record.nextAttemptAt
      : keepConflict || !grantValid
        ? null
        : throttle === "phase"
          ? Math.max(this.#now().valueOf(), record.nextPhaseAt)
          : throttle === "usage" &&
              record.confirmed !== null &&
              record.confirmed.revision.context.status === context.status &&
              record.confirmed.revision.context.attemptNumber === context.attemptNumber
            ? Math.max(
                this.#now().valueOf(),
                Date.parse(record.confirmed.confirmedAt ?? record.confirmed.revision.updatedAt) +
                  (this.options.usageIntervalMs ?? 30_000),
              )
            : this.#now().valueOf();
    const nextAt =
      throttle !== "none" &&
      record.state === "pending" &&
      record.nextAttemptAt !== null &&
      scheduledAt !== null
        ? Math.min(record.nextAttemptAt, scheduledAt)
        : scheduledAt;
    this.#store({
      ...record,
      desired: revision,
      firstStartedAt: record.firstStartedAt ?? context.startedAt ?? null,
      state,
      reasonCode:
        uncertain || keepConflict ? record.reasonCode : grantValid ? null : "authorization_changed",
      requiresAttention: uncertain || keepConflict ? record.requiresAttention : !grantValid,
      nextAttemptAt: nextAt,
      writeAttempts: uncertain ? record.writeAttempts : 0,
      updatedAt: this.#now().toISOString(),
    });
    this.#wake();
  }
  #store(record: CommentPublication): CommentPublication {
    if (record.retiredTo !== undefined || record.conversationConflict || record.legacyConflict)
      record = {
        ...record,
        state:
          record.conversationConflict || record.legacyConflict
            ? "conflict"
            : record.operation?.dispatched
              ? "unconfirmed"
              : "paused",
        reasonCode:
          record.conversationConflict || record.legacyConflict
            ? "conflict_legacy_publications"
            : "conversation_comment_replaced",
        requiresAttention:
          record.conversationConflict ||
          record.legacyConflict ||
          record.operation?.dispatched === true,
        nextAttemptAt: record.reconcileRequested ? record.nextAttemptAt : null,
      };
    let next = record;
    if (record.nextAttemptAt !== null) {
      if (
        !this.options.store.has("idempotency", record.pendingId) &&
        this.options.store.countPrefix("idempotency", pendingPrefix) >= maximumPending
      )
        next = {
          ...record,
          state: record.operation?.dispatched ? "unconfirmed" : "needs_attention",
          reasonCode: "queue_full",
          requiresAttention: true,
          nextAttemptAt: null,
        };
      else this.options.store.put("idempotency", record.pendingId, { recordId: record.id });
    }
    if (next.nextAttemptAt === null) this.options.store.delete("idempotency", record.pendingId);
    this.options.store.put("idempotency", next.id, next);
    return next;
  }
  #scope(actor: InvestigationOperatorPrincipal, repositoryId: string): void {
    requireCondition(
      actor.repositoryIds.includes(repositoryId),
      403,
      "repository_forbidden",
      "This identity cannot read this repository's comments.",
    );
    requireCondition(
      this.options.store.has("repositories", repositoryId),
      404,
      "repository_not_found",
      "The repository is not registered.",
    );
  }
  #grantValid(record: CommentPublication, policy = this.#policy(record.repository.id)): boolean {
    if (
      record.retiredTo !== undefined ||
      record.conversationConflict ||
      record.legacyConflict ||
      policy === null ||
      !policy.enabled ||
      (!record.resultOnly && !policy.progressEnabled) ||
      !equal(policy.repository, record.repository) ||
      policy.authorizationEpoch !== record.grant.authorizationEpoch ||
      policy.authorizedById !== record.grant.authorizedById
    )
      return false;
    const authorizer = this.options.resolveOperator(record.grant.authorizedById);
    return (
      authorizer !== null &&
      authorizer.repositoryIds.includes(record.repository.id) &&
      ["repository:manage", "action:prepare", "action:execute"].every((permission) =>
        authorizer.permissions.includes(permission as (typeof authorizer.permissions)[number]),
      ) &&
      authorizer.actionCapabilities.includes("comment")
    );
  }
  #can(
    actor: InvestigationOperatorPrincipal,
    operation: "sync" | "reconcile",
    record: CommentPublication,
  ): boolean {
    if (
      !actor.repositoryIds.includes(record.repository.id) ||
      !actor.permissions.includes("action:prepare") ||
      !actor.actionCapabilities.includes("comment")
    )
      return false;
    if (operation === "reconcile")
      return (
        (record.operation?.dispatched === true || record.confirmed !== null) &&
        !["sending", "pending", "retrying"].includes(record.state) &&
        (record.claim?.expiresAt ?? 0) <= this.#now().valueOf() &&
        this.options.transport?.reconcileProgressComment !== undefined
      );
    if (record.legacyConflict) {
      const legacy = inspectLegacyConversationReplies({
        store: this.options.store,
        repository: record.repository,
        target: record.target,
        channel: record.desired.context.mode === "e2e" ? "e2e" : "static",
      });
      return (
        !legacy.blocked &&
        this.#can(actor, operation, { ...record, legacyConflict: false, state: "pending" })
      );
    }
    if (
      !actor.permissions.includes("action:execute") ||
      record.retiredTo !== undefined ||
      record.conversationConflict ||
      !this.options.enableExternalWrites ||
      record.operation?.dispatched ||
      ["conflict", "unconfirmed"].includes(record.state) ||
      (record.state === "synced" &&
        !(record.taskKind === "pr-e2e" && record.desired.reportRef !== null)) ||
      (record.claim?.expiresAt ?? 0) > this.#now().valueOf()
    )
      return false;
    const policy = this.#policy(record.repository.id);
    return (
      policy !== null &&
      this.#grantValid(
        {
          ...record,
          grant: {
            authorizationEpoch: policy.authorizationEpoch,
            authorizedById: policy.authorizedById,
          },
        },
        policy,
      )
    );
  }
  #version(record: CommentPublication): string {
    return investigationContentDigest({
      desired: record.desired.id,
      confirmed: record.confirmed?.revision.id ?? null,
      state: record.state,
      reasonCode: record.reasonCode,
      grant: record.grant,
      operation: record.operation?.attemptId ?? null,
      lastAttemptId: record.lastAttemptId,
      reconcileRequested: record.reconcileRequested,
      nextAttemptAt: record.nextAttemptAt,
    });
  }
  #summary(
    actor: InvestigationOperatorPrincipal,
    record: CommentPublication,
  ): InvestigationCommentPublicationSummary {
    const externalId = record.confirmed?.externalId ?? record.operation?.request.externalId ?? null;
    const producer =
      record.taskId === null
        ? undefined
        : this.options.store.get<InvestigationTaskV1>("tasks", record.taskId);
    const boundProducer =
      producer?.repository.id === record.repository.id && producer.workItem.id === record.workItemId
        ? producer
        : undefined;
    return {
      id: record.id,
      version: this.#version(record),
      mode: "progress",
      repositoryId: record.repository.id,
      repositoryFullName: record.repository.fullName,
      workItemId: record.workItemId,
      workItemKind: record.target.kind,
      workItemNumber: record.target.number,
      taskId: record.taskId,
      producerTaskKind: boundProducer?.kind ?? record.taskKind,
      workItemTitle: boundProducer?.workItem.title ?? null,
      reportId: record.desired.reportRef?.id ?? null,
      state: record.state,
      reasonCode: record.reasonCode,
      reason: publicationReason(record.reasonCode),
      requiresAttention: record.requiresAttention,
      nextAttemptAt:
        record.nextAttemptAt === null ? null : new Date(record.nextAttemptAt).toISOString(),
      lastAttemptAt: record.lastAttemptAt,
      lastConfirmedAt: record.confirmed?.confirmedAt ?? null,
      externalId,
      commentUrl:
        externalId !== null && /^[1-9][0-9]*$/u.test(externalId)
          ? `https://github.com/${record.repository.fullName}/${record.target.kind === "pull_request" ? "pull" : "issues"}/${record.target.number}#issuecomment-${externalId}`
          : null,
      availableActions: (["sync", "reconcile"] as const).filter((action) =>
        this.#can(actor, action, record),
      ),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
  #view(record: CommentPublication): ProgressReplyReceipt {
    const revision = record.operation?.revision ?? record.confirmed?.revision ?? record.desired;
    const states: Record<CommentPublication["state"], ProgressReplyState> = {
      pending: "pending",
      sending: "sending",
      synced: "sent",
      retrying: "pending",
      unconfirmed: "unknown",
      paused: "blocked",
      needs_attention: "failed",
      conflict: "blocked",
    };
    return {
      id: record.id,
      reportId: revision.reportRef?.id ?? null,
      taskId: record.taskId,
      workItemId: record.workItemId ?? record.target.id,
      workItemKind: record.target.kind,
      workItemNumber: record.target.number,
      stage: revision.stage,
      state: states[record.state],
      body: record.operation?.request.body ?? record.confirmed?.body ?? null,
      externalId: record.confirmed?.externalId ?? record.operation?.request.externalId ?? null,
      reason: publicationReason(record.reasonCode),
      settingsVersion: revision.policy.settingsVersion,
      templateVersion: revision.policy.templateVersion,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
  #command(
    actor: InvestigationOperatorPrincipal,
    id: string,
    action: "sync" | "reconcile",
    command: InvestigationCommentCommand,
  ): InvestigationCommentPublicationSummary {
    return this.#atomic(() => {
      let record = this.#authorizedRecord(actor, id);
      requireCondition(
        typeof command.version === "string" &&
          /^[a-f0-9]{64}$/u.test(command.version) &&
          typeof command.idempotencyKey === "string" &&
          command.idempotencyKey.trim().length > 0 &&
          command.idempotencyKey.length <= 128,
        400,
        "invalid_comment_command",
        "A comment command requires an expected version and an idempotency key.",
      );
      requireCondition(
        actor.permissions.includes("action:prepare") &&
          actor.actionCapabilities.includes("comment") &&
          (action !== "sync" || actor.permissions.includes("action:execute")),
        403,
        "comment_action_forbidden",
        "This identity cannot request the comment operation.",
      );
      const key = `progress-reply:command:${investigationContentDigest([id, actor.id, action, command.idempotencyKey])}`;
      const previous = this.options.store.get<{
        digest: string;
        result: InvestigationCommentPublicationSummary;
      }>("idempotency", key);
      const digest = investigationContentDigest({ id, action, command });
      if (previous !== undefined) {
        requireCondition(
          previous.digest === digest,
          409,
          "comment_command_conflict",
          "This idempotency key already belongs to another command.",
        );
        return previous.result;
      }
      requireCondition(
        this.#version(record) === command.version,
        409,
        "comment_version_conflict",
        "The comment changed; refresh its delivery status before retrying.",
      );
      requireCondition(
        this.#can(actor, action, record),
        409,
        "comment_action_unavailable",
        "This recovery action is not currently available for the comment.",
      );
      if (action === "sync") {
        if (record.legacyConflict) record = this.#refreshLegacy(record);
        const policy = this.#policy(record.repository.id)!;
        const grant = {
          authorizationEpoch: policy.authorizationEpoch,
          authorizedById: policy.authorizedById,
        };
        record = {
          ...record,
          grant,
          grantHistory: equal(record.grant, grant)
            ? record.grantHistory
            : [
                ...record.grantHistory,
                { ...grant, at: this.#now().toISOString(), actorId: actor.id, source: "sync" },
              ],
          state: "pending",
          reasonCode: null,
          requiresAttention: false,
          writeAttempts: 0,
          nextAttemptAt: this.#now().valueOf(),
          updatedAt: this.#now().toISOString(),
        };
        if (record.taskKind === "pr-e2e" && record.desired.reportRef !== null) {
          // Explicit synchronization may retry media publication without rerunning E2E.
          // The previous revision, body, and delivery receipts remain immutable.
          this.#accept(
            record,
            {
              ...record.desired.context,
              ...(this.options.usageSummary === undefined
                ? {}
                : { usage: this.options.usageSummary(record.taskId!) }),
            },
            record.desired.failure,
            this.#assertRevision(record.desired)!,
            `media-sync:${command.idempotencyKey}`,
            this.#now().toISOString(),
          );
          record = this.#record(record.id);
        }
      } else
        record = {
          ...record,
          reconcileRequested: true,
          readAttempts: 0,
          nextAttemptAt: this.#now().valueOf(),
          updatedAt: this.#now().toISOString(),
        };
      record = this.#store(record);
      const result = this.#summary(actor, record);
      this.options.store.insert("idempotency", key, { digest, result });
      this.#wake();
      return result;
    });
  }
  #assertTarget(record: CommentPublication): void {
    requireCondition(
      equal(
        this.options.store.get("repositories", record.repository.id) ?? null,
        record.repository,
      ),
      409,
      "progress_reply_repository_identity_changed",
      "The authorized repository identity changed.",
    );
    if (record.taskId === null) return;
    const task = this.options.store.get<InvestigationTaskV1>("tasks", record.taskId);
    const item = this.options.store.get<InvestigationWorkItemRecord>(
      "workItems",
      record.workItemId!,
    );
    requireCondition(
      task !== undefined &&
        sameTask(record, task) &&
        item !== undefined &&
        item.repositoryId === record.repository.id &&
        item.kind === record.target.kind &&
        item.number === record.target.number,
      409,
      "progress_reply_work_item_identity_changed",
      "The authorized task or conversation changed.",
    );
  }
  #assertReport(
    record: CommentPublication,
    task: InvestigationTaskV1,
    report: InvestigationResultV1,
  ): void {
    const stored = this.options.store.get<InvestigationResultV1>("reports", report.report.id);
    requireCondition(
      stored !== undefined &&
        equal(stored, report) &&
        report.context.task.id === record.taskId &&
        report.context.task.kind === record.taskKind &&
        equal(report.context.repository, record.repository) &&
        report.context.workItem.id === record.workItemId &&
        report.context.workItem.kind === record.target.kind &&
        report.context.workItem.number === record.target.number &&
        report.outcome === task.state &&
        task.latestReportRef?.id === report.report.id &&
        task.latestReportRef.version === report.report.version &&
        task.latestReportRef.digest === report.report.logicalContentDigest &&
        report.context.subjects.filter(
          (subject) =>
            subject.repositoryId === record.repository.id &&
            subject.workItemId === record.workItemId &&
            subject.kind ===
              (record.target.kind === "pull_request" ? "original_pr" : "issue_snapshot"),
        ).length === 1 &&
        (task.state !== "completed" ||
          (report.report.completeness === "complete" &&
            report.report.delivery === "final" &&
            report.report.loop.stopReason === "complete")),
      409,
      "progress_reply_report_binding_changed",
      "The task outcome does not match its complete sealed report.",
    );
  }
  #assertRevision(revision: PublicationRevision): InvestigationResultV1 | undefined {
    if (revision.reportRef === null) return undefined;
    const report = this.options.store.get<InvestigationResultV1>("reports", revision.reportRef.id);
    requireCondition(
      report !== undefined &&
        report.report.version === revision.reportRef.version &&
        report.report.logicalContentDigest === revision.reportRef.digest &&
        investigationContentDigest(report) === revision.reportDigest,
      409,
      "progress_reply_report_binding_changed",
      "The immutable source report is unavailable or changed.",
    );
    return report;
  }
  #owns(record: CommentPublication, claim: PublicationClaim): boolean {
    return (
      record.claim?.ownerId === this.#ownerId &&
      record.claim.token === claim.token &&
      record.claim.expiresAt > this.#now().valueOf()
    );
  }
  #mutate(
    id: string,
    claim: PublicationClaim,
    change: (record: CommentPublication) => CommentPublication,
  ): CommentPublication {
    return this.#atomic(() => {
      const current = this.#record(id);
      requireCondition(
        this.#owns(current, claim),
        409,
        "progress_reply_lease_lost",
        "The publication processing lease was superseded.",
      );
      const next = change(current);
      return this.#store({
        ...next,
        claim: {
          ...claim,
          expiresAt: this.#now().valueOf() + (this.options.leaseDurationMs ?? 60_000),
        },
        updatedAt: this.#now().toISOString(),
      });
    });
  }
  #assertWritable(id: string, claim: PublicationClaim): CommentPublication {
    const record = this.#record(id);
    requireCondition(
      this.#started,
      409,
      "progress_reply_publisher_stopped",
      "The publisher has stopped.",
    );
    requireCondition(
      this.#owns(record, claim),
      409,
      "progress_reply_lease_lost",
      "The publication processing lease was superseded.",
    );
    this.#assertTarget(record);
    requireCondition(
      this.options.enableExternalWrites,
      503,
      "progress_reply_publisher_disabled",
      "External publication is disabled.",
    );
    requireCondition(
      this.options.transport?.publishProgressComment !== undefined &&
        this.options.transport.reconcileProgressComment !== undefined &&
        this.options.transport.readPublisherIdentity !== undefined &&
        this.options.transport.supportedActions.includes("comment"),
      503,
      "progress_reply_transport_unavailable",
      "The verified comment publisher is unavailable.",
    );
    requireCondition(
      this.#grantValid(record),
      403,
      "progress_reply_authorization_changed",
      "The standing comment publication grant is no longer valid.",
    );
    requireCondition(
      record.state !== "conflict",
      409,
      "progress_reply_conflict_comment_identity_changed",
      "The remote comment requires a separately reviewed repair.",
    );
    if (record.confirmed === null && record.receiptId !== null) {
      requireCondition(
        record.target.githubWorkItemId !== undefined &&
          this.options.isAssignmentAuthorized !== undefined &&
          this.options.isAssignmentAuthorized({
            id: record.receiptId,
            repository: record.repository,
            target: { ...record.target, githubWorkItemId: record.target.githubWorkItemId },
            trigger: record.trigger,
            receivedAt: record.receivedAt,
            expectedAssigneeUserId: record.trigger.assigneeUserId,
            ...(record.desired.context.mode === "e2e" ? { mode: "e2e" as const } : {}),
            ...(record.desired.context.scope?.headSha === undefined
              ? {}
              : { headSha: record.desired.context.scope.headSha }),
          }),
        403,
        "progress_reply_assignment_not_current",
        "The accepted assignment no longer has its local admission grant.",
      );
    }
    return record;
  }
  async #prepare(id: string, claim: PublicationClaim): Promise<CommentPublication> {
    let record = this.#assertWritable(id, claim);
    const identity = await this.options.transport!.readPublisherIdentity!();
    record = this.#assertWritable(id, claim);
    requireCondition(
      Number.isSafeInteger(identity.githubUserId) &&
        identity.githubUserId > 0 &&
        typeof identity.githubLogin === "string" &&
        identity.githubLogin.length > 0 &&
        (record.githubIdentity === null ||
          (record.githubIdentity.githubUserId === identity.githubUserId &&
            record.githubIdentity.githubLogin.toLowerCase() ===
              identity.githubLogin.toLowerCase())),
      409,
      "progress_reply_publisher_identity_changed",
      "The verified publisher identity changed.",
    );
    let operation = record.operation;
    if (
      operation !== null &&
      operation.revision.sequence !== record.desired.sequence &&
      !operation.dispatched
    ) {
      const superseded = operation;
      record = this.#mutate(id, claim, (current) => {
        if (superseded.attemptId !== null && !superseded.finished)
          this.#deliveries.finish(superseded.attemptId, {
            state: "cancelled",
            effect: "not_sent",
            reason: publicationReason("superseded"),
          });
        return { ...current, operation: null };
      });
      operation = null;
    }
    if (operation === null) {
      const revision = record.desired;
      const report = this.#assertRevision(revision);
      let trustedMediaMarkdown: string | undefined;
      if (report !== undefined && record.taskKind === "pr-e2e") {
        const task = this.options.store.get<InvestigationTaskV1>("tasks", record.taskId!);
        requireCondition(
          task !== undefined && sameTask(record, task),
          409,
          "progress_reply_report_binding_changed",
          "The E2E task is unavailable for evidence publication.",
        );
        trustedMediaMarkdown =
          this.options.prepareReportMedia === undefined
            ? "## E2E evidence\n\nEvidence publication is unavailable. The recorded test outcome is unchanged."
            : await this.options.prepareReportMedia(report, task);
        record = this.#assertWritable(id, claim);
        requireCondition(
          record.desired.id === revision.id,
          409,
          "progress_reply_superseded",
          "A newer task update superseded this prepared comment.",
        );
        this.#assertRevision(revision);
      }
      const render = (result?: RenderedAutomaticReply) =>
        record.resultOnly && result !== undefined
          ? `${result.body}\n\n${record.marker}`
          : `${renderProgressReply({
              stage: revision.stage,
              template: revision.policy.templates[revision.stage],
              trigger: record.trigger,
              updatedAt: revision.updatedAt,
              identity: record.githubIdentity ?? identity,
              context: revision.context,
              ...(report === undefined ? {} : { report }),
              ...(result === undefined ? {} : { result }),
              ...(revision.failure === null ? {} : { failure: revision.failure }),
              ...(trustedMediaMarkdown === undefined ? {} : { trustedMediaMarkdown }),
            })}\n\n${record.marker}`;
      let body = render(
        revision.stage === "completed" && report !== undefined
          ? renderAutomaticReplyParts(
              report,
              revision.policy.resultTemplate,
              record.githubIdentity ?? identity,
              {
                ...(revision.context.usage === undefined ? {} : { usage: revision.context.usage }),
                includeUsage:
                  record.resultOnly ||
                  !revision.policy.templates[revision.stage].includes("{{usage}}"),
                ...(record.resultOnly && trustedMediaMarkdown !== undefined
                  ? { trustedMediaMarkdown }
                  : {}),
              },
            )
          : undefined,
      );
      let reasonCode: string | null = null;
      if (
        Buffer.byteLength(body, "utf8") > 60_000 &&
        revision.stage === "completed" &&
        report !== undefined
      ) {
        body = render(
          renderAutomaticReplySummaryParts(report, record.githubIdentity ?? identity, {
            ...(revision.context.usage === undefined ? {} : { usage: revision.context.usage }),
            includeUsage:
              record.resultOnly || !revision.policy.templates[revision.stage].includes("{{usage}}"),
            ...(record.resultOnly && trustedMediaMarkdown !== undefined
              ? { trustedMediaMarkdown }
              : {}),
          }),
        );
        reasonCode = "summary_only";
      }
      requireCondition(
        Buffer.byteLength(body, "utf8") <= 60_000 && body.split(record.marker).length === 2,
        400,
        "progress_reply_content_unavailable",
        "The safe comment exceeds the publication constraints.",
      );
      operation = {
        revision,
        request: {
          marker: record.marker,
          body,
          externalId: record.confirmed?.externalId ?? null,
          previousBody: record.confirmed?.body ?? null,
          ...(record.confirmed === null &&
          !record.resultOnly &&
          record.desired.context.mode !== "e2e"
            ? { expectedAssigneeUserId: record.trigger.assigneeUserId }
            : {}),
        },
        attemptId: null,
        dispatched: false,
        finished: false,
        ...(reasonCode === "summary_only" ? { limitationCode: "summary_only" as const } : {}),
      };
      const frozen = operation;
      record = this.#mutate(id, claim, (current) => ({
        ...current,
        operation: frozen,
        githubIdentity: current.githubIdentity ?? identity,
        reasonCode,
      }));
    }
    this.#assertRevision(operation.revision);
    if (operation.attemptId !== null && !operation.finished) return record;
    const frozen = operation;
    return this.#mutate(id, claim, (current) => {
      const attempt = this.#deliveries.begin(
        this.#deliveryInput(current, frozen.request.body, frozen.revision),
      );
      return {
        ...current,
        operation: { ...frozen, attemptId: attempt.id, dispatched: false, finished: false },
        state: "sending",
        writeAttempts: current.writeAttempts + 1,
        lastAttemptAt: attempt.startedAt,
        lastAttemptId: attempt.id,
      };
    });
  }
  #deliveryInput(record: CommentPublication, body: string | null, revision = record.desired) {
    return {
      commentId: record.id,
      mode: "progress" as const,
      repositoryId: record.repository.id,
      repositoryFullName: record.repository.fullName,
      workItemId: revision.workItemId === undefined ? record.workItemId : revision.workItemId,
      workItemKind: record.target.kind,
      workItemNumber: record.target.number,
      taskId: revision.taskId === undefined ? record.taskId : revision.taskId,
      sourceReceiptId: revision.receiptId === undefined ? record.receiptId : revision.receiptId,
      reportId: revision.reportRef?.id ?? null,
      operation: record.confirmed === null ? ("create" as const) : ("update" as const),
      body,
      externalId: record.confirmed?.externalId ?? null,
      settingsVersion: revision.policy.settingsVersion,
      templateVersion: revision.policy.templateVersion,
    };
  }
  #wake(): void {
    if (!this.#started) return;
    if (this.#running !== undefined) {
      this.#wakeRequested = true;
      return;
    }
    if (this.#scheduled !== undefined) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#scheduled = setImmediate(() => {
      this.#scheduled = undefined;
      void this.drain().catch(() => this.options.onError?.("progress_reply_dispatch_failed"));
    });
  }
  async #drain(): Promise<void> {
    while (this.#started) {
      const records = this.options.store
        .pagePrefix<Reference>("idempotency", pendingPrefix, maximumPending)
        .map((entry) => this.#record(entry.recordId));
      const eligibleAt = (record: CommentPublication) =>
        Math.max(record.nextAttemptAt ?? Number.POSITIVE_INFINITY, record.claim?.expiresAt ?? 0);
      const next = records.find((record) => eligibleAt(record) <= this.#now().valueOf());
      if (next === undefined) {
        const future = Math.min(...records.map(eligibleAt));
        if (Number.isFinite(future)) {
          this.#timer = setTimeout(
            () => {
              this.#timer = undefined;
              this.#wake();
            },
            Math.max(1, Math.min(2_147_483_647, future - this.#now().valueOf())),
          );
          this.#timer.unref();
        }
        return;
      }
      await this.#process(next.id);
    }
  }
  async #process(id: string): Promise<void> {
    const claimed = this.#atomic(() => {
      const record = this.#record(id);
      if (
        record.nextAttemptAt === null ||
        record.nextAttemptAt > this.#now().valueOf() ||
        (record.claim?.expiresAt ?? 0) > this.#now().valueOf()
      )
        return null;
      const claim: PublicationClaim = {
        ownerId: this.#ownerId,
        token: randomUUID(),
        expiresAt: this.#now().valueOf() + (this.options.leaseDurationMs ?? 60_000),
      };
      const next = { ...record, claim };
      this.options.store.put("idempotency", id, next);
      return next;
    });
    if (claimed === null) return;
    const claim = claimed.claim;
    const heartbeat = setInterval(
      () => {
        try {
          this.#atomic(() => {
            const current = this.#record(id);
            if (this.#owns(current, claim))
              this.options.store.put("idempotency", id, {
                ...current,
                claim: {
                  ...claim,
                  expiresAt: this.#now().valueOf() + (this.options.leaseDurationMs ?? 60_000),
                },
              });
          });
        } catch {
          this.options.onError?.("progress_reply_lease_renewal_failed");
        }
      },
      Math.max(1, Math.floor((this.options.leaseDurationMs ?? 60_000) / 3)),
    );
    heartbeat.unref();
    let dispatchGuardError: unknown;
    try {
      if (claimed.operation?.dispatched || claimed.reconcileRequested) {
        await this.#readback(id, claim);
        return;
      }
      requireCondition(
        claimed.state !== "unconfirmed",
        409,
        "progress_reply_reconciliation_incomplete",
        "The unresolved write has no recoverable request evidence.",
      );
      const record = await this.#prepare(id, claim);
      const operation = record.operation!;
      const delivery = await this.options.transport!.publishProgressComment!(
        operation.request,
        record.repository,
        record.target,
        actorFor(record),
        () => {
          try {
            const current = this.#assertWritable(id, claim);
            requireCondition(
              current.desired.id === operation.revision.id && current.operation !== null,
              409,
              "progress_reply_superseded",
              "A newer task update superseded this prepared comment.",
            );
            requireCondition(
              current.operation !== null &&
                !current.operation.dispatched &&
                equal(current.operation, operation),
              409,
              "progress_reply_operation_changed",
              "The frozen operation changed before dispatch.",
            );
            this.#assertRevision(operation.revision);
            this.#mutate(id, claim, (latest) => {
              this.#deliveries.markDispatched(operation.attemptId!);
              return { ...latest, operation: { ...operation, dispatched: true } };
            });
          } catch (error) {
            dispatchGuardError = error;
            throw error;
          }
        },
      );
      if (dispatchGuardError !== undefined) throw dispatchGuardError;
      if (this.#owns(this.#record(id), claim)) this.#finish(id, claim, delivery);
    } catch (error) {
      this.#failed(
        id,
        claim,
        dispatchGuardError ?? error,
        claimed.operation?.dispatched === true || claimed.reconcileRequested,
      );
    } finally {
      clearInterval(heartbeat);
      this.#atomic(() => {
        const current = this.#record(id);
        if (current.claim?.token === claim.token)
          this.options.store.put("idempotency", id, { ...current, claim: null });
      });
    }
  }
  #finish(
    id: string,
    claim: PublicationClaim,
    delivery: InvestigationProgressCommentDelivery,
  ): void {
    const current = this.#record(id);
    const operation = current.operation!;
    let result = classifyDelivery(delivery, operation.dispatched);
    if (
      result.effect === "applied" &&
      (!result.externalId ||
        (operation.request.externalId !== null &&
          operation.request.externalId !== result.externalId))
    )
      result = {
        ...result,
        effect: "unknown",
        state: "unknown",
        externalId: operation.request.externalId,
        reasonCode: "mutation_receipt_unverified",
        retryable: false,
      };
    this.#mutate(id, claim, (record) => {
      this.#deliveries.finish(operation.attemptId!, {
        state: result.state,
        effect: result.effect,
        externalId: result.externalId ?? operation.request.externalId,
        reason:
          result.state === "succeeded"
            ? publicationReason(operation.limitationCode ?? null)
            : publicationReason(result.reasonCode),
      });
      if (result.effect === "applied")
        return this.#confirmed(record, operation, result.externalId!, false);
      if (result.effect === "unknown")
        return {
          ...record,
          operation: { ...operation, dispatched: true, finished: true },
          state: "unconfirmed",
          reasonCode: result.reasonCode,
          readAttempts: 0,
          requiresAttention: false,
          nextAttemptAt: this.#retryAt(0, result.retryAfterMs),
        };
      const newer = record.desired.sequence > operation.revision.sequence;
      const retry = result.retryable && record.writeAttempts < (this.options.maximumAttempts ?? 3);
      const state = problemState(result.reasonCode);
      const advance = newer && state !== "conflict" && state !== "paused";
      return {
        ...record,
        operation: advance ? null : { ...operation, dispatched: false, finished: true },
        state: advance ? "pending" : retry ? "retrying" : state,
        reasonCode: advance
          ? null
          : retry || !result.retryable
            ? result.reasonCode
            : "retry_exhausted",
        requiresAttention: !advance && !retry,
        writeAttempts: advance ? 0 : record.writeAttempts,
        nextAttemptAt: advance
          ? this.#now().valueOf()
          : retry
            ? this.#retryAt(record.writeAttempts, result.retryAfterMs)
            : null,
      };
    });
  }
  #confirmed(
    record: CommentPublication,
    operation: PublicationOperation,
    externalId: string,
    explicitRead: boolean,
  ): CommentPublication {
    const newer = record.desired.sequence > operation.revision.sequence;
    const summaryOnly =
      operation.limitationCode === "summary_only" || record.reasonCode === "summary_only";
    const invalidReport = record.reasonCode === "report_binding_changed";
    const deferUsage =
      newer &&
      record.desired.taskId === operation.revision.taskId &&
      record.desired.sourceEventId.startsWith("usage:") &&
      record.desired.context.status === operation.revision.context.status &&
      record.desired.context.attemptNumber === operation.revision.context.attemptNumber;
    const deferPhase =
      newer &&
      record.desired.taskId === operation.revision.taskId &&
      record.desired.context.status === "running" &&
      operation.revision.context.status === "running" &&
      record.desired.context.attemptNumber === operation.revision.context.attemptNumber;
    const nextPhaseAt =
      operation.revision.context.status === "running"
        ? this.#now().valueOf() + (this.options.phaseIntervalMs ?? 120_000)
        : record.nextPhaseAt;
    return {
      ...record,
      confirmed: {
        revision: operation.revision,
        body: operation.request.body,
        externalId,
        attemptId: operation.attemptId,
        confirmedAt: this.#now().toISOString(),
      },
      operation:
        explicitRead &&
        record.operation !== null &&
        !record.operation.dispatched &&
        record.operation.revision.id !== operation.revision.id
          ? record.operation
          : null,
      state: invalidReport
        ? "needs_attention"
        : newer
          ? explicitRead
            ? "needs_attention"
            : "pending"
          : "synced",
      reasonCode: invalidReport
        ? "report_binding_changed"
        : newer && explicitRead
          ? "synchronization_required"
          : summaryOnly
            ? "summary_only"
            : null,
      requiresAttention: invalidReport || (newer && explicitRead),
      writeAttempts: 0,
      readAttempts: 0,
      reconcileRequested: false,
      nextAttemptAt:
        newer && !explicitRead && !invalidReport
          ? deferUsage
            ? this.#now().valueOf() + (this.options.usageIntervalMs ?? 30_000)
            : deferPhase
              ? nextPhaseAt
              : this.#now().valueOf()
          : null,
      nextPhaseAt,
    };
  }
  #failed(id: string, claim: PublicationClaim, error: unknown, readback = false): void {
    const current = this.#record(id);
    if (!this.#owns(current, claim)) return;
    if (readback) {
      this.#mutate(id, claim, (record) => {
        const attemptId = record.operation?.dispatched
          ? record.operation.attemptId
          : record.confirmed?.attemptId;
        const externalId =
          record.operation?.request.externalId ?? record.confirmed?.externalId ?? null;
        if (attemptId !== undefined && attemptId !== null)
          this.#deliveries.observe(attemptId, {
            state: "unknown",
            externalId,
            reason: publicationReason(publicCode(error)),
          });
        const attempts = record.readAttempts + 1;
        const retry = !record.reconcileRequested && attempts < (this.options.maximumAttempts ?? 3);
        return {
          ...record,
          operation: record.operation === null ? null : { ...record.operation, finished: true },
          state: "unconfirmed",
          reasonCode: retry ? publicCode(error) : "reconciliation_exhausted",
          requiresAttention: !retry,
          readAttempts: attempts,
          reconcileRequested: false,
          nextAttemptAt: retry ? this.#retryAt(attempts) : null,
        };
      });
      return;
    }
    if (current.operation?.dispatched) {
      const operation = current.operation;
      this.#mutate(id, claim, (record) => {
        if (!operation.finished && operation.attemptId !== null)
          this.#deliveries.finish(operation.attemptId, {
            state: "unknown",
            effect: "unknown",
            reason: publicationReason("mutation_response_unknown"),
          });
        const reads = record.readAttempts + (record.reconcileRequested ? 1 : 0);
        return {
          ...record,
          operation: { ...operation, finished: true },
          state: "unconfirmed",
          reasonCode: "mutation_response_unknown",
          requiresAttention:
            record.reconcileRequested || reads >= (this.options.maximumAttempts ?? 3),
          readAttempts: reads,
          reconcileRequested: false,
          nextAttemptAt:
            record.reconcileRequested || reads >= (this.options.maximumAttempts ?? 3)
              ? null
              : this.#retryAt(reads),
        };
      });
      return;
    }
    const code = publicCode(error);
    const superseded = code === "superseded";
    const stopped = !this.#started || code === "publisher_stopped";
    this.#mutate(id, claim, (record) => {
      let attemptId = record.operation?.attemptId ?? null;
      let lastAttemptAt = record.lastAttemptAt;
      let attempts = record.writeAttempts;
      if (attemptId === null || record.operation?.finished) {
        const attempt = this.#deliveries.begin(
          this.#deliveryInput(
            record,
            record.operation?.request.body ?? null,
            record.operation?.revision,
          ),
        );
        attemptId = attempt.id;
        lastAttemptAt = attempt.startedAt;
        attempts += 1;
      }
      this.#deliveries.finish(attemptId, {
        state: superseded ? "cancelled" : "failed",
        effect: "not_sent",
        reason: publicationReason(superseded ? "superseded" : stopped ? "publisher_stopped" : code),
      });
      const retryable =
        !(error instanceof InvestigationRequestError) ||
        (error.statusCode >= 500 &&
          !["publisher_disabled", "transport_unavailable"].includes(code));
      const retry =
        !superseded && !stopped && retryable && attempts < (this.options.maximumAttempts ?? 3);
      return {
        ...record,
        operation: superseded
          ? null
          : record.operation === null
            ? null
            : { ...record.operation, attemptId, finished: true, dispatched: false },
        lastAttemptAt,
        lastAttemptId: attemptId,
        writeAttempts: superseded ? 0 : attempts,
        state: superseded || stopped ? "pending" : retry ? "retrying" : problemState(code),
        reasonCode: superseded
          ? null
          : stopped
            ? "publisher_stopped"
            : retryable && !retry
              ? "retry_exhausted"
              : code,
        requiresAttention: !superseded && !stopped && !retry,
        nextAttemptAt: superseded
          ? (record.nextAttemptAt ?? this.#now().valueOf())
          : stopped
            ? this.#now().valueOf()
            : retry
              ? this.#retryAt(attempts)
              : null,
      };
    });
  }
  async #readback(id: string, claim: PublicationClaim): Promise<void> {
    const current = this.#record(id);
    this.#assertTarget(current);
    requireCondition(
      this.options.transport?.reconcileProgressComment !== undefined &&
        current.githubIdentity !== null,
      503,
      "progress_reply_transport_unavailable",
      "The read-only comment publisher is unavailable.",
    );
    const explicit = current.reconcileRequested;
    const operation: PublicationOperation | null = current.operation?.dispatched
      ? current.operation
      : current.confirmed === null
        ? null
        : {
            revision: current.confirmed.revision,
            request: {
              marker: current.marker,
              body: current.confirmed.body,
              externalId: current.confirmed.externalId,
              previousBody: current.confirmed.body,
            },
            attemptId: current.confirmed.attemptId,
            dispatched: true,
            finished: true,
          };
    requireCondition(
      operation !== null,
      409,
      "progress_reply_no_readback",
      "No known comment or unresolved write can be reconciled.",
    );
    let delivery: InvestigationProgressCommentDelivery;
    try {
      delivery = await this.options.transport.reconcileProgressComment(
        operation.request,
        current.repository,
        current.target,
        actorFor(current),
      );
    } catch {
      delivery = {
        state: "unknown",
        effect: "unknown",
        retryable: true,
        reasonCode: "github_read_failed",
        message: "Readback failed.",
        externalId: operation.request.externalId,
      };
    }
    if (!this.#owns(this.#record(id), claim)) return;
    let result = classifyDelivery(delivery, true);
    if (
      result.effect === "applied" &&
      (!result.externalId ||
        (operation.request.externalId !== null &&
          operation.request.externalId !== result.externalId))
    )
      result = {
        ...result,
        effect: "unknown",
        state: "unknown",
        externalId: operation.request.externalId,
        reasonCode: "mutation_receipt_unverified",
        retryable: false,
      };
    this.#mutate(id, claim, (record) => {
      if (operation.attemptId !== null)
        this.#deliveries.observe(operation.attemptId, {
          state: result.state,
          externalId: result.externalId ?? operation.request.externalId,
          reason: result.state === "succeeded" ? null : publicationReason(result.reasonCode),
        });
      if (result.effect === "applied" && result.externalId !== null)
        return this.#confirmed(record, operation, result.externalId, explicit);
      const conflict = problemState(result.reasonCode) === "conflict";
      const attempts = record.readAttempts + 1;
      const retry = !explicit && !conflict && attempts < (this.options.maximumAttempts ?? 3);
      return {
        ...record,
        operation: record.operation === null ? null : { ...record.operation, finished: true },
        state: conflict ? "conflict" : "unconfirmed",
        reasonCode: conflict
          ? result.reasonCode
          : attempts >= (this.options.maximumAttempts ?? 3)
            ? "reconciliation_exhausted"
            : result.reasonCode,
        requiresAttention: !retry,
        readAttempts: attempts,
        reconcileRequested: false,
        nextAttemptAt: retry ? this.#retryAt(attempts, result.retryAfterMs) : null,
      };
    });
  }
  #retryAt(attempts: number, serverDelay = 0): number {
    const delay =
      (this.options.retryDelayMs ?? 10_000) * 2 ** Math.min(Math.max(0, attempts - 1), 8);
    const jitter =
      this.options.retryDelayMs === undefined ? Math.floor(Math.random() * delay * 0.1) : 0;
    return this.#now().valueOf() + Math.max(delay + jitter, serverDelay);
  }
}
