import { randomUUID } from "node:crypto";
import type {
  InvestigationCreateTaskRequestV1,
  InvestigationTaskV1,
} from "@agentic-review/contracts";
import { investigationContentDigest } from "@agentic-review/domain";
import { InvestigationRequestError, requireCondition } from "./errors.js";
import type { InvestigationProgressTrigger } from "./progress-reply-template.js";
import type { InvestigationService } from "./service.js";
import type { InvestigationSourceImporter } from "./source-import.js";
import type { InvestigationStore } from "./store.js";
import type {
  InvestigationOperatorPrincipal,
  InvestigationRepositoryRecord,
  InvestigationWorkItemRecord,
} from "./types.js";
import type { InvestigationWebhookBinding, InvestigationWebhookConfig } from "./webhook-config.js";
import type { InvestigationWebhookDeliveryInput } from "./webhook-http.js";
import type { InvestigationWebhookSettings } from "./webhook-settings.js";

const deliveryPrefix = "webhook:delivery:";
const pendingPrefix = "webhook:pending:";
const assignmentPrefix = "webhook:assignment:";
const activeCyclePrefix = "webhook:active-cycle:";
const maximumPending = 1_000;

interface Assignment {
  readonly repository: InvestigationRepositoryRecord;
  readonly kind: "pull_request" | "issue";
  readonly number: number;
  readonly githubWorkItemId: number;
  readonly actorUserId: number;
  readonly assigneeUserId: number;
  readonly actorLogin?: string;
  readonly assigneeLogin?: string;
  readonly updatedAt: string;
  readonly baseSha?: string;
  readonly headSha?: string;
}

interface ImportedSource {
  readonly workItem: InvestigationWorkItemRecord;
  readonly snapshotRef: { id: string; digest: string };
}

/** A signed, authorized assignment scope; it is not a placeholder Task or work item. */
export interface TrustedAssignmentAdmission {
  readonly id: string;
  readonly repository: InvestigationRepositoryRecord;
  readonly target: {
    readonly id: string;
    readonly repositoryId: string;
    readonly kind: "pull_request" | "issue";
    readonly number: number;
    readonly githubWorkItemId: number;
  };
  readonly trigger: InvestigationProgressTrigger;
  readonly receivedAt: string;
  readonly expectedAssigneeUserId: number;
  readonly baseSha?: string;
  readonly headSha?: string;
}

export type AssignmentProgressState = "preparing" | "failed" | "cancelled" | "queued";

export interface InvestigationWebhookReceipt {
  readonly id: string;
  readonly deliveryId: string;
  readonly eventName: string;
  readonly payloadSha256: string;
  readonly receivedAt: string;
  readonly pendingId: string;
  readonly assignment: Assignment;
  readonly policyDigest: string;
  readonly state: "accepted" | "source_ready" | "completed" | "ignored" | "failed";
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly source: ImportedSource | null;
  readonly taskRequest: InvestigationCreateTaskRequestV1 | null;
  readonly taskId: string | null;
  readonly reason: string | null;
  readonly claim?: { readonly ownerId: string; readonly expiresAt: number };
  readonly canonicalReceiptId?: string;
  readonly admission?: TrustedAssignmentAdmission;
}

interface PendingRecord {
  readonly receiptId: string;
}

export interface InvestigationWebhookIntakeOptions {
  readonly store: InvestigationStore;
  readonly config: InvestigationWebhookConfig;
  readonly service: Pick<InvestigationService, "createImportedTask">;
  readonly importer: Pick<InvestigationSourceImporter, "importWorkItem" | "verifyAssignment">;
  readonly now?: () => number;
  readonly retryDelayMs?: number;
  readonly maximumAttempts?: number;
  readonly onError?: (code: string) => void;
  readonly settings?: Pick<InvestigationWebhookSettings, "bindings">;
  readonly claimDurationMs?: number;
  readonly onAssignmentAccepted?: (admission: TrustedAssignmentAdmission) => void;
  readonly onAssignmentChanged?: (
    admission: TrustedAssignmentAdmission,
    state: AssignmentProgressState,
    reasonCode?: string,
  ) => void;
  readonly onTaskCreated?: (
    task: InvestigationTaskV1,
    trigger: InvestigationProgressTrigger,
    created: boolean,
    admission?: TrustedAssignmentAdmission,
  ) => void;
}

