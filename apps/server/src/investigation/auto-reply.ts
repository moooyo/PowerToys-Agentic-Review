import { randomUUID } from "node:crypto";
import type {
  InvestigationActionIntentV1,
  InvestigationCommentDelivery,
  InvestigationCommentPublicationSummary,
  InvestigationCreateActionIntentRequest,
  InvestigationReportRef,
  InvestigationResultV1,
  InvestigationTaskV1,
} from "@agentic-review/contracts";
import { investigationContentDigest } from "@agentic-review/domain";
import type { InvestigationActions } from "./actions.js";
import type {
  AutomaticReplyPolicy,
  InvestigationAutomaticReplySettings,
} from "./auto-reply-settings.js";
import { automaticReplyTemplateVersion, renderAutomaticReply } from "./auto-reply-template.js";
import type {
  BeginCommentDeliveryInput,
  InvestigationCommentDeliveries,
} from "./comment-deliveries.js";
import { InvestigationRequestError, requireCondition } from "./errors.js";
import type { InvestigationStore } from "./store.js";
import type {
  InvestigationGitHubIdentity,
  InvestigationOperatorPrincipal,
  InvestigationRepositoryRecord,
} from "./types.js";

export type AutomaticReplyState =
  | "pending"
  | "prepared"
  | "sending"
  | "sent"
  | "blocked"
  | "failed"
  | "unknown";
export interface AutomaticReplyReceipt {
  readonly id: string;
  readonly reportId: string;
  readonly taskId: string;
  readonly workItemId: string;
  readonly workItemKind: "pull_request" | "issue";
  readonly workItemNumber: number;
  readonly state: AutomaticReplyState;
  readonly body: string | null;
  readonly intentId: string | null;
  readonly externalId: string | null;
  readonly reason: string | null;
  readonly settingsVersion: number;
  readonly templateVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
interface AutomaticReplyRecord extends AutomaticReplyReceipt {
  readonly repository: InvestigationRepositoryRecord;
  readonly reportRef: InvestigationReportRef;
  readonly authorizedById: string;
  readonly authorizationEpoch?: number;
  readonly template?: string;
  readonly githubIdentity?: InvestigationGitHubIdentity;
  readonly request: InvestigationCreateActionIntentRequest | null;
  readonly pendingId: string;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly claim?: { readonly ownerId: string; readonly expiresAt: number };
}
interface PendingReply {
  readonly recordId: string;
}
export interface InvestigationAutomaticRepliesOptions {
  readonly store: InvestigationStore;
  readonly settings: Pick<InvestigationAutomaticReplySettings, "policy">;
  readonly actions: Pick<
    InvestigationActions,
    "findIntentByIdempotencyKey" | "createIntent" | "confirmIntent" | "reconcileIntent"
  >;
  readonly resolveOperator: (id: string) => InvestigationOperatorPrincipal | null;
  readonly resolvePublisherIdentity?: () => Promise<InvestigationGitHubIdentity>;
  readonly enableExternalWrites: boolean;
  readonly now?: () => Date;
  readonly retryDelayMs?: number;
  readonly leaseDurationMs?: number;
  readonly maximumAttempts?: number;
  readonly deliveries?: InvestigationCommentDeliveries;
  readonly onError?: (code: string) => void;
}

const recordId = (reportId: string) => `auto-reply:report:${reportId}`;
const pendingPrefix = "auto-reply:pending:";
const repositoryPrefix = (id: string) => `auto-reply:repository:${investigationContentDigest(id)}:`;
const taskPrefix = (id: string) => `auto-reply:task:${investigationContentDigest(id)}:`;
const deliveryId = (intentId: string) => `auto-reply-delivery:${intentId}`;
const maximumPending = 1000;
const equal = (left: unknown, right: unknown) =>
  investigationContentDigest(left) === investigationContentDigest(right);
const rootKinds = new Set(["pr-review", "issue-investigate"]);

function automationActor(
  repositoryId: string,
  githubIdentity?: InvestigationGitHubIdentity,
): InvestigationOperatorPrincipal {
  return {
    id: `automatic-reply:${investigationContentDigest(repositoryId).slice(0, 32)}`,
    displayName: "Automatic investigation reply",
    repositoryIds: [repositoryId],
    permissions: ["action:prepare", "action:execute"],
    actionCapabilities: ["comment"],
    allowRepositoryExecution: false,
    ...(githubIdentity === undefined ? {} : { githubIdentity }),
  };
}

/** A report-scoped durable outbox. It never discovers reports or grants authority from model data. */
export class InvestigationAutomaticReplies {
  readonly #ownerId = randomUUID();
  readonly #now: () => Date;
  #started = false;
  #running: Promise<void> | undefined;
  #scheduled: NodeJS.Immediate | undefined;
  #timer: NodeJS.Timeout | undefined;
  #wakeRequested = false;

