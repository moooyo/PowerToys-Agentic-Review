import type {
  InvestigationIntakeTriggerKind,
  InvestigationTaskV1,
  InvestigationWebhookAttempt,
  InvestigationWebhookDelivery,
  InvestigationWebhookDeliveryList,
  InvestigationWebhookDeliveryQuery,
  InvestigationWebhookRetryRequest,
} from "@agentic-review/contracts";
import { investigationContentDigest as digest } from "@agentic-review/domain";
import type { InvestigationE2eIntake, InvestigationE2eReceipt } from "./e2e-intake.js";
import { requireCondition } from "./errors.js";
import type { InvestigationStore } from "./store.js";
import type { InvestigationOperatorPrincipal } from "./types.js";
import type { InvestigationWebhookIntake, InvestigationWebhookReceipt } from "./webhook-intake.js";

type Receipt = InvestigationWebhookReceipt | InvestigationE2eReceipt;
const prefixes = ["webhook:delivery:", "e2e:webhook:"] as const;
const historyPrefix = (receiptId: string) => `webhook:attempt:${digest(receiptId)}:`;
const repositoryOf = (receipt: Receipt) =>
  "assignment" in receipt ? receipt.assignment.repository : receipt.repository;
const modeOf = (receipt: Receipt) => ("assignment" in receipt ? "static" : "e2e");

/** Lease renewals do not invalidate a console command; durable intake state changes do. */
export function webhookDeliveryVersion(receipt: Receipt): string {
  const { claim: _claim, ...durable } = receipt;
  return digest(durable);
}

function latestAttempt(store: InvestigationStore, receiptId: string) {
  return store.pagePrefix<InvestigationWebhookAttempt>(
    "idempotency",
    historyPrefix(receiptId),
    1,
    true,
  )[0];
}

/** Called inside the receipt claim transaction. A new lease never erases an old failure. */
export function beginWebhookAttempt(
  store: InvestigationStore,
  receiptId: string,
  cycleAttempt: number,
  now: number,
  totalAttempts?: number,
): void {
  const previous = latestAttempt(store, receiptId);
  if (previous?.state === "processing")
    store.put("idempotency", previous.id, {
      ...previous,
      state: "interrupted",
      finishedAt: new Date(now).toISOString(),
      reason: "intake_processing_interrupted",
    } satisfies InvestigationWebhookAttempt);
  const number = Math.max((previous?.number ?? 0) + 1, totalAttempts ?? 1);
  const attempt: InvestigationWebhookAttempt = {
    id: `${historyPrefix(receiptId)}${String(number).padStart(12, "0")}`,
    number,
    cycleAttempt,
    startedAt: new Date(now).toISOString(),
    finishedAt: null,
    state: "processing",
    phase: "authorization",
    reason: null,
    taskId: null,
  };
  store.insert("idempotency", attempt.id, attempt);
}

export function phaseWebhookAttempt(
  store: InvestigationStore,
  receiptId: string,
  phase: InvestigationWebhookAttempt["phase"],
): void {
  const attempt = latestAttempt(store, receiptId);
  if (attempt?.state === "processing") store.put("idempotency", attempt.id, { ...attempt, phase });
}

export function finishWebhookAttempt(
  store: InvestigationStore,
  receipt: Receipt,
  state: Exclude<InvestigationWebhookAttempt["state"], "processing">,
  now: number,
): void {
  const attempt = latestAttempt(store, receipt.id);
  if (attempt?.state === "processing")
    store.put("idempotency", attempt.id, {
      ...attempt,
      state,
      finishedAt: new Date(now).toISOString(),
      reason: receipt.reason,
      taskId: receipt.taskId,
    } satisfies InvestigationWebhookAttempt);
}

function history(store: InvestigationStore, receiptId: string): InvestigationWebhookAttempt[] {
  const entries: InvestigationWebhookAttempt[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = store.pagePrefix<InvestigationWebhookAttempt>(
      "idempotency",
      historyPrefix(receiptId),
      500,
      false,
      cursor,
    );
    entries.push(...page);
    if (page.length < 500) return entries;
    cursor = page.at(-1)!.id;
  }
}

