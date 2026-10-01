import {
  type InvestigationWebhookDelivery,
  InvestigationWebhookDeliveryQuerySchema,
  InvestigationWebhookRetryRequestSchema,
  type InvestigationWorkerControl,
  InvestigationWorkerControlUpdateSchema,
  isInvestigationStaticTaskKind,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import type { InvestigationApi } from "./api";
import { InvestigationHttpError } from "./transport";

const repositoryId = "repo-powertoys-fork";
const sampleTime = "2026-09-19T03:00:00.000Z";

export function sampleWorkers(now = new Date().toISOString()): InvestigationWorkerControl[] {
  const base: InvestigationWorkerControl = {
    id: "sample-static-worker",
    displayName: "Static Review Worker",
    repositoryIds: [repositoryId],
    e2eEnabled: false,
    version: 1,
    updatedAt: sampleTime,
    updatedBy: null,
    lastSeenAt: now,
    advertisedKinds: ["pr-review", "issue-investigate"],
    effectiveKinds: ["pr-review", "issue-investigate"],
    status: "static_only",
    contactStatus: "recent",
    activityStatus: "online",
    activeTaskIds: [],
    activeE2eTaskIds: [],
    cleanupPendingAttemptIds: [],
  };
  return [
    base,
    {
      ...structuredClone(base),
      id: "sample-desktop-worker",
      displayName: "Windows Desktop Worker",
      e2eEnabled: true,
      advertisedKinds: ["pr-review", "issue-investigate", "pr-e2e"],
      effectiveKinds: ["pr-review", "issue-investigate", "pr-e2e"],
      status: "e2e_enabled",
    },
    {
      ...structuredClone(base),
      id: "sample-new-worker",
      displayName: "New Review Worker",
      lastSeenAt: null,
      contactStatus: "never",
      activityStatus: "offline",
      advertisedKinds: null,
      effectiveKinds: [],
    },
  ];
}

export function sampleWebhookDeliveries(): InvestigationWebhookDelivery[] {
  const failed: InvestigationWebhookDelivery = {
    deliveryId: "sample-webhook-task-failed",
    version: "sample-webhook-task-failed-v1",
    mode: "static",
    eventName: "pull_request",
    repositoryId,
    repositoryFullName: "moooyo/PowerToys",
    kind: "pull_request",
    number: 2103,
    actorUserId: 100,
    assigneeUserId: 200,
    receivedAt: sampleTime,
    state: "failed",
    attempts: 3,
    totalAttempts: 3,
    reason: "The synthetic task store was temporarily unavailable. No task was created.",
    taskId: null,
    canonicalDeliveryId: "sample-webhook-task-failed",
    snapshotRef: { id: "sample-webhook-snapshot", digest: "a".repeat(64) },
    nextAttemptAt: null,
    availableActions: ["retry"],
    attemptHistory: [1, 2, 3].map((number) => ({
      id: `sample-webhook-task-failed-attempt-${number}`,
      number,
      cycleAttempt: number,
      startedAt: sampleTime,
      finishedAt: sampleTime,
      state: number === 3 ? "failed" : "retrying",
      phase: "task",
      reason: "The synthetic task store was temporarily unavailable.",
      taskId: null,
    })),
  };
  return [
    failed,
    {
      ...structuredClone(failed),
      deliveryId: "sample-webhook-e2e-failed",
      version: "sample-webhook-e2e-failed-v1",
      mode: "e2e",
      eventName: "issue_comment",
      number: 2102,
      canonicalDeliveryId: "sample-webhook-e2e-failed",
      attempts: 1,
      totalAttempts: 1,
      reason: "The synthetic source provider is unavailable. No E2E task was created.",
      snapshotRef: null,
      attemptHistory: [
        {
          id: "sample-webhook-e2e-failed-attempt-1",
          number: 1,
          cycleAttempt: 1,
          startedAt: sampleTime,
          finishedAt: sampleTime,
          state: "failed",
          phase: "source",
          reason: "The synthetic source provider is unavailable.",
          taskId: null,
        },
      ],
    },
    {
      ...structuredClone(failed),
      deliveryId: "sample-webhook-completed",
      version: "sample-webhook-completed-v1",
      canonicalDeliveryId: "sample-webhook-completed",
      number: 2101,
      state: "completed",
      attempts: 1,
      totalAttempts: 1,
      reason: null,
      taskId: "sample-pr-p1-task",
      availableActions: [],
      attemptHistory: [
        {
          id: "sample-webhook-completed-attempt-1",
          number: 1,
          cycleAttempt: 1,
          startedAt: sampleTime,
          finishedAt: sampleTime,
          state: "completed",
          phase: "task",
          reason: null,
          taskId: "sample-pr-p1-task",
        },
      ],
    },
  ];
}

type OperationsApi = Pick<
  InvestigationApi,
  "workers" | "updateWorkerE2e" | "webhookDeliveries" | "webhookDelivery" | "retryWebhookDelivery"
>;

/** In-memory operational examples never dispatch tasks or contact GitHub. */
export function createSampleOperationsApi(): OperationsApi {
  const workers = new Map(sampleWorkers().map((worker) => [worker.id, worker]));
  const deliveries = new Map(
    sampleWebhookDeliveries().map((delivery) => [delivery.deliveryId, delivery]),
  );
  const retryRequests = new Map<string, { deliveryId: string; version: string }>();
  const delivery = (id: string) => {
    const item = deliveries.get(id);
    if (!item) throw new InvestigationHttpError(404, "The sample webhook event was not found.");
    return item;
  };
  return {
    workers: async () => structuredClone({ items: [...workers.values()] }),
    updateWorkerE2e: async (id, input) => {
      if (!Value.Check(InvestigationWorkerControlUpdateSchema, input))
        throw new InvestigationHttpError(400, "The worker setting is invalid.");
      const worker = workers.get(id);
      if (!worker) throw new InvestigationHttpError(404, "The sample worker was not found.");
      if (worker.version !== input.version)
        throw new InvestigationHttpError(409, "The sample worker setting changed.");
      const effectiveKinds = (worker.advertisedKinds ?? []).filter(
        (kind) => input.e2eEnabled || isInvestigationStaticTaskKind(kind),
      );
      const updated: InvestigationWorkerControl = {
        ...worker,
        e2eEnabled: input.e2eEnabled,
        version: worker.version + 1,
        updatedAt: new Date().toISOString(),
        effectiveKinds,
        status: !input.e2eEnabled
          ? "static_only"
          : !worker.lastSeenAt || Date.now() - Date.parse(worker.lastSeenAt) > 120_000
            ? "awaiting_confirmation"
            : effectiveKinds.some((kind) => !isInvestigationStaticTaskKind(kind))
              ? "e2e_enabled"
              : "static_only",
      };
      workers.set(id, updated);
      return structuredClone(updated);
    },
    webhookDeliveries: async (query = {}) => {
      if (!Value.Check(InvestigationWebhookDeliveryQuerySchema, query))
        throw new InvestigationHttpError(400, "The webhook filters are invalid.");
      const prefix = `sample-webhooks:${encodeURIComponent(
        JSON.stringify([query.repositoryId, query.kind, query.number, query.state, query.mode]),
      )}:`;
      const cursor = query.cursor;
      if (
        cursor !== undefined &&
        (!cursor.startsWith(prefix) || !/^\d+$/u.test(cursor.slice(prefix.length)))
      )
        throw new InvestigationHttpError(
          400,
          "The sample webhook cursor does not match these filters.",
        );
      const filtered = [...deliveries.values()]
        .filter(
          (item) =>
            (query.repositoryId === undefined || item.repositoryId === query.repositoryId) &&
            (query.kind === undefined || item.kind === query.kind) &&
            (query.number === undefined || item.number === query.number) &&
            (query.state === undefined || item.state === query.state) &&
            (query.mode === undefined || item.mode === query.mode),
        )
        .sort(
          (left, right) =>
            right.receivedAt.localeCompare(left.receivedAt) ||
            right.deliveryId.localeCompare(left.deliveryId),
        );
      const offset = cursor === undefined ? 0 : Number(cursor.slice(prefix.length));
      if (!Number.isSafeInteger(offset) || offset > filtered.length)
        throw new InvestigationHttpError(400, "The sample webhook cursor is outside this result.");
      const end = Math.min(offset + (query.limit ?? 25), filtered.length);
      return structuredClone({
        items: filtered.slice(offset, end),
        nextCursor: end < filtered.length ? `${prefix}${end}` : null,
      });
    },
    webhookDelivery: async (id) => structuredClone(delivery(id)),
    retryWebhookDelivery: async (id, input) => {
      if (!Value.Check(InvestigationWebhookRetryRequestSchema, input))
        throw new InvestigationHttpError(400, "The webhook retry request is invalid.");
      const prior = retryRequests.get(input.idempotencyKey);
      if (prior) {
        if (prior.deliveryId !== id || prior.version !== input.version)
          throw new InvestigationHttpError(
            409,
            "The sample retry key was used for another request.",
          );
        return structuredClone(delivery(id));
      }
      const item = delivery(id);
      if (item.version !== input.version || !item.availableActions.includes("retry"))
        throw new InvestigationHttpError(
          409,
          "The sample webhook event changed or cannot be retried.",
        );
      const updated: InvestigationWebhookDelivery = {
        ...item,
        version: `${item.version}-retry`,
        state: "accepted",
        attempts: 0,
        reason: null,
        nextAttemptAt: new Date().toISOString(),
        availableActions: [],
      };
      deliveries.set(id, updated);
      retryRequests.set(input.idempotencyKey, { deliveryId: id, version: input.version });
      return structuredClone(updated);
    },
  };
}
