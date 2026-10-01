import { createHash, randomUUID } from "node:crypto";
import type {
  InvestigationCreateTaskRequestV1,
  InvestigationTaskV1,
  InvestigationWebhookRetryRequest,
} from "@agentic-review/contracts";
import { investigationContentDigest } from "@agentic-review/domain";
import { InvestigationRequestError, requireCondition } from "./errors.js";
import { githubIdentityUrl } from "./github-identity.js";
import type { InvestigationService } from "./service.js";
import type {
  InvestigationPullRequestRevision,
  InvestigationSourceImporter,
} from "./source-import.js";
import type { InvestigationStore } from "./store.js";
import type {
  InvestigationOperatorPrincipal,
  InvestigationRepositoryRecord,
  InvestigationWorkItemRecord,
} from "./types.js";
import type { InvestigationWebhookBinding } from "./webhook-config.js";
import {
  authorizeWebhookRetry,
  beginWebhookAttempt,
  finishWebhookAttempt,
  phaseWebhookAttempt,
  projectWebhookDelivery,
} from "./webhook-delivery-controls.js";
import type {
  InvestigationWebhookAcceptance,
  InvestigationWebhookDeliveryInput,
} from "./webhook-http.js";
import type { AssignmentProgressState, TrustedAssignmentAdmission } from "./webhook-intake.js";

const receiptPrefix = "e2e:webhook:";
const pendingPrefix = "e2e:pending:";
const terminalStates = new Set(["completed", "ignored", "failed"]);
const activeStates = new Set(["queued", "running"]);
const digest = investigationContentDigest;
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const positiveId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const loginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const commandKey = (repository: InvestigationRepositoryRecord, commentId: number) =>
  `e2e:command:${repository.githubRepositoryId}:${commentId}`;
const activeKey = (repository: InvestigationRepositoryRecord, number: number) =>
  `e2e:active:${repository.id}:${number}`;
const targetClaimKey = (receipt: InvestigationE2eReceipt) =>
  `e2e:target-claim:${receipt.repository.githubRepositoryId}:${receipt.number}`;
interface TargetClaim {
  readonly ownerId: string;
  readonly receiptId: string;
  readonly expiresAt: number;
}

/** Recognize a standalone command outside quoted, indented, fenced, or hidden Markdown. */
export function parseE2eCommand(body: string): { mentionLogin: string } | null {
  let fence: { character: string; length: number } | undefined;
  let hidden = false;
  let quoteContinuation = false;
  let htmlBlock: string | undefined;
  const commands: string[] = [];
  for (const line of body.split(/\r?\n/u)) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence !== undefined) {
      if (
        delimiter?.[1]?.[0] === fence.character &&
        delimiter[1].length >= fence.length &&
        delimiter[2]?.trim() === ""
      )
        fence = undefined;
      continue;
    }
    if (hidden || line.includes("<!--")) {
      let offset = 0;
      while (offset < line.length) {
        const boundary = line.indexOf(hidden ? "-->" : "<!--", offset);
        if (boundary < 0) break;
        offset = boundary + (hidden ? 3 : 4);
        hidden = !hidden;
      }
      continue;
    }
    if (htmlBlock !== undefined) {
      if (line.toLowerCase().includes(`</${htmlBlock}>`)) htmlBlock = undefined;
      continue;
    }
    const htmlStart = /^ {0,3}<(pre|code|script|style|textarea)(?:\s|>)/iu.exec(line);
    if (htmlStart !== null) {
      if (!line.toLowerCase().includes(`</${htmlStart[1]!.toLowerCase()}>`))
        htmlBlock = htmlStart[1]!.toLowerCase();
      continue;
    }
    if (line.trim() === "") {
      quoteContinuation = false;
      continue;
    }
    if (/^ {0,3}>/u.test(line)) {
      quoteContinuation = true;
      continue;
    }
    if (quoteContinuation || /^(?: {4}|\t)/u.test(line)) continue;
    if (delimiter !== null) {
      fence = { character: delimiter[1]![0]!, length: delimiter[1]!.length };
      continue;
    }
    const command = /^ {0,3}@([A-Za-z0-9-]+)[ \t]+e2e[ \t]*$/iu.exec(line);
    if (command?.[1] !== undefined && loginPattern.test(command[1])) commands.push(command[1]);
  }
  return commands.length === 1 ? { mentionLogin: commands[0]! } : null;
}

interface E2eSource {
  readonly workItem: InvestigationWorkItemRecord;
  readonly snapshotRef: { id: string; digest: string };
}

