import {
  createInvestigationPreview,
  type InvestigationTaskKind,
  type InvestigationTaskV1,
} from "@agentic-review/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildInvestigationApp } from "../../dist/investigation/app.js";
import {
  InvestigationResourceScheduler,
  investigationResourcePool,
} from "../../dist/investigation/resource-scheduler.js";
import { InvestigationService } from "../../dist/investigation/service.js";
import { InvestigationStore } from "../../dist/investigation/store.js";
import type {
  InvestigationOperatorPrincipal,
  InvestigationWorkerPrincipal,
} from "../../dist/investigation/types.js";

const stores: InvestigationStore[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const store of stores.splice(0)) store.close();
});

function fixture(staticConcurrency = 2) {
  const store = new InvestigationStore();
  stores.push(store);
  const original = createInvestigationPreview("pr", { findingCount: 0 }).task;
  let now = Date.parse("2026-09-19T01:00:00.000Z");
  let sequence = 0;
  const worker: InvestigationWorkerPrincipal = {
    id: "synthetic-worker-one",
    repositoryIds: [original.repository.id],
  };
  const operator: InvestigationOperatorPrincipal = {
    id: "synthetic-operator",
    isAdmin: true,
    displayName: "Synthetic Operator",
    repositoryIds: worker.repositoryIds,
    permissions: ["task:cancel"],
    actionCapabilities: [],
    allowRepositoryExecution: true,
  };
  const options = {
    store,
    now: () => new Date(now),
    idFactory: () => `synthetic-identity-${++sequence}`,
    leaseDurationMs: 1_000,
    staticConcurrency,
  };
  const service = new InvestigationService(options);
  const enableE2e = (owner = worker) => {
    service.workerControls.initialize([owner]);
    const version = service.workerControls.get(owner.id)!.version;
    service.updateWorkerE2e(operator, owner.id, { version, e2eEnabled: true });
  };
  const enqueue = (id: string, kind: InvestigationTaskKind = "pr-review") => {
    const task: InvestigationTaskV1 = {
      ...structuredClone(original),
      id,
      kind,
      state: "queued",
      latestReportRef: null,
      createdAt: new Date(now++).toISOString(),
    };
    store.insert("tasks", id, task);
    store.insert("idempotency", `input:${id}`, {
      inputSnapshot: {
        schemaVersion: "InvestigationInputSnapshotV1",
        repositoryId: task.repository.id,
        workItemId: task.workItem.id,
        subjectRef: task.subjectRef,
        subjectRevisionKey: task.subjects[0]!.revisionKey,
        title: task.workItem.title,
        body: "Isolated scheduler fixture; no repository operation occurs.",
        comments: [],
        source: null,
      },
      plan: null,
      execution: null,
    });
    return task;
  };
  const claim = (
    kinds: InvestigationTaskKind[] = ["pr-review", "pr-verify"],
    owner = worker,
    instance = service,
  ) => instance.workerClaim(owner, { supportedKinds: kinds }).claim;
  return {
    store,
    options,
    service,
    operator,
    worker,
    enqueue,
    claim,
    enableE2e,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

describe("investigation resource scheduling", () => {
  it("provides authenticated scheduler settings and exact cleanup HTTP routes", async () => {
    const f = fixture();
    f.enableE2e();
    const app = buildInvestigationApp({
      ...f.options,
      authenticateOperator: (request) =>
        request.headers.authorization === "operator" ? f.operator : null,
      authenticateWorker: (request) =>
        request.headers.authorization === "worker" ? f.worker : null,
    });
    apps.push(app);
    const settings = await app.inject({
      method: "PUT",
      url: "/api/investigation/scheduler",
      headers: { authorization: "operator" },
      payload: { staticConcurrency: 4 },
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({ staticConcurrency: 4, e2eConcurrency: 1 });
    expect(
      (await app.inject({ method: "GET", url: "/api/investigation/scheduler" })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/investigation/scheduler",
          headers: { authorization: "operator" },
          payload: { staticConcurrency: 4, e2eConcurrency: 2 },
        })
      ).statusCode,
    ).toBe(400);
    f.enqueue("http-cleanup", "pr-verify");
    const claim = f.claim()!;
    f.service.cancelTask(f.operator, claim.task.id);
    const cleanup = await app.inject({
      method: "POST",
      url: `/api/worker/tasks/${claim.task.id}/cleanup`,
      headers: { authorization: "worker" },
      payload: { lease: claim.lease, ownedProcessesStopped: true, desktopRestored: true },
    });
    expect(cleanup.statusCode).toBe(200);
    expect(cleanup.json()).toEqual({ released: true, attemptId: claim.attempt.id });
  });

  it("shares one execution pool across every desktop-capable legacy kind", () => {
    expect(investigationResourcePool("pr-review")).toBe("static");
    expect(investigationResourcePool("issue-investigate")).toBe("static");
    for (const kind of [
      "pr-e2e",
      "pr-verify",
      "issue-verify",
      "reproduction-setup",
      "issue-fix",
      "feature-implement",
    ] as const)
      expect(investigationResourcePool(kind)).toBe("e2e");
    const task = createInvestigationPreview("pr", { findingCount: 0 }).task;
    expect(investigationResourcePool(task)).toBe("static");
    expect(
      investigationResourcePool({
        ...task,
        executionPolicy: {
          ...task.executionPolicy,
          mode: "execute",
          allowRepositoryExecution: true,
          authorizationRef: "synthetic-administrator",
        },
      }),
    ).toBe("e2e");
  });

  it("keeps independent capacities and skips an unavailable pool at the queue head", () => {
    const f = fixture(2);
    f.enableE2e();
    f.enqueue("e2e-one", "pr-verify");
    f.enqueue("e2e-two", "issue-verify");
    f.enqueue("static-one");
    f.enqueue("static-two");
    f.enqueue("static-three");
    expect(f.claim()?.task.id).toBe("e2e-one");
    const all: InvestigationTaskKind[] = ["pr-review", "pr-verify", "issue-verify"];
    expect(f.claim(all, { ...f.worker, id: "synthetic-worker-two" })?.task.id).toBe("static-one");
    expect(f.claim(all)?.task.id).toBe("static-two");
    expect(f.claim(all)).toBeNull();
    expect(f.service.schedulerStatus(f.operator)).toMatchObject({
      staticConcurrency: 2,
      e2eConcurrency: 1,
      occupiedStatic: 2,
      occupiedE2e: 1,
    });
  });

  it("persists one static setting across server instances with different startup defaults", () => {
    const f = fixture(2);
    const anotherServer = new InvestigationService({ ...f.options, staticConcurrency: 8 });
    expect(anotherServer.schedulerStatus(f.operator).staticConcurrency).toBe(2);
    f.service.configureScheduler(f.operator, { staticConcurrency: 3 });
    expect(anotherServer.schedulerStatus(f.operator).staticConcurrency).toBe(3);
  });

  it("can start E2E when the independent static pool is full", () => {
    const f = fixture(1);
    f.enableE2e();
    f.enqueue("static-one");
    f.enqueue("static-two");
    f.enqueue("e2e-one", "pr-verify");
    expect(f.claim()?.task.id).toBe("static-one");
    expect(f.claim()?.task.id).toBe("e2e-one");
  });

  it("changes future admission without cancelling attempts above a lowered static limit", () => {
    const f = fixture(2);
    f.enqueue("one");
    f.enqueue("two");
    f.enqueue("three");
    const first = f.claim()!;
    const second = f.claim()!;
    f.service.configureScheduler(f.operator, { staticConcurrency: 1 });
    expect(f.claim()).toBeNull();
    for (const claim of [first, second]) {
      expect(
        f.service.workerHeartbeat(f.worker, claim.task.id, { lease: claim.lease }).cancelRequested,
      ).toBe(false);
    }
    f.service.configureScheduler(f.operator, { staticConcurrency: 3 });
    expect(f.claim()?.task.id).toBe("three");
    expect(() =>
      f.service.configureScheduler({ ...f.operator, isAdmin: false }, { staticConcurrency: 4 }),
    ).toThrow("administrator");
  });

  it("holds cancelled execution until exact-owner cleanup and makes cleanup retries harmless", () => {
    const f = fixture();
    f.enableE2e();
    f.enqueue("e2e-one", "pr-verify");
    f.enqueue("e2e-two", "pr-verify");
    const first = f.claim()!;
    f.service.cancelTask(f.operator, first.task.id);
    expect(f.service.schedulerStatus(f.operator).leases[0]?.state).toBe("needs_cleanup");
    expect(f.claim()).toBeNull();
    const request = {
      lease: first.lease,
      ownedProcessesStopped: true as const,
      desktopRestored: true as const,
    };
    for (const lease of [
      { ...first.lease, leaseToken: "incorrect-token" },
      { ...first.lease, fence: first.lease.fence + 1 },
    ])
      expect(() => f.service.workerCleanup(f.worker, first.task.id, { ...request, lease })).toThrow(
        "original worker",
      );
    expect(() =>
      f.service.workerCleanup({ ...f.worker, id: "another-worker" }, first.task.id, request),
    ).toThrow("original worker");
    expect(f.service.workerCleanup(f.worker, first.task.id, request).released).toBe(true);
    const second = f.claim()!;
    expect(second.task.id).toBe("e2e-two");
    f.service.workerCleanup(f.worker, first.task.id, request);
    expect(f.service.schedulerStatus(f.operator).leases.map((lease) => lease.attemptId)).toEqual([
      second.attempt.id,
    ]);
  });

  it("does not interpret lease expiry or server restart as desktop cleanup", () => {
    const f = fixture();
    f.enableE2e();
    f.enqueue("e2e-one", "pr-verify");
    f.enqueue("e2e-two", "pr-verify");
    const first = f.claim()!;
    f.advance(2_000);
    const restarted = new InvestigationService(f.options);
    expect(f.claim(undefined, f.worker, restarted)).toBeNull();
    expect(restarted.schedulerStatus(f.operator).leases[0]).toMatchObject({
      attemptId: first.attempt.id,
      state: "needs_cleanup",
      reason: "lease_expired",
    });
    restarted.workerCleanup(f.worker, first.task.id, {
      lease: first.lease,
      ownedProcessesStopped: true,
      desktopRestored: true,
    });
    expect(f.claim(undefined, f.worker, restarted)?.task.id).toBe("e2e-two");
  });

  it.each(["complete", "blocked", "error"] as const)(
    "retains the %s checkpoint and releases capacity after report delivery fails",
    (stopReason) => {
      const f = fixture();
      f.enableE2e();
      f.enqueue("undelivered", "pr-verify");
      f.enqueue("next-task", "pr-verify");
      const first = f.claim()!;
      const checkpoint = { ...first.checkpoint!, stopReason };
      f.store.put("checkpoints", first.task.id, checkpoint);
      const request = {
        lease: first.lease,
        ownedProcessesStopped: true as const,
        desktopRestored: true as const,
        reportDeliveryFailure: { code: "invalid_logical_report_semantics", retryable: false },
      };
      expect(f.service.workerCleanup(f.worker, first.task.id, request)).toEqual({
        released: true,
        attemptId: first.attempt.id,
      });
      expect(f.store.get("tasks", first.task.id)).toMatchObject({ state: "interrupted" });
      expect(f.store.get("attempts", first.attempt.id)).toMatchObject({
        attempt: {
          state: "interrupted",
          terminationReason: "report_delivery_failed:invalid_logical_report_semantics",
        },
      });
      expect(f.store.get("checkpoints", first.task.id)).toEqual(checkpoint);
      expect(f.store.list("reports")).toEqual([]);
      const next = f.claim()!;
      expect(next.task.id).toBe("next-task");
      const firstAttempt = f.store.get("attempts", first.attempt.id);
      f.service.workerCleanup(f.worker, first.task.id, request);
      expect(f.store.get("attempts", first.attempt.id)).toEqual(firstAttempt);
      expect(f.store.get("tasks", next.task.id)).toMatchObject({ state: "running" });
      expect(f.service.schedulerStatus(f.operator).occupiedE2e).toBe(1);
    },
  );

  it("does not reinterpret a sealed report when its successful response was lost", () => {
    const f = fixture();
    f.enqueue("sealed");
    const claim = f.claim()!;
    const task = { ...claim.task, state: "completed" as const };
    const stored = f.store.get<{ attempt: typeof claim.attempt }>("attempts", claim.attempt.id)!;
    const record = { ...stored, attempt: { ...stored.attempt, state: "completed" as const } };
    const report = createInvestigationPreview("pr", { findingCount: 0 }).result;
    f.store.put("tasks", task.id, task);
    f.store.put("attempts", claim.attempt.id, record);
    f.store.put("reports", claim.reportId, report);
    expect(
      f.service.workerCleanup(f.worker, task.id, {
        lease: claim.lease,
        ownedProcessesStopped: true,
        desktopRestored: true,
        reportDeliveryFailure: { code: "HTTP_ERROR", retryable: true },
      }).released,
    ).toBe(true);
    expect(f.store.get("tasks", task.id)).toEqual(task);
    expect(f.store.get("attempts", claim.attempt.id)).toEqual(record);
    expect(f.store.get("reports", claim.reportId)).toEqual(report);
  });

  it("does not accept report recovery for a checkpoint that can still execute", () => {
    const f = fixture();
    f.enableE2e();
    f.enqueue("still-executing", "pr-verify");
    const claim = f.claim()!;
    f.service.cancelTask(f.operator, claim.task.id);
    expect(() =>
      f.service.workerCleanup(f.worker, claim.task.id, {
        lease: claim.lease,
        ownedProcessesStopped: true,
        desktopRestored: true,
        reportDeliveryFailure: { code: "REPORT_DELIVERY_FAILED", retryable: false },
      }),
    ).toThrow("stopped checkpoint");
    expect(f.service.schedulerStatus(f.operator).occupiedE2e).toBe(1);
  });

  it("releases expired static capacity while preserving execution quarantine", () => {
    const f = fixture(1);
    f.enableE2e();
    f.enqueue("static-one");
    f.enqueue("static-two");
    f.enqueue("e2e-one", "pr-verify");
    f.claim();
    f.claim();
    f.advance(2_000);
    expect(f.claim()?.task.id).toBe("static-two");
    expect(f.service.schedulerStatus(f.operator)).toMatchObject({
      occupiedStatic: 1,
      occupiedE2e: 1,
    });
  });

  it("rejects cleanup while an execution attempt can still start work", () => {
    const f = fixture();
    f.enableE2e();
    f.enqueue("e2e-one", "pr-verify");
    const claim = f.claim()!;
    expect(() =>
      f.service.workerCleanup(f.worker, claim.task.id, {
        lease: claim.lease,
        ownedProcessesStopped: true,
        desktopRestored: true,
      }),
    ).toThrow("still execute");
    expect(f.service.schedulerStatus(f.operator).occupiedE2e).toBe(1);
  });

  it("rolls back the resource lease with a failed claim transaction", () => {
    const f = fixture();
    f.enableE2e();
    f.enqueue("task-one", "pr-verify");
    const failing = new InvestigationService({
      ...f.options,
      onTaskStateChanged: () => {
        throw new Error("Synthetic transaction failure");
      },
    });
    expect(() => f.claim(undefined, f.worker, failing)).toThrow("Synthetic transaction failure");
    expect(f.store.list("resourceLeases")).toEqual([]);
    expect(f.store.list("attempts")).toEqual([]);
    expect(f.store.get<InvestigationTaskV1>("tasks", "task-one")?.state).toBe("queued");
    expect(f.claim()?.task.id).toBe("task-one");
  });

  it("adopts a running pre-upgrade attempt and never reclaims another owner's desktop", () => {
    const f = fixture();
    f.enableE2e();
    f.enqueue("legacy-one", "pr-verify");
    f.enqueue("queued-two", "pr-verify");
    const existing = f.claim()!;
    f.store.delete("resourceLeases", existing.attempt.id);
    const restarted = new InvestigationService(f.options);
    expect(f.claim(undefined, f.worker, restarted)).toBeNull();
    expect(restarted.schedulerStatus(f.operator).leases[0]?.attemptId).toBe(existing.attempt.id);
  });

  it("quarantines historical execution hidden under a static kind and never releases it on expiry", () => {
    const f = fixture();
    f.enableE2e();
    const task = f.enqueue("legacy-static-execution");
    const claimed = f.claim()!;
    f.store.put("tasks", task.id, {
      ...claimed.task,
      executionPolicy: {
        ...task.executionPolicy,
        mode: "execute",
        allowRepositoryExecution: true,
        authorizationRef: f.operator.id,
      },
    });
    const restarted = new InvestigationService(f.options);
    expect(restarted.schedulerStatus(f.operator)).toMatchObject({
      occupiedStatic: 0,
      occupiedE2e: 1,
      leases: [
        expect.objectContaining({
          attemptId: claimed.attempt.id,
          pool: "e2e",
          state: "needs_cleanup",
          reason: "execution_policy_requires_e2e",
        }),
      ],
    });
    expect(
      restarted.workerHeartbeat(f.worker, task.id, { lease: claimed.lease }).cancelRequested,
    ).toBe(true);
    expect(() =>
      restarted.workerCheckpoint(f.worker, task.id, {
        kind: "execution",
        lease: claimed.lease,
        execution: claimed.checkpoint!.runtime,
      }),
    ).toThrow("not authorized for runtime execution");
    f.advance(2_000);
    expect(restarted.schedulerStatus(f.operator).occupiedE2e).toBe(1);
    expect(restarted.schedulerStatus(f.operator).leases[0]?.state).toBe("needs_cleanup");
    expect(
      restarted.workerCleanup(f.worker, task.id, {
        lease: claimed.lease,
        ownedProcessesStopped: true,
        desktopRestored: true,
      }).released,
    ).toBe(true);
    expect(restarted.schedulerStatus(f.operator).occupiedE2e).toBe(0);
  });

  it.each(["taskId", "workerId", "fence"] as const)(
    "does not adopt a retained execution lease with a mismatched %s",
    (property) => {
      const f = fixture();
      const scheduler = new InvestigationResourceScheduler(f.store, f.options.now);
      const owner = {
        attemptId: "retained-attempt",
        taskId: "retained-task",
        workerId: f.worker.id,
        fence: 1,
        pool: "static" as const,
      };
      f.store.transaction(() => scheduler.acquire(owner));
      const forged = {
        ...owner,
        pool: "e2e" as const,
        ...(property === "taskId" ? { taskId: "different-task" } : {}),
        ...(property === "workerId" ? { workerId: "different-worker" } : {}),
        ...(property === "fence" ? { fence: 2 } : {}),
      };
      expect(() => f.store.transaction(() => scheduler.adopt(forged))).toThrow(
        "original task, worker, and fence",
      );
      expect(scheduler.lease(owner.attemptId)).toMatchObject({ ...owner, state: "held" });
    },
  );

  it("keeps normal execution completion reserved until cleanup acknowledgement", () => {
    const f = fixture();
    const scheduler = new InvestigationResourceScheduler(f.store, f.options.now);
    f.store.transaction(() =>
      scheduler.acquire({
        attemptId: "attempt-one",
        taskId: "task-one",
        workerId: "worker-one",
        fence: 1,
        pool: "e2e",
      }),
    );
    f.store.transaction(() => scheduler.terminate("attempt-one", "completed"));
    expect(scheduler.available("e2e")).toBe(false);
    expect(scheduler.lease("attempt-one")?.state).toBe("needs_cleanup");
    f.store.transaction(() =>
      scheduler.confirmCleanup({
        attemptId: "attempt-one",
        taskId: "task-one",
        workerId: "worker-one",
        fence: 1,
      }),
    );
    expect(scheduler.available("e2e")).toBe(true);
  });
});
