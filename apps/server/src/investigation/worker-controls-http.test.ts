import {
  createInvestigationPreview,
  type InvestigationClaim,
  type InvestigationClaimResponse,
  type InvestigationTaskKind,
  type InvestigationTaskV1,
  type InvestigationWorkerControlList,
  unavailableInvestigationTokenUsage,
} from "@agentic-review/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildInvestigationApp } from "../../dist/investigation/app.js";
import { InvestigationStore } from "../../dist/investigation/store.js";
import type {
  InvestigationOperatorPrincipal,
  InvestigationWorkerPrincipal,
  InvestigationWorkItemRecord,
} from "../../dist/investigation/types.js";
import { InvestigationWorkerControls } from "../../dist/investigation/worker-controls.js";

const resources: Array<{ app: FastifyInstance; store: InvestigationStore }> = [];
afterEach(async () => {
  for (const { app, store } of resources.splice(0)) {
    await app.close();
    store.close();
  }
});

function post(app: FastifyInstance, url: string, payload: unknown, identity = "administrator") {
  return app.inject({
    method: "POST",
    url,
    payload: JSON.stringify(payload),
    headers: { authorization: identity, "content-type": "application/json" },
  });
}

function get(app: FastifyInstance, url: string, identity = "administrator") {
  return app.inject({ method: "GET", url, headers: { authorization: identity } });
}