  constructor(private readonly options: InvestigationAutomaticRepliesOptions) {
    this.#now = options.now ?? (() => new Date());
  }

  /** Called synchronously inside the transaction that seals the report. No historical backfill. */
  enqueue(report: InvestigationResultV1, task: InvestigationTaskV1): void {
    if (
      report.outcome !== "completed" ||
      report.report.completeness !== "complete" ||
      !rootKinds.has(task.kind)
    )
      return;
    const id = recordId(report.report.id);
    const existing = this.options.store.get<AutomaticReplyRecord>("idempotency", id);
    if (existing !== undefined) {
      requireCondition(
        existing.reportRef.digest === report.report.logicalContentDigest &&
          existing.taskId === task.id,
        409,
        "auto_reply_report_conflict",
        "The report identity already belongs to another automatic reply.",
      );
      return;
    }
    let policy: AutomaticReplyPolicy | null;
    try {
      policy = this.options.settings.policy(task.repository.id);
    } catch {
      this.options.onError?.("auto_reply_policy_invalid");
      return;
    }
    if (policy === null) return;
    const now = this.#now();
    const reportRef = {
      id: report.report.id,
      version: report.report.version,
      digest: report.report.logicalContentDigest,
    };
    const pendingId = `${pendingPrefix}${now.toISOString()}:${investigationContentDigest(id)}`;
    let record: AutomaticReplyRecord = {
      id,
      reportId: report.report.id,
      taskId: task.id,
      repository: structuredClone(task.repository),
      reportRef,
      workItemId: task.workItem.id,
      workItemKind: task.workItem.kind,
      workItemNumber: task.workItem.number,
      state: "pending",
      body: null,
      intentId: null,
      externalId: null,
      reason: null,
      settingsVersion: policy.version,
      templateVersion: policy.templateVersion,
      authorizedById: policy.authorizedById,
      authorizationEpoch: policy.authorizationEpoch,
      template:
        task.workItem.kind === "pull_request" ? policy.pullRequestTemplate : policy.issueTemplate,
      request: null,
      pendingId,
      attempts: 0,
      nextAttemptAt: now.valueOf(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    try {
      requireCondition(
        equal(report.context.repository, task.repository) &&
          report.context.task.id === task.id &&
          report.context.task.kind === task.kind &&
          report.context.workItem.id === task.workItem.id,
        409,
        "auto_reply_report_binding",
        "The sealed report does not match its originating Task.",
      );
      requireCondition(
        equal(policy.repository, task.repository),
        409,
        "auto_reply_repository_changed",
        "The authorized repository identity changed.",
      );
      const subjects = report.context.subjects.filter(
        (subject) =>
          subject.repositoryId === task.repository.id &&
          subject.workItemId === task.workItem.id &&
          subject.kind ===
            (task.workItem.kind === "pull_request" ? "original_pr" : "issue_snapshot"),
      );
      requireCondition(
        subjects.length === 1,
        409,
        "auto_reply_subject_ambiguous",
        "The report must bind one exact original target.",
      );
      requireCondition(
        this.options.store.countPrefix("idempotency", pendingPrefix) < maximumPending,
        503,
        "auto_reply_queue_full",
        "The automatic reply queue is full; the sealed report remains available.",
      );
    } catch (error) {
      record = {
        ...record,
        state: "blocked",
        reason:
          error instanceof InvestigationRequestError
            ? error.message
            : "The report could not be queued as a complete automatic comment.",
      };
    }
    this.options.store.insert("idempotency", id, record);
    this.options.store.insert(
      "idempotency",
      `${repositoryPrefix(task.repository.id)}${record.createdAt}:${investigationContentDigest(id)}`,
      { recordId: id } satisfies PendingReply,
    );
    if (record.state === "pending")
      this.options.store.insert("idempotency", pendingId, { recordId: id } satisfies PendingReply);
    this.#indexTask(record);
    this.#wake();
  }

  list(
    actor: InvestigationOperatorPrincipal,
    repositoryId: string,
  ): { items: AutomaticReplyReceipt[] } {
    requireCondition(
      actor.repositoryIds.includes(repositoryId),
      403,
      "repository_forbidden",
      "This identity cannot read this repository's automatic replies.",
    );
    requireCondition(
      this.options.store.has("repositories", repositoryId),
      404,
      "repository_not_found",
      "The repository is not registered.",
    );
    const references = this.options.store.pagePrefix<PendingReply>(
      "idempotency",
      repositoryPrefix(repositoryId),
      20,
      true,
    );
    return { items: references.map((reference) => this.#view(this.#record(reference.recordId))) };
  }

  getComment(
    actor: InvestigationOperatorPrincipal,
    id: string,
  ): InvestigationCommentPublicationSummary {
    const record = this.#record(id);
    requireCondition(
      actor.repositoryIds.includes(record.repository.id),
      403,
      "repository_forbidden",
      "This identity cannot read this repository's automatic replies.",
    );
    return this.#summary(record);
  }

  taskSummaries(
    actor: InvestigationOperatorPrincipal,
    taskIds: readonly string[],
  ): { items: InvestigationCommentPublicationSummary[] } {
    requireCondition(
      taskIds.length <= 100,
      400,
      "comment_task_limit",
      "At most 100 Tasks may be requested.",
    );
    const items: InvestigationCommentPublicationSummary[] = [];
    for (const taskId of new Set(taskIds)) {
      const task = this.options.store.get<InvestigationTaskV1>("tasks", taskId);
      if (task === undefined) continue;
      requireCondition(
        actor.repositoryIds.includes(task.repository.id),
        403,
        "repository_forbidden",
        "This identity cannot read this Task's automatic replies.",
      );
      const reference = this.options.store.pagePrefix<PendingReply>(
        "idempotency",
        taskPrefix(taskId),
        1,
        true,
      )[0];
      if (reference !== undefined) items.push(this.getComment(actor, reference.recordId));
    }
    return { items };
  }

  #summary(record: AutomaticReplyRecord): InvestigationCommentPublicationSummary {
    const latest = this.options.store.pageCommentDeliveries<InvestigationCommentDelivery>({
      commentId: record.id,
      limit: 1,
    })[0];
    const queued = this.options.store.has("idempotency", record.pendingId);
    const state: InvestigationCommentPublicationSummary["state"] =
      record.state === "sent"
        ? "synced"
        : record.state === "unknown"
          ? "unconfirmed"
          : record.state === "failed" || record.state === "blocked"
            ? "needs_attention"
            : record.state === "sending"
              ? "sending"
              : record.reason !== null && queued
                ? "retrying"
                : "pending";
    const requiresAttention = state === "needs_attention" || (state === "unconfirmed" && !queued);
    const reasonCode =
      state === "unconfirmed"
        ? "native_delivery_unconfirmed"
        : state === "needs_attention"
          ? "native_publication_needs_attention"
          : state === "retrying"
            ? "native_preparation_retrying"
            : null;
    const reason =
      reasonCode === null
        ? null
        : state === "retrying"
          ? "The existing native comment preparation will be retried."
          : "Review the existing native action workflow for this comment; an uncertain submission is never resent automatically.";
    const confirmed =
      latest?.observations.filter((observation) => observation.state === "succeeded").at(-1)?.at ??
      (latest?.state === "succeeded" ? latest.finishedAt : null);
    const summary: Omit<InvestigationCommentPublicationSummary, "version"> = {
      id: record.id,
      mode: "result",
      repositoryId: record.repository.id,
      repositoryFullName: record.repository.fullName,
      workItemId: record.workItemId,
      workItemKind: record.workItemKind,
      workItemNumber: record.workItemNumber,
      taskId: record.taskId,
      reportId: record.reportId,
      state,
      reasonCode,
      reason,
      requiresAttention,
      nextAttemptAt: queued ? new Date(record.nextAttemptAt).toISOString() : null,
      lastAttemptAt: latest?.startedAt ?? null,
      lastConfirmedAt: confirmed ?? null,
      externalId: record.externalId,
      commentUrl:
        record.externalId === null
          ? null
          : `https://github.com/${record.repository.fullName.split("/").map(encodeURIComponent).join("/")}/${record.workItemKind === "pull_request" ? "pull" : "issues"}/${record.workItemNumber}#issuecomment-${encodeURIComponent(record.externalId)}`,
      availableActions: [],
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
    return { ...summary, version: investigationContentDigest(summary) };
  }

  #indexTask(record: AutomaticReplyRecord): void {
    const key = `${taskPrefix(record.taskId)}${record.createdAt}:${investigationContentDigest(record.id)}`;
    if (!this.options.store.has("idempotency", key))
      this.options.store.insert("idempotency", key, { recordId: record.id } satisfies PendingReply);
  }

  #deliveryInput(
    record: AutomaticReplyRecord,
    intent: InvestigationActionIntentV1,
  ): BeginCommentDeliveryInput {
    this.#assertBinding(record, intent);
    requireCondition(
      intent.payload.kind === "feedback",
      409,
      "auto_reply_intent_binding",
      "The native comment payload is unavailable.",
    );
    const body = [
      intent.payload.body,
      ...intent.payload.drafts
        .filter((draft) => draft.suggestion === null)
        .map((draft) => draft.body),
      `<!-- agentic-review-action:${intent.id}:${intent.payloadDigest} -->`,
    ]
      .filter(Boolean)
      .join("\n\n");
    return {
      id: deliveryId(intent.id),
      commentId: record.id,
      mode: "result",
      repositoryId: record.repository.id,
      repositoryFullName: record.repository.fullName,
      workItemId: record.workItemId,
      workItemKind: record.workItemKind,
      workItemNumber: record.workItemNumber,
      taskId: record.taskId,
      reportId: record.reportId,
      operation: "create",
      body,
      settingsVersion: record.settingsVersion,
      templateVersion: record.templateVersion,
    };
  }

  #beginDelivery(record: AutomaticReplyRecord, intent: InvestigationActionIntentV1): void {
    if (
      this.options.deliveries === undefined ||
      this.options.store.has("commentDeliveries", deliveryId(intent.id))
    )
      return;
    if (intent.state !== "prepared") {
      this.#importRecord(record, intent);
      return;
    }
    this.options.deliveries.begin(this.#deliveryInput(record, intent));
  }

  #importRecord(record: AutomaticReplyRecord, intent: InvestigationActionIntentV1 | null): void {
    const deliveries = this.options.deliveries;
    if (deliveries === undefined || intent?.state === "prepared") return;
    const id =
      intent !== null
        ? deliveryId(intent.id)
        : `auto-reply-legacy:${investigationContentDigest(record.id)}`;
    if (this.options.store.has("commentDeliveries", id)) return;
    const input: BeginCommentDeliveryInput =
      intent !== null
        ? this.#deliveryInput(record, intent)
        : {
            id,
            commentId: record.id,
            mode: "result",
            repositoryId: record.repository.id,
            repositoryFullName: record.repository.fullName,
            workItemId: record.workItemId,
            workItemKind: record.workItemKind,
            workItemNumber: record.workItemNumber,
            taskId: record.taskId,
            reportId: record.reportId,
            operation: "create",
            body: record.body,
            settingsVersion: record.settingsVersion,
            templateVersion: record.templateVersion,
          };
    const state =
      intent?.state === "succeeded" || (intent === null && record.state === "sent")
        ? "succeeded"
        : intent?.state === "failed" || (intent === null && record.state === "failed")
          ? "failed"
          : "unknown";
    const externalId = intent?.result?.externalId ?? record.externalId;
    if (state === "succeeded" && externalId === null) return;
    deliveries.importLegacy({
      ...input,
      id,
      state,
      effect: state === "succeeded" ? "applied" : state === "failed" ? "rejected" : "unknown",
      externalId,
      startedAt: record.updatedAt,
      finishedAt: null,
      reason:
        "Retained native comment snapshot; earlier dispatch and receipt times are unavailable.",
    });
  }

  #importLegacy(): void {
    let afterId: string | undefined;
    for (;;) {
      const records = this.options.store.pagePrefix<AutomaticReplyRecord>(
        "idempotency",
        "auto-reply:report:",
        100,
        false,
        afterId,
      );
      for (const record of records) {
        this.#indexTask(record);
        if (!["sent", "failed", "unknown", "sending"].includes(record.state)) continue;
        try {
          const intent = this.options.actions.findIntentByIdempotencyKey(
            automationActor(record.repository.id),
            `auto-reply:${record.reportId}`,
          );
          if (record.body !== null || intent !== null) this.#importRecord(record, intent);
        } catch {
          this.options.onError?.("auto_reply_history_import_failed");
        }
      }
      if (records.length < 100) return;
      afterId = records.at(-1)!.id;
    }
  }