export interface InvestigationE2eReceipt {
  readonly id: string;
  readonly deliveryId: string;
  readonly eventName: string;
  readonly payloadSha256: string;
  readonly repository: InvestigationRepositoryRecord;
  readonly number: number;
  readonly receivedAt: string;
  readonly actorUserId: number;
  readonly actorLogin?: string;
  readonly actorAvatarUrl?: string;
  readonly reviewerUserId: number;
  readonly command: {
    readonly commentId: number;
    readonly githubIssueId: number;
    readonly mentionLogin: string;
    readonly bodySha256: string;
  } | null;
  readonly state: "accepted" | "source_ready" | "completed" | "ignored" | "failed";
  readonly reason: string | null;
  readonly taskId: string | null;
  readonly revision: InvestigationPullRequestRevision | null;
  readonly source: E2eSource | null;
  readonly taskRequest: InvestigationCreateTaskRequestV1 | null;
  readonly admission: TrustedAssignmentAdmission | null;
  readonly attempts: number;
  readonly totalAttempts?: number;
  readonly retryGeneration?: number;
  readonly nextAttemptAt: number;
  readonly claim?: { readonly ownerId: string; readonly expiresAt: number };
  readonly canonicalReceiptId?: string;
}

export interface InvestigationE2eIntakeOptions {
  readonly store: InvestigationStore;
  readonly settings: { bindings(): readonly InvestigationWebhookBinding[] };
  readonly service: Pick<InvestigationService, "createImportedTask" | "cancelTask">;
  readonly importer: Pick<
    InvestigationSourceImporter,
    "verifyE2eCommand" | "readPullRequestRevision" | "importWorkItem"
  >;
  readonly now?: () => number;
  readonly retryDelayMs?: number;
  readonly claimDurationMs?: number;
  readonly maximumAttempts?: number;
  readonly onAdmission?: (admission: TrustedAssignmentAdmission) => void;
  readonly onAdmissionChanged?: (
    admission: TrustedAssignmentAdmission,
    state: AssignmentProgressState,
    reason?: string,
  ) => void;
  readonly onTaskCreated?: (
    admission: TrustedAssignmentAdmission,
    task: InvestigationTaskV1,
  ) => void;
  readonly isOwnComment?: (repositoryId: string, commentId: number) => boolean;
  readonly onError?: (code: string) => void;
}