function optionalLogin(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(value)
    ? value
    : undefined;
}

function progressTrigger(assignment: Assignment): InvestigationProgressTrigger {
  return {
    eventName: assignment.kind === "issue" ? "issues" : "pull_request",
    actorUserId: assignment.actorUserId,
    assigneeUserId: assignment.assigneeUserId,
    ...(assignment.actorLogin === undefined ? {} : { actorLogin: assignment.actorLogin }),
    ...(assignment.assigneeLogin === undefined ? {} : { assigneeLogin: assignment.assigneeLogin }),
  };
}

function activeCycleKey(assignment: Assignment): string {
  return `${activeCyclePrefix}${investigationContentDigest({
    repository: assignment.repository,
    githubWorkItemId: assignment.githubWorkItemId,
    kind: assignment.kind,
    number: assignment.number,
    assigneeUserId: assignment.assigneeUserId,
    ...(assignment.baseSha === undefined
      ? {}
      : { baseSha: assignment.baseSha, headSha: assignment.headSha }),
  })}`;
}

function object(value: unknown): Record<string, unknown> {
  requireCondition(
    value !== null && typeof value === "object" && !Array.isArray(value),
    400,
    "invalid_assignment",
    "An assignment webhook must contain object identities.",
  );
  return value as Record<string, unknown>;
}

function positiveId(value: unknown): number {
  requireCondition(
    typeof value === "number" && Number.isSafeInteger(value) && value > 0,
    400,
    "invalid_assignment",
    "GitHub identities must be positive numeric IDs.",
  );
  return value;
}

function sha(value: unknown): string {
  requireCondition(
    typeof value === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(value),
    400,
    "invalid_assignment",
    "PR assignment must identify exact base and head commits.",
  );
  return value;
}

/** A deployment grant for intake only; it never impersonates a console account or grants execution. */
function principal(assignment: Assignment): InvestigationOperatorPrincipal {
  return {
    id: `github-webhook:${assignment.actorUserId}`,
    displayName: `GitHub user ${assignment.actorUserId}`,
    repositoryIds: [assignment.repository.id],
    permissions: ["repository:manage", "task:create"],
    actionCapabilities: [],
    allowRepositoryExecution: false,
  };
}

/** Consumes persisted assignment deliveries. Timers retry only received events, never scan GitHub. */
export class InvestigationWebhookIntake {
  readonly #now: () => number;
  readonly #config: InvestigationWebhookConfig;
  readonly #ownerId = randomUUID();
  #started = false;
  #running: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #scheduled: NodeJS.Immediate | undefined;

  constructor(private readonly options: InvestigationWebhookIntakeOptions) {
    this.#now = options.now ?? Date.now;
    this.#config = structuredClone(options.config);
  }