  #historyResult(
    record: AutomaticReplyRecord,
    intent: InvestigationActionIntentV1,
    readback = false,
  ): void {
    const deliveries = this.options.deliveries;
    if (deliveries === undefined) return;
    const id = deliveryId(intent.id);
    let saved = this.options.store.get<InvestigationCommentDelivery>("commentDeliveries", id);
    if (saved === undefined) {
      this.#importRecord(record, intent);
      return;
    }
    const state =
      intent.state === "succeeded" ? "succeeded" : intent.state === "failed" ? "failed" : "unknown";
    const result = {
      state,
      externalId: intent.result?.externalId ?? saved.externalId,
      reason:
        state === "succeeded"
          ? null
          : state === "failed"
            ? "Native comment publication failed. Review the existing action for details."
            : "Native comment delivery is unconfirmed. No duplicate submission was made.",
    } as const;
    if (readback && saved.state === "sending") {
      deliveries.finish(id, {
        state: "unknown",
        effect: "unknown",
        reason: "The native attempt has no retained response; its receipt is being reconciled.",
      });
      saved = this.options.store.get<InvestigationCommentDelivery>("commentDeliveries", id)!;
    }
    if (saved.state === "sending") deliveries.finish(id, result);
    else if (readback) deliveries.observe(id, result);
  }