/** Synthetic HTTP requests never start a Worker, desktop process, or upstream transport. */
async function fixture() {
  const store = new InvestigationStore();
  const original = createInvestigationPreview("pr", { findingCount: 0 }).task;
  let time = Date.parse("2026-09-19T00:00:00.000Z");
  let sequence = 0;
  const now = () => new Date(time);
  const worker: InvestigationWorkerPrincipal = {
    id: "synthetic-worker",
    displayName: "Synthetic Windows Worker",
    repositoryIds: [original.repository.id],
  };
  const otherWorker = { ...worker, id: "synthetic-other-worker" };
  const operator: InvestigationOperatorPrincipal = {
    id: "synthetic-operator",
    displayName: "Synthetic Operator",
    repositoryIds: worker.repositoryIds,
    permissions: ["repository:manage", "task:create", "task:cancel"],
    actionCapabilities: [],
    allowRepositoryExecution: true,
  };
  const administrator = { ...operator, id: "synthetic-administrator", isAdmin: true };
  const workerControls = new InvestigationWorkerControls(store, now);
  workerControls.initialize([worker, otherWorker]);
  const app = buildInvestigationApp({
    store,
    workerControls,
    now,
    idFactory: () => `synthetic-control-${++sequence}`,
    leaseDurationMs: 300_000,
    staticConcurrency: 2,
    authenticateOperator: (request) =>
      request.headers.authorization === "administrator"
        ? administrator
        : request.headers.authorization === "operator"
          ? operator
          : null,
    authenticateWorker: (request) =>
      request.headers.authorization === "worker"
        ? worker
        : request.headers.authorization === "other-worker"
          ? otherWorker
          : null,
  });
  resources.push({ app, store });
  expect((await post(app, "/api/repositories", original.repository)).statusCode).toBe(201);
  const items = new Map<"pr" | "bug", InvestigationWorkItemRecord>();
  for (const kind of ["pr", "bug"] as const) {
    const task = createInvestigationPreview(kind, { findingCount: 0 }).task;
    const subject = task.subjects.find((entry) => entry.id === task.subjectRef)!;
    const item: InvestigationWorkItemRecord = {
      ...task.workItem,
      repositoryId: task.repository.id,
      body: "Synthetic worker policy fixture; no external repository operation occurs.",
      state: "open",
      subject,
      updatedAt: now().toISOString(),
    };
    expect((await post(app, "/api/work-items", item)).statusCode).toBe(201);
    items.set(kind, item);
  }
  const createTask = async (kind: "pr-review" | "issue-investigate" | "pr-e2e") => {
    time += 1;
    const response = await post(app, "/api/tasks", {
      kind,
      workItemId: items.get(kind === "issue-investigate" ? "bug" : "pr")!.id,
      idempotencyKey: `synthetic-task-${++sequence}`,
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<InvestigationTaskV1>();
  };
  const claim = async (supportedKinds: InvestigationTaskKind[], identity = "worker") => {
    const response = await post(app, "/api/worker/claims", { supportedKinds }, identity);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<InvestigationClaimResponse>().claim;
  };
  const enable = async (owner = worker) => {
    const version = workerControls.get(owner.id)!.version;
    const response = await post(app, `/api/workers/${owner.id}/e2e`, { version, e2eEnabled: true });
    expect(response.statusCode, response.body).toBe(200);
    return response;
  };
  return {
    app,
    store,
    worker,
    otherWorker,
    workerControls,
    items,
    createTask,
    claim,
    enable,
    now,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
  };
}

function requireClaim(claim: InvestigationClaim | null): InvestigationClaim {
  if (claim === null || claim.checkpoint === null)
    throw new Error("Expected a synthetic task with an accepted initial checkpoint.");
  return claim;
}

describe("authenticated Worker controls and task admission", () => {
  it("exposes registered workers only to administrators", async () => {
    const f = await fixture();
    expect((await f.app.inject({ method: "GET", url: "/api/workers" })).statusCode).toBe(401);
    expect((await get(f.app, "/api/workers", "worker")).statusCode).toBe(401);
    expect((await get(f.app, "/api/workers", "operator")).statusCode).toBe(403);
    const response = await get(f.app, "/api/workers");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<InvestigationWorkerControlList>().items).toEqual([
      expect.objectContaining({
        id: f.otherWorker.id,
        e2eEnabled: false,
        version: 1,
        status: "static_only",
        lastSeenAt: null,
      }),
      expect.objectContaining({
        id: f.worker.id,
        displayName: f.worker.displayName,
        e2eEnabled: false,
        version: 1,
        status: "static_only",
        lastSeenAt: null,
        contactStatus: "never",
        activityStatus: "offline",
      }),
    ]);
  });

  it("records authenticated contact even when task ownership validation rejects the request", async () => {
    const f = await fixture();
    const task = await f.createTask("pr-review");
    const claimed = requireClaim(await f.claim(["pr-review"]));
    f.advance(120_000);
    expect(f.workerControls.get(f.worker.id)).toMatchObject({
      contactStatus: "stale",
      activityStatus: "busy",
      activeTaskIds: [task.id],
    });
    const payload = { lease: { ...claimed.lease, fence: claimed.lease.fence + 1 } };
    expect(
      (await post(f.app, `/api/worker/tasks/${task.id}/heartbeat`, payload, "unknown-worker"))
        .statusCode,
    ).toBe(401);
    expect(f.workerControls.get(f.worker.id)?.contactStatus).toBe("stale");
    expect(
      (await post(f.app, `/api/worker/tasks/${task.id}/heartbeat`, payload, "worker")).statusCode,
    ).toBe(409);
    expect(f.workerControls.get(f.worker.id)).toMatchObject({
      displayName: f.worker.displayName,
      lastSeenAt: f.now().toISOString(),
      contactStatus: "recent",
      activityStatus: "busy",
      activeTaskIds: [task.id],
    });
  });

  it("releases expired static ownership while expired execution retains pending cleanup", async () => {
    const f = await fixture();
    const review = await f.createTask("pr-review");
    await f.claim(["pr-review"]);
    await f.enable(f.otherWorker);
    const execution = await f.createTask("pr-e2e");
    const claimed = requireClaim(await f.claim(["pr-e2e"], "other-worker"));
    f.advance(300_001);
    const response = await get(f.app, "/api/workers");
    expect(response.statusCode, response.body).toBe(200);
    const workers = response.json<InvestigationWorkerControlList>().items;
    expect(workers.find((worker) => worker.id === f.worker.id)).toMatchObject({
      contactStatus: "stale",
      activityStatus: "offline",
      activeTaskIds: [],
    });
    expect(workers.find((worker) => worker.id === f.otherWorker.id)).toMatchObject({
      contactStatus: "stale",
      activityStatus: "cleaning",
      activeTaskIds: [execution.id],
      cleanupPendingAttemptIds: [claimed.attempt.id],
    });
    expect(f.store.get<InvestigationTaskV1>("tasks", review.id)?.state).toBe("interrupted");
  });

  it("requires an administrator and exact version for every E2E policy change", async () => {
    const f = await fixture();
    const url = `/api/workers/${f.worker.id}/e2e`;
    for (const [identity, status] of [
      ["operator", 403],
      ["worker", 401],
    ] as const) {
      expect((await post(f.app, url, { version: 1, e2eEnabled: true }, identity)).statusCode).toBe(
        status,
      );
    }
    for (const request of [
      { e2eEnabled: true },
      { version: 0, e2eEnabled: true },
      { version: 1, e2eEnabled: true, supportedKinds: ["pr-e2e"] },
    ]) {
      expect((await post(f.app, url, request)).statusCode).toBe(400);
    }
    const enabled = await f.enable();
    expect(enabled.json()).toMatchObject({
      e2eEnabled: true,
      version: 2,
      updatedBy: "synthetic-administrator",
    });
    const stale = await post(f.app, url, { version: 1, e2eEnabled: false });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("worker_control_version_conflict");
    expect(f.workerControls.get(f.worker.id)).toMatchObject({ e2eEnabled: true, version: 2 });
    expect(
      (await post(f.app, "/api/workers/unknown-worker/e2e", { version: 1, e2eEnabled: true }))
        .statusCode,
    ).toBe(404);
    const disabled = await post(f.app, url, { version: 2, e2eEnabled: false });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ e2eEnabled: false, version: 3 });
  });

  it("does not let a worker grant itself E2E through policy or forged claim capabilities", async () => {
    const f = await fixture();
    const task = await f.createTask("pr-e2e");
    const supportedKinds: InvestigationTaskKind[] = [
      "pr-review",
      "issue-investigate",
      "pr-e2e",
      "pr-verify",
      "issue-verify",
      "reproduction-setup",
      "issue-fix",
      "feature-implement",
    ];
    const policy = await post(f.app, "/api/worker/policy", { supportedKinds }, "worker");
    expect(policy.statusCode, policy.body).toBe(200);
    expect(policy.json()).toEqual({
      workerId: f.worker.id,
      version: 1,
      e2eEnabled: false,
      effectiveKinds: ["pr-review", "issue-investigate"],
    });
    expect(
      (await post(f.app, "/api/worker/policy", { supportedKinds, e2eEnabled: true }, "worker"))
        .statusCode,
    ).toBe(400);
    expect(
      (await post(f.app, "/api/worker/policy", { supportedKinds }, "administrator")).statusCode,
    ).toBe(401);
    expect(await f.claim(supportedKinds)).toBeNull();
    expect(f.store.get<InvestigationTaskV1>("tasks", task.id)?.state).toBe("queued");
    expect(f.store.list("attempts")).toEqual([]);
    expect(f.store.list("resourceLeases")).toEqual([]);
    expect(f.workerControls.get(f.worker.id)).toMatchObject({ e2eEnabled: false, version: 1 });
  });

  it("schedules execution only to an enabled worker while disabled workers still claim both static kinds", async () => {
    const f = await fixture();
    const e2e = await f.createTask("pr-e2e");
    const review = await f.createTask("pr-review");
    const issue = await f.createTask("issue-investigate");
    await f.enable(f.otherWorker);
    expect((await f.claim(["pr-e2e", "pr-review", "issue-investigate"]))?.task.id).toBe(review.id);
    expect((await f.claim(["pr-e2e", "pr-review", "issue-investigate"]))?.task.id).toBe(issue.id);
    expect(await f.claim(["pr-e2e"])).toBeNull();
    const enabledClaim = requireClaim(await f.claim(["pr-e2e"], "other-worker"));
    expect(enabledClaim.task.id).toBe(e2e.id);
    expect(enabledClaim.task.executionPolicy).toMatchObject({
      mode: "execute",
      allowRepositoryExecution: true,
    });
    expect(f.workerControls.get(f.worker.id)?.e2eEnabled).toBe(false);
  });

  it.each(["pr-review", "issue-investigate"] as const)(
    "rejects execute task creation disguised as %s despite operator execution permission",
    async (kind) => {
      const f = await fixture();
      const response = await post(f.app, "/api/tasks", {
        kind,
        workItemId: f.items.get(kind === "pr-review" ? "pr" : "bug")!.id,
        executionMode: "execute",
        idempotencyKey: "forbidden-static-execution",
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("static_task_execution_forbidden");
      expect(f.store.list("tasks")).toEqual([]);
    },
  );

  it.each(["mode", "permission", "authorization"] as const)(
    "quarantines historical static queue entries with unsafe %s even for an enabled worker",
    async (injection) => {
      const f = await fixture();
      const malformed = await f.createTask("pr-review");
      f.store.put("tasks", malformed.id, {
        ...malformed,
        executionPolicy: {
          ...malformed.executionPolicy,
          ...(injection === "mode" ? { mode: "execute" } : {}),
          ...(injection === "permission" ? { allowRepositoryExecution: true } : {}),
          ...(injection === "authorization"
            ? { authorizationRef: "legacy-execution-authority" }
            : {}),
        },
      });
      const safe = await f.createTask("pr-review");
      expect((await f.claim(["pr-review"]))?.task.id).toBe(safe.id);
      await f.enable(f.otherWorker);
      expect(await f.claim(["pr-review"], "other-worker")).toBeNull();
      expect(f.store.get<InvestigationTaskV1>("tasks", malformed.id)?.state).toBe("queued");
      expect(f.store.list("attempts")).toHaveLength(1);
    },
  );

  it("cancels running execution on disable and retains exclusive capacity until exact-owner cleanup", async () => {
    const f = await fixture();
    await f.enable();
    await f.enable(f.otherWorker);
    const task = await f.createTask("pr-e2e");
    const pending = await f.createTask("pr-e2e");
    const claimed = requireClaim(await f.claim(["pr-e2e"]));
    const disabled = await post(f.app, `/api/workers/${f.worker.id}/e2e`, {
      version: 2,
      e2eEnabled: false,
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(disabled.json()).toMatchObject({
      status: "disabling",
      activeE2eTaskIds: [task.id],
      cleanupPendingAttemptIds: [claimed.attempt.id],
    });
    expect(await f.claim(["pr-e2e"], "other-worker")).toBeNull();
    const heartbeat = await post(
      f.app,
      `/api/worker/tasks/${task.id}/heartbeat`,
      { lease: claimed.lease },
      "worker",
    );
    expect(heartbeat.statusCode).toBe(200);
    expect(heartbeat.json().cancelRequested).toBe(true);
    const start = await post(
      f.app,
      `/api/worker/tasks/${task.id}/checkpoints`,
      {
        kind: "execution",
        lease: claimed.lease,
        execution: {
          ...claimed.checkpoint!.runtime,
          e2eExecution: {
            attemptId: claimed.attempt.id,
            status: "started",
            startedAt: f.now().toISOString(),
            completedAt: null,
          },
        },
      },
      "worker",
    );
    expect(start.statusCode).toBe(409);
    expect(start.json().code).toBe("cancellation_requested");
    expect(f.store.get("checkpoints", task.id)).toEqual(claimed.checkpoint);
    const cleanup = { lease: claimed.lease, ownedProcessesStopped: true, desktopRestored: true };
    expect(
      (await post(f.app, `/api/worker/tasks/${task.id}/cleanup`, cleanup, "other-worker"))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await post(
          f.app,
          `/api/worker/tasks/${task.id}/cleanup`,
          {
            ...cleanup,
            lease: { ...claimed.lease, fence: claimed.lease.fence + 1 },
          },
          "worker",
        )
      ).statusCode,
    ).toBe(409);
    expect(await f.claim(["pr-e2e"], "other-worker")).toBeNull();
    f.advance(120_001);
    expect(f.workerControls.get(f.worker.id)?.status).toBe("awaiting_confirmation");
    const acknowledged = await post(
      f.app,
      `/api/worker/tasks/${task.id}/cleanup`,
      cleanup,
      "worker",
    );
    expect(acknowledged.statusCode, acknowledged.body).toBe(200);
    expect(acknowledged.json()).toEqual({ released: true, attemptId: claimed.attempt.id });
    expect((await f.claim(["pr-e2e"], "other-worker"))?.task.id).toBe(pending.id);
    expect(
      (await post(f.app, `/api/worker/tasks/${task.id}/cleanup`, cleanup, "worker")).statusCode,
    ).toBe(200);
    expect(f.workerControls.get(f.worker.id)?.status).toBe("static_only");
  });

  it("does not admit a new model invocation after an accepted terminal checkpoint is disabled", async () => {
    const f = await fixture();
    await f.enable();
    const task = await f.createTask("pr-e2e");
    const claimed = requireClaim(await f.claim(["pr-e2e"]));
    const stopped = await post(
      f.app,
      `/api/worker/tasks/${task.id}/checkpoints`,
      {
        kind: "interrupt",
        lease: claimed.lease,
        reason: "interrupted",
        diagnostics: [],
        modelInvocationState: "not_started",
      },
      "worker",
    );
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(
      (await post(f.app, `/api/workers/${f.worker.id}/e2e`, { version: 2, e2eEnabled: false }))
        .statusCode,
    ).toBe(200);
    const heartbeat = await post(
      f.app,
      `/api/worker/tasks/${task.id}/heartbeat`,
      { lease: claimed.lease },
      "worker",
    );
    expect(heartbeat.json().cancelRequested).toBe(false);
    const registration = await post(
      f.app,
      `/api/worker/tasks/${task.id}/model-usage`,
      {
        lease: claimed.lease,
        receipt: {
          invocationId: "synthetic-late-invocation",
          taskId: task.id,
          attemptId: claimed.attempt.id,
          purpose: "e2e",
          engine: "codex",
          model: null,
          startedAt: f.now().toISOString(),
          updatedAt: f.now().toISOString(),
          revision: 1,
          state: "registered",
          disposition: "pending",
          completeness: "unavailable",
          usage: unavailableInvestigationTokenUsage(),
        },
      },
      "worker",
    );
    expect(registration.statusCode, registration.body).toBe(200);
    expect(registration.json().executionAllowed).toBe(false);
    expect(
      (
        await post(
          f.app,
          `/api/worker/tasks/${task.id}/cleanup`,
          {
            lease: claimed.lease,
            ownedProcessesStopped: true,
            desktopRestored: true,
          },
          "worker",
        )
      ).statusCode,
    ).toBe(200);
  });
});