  #canonical(receipt: InvestigationWebhookReceipt): InvestigationWebhookReceipt {
    if (receipt.canonicalReceiptId === undefined || receipt.canonicalReceiptId === receipt.id)
      return receipt;
    const canonical = this.options.store.get<InvestigationWebhookReceipt>(
      "idempotency",
      receipt.canonicalReceiptId,
    );
    requireCondition(
      canonical !== undefined,
      409,
      "webhook_canonical_missing",
      "The canonical assignment receipt is unavailable.",
    );
    return canonical;
  }

  #admission(receipt: InvestigationWebhookReceipt): TrustedAssignmentAdmission {
    const canonical = this.#canonical(receipt);
    if (canonical.admission !== undefined) return canonical.admission;
    const assignment = canonical.assignment;
    const existing = this.options.store.list<InvestigationWorkItemRecord>(
      "workItems",
      (item) =>
        item.repositoryId === assignment.repository.id &&
        item.kind === assignment.kind &&
        item.number === assignment.number,
    );
    requireCondition(
      existing.length <= 1,
      409,
      "work_item_identity_conflict",
      "Multiple local records identify this upstream work item.",
    );
    const target = {
      repositoryId: assignment.repository.id,
      kind: assignment.kind,
      number: assignment.number,
    };
    return {
      id: canonical.id,
      repository: structuredClone(assignment.repository),
      target: {
        id:
          canonical.source?.workItem.id ??
          existing[0]?.id ??
          `work-item:${investigationContentDigest(target).slice(0, 48)}`,
        ...target,
        githubWorkItemId: assignment.githubWorkItemId,
      },
      trigger: progressTrigger(assignment),
      receivedAt: canonical.receivedAt,
      expectedAssigneeUserId: assignment.assigneeUserId,
      ...(assignment.baseSha === undefined
        ? {}
        : { baseSha: assignment.baseSha, headSha: assignment.headSha! }),
    };
  }

  #isActive(receipt: InvestigationWebhookReceipt): boolean {
    if (receipt.state === "accepted" || receipt.state === "source_ready") return true;
    if (receipt.state !== "completed" || receipt.taskId === null) return false;
    const task = this.options.store.get<InvestigationTaskV1>("tasks", receipt.taskId);
    return task !== undefined && (task.state === "queued" || task.state === "running");
  }

  #activeReceipt(assignment: Assignment): InvestigationWebhookReceipt | undefined {
    const key = activeCycleKey(assignment);
    const indexed = this.options.store.get<PendingRecord>("idempotency", key);
    if (indexed !== undefined) {
      const receipt = this.options.store.get<InvestigationWebhookReceipt>(
        "idempotency",
        indexed.receiptId,
      );
      return receipt !== undefined && this.#isActive(receipt) ? receipt : undefined;
    }
    // Existing active receipts can join a cycle without retroactive publication enrollment.
    let latest: InvestigationWebhookReceipt | undefined;
    let afterId: string | undefined;
    for (;;) {
      const page = this.options.store.pagePrefix<InvestigationWebhookReceipt>(
        "idempotency",
        deliveryPrefix,
        500,
        false,
        afterId,
      );
      for (const receipt of page) {
        if (
          (receipt.canonicalReceiptId === undefined || receipt.canonicalReceiptId === receipt.id) &&
          activeCycleKey(receipt.assignment) === key &&
          this.#isActive(receipt) &&
          (latest === undefined || receipt.receivedAt > latest.receivedAt)
        )
          latest = receipt;
      }
      if (page.length < 500) return latest;
      afterId = page[page.length - 1]!.id;
    }
  }

  accept(input: InvestigationWebhookDeliveryInput): {
    status: "accepted" | "duplicate" | "ignored";
    reason?: string;
    taskId?: string;
  } {
    const existing = this.options.store.get<InvestigationWebhookReceipt>(
      "idempotency",
      `${deliveryPrefix}${input.deliveryId}`,
    );
    requireCondition(
      existing === undefined ||
        (existing.payloadSha256 === input.payloadSha256 && existing.eventName === input.eventName),
      409,
      "webhook_delivery_conflict",
      "This delivery ID already identifies another payload.",
    );
    if (input.eventName !== "issues" && input.eventName !== "pull_request")
      return { status: "ignored", reason: "unsupported_event" };
    const payload = object(input.payload);
    if (payload.action !== "assigned") return { status: "ignored", reason: "unsupported_action" };
    const remoteRepository = object(payload.repository);
    const githubRepositoryId = positiveId(remoteRepository.id);
    const binding = this.#bindings().find((entry) => {
      const repository = this.options.store.get<InvestigationRepositoryRecord>(
        "repositories",
        entry.repositoryId,
      );
      return (
        repository?.githubRepositoryId === githubRepositoryId &&
        repository.fullName === remoteRepository.full_name
      );
    });
    if (binding === undefined) return { status: "ignored", reason: "repository_not_configured" };
    const sender = object(payload.sender);
    const assignee = object(payload.assignee);
    const actorUserId = positiveId(sender.id);
    const assigneeUserId = positiveId(assignee.id);
    if (
      sender.type !== "User" ||
      assignee.type !== "User" ||
      assigneeUserId !== binding.reviewerUserId ||
      !binding.allowedActorUserIds.includes(actorUserId)
    )
      return { status: "ignored", reason: "assignment_not_authorized" };
    const item = object(input.eventName === "issues" ? payload.issue : payload.pull_request);
    if (item.state !== "open") return { status: "ignored", reason: "work_item_not_open" };
    requireCondition(
      input.eventName !== "issues" || item.pull_request === undefined,
      400,
      "invalid_assignment",
      "An Issue event cannot identify a pull request.",
    );
    requireCondition(
      Array.isArray(item.assignees) &&
        item.assignees.some(
          (value) =>
            value !== null &&
            typeof value === "object" &&
            "id" in value &&
            value.id === assigneeUserId,
        ),
      400,
      "invalid_assignment",
      "The assigned user must belong to the event's current assignees.",
    );
    requireCondition(
      typeof item.updated_at === "string" &&
        /^\d{4}-\d{2}-\d{2}T/u.test(item.updated_at) &&
        Number.isFinite(Date.parse(item.updated_at)),
      400,
      "invalid_assignment",
      "The assignment must include a valid source timestamp.",
    );
    const repository = this.options.store.get<InvestigationRepositoryRecord>(
      "repositories",
      binding.repositoryId,
    )!;
    const base = input.eventName === "pull_request" ? object(item.base) : null;
    const head = input.eventName === "pull_request" ? object(item.head) : null;
    if (base !== null)
      requireCondition(
        object(base.repo).id === repository.githubRepositoryId,
        400,
        "invalid_assignment",
        "The PR base repository must match the configured target.",
      );
    const assignmentIdentity: Assignment = {
      repository,
      kind: input.eventName === "issues" ? "issue" : "pull_request",
      number: positiveId(item.number),
      githubWorkItemId: positiveId(item.id),
      actorUserId,
      assigneeUserId,
      updatedAt: item.updated_at,
      ...(base === null || head === null ? {} : { baseSha: sha(base.sha), headSha: sha(head.sha) }),
    };
    const actorLogin = optionalLogin(sender.login);
    const assigneeLogin = optionalLogin(assignee.login);
    const assignment: Assignment = {
      ...assignmentIdentity,
      ...(actorLogin === undefined ? {} : { actorLogin }),
      ...(assigneeLogin === undefined ? {} : { assigneeLogin }),
    };
    const receiptId = `${deliveryPrefix}${input.deliveryId}`;
    const semanticKey = `${assignmentPrefix}${investigationContentDigest(assignmentIdentity)}`;
    const result = this.options.store.transaction(() => {
      const previous = this.options.store.get<InvestigationWebhookReceipt>(
        "idempotency",
        receiptId,
      );
      if (previous !== undefined) {
        requireCondition(
          previous.payloadSha256 === input.payloadSha256 && previous.eventName === input.eventName,
          409,
          "webhook_delivery_conflict",
          "This delivery ID already identifies another payload.",
        );
        const canonical = this.#canonical(previous);
        const active = this.#activeReceipt(canonical.assignment);
        if (
          previous.id === canonical.id &&
          canonical.state === "failed" &&
          (active === undefined || active.id === canonical.id)
        ) {
          requireCondition(
            this.options.store.countPrefix("idempotency", pendingPrefix) < maximumPending,
            503,
            "webhook_queue_full",
            "The received-event queue is full; redeliver this event later.",
          );
          const retried: InvestigationWebhookReceipt = {
            ...canonical,
            state: canonical.source === null ? "accepted" : "source_ready",
            attempts: 0,
            nextAttemptAt: this.#now(),
            reason: null,
          };
          this.options.store.put("idempotency", canonical.id, retried);
          this.options.store.put("idempotency", canonical.pendingId, { receiptId: canonical.id });
          this.options.store.put("idempotency", activeCycleKey(canonical.assignment), {
            receiptId: canonical.id,
          });
          this.options.onAssignmentChanged?.(this.#admission(retried), "preparing");
          return { status: "accepted" as const };
        }
        return {
          status: "duplicate" as const,
          ...(canonical.taskId === null ? {} : { taskId: canonical.taskId }),
        };
      }
      const duplicate = this.options.store.get<{ receiptId: string }>("idempotency", semanticKey);
      if (duplicate !== undefined) {
        const original = this.#canonical(
          this.options.store.get<InvestigationWebhookReceipt>("idempotency", duplicate.receiptId)!,
        );
        this.options.store.insert("idempotency", receiptId, {
          ...original,
          id: receiptId,
          deliveryId: input.deliveryId,
          payloadSha256: input.payloadSha256,
          receivedAt: input.receivedAt,
          canonicalReceiptId: original.id,
          assignment,
          state: "ignored",
          reason: "duplicate_assignment",
        } satisfies InvestigationWebhookReceipt);
        return {
          status: "duplicate" as const,
          ...(original.taskId === null ? {} : { taskId: original.taskId }),
        };
      }
      const active = this.#activeReceipt(assignment);
      if (active !== undefined) {
        this.options.store.insert("idempotency", receiptId, {
          ...active,
          id: receiptId,
          canonicalReceiptId: active.id,
          deliveryId: input.deliveryId,
          eventName: input.eventName,
          payloadSha256: input.payloadSha256,
          receivedAt: input.receivedAt,
          assignment,
          state: "ignored",
          reason: "active_assignment_cycle",
        } satisfies InvestigationWebhookReceipt);
        this.options.store.insert("idempotency", semanticKey, { receiptId: active.id });
        this.options.store.put("idempotency", activeCycleKey(assignment), { receiptId: active.id });
        return {
          status: "duplicate" as const,
          ...(active.taskId === null ? {} : { taskId: active.taskId }),
        };
      }
      requireCondition(
        this.options.store.countPrefix("idempotency", pendingPrefix) < maximumPending,
        503,
        "webhook_queue_full",
        "The received-event queue is full; redeliver this event later.",
      );
      const pendingId = `${pendingPrefix}${input.receivedAt}:${input.deliveryId}`;
      const receipt: InvestigationWebhookReceipt = {
        id: receiptId,
        canonicalReceiptId: receiptId,
        deliveryId: input.deliveryId,
        eventName: input.eventName,
        payloadSha256: input.payloadSha256,
        receivedAt: input.receivedAt,
        pendingId,
        assignment,
        policyDigest: investigationContentDigest(binding),
        state: "accepted",
        attempts: 0,
        nextAttemptAt: this.#now(),
        source: null,
        taskRequest: null,
        taskId: null,
        reason: null,
      };
      const admitted = { ...receipt, admission: this.#admission(receipt) };
      this.options.store.insert("idempotency", receiptId, admitted);
      this.options.store.insert("idempotency", semanticKey, { receiptId });
      this.options.store.insert("idempotency", pendingId, { receiptId } satisfies PendingRecord);
      this.options.store.put("idempotency", activeCycleKey(assignment), { receiptId });
      this.options.onAssignmentAccepted?.(admitted.admission);
      return { status: "accepted" as const };
    });
    this.#wake();
    return result;
  }

  start(): void {
    this.#started = true;
    this.#wake();
  }

  readReceipt(actor: InvestigationOperatorPrincipal, deliveryId: string) {
    const receipt = this.options.store.get<InvestigationWebhookReceipt>(
      "idempotency",
      `${deliveryPrefix}${deliveryId}`,
    );
    requireCondition(
      receipt !== undefined,
      404,
      "webhook_delivery_not_found",
      "This webhook delivery is not recorded.",
    );
    requireCondition(
      actor.repositoryIds.includes(receipt.assignment.repository.id),
      403,
      "repository_access_denied",
      "This identity cannot read the delivery's repository.",
    );
    const canonical = this.#canonical(receipt);
    return {
      deliveryId: receipt.deliveryId,
      repositoryId: receipt.assignment.repository.id,
      kind: receipt.assignment.kind,
      number: receipt.assignment.number,
      actorUserId: receipt.assignment.actorUserId,
      assigneeUserId: receipt.assignment.assigneeUserId,
      receivedAt: receipt.receivedAt,
      state: receipt.state,
      attempts: receipt.attempts,
      reason: receipt.reason,
      canonicalReceiptId: canonical.id,
      taskId: canonical.taskId,
      snapshotRef: canonical.source?.snapshotRef ?? null,
    };
  }

  async stop(): Promise<void> {
    this.#started = false;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    if (this.#scheduled !== undefined) clearImmediate(this.#scheduled);
    this.#timer = undefined;
    this.#scheduled = undefined;
    await this.#running;
  }

  /** Also lets isolated verification await all work that is currently eligible, without timer polling. */
  drain(): Promise<void> {
    if (this.#running !== undefined) return this.#running;
    this.#running = this.#drain().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  #wake(): void {
    if (!this.#started || this.#scheduled !== undefined || this.#running !== undefined) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#scheduled = setImmediate(() => {
      this.#scheduled = undefined;
      void this.drain().catch(() => this.options.onError?.("webhook_drain_failed"));
    });
  }

  #binding(assignment: Assignment): InvestigationWebhookBinding | undefined {
    const repository = this.options.store.get<InvestigationRepositoryRecord>(
      "repositories",
      assignment.repository.id,
    );
    if (
      repository === undefined ||
      investigationContentDigest(repository) !== investigationContentDigest(assignment.repository)
    )
      return undefined;
    return this.#bindings().find(
      (entry) =>
        entry.repositoryId === repository.id &&
        entry.reviewerUserId === assignment.assigneeUserId &&
        entry.allowedActorUserIds.includes(assignment.actorUserId),
    );
  }

  #bindings(): readonly InvestigationWebhookBinding[] {
    return this.options.settings?.bindings() ?? this.#config.bindings;
  }

  #owns(receipt: InvestigationWebhookReceipt): boolean {
    const current = this.options.store.get<InvestigationWebhookReceipt>("idempotency", receipt.id);
    return current?.claim?.ownerId === this.#ownerId && current.claim.expiresAt > this.#now();
  }

  #save(receipt: InvestigationWebhookReceipt, terminal = false): void {
    this.options.store.transaction(() => {
      requireCondition(
        this.#owns(receipt),
        409,
        "webhook_claim_lost",
        "The event processing lease was superseded.",
      );
      const previous = this.options.store.get<InvestigationWebhookReceipt>(
        "idempotency",
        receipt.id,
      )!;
      this.options.store.put("idempotency", receipt.id, {
        ...receipt,
        claim: {
          ownerId: this.#ownerId,
          expiresAt: terminal ? 0 : this.#now() + (this.options.claimDurationMs ?? 60_000),
        },
      });
      if (terminal) this.options.store.delete("idempotency", receipt.pendingId);
      if (
        previous.state !== receipt.state ||
        previous.reason !== receipt.reason ||
        previous.taskId !== receipt.taskId
      ) {
        if (receipt.state === "failed" || receipt.state === "ignored") {
          const cancelled =
            receipt.state === "ignored" ||
            [
              "webhook_authorization_revoked",
              "source_assignment_missing",
              "source_assignment_stale",
              "source_assignment_revision_changed",
              "source_assignment_target_changed",
            ].includes(receipt.reason ?? "");
          this.options.onAssignmentChanged?.(
            this.#admission(receipt),
            cancelled ? "cancelled" : "failed",
            receipt.reason ?? undefined,
          );
        } else if (receipt.state === "accepted" || receipt.state === "source_ready") {
          this.options.onAssignmentChanged?.(
            this.#admission(receipt),
            "preparing",
            receipt.reason ?? undefined,
          );
        } else if (
          receipt.taskId !== null &&
          this.options.store.get<InvestigationTaskV1>("tasks", receipt.taskId)?.state === "queued"
        ) {
          this.options.onAssignmentChanged?.(this.#admission(receipt), "queued");
        }
      }
    });
  }

  async #drain(): Promise<void> {
    while (this.#started) {
      const pending = this.options.store.pagePrefix<PendingRecord>(
        "idempotency",
        pendingPrefix,
        maximumPending,
      );
      const receipts = pending.map(
        (entry) =>
          this.options.store.get<InvestigationWebhookReceipt>("idempotency", entry.receiptId)!,
      );
      const eligibleAt = (entry: InvestigationWebhookReceipt) =>
        Math.max(entry.nextAttemptAt, entry.claim?.expiresAt ?? 0);
      const receipt = receipts.find((entry) => eligibleAt(entry) <= this.#now());
      if (receipt === undefined) {
        if (receipts.length > 0) {
          const delay = Math.max(1, Math.min(...receipts.map(eligibleAt)) - this.#now());
          this.#timer = setTimeout(() => {
            this.#timer = undefined;
            this.#wake();
          }, delay);
          this.#timer.unref();
        }
        return;
      }
      await this.#process(receipt);
    }
  }

  #finish(receipt: InvestigationWebhookReceipt): void {
    this.#save(receipt, true);
  }

  #recoverCommittedTask(receipt: InvestigationWebhookReceipt): boolean {
    if (receipt.taskRequest === null) return false;
    const key = `task:${principal(receipt.assignment).id}:${receipt.taskRequest.idempotencyKey}`;
    const saved = this.options.store.get<{ digest: string; entityId: string }>("idempotency", key);
    if (saved === undefined) return false;
    requireCondition(
      saved.digest === investigationContentDigest(receipt.taskRequest),
      409,
      "webhook_task_conflict",
      "The saved task request no longer matches the delivery.",
    );
    const task = this.options.store.get<InvestigationTaskV1>("tasks", saved.entityId);
    requireCondition(
      task !== undefined,
      409,
      "webhook_task_missing",
      "The saved task is unavailable.",
    );
    this.options.store.transaction(() => {
      this.options.onTaskCreated?.(
        task,
        progressTrigger(receipt.assignment),
        false,
        this.#admission(receipt),
      );
    });
    this.#finish({ ...receipt, state: "completed", taskId: task.id, reason: null });
    return true;
  }

  async #process(original: InvestigationWebhookReceipt): Promise<void> {
    const claimed = this.options.store.transaction(() => {
      const current = this.options.store.get<InvestigationWebhookReceipt>(
        "idempotency",
        original.id,
      )!;
      if ((current.claim?.expiresAt ?? 0) > this.#now() || current.nextAttemptAt > this.#now())
        return null;
      const next = {
        ...current,
        attempts: current.attempts + 1,
        claim: {
          ownerId: this.#ownerId,
          expiresAt: this.#now() + (this.options.claimDurationMs ?? 60_000),
        },
      };
      this.options.store.put("idempotency", next.id, next);
      this.options.onAssignmentChanged?.(this.#admission(next), "preparing");
      return next;
    });
    if (claimed === null) return;
    let receipt: InvestigationWebhookReceipt = claimed;
    const heartbeat = setInterval(
      () => {
        try {
          const current = this.options.store.get<InvestigationWebhookReceipt>(
            "idempotency",
            receipt.id,
          );
          if (current !== undefined && this.#owns(current)) this.#save(current);
        } catch {
          this.options.onError?.("webhook_lease_renewal_failed");
        }
      },
      Math.max(1, Math.floor((this.options.claimDurationMs ?? 60_000) / 3)),
    );
    heartbeat.unref();
    try {
      // Completing a receipt for an existing Task does not authorize any new work.
      if (this.#recoverCommittedTask(receipt)) return;
      requireCondition(
        this.#binding(receipt.assignment) !== undefined,
        403,
        "webhook_authorization_revoked",
        "The configured assignment grant no longer authorizes this delivery.",
      );
      const actor = principal(receipt.assignment);
      const request = { kind: receipt.assignment.kind, number: receipt.assignment.number };
      const expectation = {
        githubWorkItemId: receipt.assignment.githubWorkItemId,
        assigneeUserId: receipt.assignment.assigneeUserId,
        ...(receipt.assignment.baseSha === undefined
          ? {}
          : { baseSha: receipt.assignment.baseSha, headSha: receipt.assignment.headSha! }),
      };
      if (receipt.source === null) {
        const imported = await this.options.importer.importWorkItem(
          actor,
          receipt.assignment.repository.id,
          request,
          expectation,
        );
        const source: ImportedSource = {
          workItem: imported.workItem,
          snapshotRef: imported.snapshotRef,
        };
        const taskRequest: InvestigationCreateTaskRequestV1 = {
          workItemId: source.workItem.id,
          kind: request.kind === "pull_request" ? "pr-review" : "issue-investigate",
          executionMode: request.kind === "pull_request" ? "source_read" : "snapshot_only",
          idempotencyKey: `webhook-admission:${investigationContentDigest(receipt.canonicalReceiptId ?? receipt.id)}`,
        };
        receipt = { ...receipt, source, taskRequest, state: "source_ready" };
        this.#save(receipt);
      }
      if (!this.#started) return;
      if (this.#recoverCommittedTask(receipt)) return;
      requireCondition(
        this.#binding(receipt.assignment) !== undefined,
        403,
        "webhook_authorization_revoked",
        "The configured assignment grant changed while reading the source.",
      );
      await this.options.importer.verifyAssignment(
        actor,
        receipt.assignment.repository.id,
        request,
        expectation,
      );
      if (!this.#started) return;
      requireCondition(
        this.#binding(receipt.assignment) !== undefined,
        403,
        "webhook_authorization_revoked",
        "The configured assignment grant changed before task creation.",
      );
      requireCondition(
        this.#owns(receipt),
        409,
        "webhook_claim_lost",
        "The event processing lease was superseded.",
      );
      let notified = false;
      const task = await this.options.service.createImportedTask(
        actor,
        receipt.taskRequest!,
        receipt.source!,
        () => {
          requireCondition(
            this.#started && this.#owns(receipt),
            409,
            "webhook_claim_lost",
            "The event processing lease is no longer active.",
          );
          requireCondition(
            this.#binding(receipt.assignment) !== undefined,
            403,
            "webhook_authorization_revoked",
            "The assignment grant was revoked before the Task transaction committed.",
          );
        },
        (created) => {
          this.options.onTaskCreated?.(
            created,
            progressTrigger(receipt.assignment),
            true,
            this.#admission(receipt),
          );
          notified = true;
        },
      );
      if (!notified)
        this.options.store.transaction(() => {
          this.options.onTaskCreated?.(
            task,
            progressTrigger(receipt.assignment),
            false,
            this.#admission(receipt),
          );
        });
      this.#finish({ ...receipt, state: "completed", taskId: task.id, reason: null });
    } catch (error) {
      if (!this.#started || !this.#owns(receipt)) return;
      const reason =
        error instanceof InvestigationRequestError ? error.code : "webhook_preparation_failed";
      const stalePreparedSource =
        reason === "stale_subject" &&
        receipt.state === "source_ready" &&
        receipt.source !== null &&
        receipt.taskId === null;
      if (stalePreparedSource && this.#recoverCommittedTask(receipt)) return;
      const retryable =
        !(error instanceof InvestigationRequestError) ||
        error.statusCode >= 500 ||
        error.statusCode === 429 ||
        error.code === "source_changed_during_import" ||
        stalePreparedSource;
      if (retryable && receipt.attempts < (this.options.maximumAttempts ?? 3)) {
        this.#save({
          ...receipt,
          // No Task was committed. Retain the old immutable snapshot and import a complete new one.
          ...(stalePreparedSource
            ? { state: "accepted" as const, source: null, taskRequest: null }
            : {}),
          reason,
          nextAttemptAt:
            this.#now() + (this.options.retryDelayMs ?? 1_000) * 2 ** (receipt.attempts - 1),
        });
      } else {
        this.#finish({ ...receipt, state: "failed", reason });
        this.options.onError?.(reason);
      }
    } finally {
      clearInterval(heartbeat);
      this.options.store.transaction(() => {
        const current = this.options.store.get<InvestigationWebhookReceipt>(
          "idempotency",
          receipt.id,
        );
        if (current?.claim?.ownerId === this.#ownerId)
          this.options.store.put("idempotency", receipt.id, {
            ...current,
            claim: { ownerId: this.#ownerId, expiresAt: 0 },
          });
      });
    }
  }
}