  start(): void {
    this.#importLegacy();
    this.#started = true;
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
  #record(id: string): AutomaticReplyRecord {
    const record = this.options.store.get<AutomaticReplyRecord>("idempotency", id);
    requireCondition(
      record !== undefined,
      404,
      "auto_reply_not_found",
      "The automatic reply record is unavailable.",
    );
    return record;
  }
  #view(record: AutomaticReplyRecord): AutomaticReplyReceipt {
    const {
      id,
      reportId,
      taskId,
      workItemId,
      workItemKind,
      workItemNumber,
      state,
      body,
      intentId,
      externalId,
      reason,
      settingsVersion,
      templateVersion,
      createdAt,
      updatedAt,
    } = record;
    return {
      id,
      reportId,
      taskId,
      workItemId,
      workItemKind,
      workItemNumber,
      state,
      body,
      intentId,
      externalId,
      reason,
      settingsVersion,
      templateVersion,
      createdAt,
      updatedAt,
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
      void this.drain().catch(() => this.options.onError?.("auto_reply_dispatch_failed"));
    });
  }
  #owns(record: AutomaticReplyRecord): boolean {
    const current = this.#record(record.id);
    return (
      current.claim?.ownerId === this.#ownerId && current.claim.expiresAt > this.#now().valueOf()
    );
  }
  #save(record: AutomaticReplyRecord, terminal = false): void {
    this.options.store.transaction(() => {
      requireCondition(
        this.#owns(record),
        409,
        "auto_reply_claim_lost",
        "The automatic reply processing lease was superseded.",
      );
      this.options.store.put("idempotency", record.id, {
        ...record,
        updatedAt: this.#now().toISOString(),
        claim: {
          ownerId: this.#ownerId,
          expiresAt: terminal
            ? 0
            : this.#now().valueOf() + (this.options.leaseDurationMs ?? 60_000),
        },
      });
      if (terminal) this.options.store.delete("idempotency", record.pendingId);
    });
  }
  #assertRepository(record: AutomaticReplyRecord): void {
    requireCondition(
      equal(
        this.options.store.get("repositories", record.repository.id) ?? null,
        record.repository,
      ),
      409,
      "auto_reply_repository_changed",
      "The automatic reply repository identity changed.",
    );
  }
  #assertBinding(record: AutomaticReplyRecord, intent: InvestigationActionIntentV1): void {
    const request = record.request;
    requireCondition(
      request !== null &&
        intent.action === "comment" &&
        intent.actorId === automationActor(record.repository.id).id &&
        intent.repositoryId === record.repository.id &&
        intent.workItemId === record.workItemId &&
        intent.idempotencyKey === request.idempotencyKey &&
        intent.subjectRef === request.subjectRef &&
        intent.expectedRevisionKey === request.expectedRevisionKey &&
        intent.expectedHeadSha === request.expectedHeadSha &&
        equal(intent.reportRef, record.reportRef) &&
        equal(intent.payload, request.payload) &&
        intent.payloadDigest === investigationContentDigest(request.payload),
      409,
      "auto_reply_intent_binding",
      "The automatic comment no longer matches its frozen report and payload.",
    );
  }
  #assertWritable(record: AutomaticReplyRecord, intent?: InvestigationActionIntentV1): void {
    requireCondition(
      (this.#started || this.#running !== undefined) && this.#owns(record),
      409,
      "auto_reply_claim_lost",
      "The automatic reply processing lease is no longer active.",
    );
    this.#assertRepository(record);
    requireCondition(
      this.options.enableExternalWrites,
      503,
      "auto_reply_publisher_disabled",
      "External comment publication is disabled.",
    );
    const policy = this.options.settings.policy(record.repository.id);
    requireCondition(
      policy !== null &&
        equal(policy.repository, record.repository) &&
        policy.authorizedById === record.authorizedById &&
        (record.authorizationEpoch === undefined
          ? policy.version === record.settingsVersion &&
            policy.templateVersion === record.templateVersion &&
            record.templateVersion === automaticReplyTemplateVersion &&
            record.template ===
              (record.workItemKind === "pull_request"
                ? policy.pullRequestTemplate
                : policy.issueTemplate)
          : Number.isSafeInteger(record.authorizationEpoch) &&
            record.authorizationEpoch > 0 &&
            policy.authorizationEpoch === record.authorizationEpoch),
      403,
      "auto_reply_authorization_changed",
      "Automatic comment publication was disabled or its authorizing grant changed.",
    );
    const operator = this.options.resolveOperator(record.authorizedById);
    requireCondition(
      operator !== null &&
        operator.repositoryIds.includes(record.repository.id) &&
        ["repository:manage", "action:prepare", "action:execute"].every((permission) =>
          operator.permissions.includes(permission as (typeof operator.permissions)[number]),
        ) &&
        operator.actionCapabilities.includes("comment"),
      403,
      "auto_reply_authorization_revoked",
      "The account that authorized automatic comments no longer has publication permission.",
    );
    const report = this.options.store.get<InvestigationResultV1>("reports", record.reportId);
    requireCondition(
      report !== undefined &&
        report.report.version === record.reportRef.version &&
        report.report.logicalContentDigest === record.reportRef.digest &&
        report.outcome === "completed" &&
        report.report.completeness === "complete" &&
        report.context.task.id === record.taskId,
      409,
      "auto_reply_report_changed",
      "The complete sealed source report is unavailable or changed.",
    );
    if (intent !== undefined) this.#assertBinding(record, intent);
  }
  async #render(record: AutomaticReplyRecord): Promise<AutomaticReplyRecord> {
    requireCondition(
      this.options.resolvePublisherIdentity !== undefined,
      503,
      "auto_reply_identity_unavailable",
      "The comment publisher cannot verify its GitHub identity.",
    );
    const githubIdentity = await this.options.resolvePublisherIdentity();
    // Identity lookup is read-only and can outlive a policy edit or a processing lease.
    this.#assertWritable(record);
    const report = this.options.store.get<InvestigationResultV1>("reports", record.reportId)!;
    const subjects = report.context.subjects.filter(
      (subject) =>
        subject.repositoryId === record.repository.id &&
        subject.workItemId === record.workItemId &&
        subject.kind ===
          (record.workItemKind === "pull_request" ? "original_pr" : "issue_snapshot"),
    );
    requireCondition(
      subjects.length === 1 && record.template !== undefined,
      409,
      "auto_reply_subject_ambiguous",
      "The report must bind one exact original target and frozen template.",
    );
    const subject = subjects[0]!;
    const body = renderAutomaticReply(report, record.template, githubIdentity);
    const rendered: AutomaticReplyRecord = {
      ...record,
      githubIdentity,
      body,
      request: {
        idempotencyKey: `auto-reply:${record.reportId}`,
        workItemId: record.workItemId,
        action: "comment",
        subjectRef: subject.id,
        expectedRevisionKey: subject.revisionKey,
        expectedHeadSha: subject.kind === "original_pr" ? subject.headSha : null,
        reportRef: record.reportRef,
        payload: { kind: "feedback", body, findingIds: [], drafts: [] },
      },
    };
    this.#save(rendered);
    return rendered;
  }
  #finish(
    record: AutomaticReplyRecord,
    intent: InvestigationActionIntentV1,
    readback = false,
  ): boolean {
    this.#assertBinding(record, intent);
    if (intent.state !== "succeeded" && intent.state !== "failed") return false;
    this.#historyResult(record, intent, readback);
    this.#save(
      {
        ...record,
        intentId: intent.id,
        state: intent.state === "succeeded" ? "sent" : "failed",
        externalId: intent.result?.externalId ?? null,
        reason:
          intent.state === "succeeded"
            ? null
            : (intent.result?.message ?? "Comment publication failed."),
      },
      true,
    );
    return true;
  }
  async #drain(): Promise<void> {
    while (this.#started) {
      const records = this.options.store
        .pagePrefix<PendingReply>("idempotency", pendingPrefix, maximumPending)
        .map((entry) => this.#record(entry.recordId));
      const eligibleAt = (record: AutomaticReplyRecord) =>
        Math.max(record.nextAttemptAt, record.claim?.expiresAt ?? 0);
      const next = records.find((record) => eligibleAt(record) <= this.#now().valueOf());
      if (next === undefined) {
        if (records.length > 0) {
          this.#timer = setTimeout(
            () => {
              this.#timer = undefined;
              this.#wake();
            },
            Math.max(1, Math.min(...records.map(eligibleAt)) - this.#now().valueOf()),
          );
          this.#timer.unref();
        }
        return;
      }
      await this.#process(next);
    }
  }
  async #process(original: AutomaticReplyRecord): Promise<void> {
    const claimed = this.options.store.transaction(() => {
      const current = this.#record(original.id);
      if (
        (current.claim?.expiresAt ?? 0) > this.#now().valueOf() ||
        current.nextAttemptAt > this.#now().valueOf()
      )
        return null;
      const record = {
        ...current,
        attempts: current.attempts + 1,
        claim: {
          ownerId: this.#ownerId,
          expiresAt: this.#now().valueOf() + (this.options.leaseDurationMs ?? 60_000),
        },
      };
      this.options.store.put("idempotency", record.id, record);
      return record;
    });
    if (claimed === null) return;
    let record: AutomaticReplyRecord = claimed;
    let activeIntent: InvestigationActionIntentV1 | null = null;
    let historyDispatched = false;
    const attemptStartedAt = this.#now().toISOString();
    const heartbeat = setInterval(
      () => {
        try {
          const current = this.#record(record.id);
          if (this.#owns(current)) this.#save(current);
        } catch {
          this.options.onError?.("auto_reply_lease_renewal_failed");
        }
      },
      Math.max(1, Math.floor((this.options.leaseDurationMs ?? 60_000) / 3)),
    );
    heartbeat.unref();
    try {
      const recoveryActor = automationActor(record.repository.id);
      let intent = this.options.actions.findIntentByIdempotencyKey(
        recoveryActor,
        `auto-reply:${record.reportId}`,
      );
      activeIntent = intent;
      // A completed write remains completed even if the policy was subsequently revoked.
      if (intent !== null && this.#finish(record, intent, true)) return;
      if (intent !== null && (intent.state === "executing" || intent.state === "unknown")) {
        this.#assertBinding(record, intent);
        this.#assertRepository(record);
        if (!this.options.store.has("commentDeliveries", deliveryId(intent.id)))
          this.#importRecord(record, intent);
        intent = await this.options.actions.reconcileIntent(recoveryActor, intent.id);
        activeIntent = intent;
        if (this.#finish(record, intent, true)) return;
        this.#historyResult(record, intent, true);
        this.#uncertain({
          ...record,
          intentId: intent.id,
          state: "unknown",
          externalId: intent.result?.externalId ?? null,
          reason:
            intent.result?.message ??
            "The comment delivery could not be confirmed. It was not resent.",
        });
        return;
      }
      this.#assertWritable(record);
      if (record.request === null) record = await this.#render(record);
      requireCondition(
        record.request !== null && record.githubIdentity !== undefined,
        409,
        "auto_reply_request_missing",
        "The automatic reply has no frozen request and verified GitHub identity.",
      );
      const actor = automationActor(record.repository.id, record.githubIdentity);
      if (intent === null)
        intent = await this.options.actions.createIntent(actor, record.request, (candidate) =>
          this.#assertWritable(record, candidate),
        );
      activeIntent = intent;
      this.#assertBinding(record, intent);
      record = { ...record, intentId: intent.id, state: "prepared" };
      this.#save(record);
      this.#beginDelivery(record, intent);
      if (this.#finish(record, intent)) return;
      // Another lease owner may have confirmed the same intent while this one prepared it.
      if (intent.state === "executing" || intent.state === "unknown") {
        this.#historyResult(record, intent, true);
        this.#uncertain({
          ...record,
          state: "unknown",
          reason: "Delivery is being reconciled. The comment was not resent.",
        });
        return;
      }
      this.#assertWritable(record, intent);
      record = { ...record, state: "sending" };
      this.#save(record);
      intent = await this.options.actions.confirmIntent(
        actor,
        intent.id,
        { version: intent.version, payloadDigest: intent.payloadDigest },
        (candidate) => this.#assertWritable(record, candidate),
        (candidate) => {
          this.#assertWritable(record, candidate);
          activeIntent = candidate;
          if (historyDispatched || this.options.deliveries === undefined) return;
          this.options.store.transaction(() => {
            this.#assertWritable(record, candidate);
            this.options.deliveries!.markDispatched(deliveryId(candidate.id));
            historyDispatched = true;
          });
        },
      );
      activeIntent = intent;
      if (!this.#finish(record, intent)) {
        this.#historyResult(record, intent);
        this.#uncertain({
          ...record,
          state: "unknown",
          reason: intent.result?.message ?? "Delivery is unresolved. The comment was not resent.",
        });
      }
    } catch (error) {
      if (!this.#started || !this.#owns(record)) return;
      if (
        activeIntent !== null &&
        (historyDispatched ||
          activeIntent.state === "executing" ||
          activeIntent.state === "unknown")
      ) {
        try {
          const persisted = this.options.actions.findIntentByIdempotencyKey(
            automationActor(record.repository.id),
            `auto-reply:${record.reportId}`,
          );
          if (persisted !== null && this.#finish(record, persisted, true)) return;
          this.#historyResult(record, persisted ?? activeIntent, true);
        } catch {
          this.options.onError?.("auto_reply_history_recovery_failed");
        }
        this.#uncertain({
          ...record,
          intentId: activeIntent.id,
          state: "unknown",
          reason:
            "The native comment receipt is unresolved. It will only be reconciled, never resent.",
        });
        return;
      }
      const reason =
        error instanceof InvestigationRequestError
          ? error.message
          : "Automatic comment preparation failed.";
      const retryable =
        !(error instanceof InvestigationRequestError) ||
        (error.statusCode >= 500 &&
          !["auto_reply_publisher_disabled", "auto_reply_identity_unavailable"].includes(
            error.code,
          ));
      this.#preparationFailure(
        record,
        activeIntent,
        attemptStartedAt,
        retryable && record.attempts < (this.options.maximumAttempts ?? 3),
      );
      if (retryable && record.attempts < (this.options.maximumAttempts ?? 3)) {
        this.#save({
          ...record,
          reason,
          nextAttemptAt:
            this.#now().valueOf() +
            (this.options.retryDelayMs ?? 10_000) * 2 ** (record.attempts - 1),
        });
      } else {
        this.#save({ ...record, state: "blocked", reason }, true);
        this.options.onError?.(
          error instanceof InvestigationRequestError ? error.code : "auto_reply_preparation_failed",
        );
      }
    } finally {
      clearInterval(heartbeat);
      this.options.store.transaction(() => {
        const current = this.#record(record.id);
        if (current.claim?.ownerId === this.#ownerId)
          this.options.store.put("idempotency", current.id, {
            ...current,
            claim: { ownerId: this.#ownerId, expiresAt: 0 },
          });
      });
    }
  }
  #uncertain(record: AutomaticReplyRecord): void {
    const terminal = record.attempts >= (this.options.maximumAttempts ?? 3);
    this.#save(
      {
        ...record,
        nextAttemptAt:
          this.#now().valueOf() +
          (this.options.retryDelayMs ?? 10_000) * 2 ** (record.attempts - 1),
      },
      terminal,
    );
  }

  #preparationFailure(
    record: AutomaticReplyRecord,
    intent: InvestigationActionIntentV1 | null,
    startedAt: string,
    willRetry: boolean,
  ): void {
    const deliveries = this.options.deliveries;
    if (deliveries === undefined) return;
    if (
      intent === null &&
      (record.intentId !== null || record.state === "sending" || record.state === "unknown")
    )
      return;
    if (intent !== null) {
      if (intent.state !== "prepared") return;
      const saved = this.options.store.get<InvestigationCommentDelivery>(
        "commentDeliveries",
        deliveryId(intent.id),
      );
      if (!willRetry && saved?.state === "sending")
        deliveries.finish(saved.id, {
          state: "failed",
          effect: "not_sent",
          reason: "Native comment preparation stopped before dispatch.",
        });
      return;
    }
    const id = `auto-reply-preparation:${investigationContentDigest(record.id).slice(0, 32)}:${record.attempts}`;
    deliveries.begin({
      id,
      commentId: record.id,
      mode: "result",
      repositoryId: record.repository.id,
      repositoryFullName: record.repository.fullName,
      workItemId: record.workItemId,
      workItemKind: record.workItemKind,
      workItemNumber: record.workItemNumber,
      taskId: record.taskId,
      reportId: record.reportId,
      operation: "create",
      body: null,
      settingsVersion: record.settingsVersion,
      templateVersion: record.templateVersion,
      startedAt,
    });
    deliveries.finish(id, {
      state: "failed",
      effect: "not_sent",
      reason: "Automatic comment preparation failed before a native submission was available.",
    });
  }
}