/** Signed comment commands have their own durable inbox and cannot reuse a static publication. */
export class InvestigationE2eIntake {
  readonly #ownerId = randomUUID();
  readonly #now: () => number;
  #started = false;
  #running: Promise<void> | undefined;
  #scheduled: NodeJS.Immediate | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: InvestigationE2eIntakeOptions) {
    this.#now = options.now ?? Date.now;
  }

  accept(input: InvestigationWebhookDeliveryInput): InvestigationWebhookAcceptance {
    if (input.eventName !== "issue_comment" && input.eventName !== "pull_request")
      return { status: "ignored", reason: "unsupported_event" };
    const payload = object(input.payload);
    const isCommand = input.eventName === "issue_comment" && payload.action === "created";
    const isRevision = input.eventName === "pull_request" && payload.action === "synchronize";
    if (!isCommand && !isRevision) return { status: "ignored", reason: "unsupported_action" };
    const id = `${receiptPrefix}${input.deliveryId}`;
    const previous = this.options.store.get<InvestigationE2eReceipt>("idempotency", id);
    if (previous !== undefined) {
      requireCondition(
        previous.payloadSha256 === input.payloadSha256 && previous.eventName === input.eventName,
        409,
        "webhook_delivery_conflict",
        "The delivery ID already identifies another payload.",
      );
      if (previous.state === "failed") {
        const retried = this.options.store.transaction(() => {
          const current = this.options.store.get<InvestigationE2eReceipt>("idempotency", id)!;
          if (current.state !== "failed")
            return {
              status: "duplicate" as const,
              ...(current.taskId === null ? {} : { taskId: current.taskId }),
            };
          requireCondition(
            this.#committedTask(current) !== undefined || this.#authorized(current),
            403,
            "e2e_authorization_revoked",
            "The repository no longer authorizes this E2E command.",
          );
          this.#requeue(current);
          return { status: "accepted" as const };
        });
        this.#wake(true);
        return retried;
      }
      const canonical =
        previous.canonicalReceiptId === undefined
          ? previous
          : this.options.store.get<InvestigationE2eReceipt>(
              "idempotency",
              previous.canonicalReceiptId,
            );
      requireCondition(
        canonical !== undefined,
        409,
        "webhook_canonical_missing",
        "The canonical E2E receipt is unavailable.",
      );
      return {
        status: "duplicate",
        ...(canonical.taskId === null ? {} : { taskId: canonical.taskId }),
      };
    }
    const remoteRepository = object(payload.repository);
    const binding = this.options.settings.bindings().find((entry) => {
      const repository = this.options.store.get<InvestigationRepositoryRecord>(
        "repositories",
        entry.repositoryId,
      );
      return (
        repository?.githubRepositoryId === remoteRepository.id &&
        repository?.fullName === remoteRepository.full_name &&
        entry.e2eEnabled === true
      );
    });
    if (binding === undefined) return { status: "ignored", reason: "e2e_not_enabled" };
    const repository = this.options.store.get<InvestigationRepositoryRecord>(
      "repositories",
      binding.repositoryId,
    )!;
    const item = object(isCommand ? payload.issue : payload.pull_request);
    const sender = object(payload.sender);
    if (
      !positiveId(item.number) ||
      !positiveId(item.id) ||
      !positiveId(sender.id) ||
      item.state !== "open"
    )
      return { status: "ignored", reason: "e2e_target_not_open" };
    let command: InvestigationE2eReceipt["command"] = null;
    if (isCommand) {
      const comment = object(payload.comment);
      const author = object(comment.user);
      if (
        item.pull_request === undefined ||
        !positiveId(comment.id) ||
        author.id !== sender.id ||
        sender.type !== "User" ||
        author.type !== "User" ||
        !binding.allowedActorUserIds.includes(sender.id)
      )
        return { status: "ignored", reason: "e2e_command_not_authorized" };
      if (this.options.isOwnComment?.(repository.id, comment.id))
        return { status: "ignored", reason: "automation_comment" };
      const parsed = typeof comment.body === "string" ? parseE2eCommand(comment.body) : null;
      if (parsed === null) return { status: "ignored", reason: "not_e2e_command" };
      command = {
        commentId: comment.id,
        githubIssueId: item.id,
        mentionLogin: parsed.mentionLogin,
        bodySha256: createHash("sha256")
          .update(comment.body as string, "utf8")
          .digest("hex"),
      };
    } else if (object(object(item.base).repo).id !== repository.githubRepositoryId)
      return { status: "ignored", reason: "e2e_repository_mismatch" };
    const actorAvatarUrl = githubIdentityUrl(sender.avatar_url);
    const receipt: InvestigationE2eReceipt = {
      id,
      deliveryId: input.deliveryId,
      eventName: input.eventName,
      payloadSha256: input.payloadSha256,
      repository,
      number: item.number,
      receivedAt: input.receivedAt,
      actorUserId: sender.id,
      ...(typeof sender.login === "string" && loginPattern.test(sender.login)
        ? { actorLogin: sender.login }
        : {}),
      ...(actorAvatarUrl === null ? {} : { actorAvatarUrl }),
      reviewerUserId: binding.reviewerUserId,
      command,
      state: "accepted",
      reason: null,
      taskId: null,
      revision: null,
      source: null,
      taskRequest: null,
      admission: null,
      attempts: 0,
      nextAttemptAt: this.#now(),
    };
    const result = this.options.store.transaction(() => {
      const concurrent = this.options.store.get<InvestigationE2eReceipt>("idempotency", id);
      if (concurrent !== undefined) {
        requireCondition(
          concurrent.payloadSha256 === input.payloadSha256 &&
            concurrent.eventName === input.eventName,
          409,
          "webhook_delivery_conflict",
          "The delivery ID already identifies another payload.",
        );
        if (concurrent.state === "failed") {
          requireCondition(
            this.#committedTask(concurrent) !== undefined || this.#authorized(concurrent),
            403,
            "e2e_authorization_revoked",
            "The repository no longer authorizes this E2E command.",
          );
          this.#requeue(concurrent);
          return { status: "accepted" as const };
        }
        return {
          status: "duplicate" as const,
          ...(concurrent.taskId === null ? {} : { taskId: concurrent.taskId }),
        };
      }
      if (command !== null) {
        const duplicate = this.options.store.get<{ receiptId: string }>(
          "idempotency",
          commandKey(repository, command.commentId),
        );
        if (duplicate !== undefined) {
          const original = this.options.store.get<InvestigationE2eReceipt>(
            "idempotency",
            duplicate.receiptId,
          )!;
          this.options.store.insert("idempotency", id, {
            ...receipt,
            canonicalReceiptId: original.id,
            state: "ignored",
            reason: "duplicate_comment",
            taskId: original.taskId,
          });
          return {
            status: "duplicate" as const,
            ...(original.taskId === null ? {} : { taskId: original.taskId }),
          };
        }
      }
      requireCondition(
        this.options.store.countPrefix("idempotency", pendingPrefix) < 1_000,
        503,
        "e2e_queue_full",
        "The E2E intake queue is full; redeliver later.",
      );
      this.options.store.insert("idempotency", id, receipt);
      this.options.store.insert("idempotency", `${pendingPrefix}${id}`, { receiptId: id });
      if (command !== null)
        this.options.store.insert("idempotency", commandKey(repository, command.commentId), {
          receiptId: id,
        });
      return { status: "accepted" as const };
    });
    this.#wake(true);
    return result;
  }

  readReceipt(actor: InvestigationOperatorPrincipal, deliveryId: string) {
    const receipt = this.options.store.get<InvestigationE2eReceipt>(
      "idempotency",
      `${receiptPrefix}${deliveryId}`,
    );
    requireCondition(
      receipt !== undefined,
      404,
      "webhook_delivery_not_found",
      "This E2E delivery is not recorded.",
    );
    return projectWebhookDelivery(this.options.store, actor, receipt);
  }

  retryReceipt(
    actor: InvestigationOperatorPrincipal,
    deliveryId: string,
    request: InvestigationWebhookRetryRequest,
  ) {
    this.options.store.transaction(() => {
      const receipt = this.options.store.get<InvestigationE2eReceipt>(
        "idempotency",
        `${receiptPrefix}${deliveryId}`,
      );
      requireCondition(
        receipt !== undefined,
        404,
        "webhook_delivery_not_found",
        "This E2E delivery is not recorded.",
      );
      const command = authorizeWebhookRetry(this.options.store, actor, receipt, request);
      if (command.replay) return;
      requireCondition(
        this.#committedTask(receipt) !== undefined || this.#authorized(receipt),
        403,
        "e2e_authorization_revoked",
        "The repository no longer authorizes this E2E command.",
      );
      this.#requeue(receipt);
      command.remember();
    });
    this.#wake(true);
    return this.readReceipt(actor, deliveryId);
  }

  #requeue(receipt: InvestigationE2eReceipt): void {
    requireCondition(
      receipt.state === "failed" &&
        (receipt.canonicalReceiptId === undefined || receipt.canonicalReceiptId === receipt.id),
      409,
      "webhook_retry_unavailable",
      "Only a failed canonical intake can be retried.",
    );
    requireCondition(
      this.options.store.countPrefix("idempotency", pendingPrefix) < 1_000,
      503,
      "e2e_queue_full",
      "The E2E intake queue is full; retry later.",
    );
    const retried: InvestigationE2eReceipt = {
      ...receipt,
      state: receipt.source === null ? "accepted" : "source_ready",
      attempts: 0,
      retryGeneration: (receipt.retryGeneration ?? 0) + 1,
      totalAttempts: receipt.totalAttempts ?? receipt.attempts,
      nextAttemptAt: this.#now(),
      reason: null,
    };
    this.options.store.put("idempotency", receipt.id, retried);
    this.options.store.put("idempotency", `${pendingPrefix}${receipt.id}`, {
      receiptId: receipt.id,
    });
    if (receipt.admission !== null)
      this.options.onAdmissionChanged?.(receipt.admission, "preparing");
  }

  hasReceipt(deliveryId: string): boolean {
    return this.options.store.has("idempotency", `${receiptPrefix}${deliveryId}`);
  }
  start(): void {
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
    this.#running = this.#drain()
      .catch((error: unknown) => {
        if (this.#started) {
          this.#timer = setTimeout(
            () => {
              this.#timer = undefined;
              this.#wake();
            },
            Math.max(1_000, this.options.retryDelayMs ?? 1_000),
          );
          this.#timer.unref();
        }
        throw error;
      })
      .finally(() => {
        this.#running = undefined;
        if (this.options.store.countPrefix("idempotency", pendingPrefix) > 0) this.#wake();
      });
    return this.#running;
  }
  #wake(immediate = false): void {
    if (
      !this.#started ||
      this.#scheduled !== undefined ||
      this.#running !== undefined ||
      (!immediate && this.#timer !== undefined)
    )
      return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#scheduled = setImmediate(() => {
      this.#scheduled = undefined;
      void this.drain().catch(() => this.options.onError?.("e2e_intake_failed"));
    });
  }
  #principal(receipt: InvestigationE2eReceipt): InvestigationOperatorPrincipal {
    return {
      id: `github-e2e:${receipt.repository.id}:${receipt.reviewerUserId}:${receipt.actorUserId}`,
      displayName: "Trusted GitHub E2E command",
      repositoryIds: [receipt.repository.id],
      permissions: ["repository:manage", "task:create", "task:cancel"],
      actionCapabilities: [],
      allowRepositoryExecution: true,
    };
  }
  #authorized(receipt: InvestigationE2eReceipt): boolean {
    const repository = this.options.store.get<InvestigationRepositoryRecord>(
      "repositories",
      receipt.repository.id,
    );
    return (
      repository !== undefined &&
      digest(repository) === digest(receipt.repository) &&
      this.options.settings
        .bindings()
        .some(
          (binding) =>
            binding.repositoryId === repository.id &&
            binding.e2eEnabled === true &&
            binding.reviewerUserId === receipt.reviewerUserId &&
            (receipt.command === null || binding.allowedActorUserIds.includes(receipt.actorUserId)),
        )
    );
  }
  #owns(receipt: InvestigationE2eReceipt): boolean {
    const current = this.options.store.get<InvestigationE2eReceipt>("idempotency", receipt.id);
    const target = this.options.store.get<TargetClaim>("idempotency", targetClaimKey(receipt));
    return (
      current?.claim?.ownerId === this.#ownerId &&
      current.claim.expiresAt > this.#now() &&
      target?.ownerId === this.#ownerId &&
      target.receiptId === receipt.id &&
      target.expiresAt > this.#now()
    );
  }
  #save(receipt: InvestigationE2eReceipt, retrying = false): void {
    requireCondition(
      this.#owns(receipt),
      409,
      "e2e_claim_lost",
      "The E2E intake lease was superseded.",
    );
    this.options.store.put("idempotency", receipt.id, receipt);
    if (terminalStates.has(receipt.state))
      this.options.store.delete("idempotency", `${pendingPrefix}${receipt.id}`);
    if (terminalStates.has(receipt.state))
      finishWebhookAttempt(
        this.options.store,
        receipt,
        receipt.state === "completed"
          ? "completed"
          : receipt.state === "ignored"
            ? "ignored"
            : "failed",
        this.#now(),
      );
    else if (retrying) finishWebhookAttempt(this.options.store, receipt, "retrying", this.#now());
  }

  #committedTask(receipt: InvestigationE2eReceipt): InvestigationTaskV1 | undefined {
    if (receipt.taskRequest === null) return undefined;
    const saved = this.options.store.get<{ digest: string; entityId: string }>(
      "idempotency",
      `task:${this.#principal(receipt).id}:${receipt.taskRequest.idempotencyKey}`,
    );
    if (saved === undefined) return undefined;
    requireCondition(
      saved.digest === digest(receipt.taskRequest),
      409,
      "webhook_task_conflict",
      "The saved Task request no longer matches this delivery.",
    );
    const task = this.options.store.get<InvestigationTaskV1>("tasks", saved.entityId);
    requireCondition(
      task !== undefined,
      409,
      "webhook_task_missing",
      "The saved Task is unavailable.",
    );
    return task;
  }

  #recoverCommittedTask(receipt: InvestigationE2eReceipt): boolean {
    const task = this.#committedTask(receipt);
    if (task === undefined) return false;
    phaseWebhookAttempt(this.options.store, receipt.id, "recovery");
    this.options.store.transaction(() => {
      // Adopt an existing Task without rechecking a command that can no longer create work.
      // A newer command may already own the active pointer; recovery must not replace it.
      const active = this.#active(receipt);
      if (active === undefined && activeStates.has(task.state))
        this.options.store.put("idempotency", activeKey(receipt.repository, receipt.number), {
          taskId: task.id,
        });
      if (receipt.admission !== null) this.options.onTaskCreated?.(receipt.admission, task);
      this.#save({ ...receipt, taskId: task.id, state: "completed", reason: null });
    });
    return true;
  }
  #active(receipt: InvestigationE2eReceipt): InvestigationTaskV1 | undefined {
    const pointer = this.options.store.get<{ taskId: string }>(
      "idempotency",
      activeKey(receipt.repository, receipt.number),
    );
    const task =
      pointer === undefined
        ? undefined
        : this.options.store.get<InvestigationTaskV1>("tasks", pointer.taskId);
    return task !== undefined && activeStates.has(task.state) ? task : undefined;
  }
  #supersede(
    receipt: InvestigationE2eReceipt,
    revision: InvestigationPullRequestRevision,
  ): InvestigationTaskV1 | undefined {
    const active = this.#active(receipt);
    if (active === undefined) return undefined;
    if (this.#matchesRevision(active, revision)) return active;
    // Cancellation follows the normal scheduler path, retaining the desktop slot until cleanup.
    try {
      this.options.service.cancelTask(this.#principal(receipt), active.id);
    } catch (error) {
      // Execution has already ended when immutable report finalization starts. Its resource
      // remains held until cleanup, but must not prevent the next revision from queueing.
      if (
        !(error instanceof InvestigationRequestError) ||
        error.code !== "terminal_analysis_accepted"
      )
        throw error;
    }
    this.options.store.put("idempotency", `e2e:superseded:${active.id}`, {
      taskId: active.id,
      reason: "pull_request_revision_changed",
      headSha: revision.headSha,
      receivedAt: receipt.receivedAt,
    });
    return undefined;
  }
  #matchesRevision(task: InvestigationTaskV1, revision: InvestigationPullRequestRevision): boolean {
    const subject = task.subjects.find((entry) => entry.id === task.subjectRef);
    return (
      subject?.kind === "original_pr" &&
      subject.baseSha === revision.baseSha &&
      subject.headSha === revision.headSha
    );
  }
  async #drain(): Promise<void> {
    while (this.#started) {
      const receipts = this.options.store
        .pagePrefix<{ receiptId: string }>("idempotency", pendingPrefix, 1_000)
        .map(
          (entry) =>
            this.options.store.get<InvestigationE2eReceipt>("idempotency", entry.receiptId)!,
        );
      const eligibleAt = (entry: InvestigationE2eReceipt) =>
        Math.max(entry.nextAttemptAt, entry.claim?.expiresAt ?? 0);
      const original = receipts.find((entry) => eligibleAt(entry) <= this.#now());
      if (original === undefined) {
        if (receipts.length > 0) {
          this.#timer = setTimeout(
            () => {
              this.#timer = undefined;
              this.#wake();
            },
            Math.max(1, Math.min(...receipts.map(eligibleAt)) - this.#now()),
          );
          this.#timer.unref();
        }
        return;
      }
      await this.#process(original);
    }
  }
  async #process(original: InvestigationE2eReceipt): Promise<void> {
    const duration = this.options.claimDurationMs ?? 60_000;
    const claimed = this.options.store.transaction(() => {
      const current = this.options.store.get<InvestigationE2eReceipt>("idempotency", original.id)!;
      if (
        terminalStates.has(current.state) ||
        !this.options.store.has("idempotency", `${pendingPrefix}${current.id}`) ||
        current.nextAttemptAt > this.#now() ||
        (current.claim?.expiresAt ?? 0) > this.#now()
      )
        return null;
      const target = this.options.store.get<TargetClaim>("idempotency", targetClaimKey(current));
      if (target !== undefined && target.expiresAt > this.#now()) {
        this.options.store.put("idempotency", current.id, {
          ...current,
          nextAttemptAt: Math.min(target.expiresAt, this.#now() + 1_000),
        });
        return null;
      }
      const claimed = {
        ...current,
        attempts: current.attempts + 1,
        totalAttempts: (current.totalAttempts ?? current.attempts) + 1,
        reason: null,
        claim: { ownerId: this.#ownerId, expiresAt: this.#now() + duration },
      };
      this.options.store.put("idempotency", claimed.id, claimed);
      beginWebhookAttempt(
        this.options.store,
        claimed.id,
        claimed.attempts,
        this.#now(),
        claimed.totalAttempts,
      );
      this.options.store.put("idempotency", targetClaimKey(claimed), {
        ownerId: this.#ownerId,
        receiptId: claimed.id,
        expiresAt: this.#now() + duration,
      } satisfies TargetClaim);
      return claimed;
    });
    if (claimed === null) return;
    let receipt: InvestigationE2eReceipt = claimed;
    const heartbeat = setInterval(
      () => {
        if (this.#owns(receipt))
          this.options.store.transaction(() => {
            receipt = {
              ...receipt,
              claim: { ownerId: this.#ownerId, expiresAt: this.#now() + duration },
            };
            this.options.store.put("idempotency", targetClaimKey(receipt), {
              ownerId: this.#ownerId,
              receiptId: receipt.id,
              expiresAt: this.#now() + duration,
            } satisfies TargetClaim);
            this.#save(receipt);
          });
      },
      Math.max(10, Math.floor(duration / 3)),
    );
    heartbeat.unref();
    try {
      if (this.#recoverCommittedTask(receipt)) return;
      requireCondition(
        receipt.attempts <= (this.options.maximumAttempts ?? 3),
        409,
        "e2e_attempts_exhausted",
        "The intake attempt limit was reached before its last failure could be acknowledged.",
      );
      requireCondition(
        this.#authorized(receipt),
        403,
        "e2e_authorization_revoked",
        "The repository no longer authorizes this E2E command.",
      );
      const actor = this.#principal(receipt);
      phaseWebhookAttempt(this.options.store, receipt.id, "source");
      const revision =
        receipt.command === null
          ? await this.options.importer.readPullRequestRevision(
              actor,
              receipt.repository.id,
              receipt.number,
            )
          : await this.options.importer.verifyE2eCommand(
              actor,
              receipt.repository.id,
              receipt.number,
              {
                ...receipt.command,
                actorUserId: receipt.actorUserId,
                reviewerUserId: receipt.reviewerUserId,
              },
            );
      if (!this.#started) return;
      requireCondition(
        this.#owns(receipt) && this.#authorized(receipt),
        403,
        "e2e_authorization_revoked",
        "The E2E authorization changed during source verification.",
      );
      if (receipt.revision !== null)
        requireCondition(
          digest(receipt.revision) === digest(revision),
          409,
          "e2e_revision_changed",
          "The PR revision changed after this E2E command was admitted.",
        );
      // The per-PR intake lease serializes this decision. cancelTask owns its own transaction.
      const active = this.#supersede(receipt, revision);
      if (receipt.command === null || active !== undefined) {
        this.options.store.transaction(() =>
          this.#save({
            ...receipt,
            revision,
            state: "completed",
            reason: active === undefined ? "revision_observed" : "active_e2e_revision",
            taskId: active?.id ?? null,
          }),
        );
        return;
      }
      const existing = this.options.store.list<InvestigationWorkItemRecord>(
        "workItems",
        (item) =>
          item.repositoryId === receipt!.repository.id &&
          item.kind === "pull_request" &&
          item.number === receipt!.number,
      );
      requireCondition(
        existing.length <= 1,
        409,
        "work_item_identity_conflict",
        "The PR maps to multiple local work items.",
      );
      const admission: TrustedAssignmentAdmission = receipt.admission ?? {
        mode: "e2e",
        id: receipt.id,
        repository: receipt.repository,
        target: {
          id:
            existing[0]?.id ??
            `work-item:${digest({ repositoryId: receipt.repository.id, kind: "pull_request", number: receipt.number }).slice(0, 48)}`,
          repositoryId: receipt.repository.id,
          kind: "pull_request",
          number: receipt.number,
          githubWorkItemId: revision.githubWorkItemId,
        },
        trigger: {
          eventName: "issue_comment",
          actorUserId: receipt.actorUserId,
          assigneeUserId: receipt.reviewerUserId,
          commandCommentId: receipt.command.commentId,
          assigneeLogin: receipt.command.mentionLogin,
          ...(receipt.actorLogin === undefined ? {} : { actorLogin: receipt.actorLogin }),
        },
        receivedAt: receipt.receivedAt,
        expectedAssigneeUserId: receipt.reviewerUserId,
        baseSha: revision.baseSha,
        headSha: revision.headSha,
      };
      if (receipt.admission === null)
        this.options.store.transaction(() => {
          receipt = { ...receipt!, revision, admission };
          this.#save(receipt);
          this.options.onAdmission?.(admission);
        });
      if (receipt.source === null) {
        const imported = await this.options.importer.importWorkItem(actor, receipt.repository.id, {
          kind: "pull_request",
          number: receipt.number,
        });
        const subject = imported.workItem.subject;
        requireCondition(
          subject.kind === "original_pr" &&
            subject.baseSha === revision.baseSha &&
            subject.headSha === revision.headSha,
          409,
          "e2e_revision_changed",
          "The PR changed while preparing E2E source.",
        );
        const taskRequest: InvestigationCreateTaskRequestV1 = {
          kind: "pr-e2e",
          executionMode: "execute",
          workItemId: imported.workItem.id,
          idempotencyKey: `e2e-comment:${receipt.repository.githubRepositoryId}:${receipt.command!.commentId}`,
        };
        receipt = {
          ...receipt,
          revision,
          admission,
          source: { workItem: imported.workItem, snapshotRef: imported.snapshotRef },
          taskRequest,
          state: "source_ready",
        };
        this.options.store.transaction(() => this.#save(receipt));
      }
      if (!this.#started) return;
      const latest = await this.options.importer.verifyE2eCommand(
        actor,
        receipt.repository.id,
        receipt.number,
        {
          ...receipt.command!,
          actorUserId: receipt.actorUserId,
          reviewerUserId: receipt.reviewerUserId,
        },
      );
      requireCondition(
        digest(latest) === digest(revision),
        409,
        "e2e_revision_changed",
        "The PR changed before E2E dispatch.",
      );
      let notified = false;
      if (this.#owns(receipt)) phaseWebhookAttempt(this.options.store, receipt.id, "task");
      const task = await this.options.service.createImportedTask(
        actor,
        receipt.taskRequest!,
        receipt.source!,
        () => {
          requireCondition(
            this.#started && this.#owns(receipt!) && this.#authorized(receipt!),
            403,
            "e2e_authorization_revoked",
            "E2E authorization was revoked before task creation.",
          );
          const currentActive = this.#active(receipt);
          // This callback already runs inside the Task creation transaction. Cancellation was
          // requested above; a running obsolete Task keeps its resource until Worker cleanup.
          requireCondition(
            currentActive === undefined || !this.#matchesRevision(currentActive, revision),
            409,
            "e2e_already_active",
            "Another E2E command already scheduled this revision.",
          );
        },
        (created) => {
          this.options.store.put("idempotency", activeKey(receipt!.repository, receipt!.number), {
            taskId: created.id,
          });
          this.options.onTaskCreated?.(admission, created);
          notified = true;
        },
      );
      this.options.store.transaction(() => {
        this.options.store.put("idempotency", activeKey(receipt!.repository, receipt!.number), {
          taskId: task.id,
        });
        if (!notified) this.options.onTaskCreated?.(admission, task);
        this.#save({ ...receipt!, taskId: task.id, state: "completed", reason: null });
      });
    } catch (error) {
      if (!this.#started || !this.#owns(receipt)) return;
      const reason =
        error instanceof InvestigationRequestError ? error.code : "e2e_preparation_failed";
      if (reason === "e2e_already_active") {
        const active = this.#active(receipt);
        this.options.store.transaction(() => {
          this.#save({ ...receipt, taskId: active?.id ?? null, state: "completed", reason });
        });
        if (receipt.admission !== null)
          this.options.onAdmissionChanged?.(receipt.admission, "cancelled", reason);
        return;
      }
      const retryable =
        !(error instanceof InvestigationRequestError) ||
        error.statusCode >= 500 ||
        error.statusCode === 429 ||
        reason === "source_changed_during_import";
      if (retryable && receipt.attempts < (this.options.maximumAttempts ?? 3)) {
        this.options.store.transaction(() =>
          this.#save(
            {
              ...receipt,
              reason,
              nextAttemptAt:
                this.#now() + (this.options.retryDelayMs ?? 1_000) * 2 ** (receipt.attempts - 1),
            },
            true,
          ),
        );
      } else {
        this.options.store.transaction(() => {
          this.#save({ ...receipt, reason, state: "failed" });
        });
        if (receipt.admission !== null)
          this.options.onAdmissionChanged?.(
            receipt.admission,
            reason.startsWith("e2e_") &&
              error instanceof InvestigationRequestError &&
              error.statusCode < 500
              ? "cancelled"
              : "failed",
            reason,
          );
        this.options.onError?.(reason);
      }
    } finally {
      clearInterval(heartbeat);
      this.options.store.transaction(() => {
        const current = this.options.store.get<InvestigationE2eReceipt>("idempotency", receipt.id);
        if (current?.claim?.ownerId === this.#ownerId)
          this.options.store.put("idempotency", current.id, {
            ...current,
            claim: { ownerId: this.#ownerId, expiresAt: 0 },
          });
        const target = this.options.store.get<TargetClaim>("idempotency", targetClaimKey(receipt));
        if (target?.ownerId === this.#ownerId && target.receiptId === receipt.id)
          this.options.store.delete("idempotency", targetClaimKey(receipt));
      });
    }
  }
}