function mayRetry(actor: InvestigationOperatorPrincipal, receipt: Receipt): boolean {
  return (
    actor.repositoryIds.includes(repositoryOf(receipt).id) &&
    actor.permissions.includes("repository:manage") &&
    actor.permissions.includes("task:create") &&
    (modeOf(receipt) !== "e2e" || actor.allowRepositoryExecution)
  );
}

export function projectWebhookDelivery(
  store: InvestigationStore,
  actor: InvestigationOperatorPrincipal,
  receipt: Receipt,
): InvestigationWebhookDelivery {
  const repository = repositoryOf(receipt);
  requireCondition(
    actor.repositoryIds.includes(repository.id),
    403,
    "repository_access_denied",
    "This identity cannot read the delivery's repository.",
  );
  const canonicalId = "canonicalReceiptId" in receipt ? receipt.canonicalReceiptId : undefined;
  const canonical =
    canonicalId === undefined || canonicalId === receipt.id
      ? receipt
      : store.get<Receipt>("idempotency", canonicalId);
  requireCondition(
    canonical !== undefined,
    409,
    "webhook_canonical_missing",
    "The canonical intake receipt is unavailable.",
  );
  requireCondition(
    repositoryOf(canonical).id === repository.id && modeOf(canonical) === modeOf(receipt),
    409,
    "webhook_canonical_conflict",
    "The canonical receipt belongs to another intake scope.",
  );
  const attemptHistory = history(store, receipt.id);
  const assignment = "assignment" in receipt ? receipt.assignment : undefined;
  const actorLogin =
    assignment?.actorLogin ?? ("actorLogin" in receipt ? receipt.actorLogin : undefined);
  const actorAvatarUrl =
    assignment?.actorAvatarUrl ??
    ("actorAvatarUrl" in receipt ? receipt.actorAvatarUrl : undefined);
  const assigneeLogin =
    assignment?.assigneeLogin ??
    receipt.admission?.trigger.assigneeLogin ??
    canonical.admission?.trigger.assigneeLogin;
  const task =
    canonical.taskId === null
      ? undefined
      : store.get<InvestigationTaskV1>("tasks", canonical.taskId);
  const baselineBelongsToRequest =
    assignment !== undefined &&
    task?.repository?.id === repository.id &&
    task.workItem.kind === assignment.kind &&
    task.workItem.number === assignment.number &&
    task.reviewBaseline !== undefined;
  const triggerKind: InvestigationIntakeTriggerKind =
    assignment === undefined
      ? "command" in receipt && receipt.command !== null
        ? "e2e_command"
        : "e2e_revision"
      : assignment.requestKind === "review_request"
        ? receipt.id === canonical.id && baselineBelongsToRequest
          ? "review_rerequest"
          : "review_request"
        : "assignment";
  return {
    deliveryId: receipt.deliveryId,
    version: webhookDeliveryVersion(receipt),
    mode: modeOf(receipt),
    eventName: receipt.eventName,
    repositoryId: repository.id,
    repositoryFullName: repository.fullName,
    kind: "assignment" in receipt ? receipt.assignment.kind : "pull_request",
    number: "assignment" in receipt ? receipt.assignment.number : receipt.number,
    actorUserId: "assignment" in receipt ? receipt.assignment.actorUserId : receipt.actorUserId,
    assigneeUserId:
      "assignment" in receipt ? receipt.assignment.assigneeUserId : receipt.reviewerUserId,
    triggerKind,
    ...(actorLogin === undefined ? {} : { actorLogin }),
    ...(assigneeLogin === undefined ? {} : { assigneeLogin }),
    ...(actorAvatarUrl === undefined ? {} : { actorAvatarUrl }),
    ...(assignment?.assigneeAvatarUrl === undefined
      ? {}
      : { assigneeAvatarUrl: assignment.assigneeAvatarUrl }),
    receivedAt: receipt.receivedAt,
    state: receipt.state,
    attempts: receipt.attempts,
    totalAttempts: Math.max(
      receipt.totalAttempts ?? receipt.attempts,
      attemptHistory.at(-1)?.number ?? 0,
    ),
    reason: receipt.reason,
    taskId: canonical.taskId,
    canonicalDeliveryId: canonical.deliveryId,
    snapshotRef: canonical.source?.snapshotRef ?? null,
    nextAttemptAt:
      receipt.state === "accepted" || receipt.state === "source_ready"
        ? new Date(receipt.nextAttemptAt).toISOString()
        : null,
    availableActions:
      receipt.id === canonical.id && receipt.state === "failed" && mayRetry(actor, receipt)
        ? ["retry"]
        : [],
    attemptHistory,
  };
}

/** Must run in the same transaction as requeueing. A repeated command only observes its result. */
export function authorizeWebhookRetry(
  store: InvestigationStore,
  actor: InvestigationOperatorPrincipal,
  receipt: Receipt,
  request: InvestigationWebhookRetryRequest,
): { replay: boolean; remember(): void } {
  requireCondition(
    mayRetry(actor, receipt),
    403,
    "webhook_retry_forbidden",
    "Retry requires repository management, task creation, and applicable execution permission.",
  );
  requireCondition(
    typeof request.version === "string" &&
      request.version.length > 0 &&
      request.version.length <= 128 &&
      typeof request.idempotencyKey === "string" &&
      /\S/u.test(request.idempotencyKey) &&
      request.idempotencyKey.length <= 128,
    400,
    "invalid_webhook_retry",
    "Retry requires a delivery version and an idempotency key.",
  );
  const key = `webhook:retry:${digest({ actorId: actor.id, key: request.idempotencyKey })}`;
  const commandDigest = digest({ deliveryId: receipt.deliveryId, request });
  const previous = store.get<{ digest: string }>("idempotency", key);
  if (previous !== undefined) {
    requireCondition(
      previous.digest === commandDigest,
      409,
      "webhook_retry_conflict",
      "This retry key already identifies another command.",
    );
    return { replay: true, remember: () => undefined };
  }
  requireCondition(
    request.version === webhookDeliveryVersion(receipt),
    409,
    "webhook_delivery_stale",
    "The delivery changed; reload its current state before retrying.",
  );
  requireCondition(
    receipt.state === "failed" &&
      (!("canonicalReceiptId" in receipt) ||
        receipt.canonicalReceiptId === undefined ||
        receipt.canonicalReceiptId === receipt.id),
    409,
    "webhook_retry_unavailable",
    "Only a failed canonical intake can be retried; a Task result requires a separate operation.",
  );
  return {
    replay: false,
    remember: () => store.insert("idempotency", key, { digest: commandDigest }),
  };
}

export interface InvestigationWebhookDeliveryControlsOptions {
  readonly store: InvestigationStore;
  readonly intake?: InvestigationWebhookIntake;
  readonly e2eIntake?: InvestigationE2eIntake;
}

/** Read and retry the two durable intake namespaces without mixing in comment deliveries. */
export class InvestigationWebhookDeliveryControls {
  constructor(private readonly options: InvestigationWebhookDeliveryControlsOptions) {}

  #receipt(deliveryId: string): Receipt {
    const receipts = prefixes
      .map((prefix) => this.options.store.get<Receipt>("idempotency", `${prefix}${deliveryId}`))
      .filter((receipt): receipt is Receipt => receipt !== undefined);
    requireCondition(
      receipts.length > 0,
      404,
      "webhook_delivery_not_found",
      "This delivery is not recorded.",
    );
    requireCondition(
      receipts.length === 1,
      409,
      "webhook_delivery_ambiguous",
      "This delivery has conflicting intake identities.",
    );
    return receipts[0]!;
  }

  read(actor: InvestigationOperatorPrincipal, deliveryId: string): InvestigationWebhookDelivery {
    return projectWebhookDelivery(this.options.store, actor, this.#receipt(deliveryId));
  }

  list(
    actor: InvestigationOperatorPrincipal,
    query: InvestigationWebhookDeliveryQuery = {},
  ): InvestigationWebhookDeliveryList {
    const limit = query.limit ?? 20;
    requireCondition(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 50,
      400,
      "invalid_webhook_query",
      "The page size must be between 1 and 50.",
    );
    if (query.repositoryId !== undefined)
      requireCondition(
        actor.repositoryIds.includes(query.repositoryId),
        403,
        "repository_access_denied",
        "This repository is outside the identity's scope.",
      );
    const { cursor: _cursor, limit: _limit, ...filters } = query;
    const scope = digest({ filters, repositoryIds: [...actor.repositoryIds].sort() });
    let before: { receivedAt: string; id: string } | undefined;
    if (query.cursor !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
      } catch {
        // Invalid cursors are rejected below.
      }
      const value = parsed as { scope?: unknown; receivedAt?: unknown; id?: unknown } | null;
      requireCondition(
        value !== null &&
          typeof value === "object" &&
          value.scope === scope &&
          typeof value.receivedAt === "string" &&
          Number.isFinite(Date.parse(value.receivedAt)) &&
          typeof value.id === "string" &&
          prefixes.some((prefix) => (value.id as string).startsWith(prefix)),
        400,
        "invalid_webhook_cursor",
        "The delivery cursor does not match this query and repository scope.",
      );
      before = { receivedAt: value.receivedAt as string, id: value.id as string };
    }
    const compare = (left: Receipt, right: Receipt) => {
      if (left.receivedAt !== right.receivedAt) return left.receivedAt > right.receivedAt ? -1 : 1;
      return left.id === right.id ? 0 : left.id > right.id ? -1 : 1;
    };
    const selected: Receipt[] = [];
    for (const prefix of prefixes) {
      let afterId: string | undefined;
      for (;;) {
        const page = this.options.store.pagePrefix<Receipt>(
          "idempotency",
          prefix,
          500,
          false,
          afterId,
        );
        for (const receipt of page) {
          const repository = repositoryOf(receipt);
          const kind = "assignment" in receipt ? receipt.assignment.kind : "pull_request";
          const number = "assignment" in receipt ? receipt.assignment.number : receipt.number;
          if (
            !actor.repositoryIds.includes(repository.id) ||
            (query.repositoryId !== undefined && query.repositoryId !== repository.id) ||
            (query.kind !== undefined && query.kind !== kind) ||
            (query.number !== undefined && query.number !== number) ||
            (query.state !== undefined && query.state !== receipt.state) ||
            (query.mode !== undefined && query.mode !== modeOf(receipt)) ||
            (before !== undefined &&
              (receipt.receivedAt > before.receivedAt ||
                (receipt.receivedAt === before.receivedAt && receipt.id >= before.id)))
          )
            continue;
          selected.push(receipt);
          selected.sort(compare);
          if (selected.length > limit + 1) selected.pop();
        }
        if (page.length < 500) break;
        afterId = page.at(-1)!.id;
      }
    }
    const more = selected.length > limit;
    const page = selected.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((receipt) => projectWebhookDelivery(this.options.store, actor, receipt)),
      nextCursor:
        more && last !== undefined
          ? Buffer.from(
              JSON.stringify({ scope, receivedAt: last.receivedAt, id: last.id }),
            ).toString("base64url")
          : null,
    };
  }

  retry(
    actor: InvestigationOperatorPrincipal,
    deliveryId: string,
    request: InvestigationWebhookRetryRequest,
  ): InvestigationWebhookDelivery {
    const receipt = this.#receipt(deliveryId);
    requireCondition(
      mayRetry(actor, receipt),
      403,
      "webhook_retry_forbidden",
      "Retry requires repository management, task creation, and applicable execution permission.",
    );
    const intake = "assignment" in receipt ? this.options.intake : this.options.e2eIntake;
    requireCondition(
      intake !== undefined,
      503,
      "webhook_intake_unavailable",
      "This intake is not configured.",
    );
    return intake.retryReceipt(actor, deliveryId, request);
  }
}
