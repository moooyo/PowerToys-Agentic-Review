import { createHash } from "node:crypto";
import {
  type ActionContextV1,
  createInvestigationPreview as createInvestigationFixture,
  type InvestigationAnalysisV1,
  type InvestigationArtifactV1,
  type InvestigationCheckpointRequest,
  type InvestigationCheckpointResponse,
  type InvestigationClaim,
  type InvestigationClaimResponse,
  type InvestigationCreateTaskRequestV1,
  type InvestigationFindingsPageV1,
  type InvestigationHeartbeatResponse,
  type InvestigationLoopCheckpointV1,
  type InvestigationModelInvocationReceipt,
  type InvestigationOutputBatchRequest,
  type InvestigationPlanExecutionBinding,
  type InvestigationResultV1,
  type InvestigationRuntimeState,
  type InvestigationTaskV1,
  type InvestigationUsageSummary,
  unavailableInvestigationTokenUsage,
} from "@agentic-review/contracts";
import { investigationContentDigest, projectRecordedE2eAnalysis } from "@agentic-review/domain";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildInvestigationApp } from "../../dist/investigation/app.js";
import {
  type InvestigationEvidencePolicy,
  InvestigationEvidenceStore,
} from "../../dist/investigation/evidence-store.js";
import type {
  InvestigationPreparedTaskInput,
  InvestigationServiceOptions,
} from "../../dist/investigation/service.js";
import { InvestigationStore } from "../../dist/investigation/store.js";
import type {
  InvestigationActionTransport,
  InvestigationOperatorPrincipal,
  InvestigationRepositoryRecord,
  InvestigationWorkerPrincipal,
  InvestigationWorkItemRecord,
} from "../../dist/investigation/types.js";
import { investigationUsagePublicationPendingKey } from "../../dist/investigation/usage-ledger.js";
import { InvestigationWorkerControls } from "../../dist/investigation/worker-controls.js";

const resources: { app: FastifyInstance; store: InvestigationStore }[] = [];
const startedAt = Date.parse("2026-09-15T02:01:00.000Z");
const foreignRepositoryId = "synthetic-foreign-repository";

afterEach(async () => {
  for (const { app, store } of resources.splice(0)) {
    await app.close();
    store.close();
  }
});

function workItem(kind: "pr" | "bug" = "pr"): InvestigationWorkItemRecord {
  const { task } = createInvestigationFixture(kind, { findingCount: 0 });
  const subject = task.subjects.find((entry) => entry.id === task.subjectRef);
  if (subject === undefined)
    throw new Error("The synthetic fixture must include its original subject.");
  return {
    ...task.workItem,
    repositoryId: task.repository.id,
    body: "An isolated synthetic investigation target with no upstream activity.",
    state: "open",
    subject,
    updatedAt: new Date(startedAt).toISOString(),
  };
}

function post(app: FastifyInstance, path: string, payload: unknown, token = "operator") {
  return app.inject({
    method: "POST",
    url: path,
    payload: JSON.stringify(payload),
    headers: { authorization: token, "content-type": "application/json" },
  });
}

function get(app: FastifyInstance, path: string, token = "operator") {
  return app.inject({ method: "GET", url: path, headers: { authorization: token } });
}

/** Every identity and persisted entity is synthetic; optional transports are in-memory mocks. */
async function harness(
  options: {
    actionTransport?: InvestigationActionTransport;
    allowRepositoryExecution?: boolean;
    enableWorkerE2e?: boolean;
    evidencePolicy?: Partial<InvestigationEvidencePolicy>;
    onTaskStateChanged?: InvestigationServiceOptions["onTaskStateChanged"];
    onTaskUsageChanged?: InvestigationServiceOptions["onTaskUsageChanged"];
    onTaskProgress?: InvestigationServiceOptions["onTaskProgress"];
    prepareTaskInput?: InvestigationServiceOptions["prepareTaskInput"];
    staticConcurrency?: number;
  } = {},
) {
  const item = workItem();
  const { task: fixtureTask } = createInvestigationFixture("pr", { findingCount: 0 });
  const repository: InvestigationRepositoryRecord = fixtureTask.repository;
  const operator: InvestigationOperatorPrincipal = {
    id: "synthetic-operator",
    displayName: "Synthetic Operator",
    repositoryIds: [repository.id],
    permissions: [
      "repository:manage",
      "task:create",
      "task:cancel",
      "action:prepare",
      "action:execute",
    ],
    actionCapabilities: [
      "comment",
      "approve",
      "request-changes",
      "start-task",
      "reviews.verify",
      "view-evidence",
    ],
    allowRepositoryExecution: options.allowRepositoryExecution ?? false,
  };
  const otherOperator: InvestigationOperatorPrincipal = {
    ...operator,
    id: "synthetic-other-operator",
    repositoryIds: [foreignRepositoryId],
  };
  const worker: InvestigationWorkerPrincipal = {
    id: "synthetic-worker",
    repositoryIds: [repository.id],
  };
  const otherWorker: InvestigationWorkerPrincipal = {
    id: "synthetic-other-worker",
    repositoryIds: [foreignRepositoryId],
  };
  const sameScopeWorker: InvestigationWorkerPrincipal = {
    ...worker,
    id: "synthetic-same-scope-worker",
  };
  let time = startedAt;
  let sequence = 0;
  const store = new InvestigationStore();
  const administrator = { ...operator, id: "synthetic-administrator", isAdmin: true };
  const workerControls = new InvestigationWorkerControls(store, () => new Date(time));
  workerControls.initialize([worker, otherWorker, sameScopeWorker]);
  if (options.enableWorkerE2e === true)
    workerControls.update(administrator, worker.id, { version: 1, e2eEnabled: true }, () => {});
  const app = buildInvestigationApp({
    store,
    workerControls,
    now: () => new Date(time),
    idFactory: () => `synthetic-generated-${++sequence}`,
    leaseDurationMs: 1_000,
    ...(options.staticConcurrency === undefined
      ? {}
      : { staticConcurrency: options.staticConcurrency }),
    ...(options.evidencePolicy === undefined ? {} : { evidencePolicy: options.evidencePolicy }),
    ...(options.actionTransport === undefined ? {} : { actionTransport: options.actionTransport }),
    ...(options.onTaskStateChanged === undefined
      ? {}
      : { onTaskStateChanged: options.onTaskStateChanged }),
    ...(options.onTaskProgress === undefined ? {} : { onTaskProgress: options.onTaskProgress }),
    ...(options.onTaskUsageChanged === undefined
      ? {}
      : { onTaskUsageChanged: options.onTaskUsageChanged }),
    ...(options.prepareTaskInput === undefined
      ? {}
      : { prepareTaskInput: options.prepareTaskInput }),
    authenticateOperator: (request) =>
      request.headers.authorization === "administrator"
        ? administrator
        : request.headers.authorization === "operator"
          ? operator
          : request.headers.authorization === "other-operator"
            ? otherOperator
            : null,
    authenticateWorker: (request) =>
      request.headers.authorization === "worker"
        ? worker
        : request.headers.authorization === "other-worker"
          ? otherWorker
          : request.headers.authorization === "same-scope-worker"
            ? sameScopeWorker
            : null,
  });
  resources.push({ app, store });
  expect((await post(app, "/api/repositories", repository)).statusCode).toBe(201);
  expect((await post(app, "/api/work-items", item)).statusCode).toBe(201);
  return {
    app,
    store,
    repository,
    item,
    operator,
    worker,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
  };
}

async function createTask(
  app: FastifyInstance,
  item: InvestigationWorkItemRecord,
  idempotencyKey = "create-task",
  token = "operator",
): Promise<InvestigationTaskV1> {
  const response = await post(
    app,
    "/api/tasks",
    {
      workItemId: item.id,
      kind: item.kind === "pull_request" ? "pr-review" : "issue-investigate",
      idempotencyKey,
    } satisfies InvestigationCreateTaskRequestV1,
    token,
  );
  expect(response.statusCode).toBe(201);
  return response.json<InvestigationTaskV1>();
}

async function claim(
  app: FastifyInstance,
  kind: "pr-review" | "issue-investigate" = "pr-review",
): Promise<InvestigationClaim> {
  const response = await post(app, "/api/worker/claims", { supportedKinds: [kind] }, "worker");
  expect(response.statusCode).toBe(200);
  const result = response.json<InvestigationClaimResponse>().claim;
  if (result === null) throw new Error("Expected an isolated queued task to be claimed.");
  return result;
}

function artifactFor(claimed: InvestigationClaim, bytes: Buffer): InvestigationArtifactV1 {
  return {
    id: "synthetic-artifact",
    taskId: claimed.task.id,
    attemptId: claimed.attempt.id,
    subjectRef: claimed.task.subjectRef,
    kind: "log",
    name: "diagnostics 'trace'.txt",
    mediaType: "application/octet-stream",
    digest: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    availability: "available",
  };
}

function checkpointFor(claimed: InvestigationClaim): InvestigationLoopCheckpointV1 {
  if (claimed.checkpoint === null)
    throw new Error("Expected an isolated claim with an accepted checkpoint.");
  return claimed.checkpoint;
}

describe("authenticated visible output and workspace reads", () => {
  function outputBatch(
    claimed: InvestigationClaim,
    sequence = 1,
    invocationId: string | null = null,
  ): InvestigationOutputBatchRequest {
    return {
      lease: claimed.lease,
      batchId: `batch-${sequence}`,
      events: [
        {
          schemaVersion: "InvestigationOutputEventV1",
          attemptId: claimed.attempt.id,
          invocationId,
          producerSequence: sequence,
          itemId: `item-${sequence}`,
          kind: invocationId === null ? "system" : "assistant",
          operation: "replace",
          text: "Observed visible synthetic output.",
          observedAt: new Date(startedAt).toISOString(),
        },
      ],
    };
  }

  it("checks the reviewed source for new creates while replaying the same accepted request after source changes", async () => {
    const { app, item, store } = await harness();
    const request: InvestigationCreateTaskRequestV1 = {
      workItemId: item.id,
      kind: "pr-review",
      idempotencyKey: "reviewed-source",
      expectedSubjectRevisionKey: item.subject.revisionKey,
    };
    const first = await post(app, "/api/tasks", request);
    expect(first.statusCode).toBe(201);
    const changed = { ...item, subject: { ...item.subject, revisionKey: "b".repeat(64) } };
    store.put("workItems", item.id, changed);
    const replay = await post(app, "/api/tasks", request);
    expect(replay.statusCode).toBe(201);
    expect(replay.json().id).toBe(first.json().id);
    const stale = await post(app, "/api/tasks", { ...request, idempotencyKey: "new-stale-source" });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("stale_subject");
    expect(store.list("tasks")).toHaveLength(1);
    expect(
      (
        await post(app, "/api/tasks", {
          ...request,
          idempotencyKey: "invalid-revision",
          expectedSubjectRevisionKey: "not-a-digest",
        })
      ).statusCode,
    ).toBe(400);
  });

  it("rechecks the reviewed revision inside the final task admission transaction", async () => {
    let writer: InvestigationStore;
    const h = await harness({
      prepareTaskInput: async (task, item, plan) => {
        writer.put("workItems", item.id, {
          ...item,
          subject: { ...item.subject, revisionKey: "b".repeat(64) },
        });
        return {
          inputSnapshot: {
            schemaVersion: "InvestigationInputSnapshotV1",
            repositoryId: task.repository.id,
            workItemId: item.id,
            subjectRef: task.subjectRef,
            subjectRevisionKey: item.subject.revisionKey,
            title: item.title,
            body: item.body,
            comments: [],
            source: null,
          },
          plan,
          execution: null,
        };
      },
    });
    writer = h.store;
    const response = await post(h.app, "/api/tasks", {
      workItemId: h.item.id,
      kind: "pr-review",
      idempotencyKey: "source-race",
      expectedSubjectRevisionKey: h.item.subject.revisionKey,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("stale_subject");
    expect(h.store.list("tasks")).toEqual([]);
  });

  it("authenticates exact repository, worker, lease, attempt and admitted invocation identities", async () => {
    const { app, item } = await harness();
    await createTask(app, item);
    const claimed = await claim(app);
    const path = `/api/worker/tasks/${claimed.task.id}/output-events`;
    const request = outputBatch(claimed);
    expect((await post(app, path, request, "other-worker")).statusCode).toBe(403);
    expect((await post(app, path, request, "same-scope-worker")).statusCode).toBe(409);
    expect(
      (
        await post(
          app,
          path,
          { ...request, lease: { ...request.lease, fence: request.lease.fence + 1 } },
          "worker",
        )
      ).statusCode,
    ).toBe(409);
    expect((await post(app, path, request, "worker")).statusCode).toBe(200);
    expect((await post(app, path, request, "worker")).json().duplicate).toBe(true);
    expect(
      (await post(app, path, outputBatch(claimed, 2, "not-registered"), "worker")).statusCode,
    ).toBe(409);
    const receipt: InvestigationModelInvocationReceipt = {
      invocationId: "registered-output-call",
      taskId: claimed.task.id,
      attemptId: claimed.attempt.id,
      purpose: "analysis",
      engine: "codex",
      model: null,
      startedAt: new Date(startedAt).toISOString(),
      updatedAt: new Date(startedAt).toISOString(),
      revision: 1,
      state: "registered",
      disposition: "pending",
      completeness: "unavailable",
      usage: unavailableInvestigationTokenUsage(),
    };
    expect(
      (
        await post(
          app,
          `/api/worker/tasks/${claimed.task.id}/model-usage`,
          { lease: claimed.lease, receipt },
          "worker",
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (await post(app, path, outputBatch(claimed, 2, receipt.invocationId), "worker")).statusCode,
    ).toBe(200);
    const readPath = `/api/tasks/${claimed.task.id}/output-events?attemptId=${claimed.attempt.id}&limit=1`;
    expect((await get(app, readPath, "other-operator")).statusCode).toBe(403);
    expect((await get(app, readPath, "unauthenticated")).statusCode).toBe(401);
    const first = await get(app, readPath);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.json().items).toHaveLength(1);
    expect(first.json().nextCursor).not.toBeNull();
    expect(JSON.stringify(first.json())).not.toContain(claimed.lease.leaseToken);
    expect((await get(app, `${readPath}&unexpected=raw`)).statusCode).toBe(400);
  });

  it("keeps a bounded original-attempt terminal drain without weakening normal lease mutation", async () => {
    const { app, item, advance } = await harness();
    await createTask(app, item);
    const claimed = await claim(app);
    const path = `/api/worker/tasks/${claimed.task.id}/output-events`;
    const original = outputBatch(claimed);
    expect((await post(app, path, original, "worker")).statusCode).toBe(200);
    expect((await post(app, `/api/tasks/${claimed.task.id}/cancel`, {})).statusCode).toBe(200);
    advance(2_000);
    await get(app, `/api/tasks/${claimed.task.id}`);
    expect((await post(app, path, outputBatch(claimed, 2), "worker")).statusCode).toBe(200);
    expect(
      (
        await post(
          app,
          `/api/worker/tasks/${claimed.task.id}/heartbeat`,
          { lease: claimed.lease },
          "worker",
        )
      ).statusCode,
    ).toBe(409);
    advance(24 * 60 * 60 * 1_000 + 1);
    expect((await post(app, path, outputBatch(claimed, 3), "worker")).statusCode).toBe(409);
    expect((await post(app, path, original, "worker")).json().duplicate).toBe(true);
    expect(
      (
        await get(
          app,
          `/api/tasks/${claimed.task.id}/output-events?attemptId=${claimed.attempt.id}`,
        )
      ).json().items,
    ).toHaveLength(2);
  });

  it("refuses first-time expired output and cross-task attempt reads", async () => {
    const { app, item, advance } = await harness();
    await createTask(app, item);
    const claimed = await claim(app);
    const another = await createTask(app, item, "another-output-task");
    expect(
      (await get(app, `/api/tasks/${another.id}/output-events?attemptId=${claimed.attempt.id}`))
        .statusCode,
    ).toBe(404);
    advance(2_000);
    expect(
      (
        await post(
          app,
          `/api/worker/tasks/${claimed.task.id}/output-events`,
          outputBatch(claimed),
          "worker",
        )
      ).statusCode,
    ).toBe(409);
  });

  it.each([false, true])(
    "does not reopen an expired output drain after delayed lease reaping (restart: %s)",
    async (restart) => {
      const h = await harness();
      await createTask(h.app, h.item);
      const claimed = await claim(h.app);
      const path = `/api/worker/tasks/${claimed.task.id}/output-events`;
      const original = outputBatch(claimed);
      expect((await post(h.app, path, original, "worker")).statusCode).toBe(200);
      const elapsed = 24 * 60 * 60 * 1_000 + 2_000;
      h.advance(elapsed);
      expect((await post(h.app, path, outputBatch(claimed, 2), "worker")).json()).toMatchObject({
        code: "output_lease_lost",
        retryable: false,
      });
      let app = h.app;
      if (restart) {
        await h.app.close();
        app = buildInvestigationApp({
          store: h.store,
          now: () => new Date(startedAt + elapsed),
          authenticateOperator: (request) =>
            request.headers.authorization === "operator" ? h.operator : null,
          authenticateWorker: (request) =>
            request.headers.authorization === "worker" ? h.worker : null,
        });
        const resource = resources.find((entry) => entry.app === h.app);
        if (resource === undefined) throw new Error("The original synthetic resource is missing.");
        resource.app = app;
      }
      // The Task read reaps the old lease at the current observation time, as startup does.
      expect((await get(app, `/api/tasks/${claimed.task.id}`)).statusCode).toBe(200);
      expect(h.store.get("attempts", claimed.attempt.id)).toMatchObject({
        attempt: {
          finishedAt: new Date(startedAt + elapsed).toISOString(),
          terminationReason: "lease_expired",
        },
      });
      const rejected = await post(app, path, outputBatch(claimed, 2), "worker");
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json()).toMatchObject({ code: "output_lease_lost", retryable: false });
      const repeated = await post(app, path, original, "worker");
      expect(repeated.statusCode).toBe(200);
      expect(repeated.json().duplicate).toBe(true);
      expect(
        (
          await post(
            app,
            `/api/worker/tasks/${claimed.task.id}/heartbeat`,
            { lease: claimed.lease },
            "worker",
          )
        ).statusCode,
      ).toBe(409);
    },
  );

  it("replays resumed attempts independently while a delayed old batch stays in its original attempt", async () => {
    const { app, item, advance } = await harness();
    const task = await createTask(app, item);
    const first = await claim(app);
    const path = `/api/worker/tasks/${task.id}/output-events`;
    expect((await post(app, path, outputBatch(first), "worker")).statusCode).toBe(200);
    expect((await post(app, `/api/tasks/${task.id}/cancel`, {})).statusCode).toBe(200);
    advance(2_000);
    await get(app, `/api/tasks/${task.id}`);
    expect(
      (
        await post(
          app,
          `/api/worker/tasks/${task.id}/cleanup`,
          { lease: first.lease, ownedProcessesStopped: true, desktopRestored: true },
          "worker",
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (await post(app, `/api/tasks/${task.id}/resume`, { idempotencyKey: "resume-output-task" }))
        .statusCode,
    ).toBe(200);
    const second = await claim(app);
    expect(second.attempt.id).not.toBe(first.attempt.id);
    expect((await post(app, path, outputBatch(second), "worker")).statusCode).toBe(200);
    expect((await post(app, path, outputBatch(first, 2), "worker")).statusCode).toBe(200);
    const oldPage = (
      await get(app, `/api/tasks/${task.id}/output-events?attemptId=${first.attempt.id}`)
    ).json();
    const currentPage = (
      await get(app, `/api/tasks/${task.id}/output-events?attemptId=${second.attempt.id}`)
    ).json();
    expect(
      oldPage.items.map((entry: { producerSequence: number }) => entry.producerSequence),
    ).toEqual([1, 2]);
    expect(currentPage.items).toHaveLength(1);
    expect(currentPage.items[0].attemptId).toBe(second.attempt.id);
    expect(
      (
        await get(
          app,
          `/api/tasks/${task.id}/output-events?attemptId=${second.attempt.id}&after=${encodeURIComponent(oldPage.highWaterCursor)}`,
        )
      ).statusCode,
    ).toBe(400);
  });

  it("exposes authoritative defaults and uploaded metadata through bounded scoped reads", async () => {
    const { app, item } = await harness();
    const defaults = await get(app, "/api/investigation/task-defaults");
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json().budget.maxReportBytes).toBeGreaterThan(0);
    const task = await createTask(app, item);
    const claimed = await claim(app);
    const bytes = Buffer.from("Synthetic uploaded evidence.");
    const artifact = artifactFor(claimed, bytes);
    expect(
      (
        await post(
          app,
          `/api/worker/tasks/${task.id}/artifacts`,
          { lease: claimed.lease, artifact, contentBase64: bytes.toString("base64") },
          "worker",
        )
      ).statusCode,
    ).toBe(200);
    const metadata = await get(
      app,
      `/api/tasks/${task.id}/artifacts?attemptId=${claimed.attempt.id}&limit=1`,
    );
    expect(metadata.json()).toMatchObject({
      taskId: task.id,
      items: [{ artifact: { id: artifact.id } }],
      nextCursor: null,
    });
    expect(JSON.stringify(metadata.json())).not.toContain(bytes.toString("base64"));
    expect((await get(app, `/api/tasks/${task.id}/artifacts`, "other-operator")).statusCode).toBe(
      403,
    );
    expect((await get(app, "/api/reports?limit=51")).statusCode).toBe(400);
    expect((await get(app, `/api/work-items/${item.id}/discussion`)).json()).toMatchObject({
      availability: "unavailable",
      inputSnapshot: null,
    });
    expect(
      (
        await get(
          app,
          `/api/workspace/search?query=Settings&repositoryId=${item.repositoryId}`,
          "other-operator",
        )
      ).statusCode,
    ).toBe(403);
  });
});

describe("authenticated model usage receipt API", () => {
  function registered(claimed: InvestigationClaim): InvestigationModelInvocationReceipt {
    return {
      invocationId: "synthetic-model-call",
      taskId: claimed.task.id,
      attemptId: claimed.attempt.id,
      purpose: "analysis",
      engine: "codex",
      model: null,
      startedAt: new Date(startedAt).toISOString(),
      updatedAt: new Date(startedAt).toISOString(),
      revision: 1,
      state: "registered",
      disposition: "pending",
      usage: unavailableInvestigationTokenUsage(),
      completeness: "unavailable",
    };
  }

  it("does not claim zero consumption for an uncovered historical expired attempt", async () => {
    const { app, item, advance } = await harness();
    const task = await createTask(app, item);
    expect((await get(app, `/api/tasks/${task.id}/usage`)).json().usage).toMatchObject({
      completeness: "complete",
      reportedTokens: 0,
    });
    await claim(app);
    advance(2_000);
    await get(app, `/api/tasks/${task.id}`);
    expect((await get(app, `/api/tasks/${task.id}/usage`)).json().usage).toMatchObject({
      completeness: "unavailable",
      reportedTokens: 0,
      usage: { totalTokens: null },
    });
  });

  it("freezes report usage once while later receipts only increase the task total", async () => {
    const { app, item } = await harness();
    await createTask(app, item);
    const claimed = await claim(app);
    const first = registered(claimed);
    const path = `/api/worker/tasks/${claimed.task.id}/model-usage`;
    const complete = (
      receipt: InvestigationModelInvocationReceipt,
      tokens: number,
    ): InvestigationModelInvocationReceipt => ({
      ...receipt,
      revision: 2,
      state: "completed",
      disposition: "accepted",
      completeness: "complete",
      usage: { ...unavailableInvestigationTokenUsage(), totalTokens: tokens },
    });
    await post(app, path, { lease: claimed.lease, receipt: first }, "worker");
    await post(app, path, { lease: claimed.lease, receipt: complete(first, 60) }, "worker");
    const reportUsagePath = `/api/worker/tasks/${claimed.task.id}/report-usage`;
    const snapshot = await post(app, reportUsagePath, { lease: claimed.lease }, "worker");
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json().summary.reportedTokens).toBe(60);
    const second = { ...first, invocationId: "synthetic-late-call" };
    await post(app, path, { lease: claimed.lease, receipt: second }, "worker");
    await post(app, path, { lease: claimed.lease, receipt: complete(second, 40) }, "worker");
    expect((await post(app, reportUsagePath, { lease: claimed.lease }, "worker")).json()).toEqual(
      snapshot.json(),
    );
    expect(
      (await get(app, `/api/tasks/${claimed.task.id}/usage`)).json().usage.reportedTokens,
    ).toBe(100);
    expect(
      (
        await post(
          app,
          reportUsagePath,
          { lease: { ...claimed.lease, leaseToken: "wrong-token" } },
          "worker",
        )
      ).statusCode,
    ).toBe(409);
  });

  it("exposes one total in details, listing and usage API without exposing the lease secret", async () => {
    const { app, item } = await harness();
    await createTask(app, item);
    const claimed = await claim(app);
    const first = registered(claimed);
    const path = `/api/worker/tasks/${claimed.task.id}/model-usage`;
    expect(
      (await post(app, path, { lease: claimed.lease, receipt: first }, "worker")).json(),
    ).toEqual({ invocationId: first.invocationId, revision: 1, executionAllowed: true });
    const final: InvestigationModelInvocationReceipt = {
      ...first,
      revision: 2,
      state: "completed",
      disposition: "accepted",
      completeness: "complete",
      usage: {
        ...unavailableInvestigationTokenUsage(),
        inputTokens: 100,
        cachedReadTokens: 80,
        outputTokens: 20,
        reasoningTokens: 5,
        totalTokens: 120,
      },
    };
    for (let retry = 0; retry < 2; retry++)
      expect(
        (await post(app, path, { lease: claimed.lease, receipt: final }, "worker")).statusCode,
      ).toBe(200);
    const detail = await get(app, `/api/tasks/${claimed.task.id}`);
    const usage = await get(app, `/api/tasks/${claimed.task.id}/usage`);
    const listing = await get(app, "/api/tasks");
    expect(detail.json()).toMatchObject({
      usage: { reportedTokens: 120, invocationCount: 1 },
      invocations: [final],
    });
    expect(usage.json().usage).toEqual(detail.json().usage);
    expect(listing.json().usageByTaskId[claimed.task.id]).toEqual(detail.json().usage);
    expect(detail.body).not.toContain(claimed.lease.leaseToken);
    expect(
      (await get(app, `/api/tasks/${claimed.task.id}/usage`, "other-operator")).statusCode,
    ).toBe(403);
  });

  it("accepts late cancellation accounting only from the original lease owner", async () => {
    const { app, item, advance } = await harness();
    await createTask(app, item);
    const claimed = await claim(app);
    const first = registered(claimed);
    const path = `/api/worker/tasks/${claimed.task.id}/model-usage`;
    expect(
      (await post(app, path, { lease: claimed.lease, receipt: first }, "worker")).statusCode,
    ).toBe(200);
    advance(2_000);
    await get(app, `/api/tasks/${claimed.task.id}`);
    const final: InvestigationModelInvocationReceipt = {
      ...first,
      revision: 2,
      state: "cancelled",
      disposition: "rejected",
      completeness: "partial",
      usage: { ...unavailableInvestigationTokenUsage(), totalTokens: 70 },
    };
    for (const payload of [
      { lease: { ...claimed.lease, fence: claimed.lease.fence + 1 }, receipt: final },
      { lease: { ...claimed.lease, leaseToken: "wrong-token" }, receipt: final },
      { lease: claimed.lease, receipt: { ...final, attemptId: "other-attempt" } },
    ])
      expect((await post(app, path, payload, "worker")).statusCode).toBe(409);
    expect(
      (await post(app, path, { lease: claimed.lease, receipt: final }, "same-scope-worker"))
        .statusCode,
    ).toBe(409);
    expect(
      (await post(app, path, { lease: claimed.lease, receipt: final }, "worker")).statusCode,
    ).toBe(200);
    const usage = (await get(app, `/api/tasks/${claimed.task.id}/usage`)).json();
    expect(usage.usage).toMatchObject({
      reportedTokens: 70,
      completeness: "partial",
      usage: { totalTokens: null },
    });
  });
});

async function acceptAnalysis(
  app: FastifyInstance,
  claimed: InvestigationClaim,
  checkpoint: InvestigationLoopCheckpointV1,
  tokens: number,
  options: { analysis?: InvestigationAnalysisV1; finalize?: boolean } = {},
): Promise<InvestigationLoopCheckpointV1> {
  const response = await post(
    app,
    `/api/worker/tasks/${claimed.task.id}/checkpoints`,
    {
      kind: "analysis",
      lease: claimed.lease,
      round: {
        schemaVersion: "InvestigationLoopRoundV1",
        taskId: claimed.task.id,
        attemptId: claimed.attempt.id,
        inputCheckpointRef: {
          id: checkpoint.id,
          version: checkpoint.version,
          digest: checkpoint.digest,
        },
        round: checkpoint.round + 1,
        phase: options.finalize ? "finalize" : "discovery",
        analysis: structuredClone(options.analysis ?? checkpoint.analysis),
        continue: !options.finalize,
        continuationReason: "Record isolated synthetic analysis for usage accounting.",
      },
      usage: { durationMs: 0, tokens, reportBytes: 0 },
    } satisfies InvestigationCheckpointRequest,
    "worker",
  );
  expect(response.statusCode, response.body).toBe(200);
  return response.json<InvestigationCheckpointResponse>().checkpoint;
}

const unacceptedUsageDiagnostic = {
  id: "synthetic-unaccepted-model-output",
  code: "MODEL_OUTPUT_REJECTED",
  category: "recovery" as const,
  message: "The synthetic model invocation ended without accepted analysis.",
  retryable: false,
  evidenceRefs: [],
  prerequisiteRefs: [],
};

describe("investigation service API", () => {
  it("persists autonomous snapshot semantics and accepts a complete issue analysis without a finalize call", async () => {
    const { app } = await harness();
    const issue = workItem("bug");
    expect((await post(app, "/api/work-items", issue)).statusCode).toBe(201);
    const task = await createTask(app, issue, "snapshot-single-invocation");
    const claimed = await claim(app, "issue-investigate");
    const checkpoint = checkpointFor(claimed);
    expect(checkpoint.runtime.reviewMode).toBe("local_snapshot");
    expect(claimed.task.executionPolicy.mode).toBe("snapshot_only");
    const analysis = structuredClone(checkpoint.analysis);
    analysis.summary =
      "All supplied reporter facts were assessed; runtime verification remains a follow-up.";
    analysis.coverage.includedUnits.forEach((unit) => {
      unit.status = "completed";
    });
    analysis.coverage.completedUnitRefs = analysis.coverage.includedUnits.map((unit) => unit.id);
    analysis.coverage.unresolvedUnitRefs = [];
    const completed = await acceptAnalysis(app, claimed, checkpoint, 41, { analysis });
    expect(completed.stopReason).toBe("complete");
    expect(completed.consumed).toMatchObject({ rounds: 1, tokens: 41 });
    const detail = (await get(app, `/api/tasks/${task.id}`)).json();
    expect(detail.checkpoint).toEqual(completed);
    expect(completed.runtime.sourceCoverage).toBeUndefined();
  });

  it("authenticates progress and keeps heartbeat separate from real activity and semantic progress", async () => {
    const { app, item, advance } = await harness();
    const task = await createTask(app, item);
    const claimed = await claim(app);
    const path = `/api/worker/tasks/${task.id}/progress`;
    const activity = { lease: claimed.lease, sequence: 1, kind: "stage", stage: "model" };
    expect((await post(app, path, activity, "other-worker")).statusCode).toBe(403);
    expect((await post(app, path, activity, "same-scope-worker")).statusCode).toBe(409);
    expect((await post(app, path, { ...activity, meaningful: true }, "worker")).statusCode).toBe(
      400,
    );
    expect((await post(app, path, activity, "worker")).statusCode).toBe(200);
    const first = (await get(app, `/api/tasks/${task.id}`)).json().progress;
    expect(first).toMatchObject({
      stage: "model",
      lastMeaningfulProgressAt: null,
      lastHeartbeatAt: null,
    });
    advance(100);
    expect(
      (
        await post(
          app,
          `/api/worker/tasks/${task.id}/heartbeat`,
          { lease: claimed.lease },
          "worker",
        )
      ).statusCode,
    ).toBe(200);
    const heartbeat = (await get(app, `/api/tasks/${task.id}`)).json().progress;
    expect(heartbeat.lastActivityAt).toBe(first.lastActivityAt);
    expect(heartbeat.stageStartedAt).toBe(first.stageStartedAt);
    expect(heartbeat.lastMeaningfulProgressAt).toBeNull();
    expect(heartbeat.lastHeartbeatAt).not.toBeNull();
    advance(100);
    await post(app, path, activity, "worker");
    expect((await get(app, `/api/tasks/${task.id}`)).json().progress).toEqual(heartbeat);
    const checkpoint = checkpointFor(claimed);
    const analysis = structuredClone(checkpoint.analysis);
    analysis.evidence.push({
      id: "source-observation",
      subjectRef: task.subjectRef,
      source: "static_analysis",
      summary: "The pinned source delegates cleanup through the shared helper.",
      evidenceRefs: [],
    });
    const accepted = await acceptAnalysis(app, claimed, checkpoint, 3, { analysis });
    const meaningful = (await get(app, `/api/tasks/${task.id}`)).json().progress
      .lastMeaningfulProgressAt;
    expect(meaningful).not.toBeNull();
    advance(100);
    analysis.summary = "The same source was summarized again without a new observation.";
    await acceptAnalysis(app, claimed, accepted, 2, { analysis });
    expect((await get(app, `/api/tasks/${task.id}`)).json().progress.lastMeaningfulProgressAt).toBe(
      meaningful,
    );
  });

  it("records progress only for newly accepted checkpoints in the same transaction", async () => {
    const changes = vi.fn<NonNullable<InvestigationServiceOptions["onTaskProgress"]>>();
    const { app, item, store } = await harness({ onTaskProgress: changes });
    const task = await createTask(app, item);
    const claimed = await claim(app);
    const original = checkpointFor(claimed);
    changes.mockImplementation((currentTask, checkpoint, attempt) => {
      expect(currentTask.id).toBe(task.id);
      expect(store.get("checkpoints", task.id)).toEqual(checkpoint);
      expect(attempt.id).toBe(claimed.attempt.id);
    });
    const accepted = await acceptAnalysis(app, claimed, original, 0);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes.mock.calls[0]?.[1]).toEqual(accepted);
    expect(await acceptAnalysis(app, claimed, original, 0)).toEqual(accepted);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("notifies persisted task transitions once across cancellation, lease expiry, and resume", async () => {
    const changes = vi.fn<NonNullable<InvestigationServiceOptions["onTaskStateChanged"]>>();
    const { app, item, store, advance } = await harness({ onTaskStateChanged: changes });
    changes.mockImplementation((task) => {
      expect(store.get("tasks", task.id)).toEqual(task);
    });
    const cancelled = await createTask(app, item, "cancel-before-claim");
    expect(changes).not.toHaveBeenCalled();
    expect((await post(app, `/api/tasks/${cancelled.id}/cancel`, {})).statusCode).toBe(200);
    expect((await post(app, `/api/tasks/${cancelled.id}/cancel`, {})).statusCode).toBe(200);
    expect(changes.mock.calls.map(([task]) => task.state)).toEqual(["cancelled"]);

    const task = await createTask(app, item, "recover-after-expiry");
    await claim(app);
    advance(1_001);
    expect(
      (await post(app, "/api/worker/claims", { supportedKinds: ["pr-review"] }, "worker")).json(),
    ).toEqual({ claim: null });
    const resume = { idempotencyKey: "resume-progress-task" };
    expect((await post(app, `/api/tasks/${task.id}/resume`, resume)).statusCode).toBe(200);
    expect((await post(app, `/api/tasks/${task.id}/resume`, resume)).statusCode).toBe(200);
    await claim(app);
    expect((await post(app, `/api/tasks/${task.id}/cancel`, {})).statusCode).toBe(200);
    expect(changes.mock.calls.map(([entry]) => entry.state)).toEqual([
      "cancelled",
      "running",
      "interrupted",
      "queued",
      "running",
    ]);
    advance(1_001);
    await post(app, "/api/worker/claims", { supportedKinds: ["pr-review"] }, "worker");
    expect(changes.mock.calls.at(-1)?.[0]).toMatchObject({ id: task.id, state: "cancelled" });
  });

  it("rolls back a task transition and its outbox writes when the synchronous hook fails", async () => {
    const changes = vi.fn<NonNullable<InvestigationServiceOptions["onTaskStateChanged"]>>();
    const { app, item, store } = await harness({ onTaskStateChanged: changes });
    const task = await createTask(app, item);
    changes.mockImplementation((running) => {
      store.insert("idempotency", "synthetic-progress-transition", { taskId: running.id });
      throw new Error("Synthetic outbox failure inside the task transaction.");
    });
    const rejected = await post(
      app,
      "/api/worker/claims",
      { supportedKinds: ["pr-review"] },
      "worker",
    );
    expect(rejected.statusCode).toBe(500);
    expect(store.get("tasks", task.id)).toEqual(task);
    expect(store.list("attempts")).toEqual([]);
    expect(store.list("checkpoints")).toEqual([]);
    expect(store.has("idempotency", "synthetic-progress-transition")).toBe(false);
  });

  it("fails closed without authenticators while keeping liveness public", async () => {
    const store = new InvestigationStore();
    const app = buildInvestigationApp({ store });
    resources.push({ app, store });
    expect((await get(app, "/health/live", "")).statusCode).toBe(200);
    expect((await get(app, "/api/repositories")).statusCode).toBe(401);
    expect(
      (await post(app, "/api/worker/claims", { supportedKinds: ["pr-review"] }, "worker"))
        .statusCode,
    ).toBe(401);
    expect(store.list("tasks")).toEqual([]);
  });

  it("isolates operator and worker identities and enforces repository scope", async () => {
    const { app, item } = await harness();
    const task = await createTask(app, item);
    const claimed = await claim(app);
    expect((await get(app, `/api/tasks/${task.id}`, "worker")).statusCode).toBe(401);
    expect(
      (await post(app, "/api/worker/claims", { supportedKinds: ["pr-review"] })).statusCode,
    ).toBe(401);
    expect((await get(app, `/api/tasks/${task.id}`, "other-operator")).statusCode).toBe(403);
    const unauthorizedHeartbeat = await post(
      app,
      `/api/worker/tasks/${task.id}/heartbeat`,
      { lease: claimed.lease },
      "other-worker",
    );
    expect(unauthorizedHeartbeat.statusCode).toBe(403);
    expect(unauthorizedHeartbeat.json()).toMatchObject({
      code: "repository_forbidden",
      retryable: false,
    });
    expect(
      (
        await post(
          app,
          `/api/worker/tasks/${task.id}/heartbeat`,
          { lease: claimed.lease },
          "same-scope-worker",
        )
      ).statusCode,
    ).toBe(409);
  });

  it("registers targets and makes task creation idempotent without accepting different input", async () => {
    const { app, item, store, repository } = await harness();
    expect((await get(app, "/api/repositories")).json()).toEqual({ items: [repository] });
    expect((await get(app, `/api/work-items/${item.id}`)).json()).toEqual(item);
    const task = await createTask(app, item, "stable-key");
    const repeated = await createTask(app, item, "stable-key");
    expect(repeated.id).toBe(task.id);
    expect(store.list("tasks")).toHaveLength(1);

    const changed = await post(app, "/api/tasks", {
      workItemId: item.id,
      kind: "pr-review",
      idempotencyKey: "stable-key",
      executionMode: "snapshot_only",
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({ code: "idempotency_conflict" });
    expect(
      (
        await post(app, "/api/tasks", {
          workItemId: item.id,
          kind: "pr-review",
          idempotencyKey: "invalid-key",
          unexpected: true,
        })
      ).statusCode,
    ).toBe(400);
    expect(store.list("tasks")).toHaveLength(1);
  });

  it("claims only supported task kinds in the worker scope and creates a fresh checkpoint", async () => {
    const { app, item, repository } = await harness({ staticConcurrency: 2 });
    const foreignRepository = {
      id: foreignRepositoryId,
      fullName: "synthetic/other",
      githubRepositoryId: repository.githubRepositoryId + 1,
    };
    const foreignItem: InvestigationWorkItemRecord = {
      ...item,
      id: "synthetic-foreign-item",
      repositoryId: foreignRepositoryId,
      subject: {
        ...item.subject,
        id: "synthetic-foreign-subject",
        repositoryId: foreignRepositoryId,
        workItemId: "synthetic-foreign-item",
      },
    };
    expect(
      (await post(app, "/api/repositories", foreignRepository, "other-operator")).statusCode,
    ).toBe(201);
    expect((await post(app, "/api/work-items", foreignItem, "other-operator")).statusCode).toBe(
      201,
    );
    const foreignTask = await createTask(app, foreignItem, "foreign-task", "other-operator");
    const prTask = await createTask(app, item, "pr-task");
    const bugItem = workItem("bug");
    expect((await post(app, "/api/work-items", bugItem)).statusCode).toBe(201);
    const bugTask = await createTask(app, bugItem, "bug-task");

    const bugClaim = await claim(app, "issue-investigate");
    expect(bugClaim.task.id).toBe(bugTask.id);
    expect(bugClaim.checkpoint).toMatchObject({
      taskId: bugTask.id,
      attemptId: bugClaim.attempt.id,
      round: 0,
    });
    const noMoreBugs = await post(
      app,
      "/api/worker/claims",
      { supportedKinds: ["issue-investigate"] },
      "worker",
    );
    expect(noMoreBugs.json()).toEqual({ claim: null });
    expect((await claim(app)).task.id).toBe(prTask.id);
    expect((await get(app, `/api/tasks/${foreignTask.id}`, "other-operator")).json()).toMatchObject(
      { task: { state: "queued" }, attempts: [] },
    );
  });

  it("rejects forged lease credentials and extends valid ownership beyond the original deadline", async () => {
    const { app, item, advance } = await harness();
    const task = await createTask(app, item);
    const claimed = await claim(app);
    for (const lease of [
      { ...claimed.lease, fence: claimed.lease.fence + 1 },
      { ...claimed.lease, leaseToken: "synthetic-forged-token" },
    ]) {
      const rejected = await post(
        app,
        `/api/worker/tasks/${task.id}/heartbeat`,
        { lease },
        "worker",
      );
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json()).toMatchObject({ code: "lease_lost" });
    }
    advance(500);
    const renewed = await post(
      app,
      `/api/worker/tasks/${task.id}/heartbeat`,
      { lease: claimed.lease },
      "worker",
    );
    expect(renewed.statusCode).toBe(200);
    expect(Date.parse(renewed.json<InvestigationHeartbeatResponse>().leaseExpiresAt)).toBe(
      startedAt + 1_500,
    );
    advance(750);
    expect(
      (
        await post(
          app,
          `/api/worker/tasks/${task.id}/heartbeat`,
          { lease: claimed.lease },
          "worker",
        )
      ).statusCode,
    ).toBe(200);
  });

  it("rejects new execution starts after cancellation without changing the accepted runtime", async () => {
    const { app, store, item, operator } = await harness({
      allowRepositoryExecution: true,
      enableWorkerE2e: true,
    });
    const { task: original, result } = createInvestigationFixture("pr", { findingCount: 0 });
    const plan = result.plans[0];
    const plannedStep = plan?.steps[0];
    if (plan === undefined || plannedStep === undefined)
      throw new Error("Expected a synthetic saved verification plan.");
    const planRef = { id: plan.id, version: plan.version, digest: plan.digest };
    const units = plan.steps.map((step) => ({
      id: step.id,
      subjectRef: item.subject.id,
      kind: "verification",
      paths: [],
      requiredWork: step.description,
      status: "pending" as const,
      evidenceRefs: [],
    }));
    const task: InvestigationTaskV1 = {
      ...original,
      id: "synthetic-cancellation-task",
      kind: "pr-verify",
      state: "queued",
      latestReportRef: null,
      parentTaskId: original.id,
      parentReportRef: {
        id: result.report.id,
        version: result.report.version,
        digest: result.report.logicalContentDigest,
      },
      planRef,
      executionPolicy: {
        mode: "execute",
        allowedSubjectRefs: [item.subject.id],
        allowRepositoryExecution: true,
        authorizationRef: operator.id,
      },
      scope: {
        scopeManifest: {
          id: "synthetic-execution-scope",
          version: 1,
          digest: investigationContentDigest(units),
        },
        includedUnits: units,
        completedUnitRefs: [],
        unresolvedUnitRefs: units.map((unit) => unit.id),
        exclusions: [],
      },
    };
    const operation = {
      kind: "ui" as const,
      adapterId: "synthetic-ui",
      scenarioId: "synthetic-scenario",
    };
    const step = {
      stepId: plannedStep.id,
      operation,
      digest: investigationContentDigest({ stepId: plannedStep.id, operation }),
    };
    const execution: InvestigationPlanExecutionBinding = {
      planRef,
      subjectRef: item.subject.id,
      subjectRevisionKey: item.subject.revisionKey,
      executionPolicyDigest: investigationContentDigest(task.executionPolicy),
      authorizationRef: operator.id,
      satisfiedPrerequisiteRefs: plan.prerequisites.map((prerequisite) => prerequisite.id),
      steps: [step],
    };
    const input: InvestigationPreparedTaskInput = {
      inputSnapshot: {
        schemaVersion: "InvestigationInputSnapshotV1",
        repositoryId: item.repositoryId,
        workItemId: item.id,
        subjectRef: item.subject.id,
        subjectRevisionKey: item.subject.revisionKey,
        title: item.title,
        body: item.body,
        comments: [],
        source: null,
      },
      plan,
      execution,
    };
    store.insert("reports", result.report.id, result);
    store.insert("tasks", task.id, task);
    store.insert("idempotency", `input:${task.id}`, input);
    const claimResponse = await post(
      app,
      "/api/worker/claims",
      { supportedKinds: ["pr-verify"] },
      "worker",
    );
    expect(claimResponse.statusCode).toBe(200);
    const claimed = claimResponse.json<InvestigationClaimResponse>().claim;
    if (claimed === null || claimed.checkpoint === null)
      throw new Error("Expected an executable claim with an initial checkpoint.");
    expect((await post(app, `/api/tasks/${task.id}/cancel`, {})).statusCode).toBe(200);
    expect(
      (
        await post(
          app,
          `/api/worker/tasks/${task.id}/heartbeat`,
          { lease: claimed.lease },
          "worker",
        )
      ).json(),
    ).toMatchObject({ cancelRequested: true });

    const runtime = structuredClone(claimed.checkpoint.runtime);
    runtime.startedSteps.push({
      taskId: task.id,
      attemptId: claimed.attempt.id,
      planRef,
      subjectRef: execution.subjectRef,
      subjectRevisionKey: execution.subjectRevisionKey,
      stepId: step.stepId,
      stepDigest: step.digest,
    });
    const rejected = await post(
      app,
      `/api/worker/tasks/${task.id}/checkpoints`,
      {
        kind: "execution",
        lease: claimed.lease,
        execution: runtime,
      },
      "worker",
    );
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({ code: "cancellation_requested" });
    expect(store.get("checkpoints", task.id)).toEqual(claimed.checkpoint);
  });

  it("interrupts expired attempts and refuses to resume after the original PR changes", async () => {
    const { app, item, advance } = await harness();
    const task = await createTask(app, item);
    const claimed = await claim(app);
    advance(1_001);
    const nextClaim = await post(
      app,
      "/api/worker/claims",
      { supportedKinds: ["pr-review"] },
      "worker",
    );
    expect(nextClaim.json()).toEqual({ claim: null });
    expect((await get(app, `/api/tasks/${task.id}`)).json()).toMatchObject({
      task: { state: "interrupted" },
      attempts: [
        { id: claimed.attempt.id, state: "interrupted", terminationReason: "lease_expired" },
      ],
    });
    if (item.subject.kind !== "original_pr") throw new Error("Expected an original PR fixture.");
    expect(
      (
        await post(app, "/api/work-items", {
          ...item,
          subject: { ...item.subject, headSha: "f".repeat(40), revisionKey: "e".repeat(64) },
        })
      ).statusCode,
    ).toBe(201);
    const resume = await post(app, `/api/tasks/${task.id}/resume`, {
      idempotencyKey: "resume-changed-pr",
    });
    expect(resume.statusCode).toBe(409);
    expect(resume.json()).toMatchObject({ code: "stale_subject" });
    expect(
      (
        await post(
          app,
          `/api/worker/tasks/${task.id}/heartbeat`,
          { lease: claimed.lease },
          "worker",
        )
      ).statusCode,
    ).toBe(409);
  });

  it("does not let a delayed resume overwrite a newly claimed attempt", async () => {
    const firstGate = {
      entered: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
    const secondGate = {
      entered: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
    const gates = [firstGate, secondGate];
    let pauseReads = false;
    let pausedReadCount = 0;
    const execute = vi.fn(async () => {
      throw new Error("External writes are forbidden in this fixture.");
    });
    const reconcile = vi.fn(async () => {
      throw new Error("External reconciliation is forbidden in this fixture.");
    });
    const transport: InvestigationActionTransport = {
      supportedActions: [],
      execute,
      reconcile,
      async readTarget(_repository, item) {
        if (pauseReads) {
          const gate = gates[pausedReadCount++];
          if (gate === undefined)
            throw new Error("Unexpected extra target read during the resume race.");
          gate.entered.resolve();
          await gate.release.promise;
        }
        return {
          kind: item.kind,
          state: item.state,
          revisionKey: item.subject.revisionKey,
          headSha: item.subject.kind === "original_pr" ? item.subject.headSha : null,
        };
      },
    };
    const { app, item, advance } = await harness({ actionTransport: transport });
    const task = await createTask(app, item);
    const expiredClaim = await claim(app);
    advance(1_001);
    expect((await get(app, `/api/tasks/${task.id}`)).json()).toMatchObject({
      task: { state: "interrupted" },
    });

    pauseReads = true;
    const pendingRequests: ReturnType<typeof post>[] = [];
    const firstResume = post(app, `/api/tasks/${task.id}/resume`, {
      idempotencyKey: "resume-first",
    });
    pendingRequests.push(firstResume);
    try {
      await firstGate.entered.promise;
      const secondResume = post(app, `/api/tasks/${task.id}/resume`, {
        idempotencyKey: "resume-second",
      });
      pendingRequests.push(secondResume);
      await secondGate.entered.promise;

      firstGate.release.resolve();
      expect((await firstResume).statusCode).toBe(200);
      const resumedClaim = await claim(app);
      expect(resumedClaim.task.id).toBe(task.id);
      expect(resumedClaim.attempt.id).not.toBe(expiredClaim.attempt.id);

      secondGate.release.resolve();
      const rejected = await secondResume;
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json()).toMatchObject({ code: "task_resume_conflict" });
      expect(pausedReadCount).toBe(2);

      const detail = (await get(app, `/api/tasks/${task.id}`)).json<{
        task: InvestigationTaskV1;
        attempts: { id: string; state: string }[];
      }>();
      expect(detail.task.state).toBe("running");
      expect(detail.attempts).toHaveLength(2);
      expect(
        detail.attempts
          .filter((attempt) => attempt.state === "running")
          .map((attempt) => attempt.id),
      ).toEqual([resumedClaim.attempt.id]);
      expect(
        (await post(app, "/api/worker/claims", { supportedKinds: ["pr-review"] }, "worker")).json(),
      ).toEqual({ claim: null });
      expect(
        (
          await post(
            app,
            `/api/worker/tasks/${task.id}/heartbeat`,
            { lease: resumedClaim.lease },
            "worker",
          )
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await post(
            app,
            `/api/worker/tasks/${task.id}/heartbeat`,
            { lease: expiredClaim.lease },
            "worker",
          )
        ).statusCode,
      ).toBe(409);
      expect(execute).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
    } finally {
      firstGate.release.resolve();
      secondGate.release.resolve();
      await Promise.allSettled(pendingRequests);
    }
  });

  it("rejects replacing a saved plan's frozen source commit through direct task creation", async () => {
    const { app, store } = await harness({ allowRepositoryExecution: true });
    const item = workItem("bug");
    expect((await post(app, "/api/work-items", item)).statusCode).toBe(201);
    const { result } = createInvestigationFixture("bug", { findingCount: 0 });
    const source = {
      id: "synthetic-saved-source",
      kind: "source_commit" as const,
      repositoryId: item.repositoryId,
      workItemId: item.id,
      revisionKey: "9".repeat(64),
      commitSha: "7".repeat(40),
    };
    result.context.subjects.push(source);
    const plan = result.plans[0];
    if (plan === undefined)
      throw new Error("The synthetic Issue fixture must include a saved reproduction plan.");
    plan.subjectRef = source.id;
    const { digest: _planDigest, state: _state, sourceReportRef: _sourceReport, ...draft } = plan;
    plan.digest = investigationContentDigest(draft);
    const planRef = { id: plan.id, version: plan.version, digest: plan.digest };
    for (const action of result.nextActions) {
      if (action.planRef?.id === plan.id) {
        action.subjectRef = source.id;
        action.planRef = planRef;
      }
    }
    if (result.assessment.kind === "bug") result.assessment.reproduction.planRef = planRef;
    const { logicalContentDigest: _reportDigest, ...reportContent } = result.report;
    result.report.logicalContentDigest = investigationContentDigest({
      ...result,
      report: reportContent,
    });
    store.insert("reports", result.report.id, result);

    const response = await post(app, "/api/tasks", {
      idempotencyKey: "replace-saved-source",
      workItemId: item.id,
      kind: "reproduction-setup",
      executionMode: "execute",
      sourceCommit: "8".repeat(40),
      planRef,
      parentReportRef: {
        id: result.report.id,
        version: result.report.version,
        digest: result.report.logicalContentDigest,
      },
    } satisfies InvestigationCreateTaskRequestV1);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "saved_source_commit_changed" });
    expect(store.list("tasks")).toEqual([]);
  });

  it("recovers a completed checkpoint for delivery without repeating its investigation", async () => {
    const { app, store, item, advance } = await harness();
    const task = await createTask(app, item);
    const first = await claim(app);
    const checkpoint = first.checkpoint;
    if (checkpoint === null) throw new Error("Claim must persist the initial checkpoint.");
    const subject = task.subjects.find((entry) => entry.id === task.subjectRef);
    if (subject?.kind !== "original_pr") throw new Error("Expected the original PR subject.");
    const manifestContent = {
      schemaVersion: "InvestigationPrDiffManifestV1" as const,
      subjectRef: subject.id,
      baseSha: subject.baseSha,
      headSha: subject.headSha,
      mergeBaseSha: subject.baseSha,
      files: [],
      chunks: [],
    };
    checkpoint.runtime.sourceCoverage = {
      manifest: { ...manifestContent, digest: investigationContentDigest(manifestContent) },
      brokeredUnitIds: [],
    };
    checkpoint.analysis.coverage.includedUnits = checkpoint.analysis.coverage.includedUnits.map(
      (unit) => ({ ...unit, status: "completed" }),
    );
    checkpoint.analysis.coverage.completedUnitRefs = checkpoint.analysis.coverage.includedUnits.map(
      (unit) => unit.id,
    );
    checkpoint.analysis.coverage.unresolvedUnitRefs = [];
    checkpoint.round = 2;
    checkpoint.consumed.rounds = 2;
    checkpoint.lastPhase = "finalize";
    checkpoint.stopReason = "complete";
    const { digest: _digest, ...content } = checkpoint;
    checkpoint.digest = investigationContentDigest(content);
    store.put("checkpoints", task.id, checkpoint);
    advance(1_001);
    expect(
      (await post(app, `/api/tasks/${task.id}/resume`, { idempotencyKey: "delivery-resume" }))
        .statusCode,
    ).toBe(200);
    const second = await claim(app);
    expect(second.attempt.id).not.toBe(first.attempt.id);
    expect(second.checkpoint?.stopReason).toBe("complete");
    expect(second.checkpoint?.analysis).toEqual(checkpoint.analysis);
    expect(second.checkpoint?.adoptedAttemptIds).toEqual([first.attempt.id, second.attempt.id]);
    expect(
      (await post(app, `/api/worker/tasks/${task.id}/heartbeat`, { lease: first.lease }, "worker"))
        .statusCode,
    ).toBe(409);
  });

  it("preserves every finding across pages and export and sees a P0 on the last page", async () => {
    const { app, store, item } = await harness();
    const { task, result } = createInvestigationFixture("pr", {
      findingCount: 137,
      priority: "P2",
    });
    const lastFinding = result.findings.at(-1);
    if (lastFinding === undefined || result.assessment.kind !== "pr")
      throw new Error("Expected the complete PR fixture.");
    lastFinding.priority = "P0";
    for (const finding of result.findings)
      finding.feedbackDraft.body += `\n${"Full untruncated analysis evidence. ".repeat(600)}`;
    result.assessment.reviewConclusion = {
      status: "changes-requested",
      rationale: "The last finding is a confirmed unresolved P0.",
    };
    const { logicalContentDigest: _digest, ...reportContent } = result.report;
    result.report.logicalContentDigest = investigationContentDigest({
      ...result,
      report: reportContent,
    });
    task.latestReportRef = {
      id: result.report.id,
      version: result.report.version,
      digest: result.report.logicalContentDigest,
    };
    expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(2 * 1024 * 1024);
    store.insert("tasks", task.id, task);
    store.insert("reports", result.report.id, result);

    const foundIds: string[] = [];
    let cursor: string | null = null;
    let firstCursor: string | null = null;
    for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
      const response = await get(
        app,
        `/api/reports/${result.report.id}/findings?limit=50${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
      );
      expect(response.statusCode).toBe(200);
      const page = response.json<InvestigationFindingsPageV1>();
      expect(page.total).toBe(137);
      expect(page.offset).toBe(pageIndex * 50);
      foundIds.push(...page.items.map((finding) => finding.id));
      if (pageIndex === 0) firstCursor = page.nextCursor;
      if (pageIndex === 2) expect(page.items.at(-1)?.priority).toBe("P0");
      cursor = page.nextCursor;
    }
    expect(cursor).toBeNull();
    expect(foundIds).toEqual(result.findings.map((finding) => finding.id));
    expect(new Set(foundIds).size).toBe(137);
    const exported = await get(app, `/api/reports/${result.report.id}/export`);
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-disposition"]).toContain("attachment");
    expect(exported.json<InvestigationResultV1>().findings).toEqual(result.findings);
    expect(
      (await get(app, `/api/reports/${result.report.id}/export`, "other-operator")).statusCode,
    ).toBe(403);

    const contextResponse = await get(
      app,
      `/api/work-items/${item.id}/action-context?reportId=${result.report.id}`,
    );
    expect(contextResponse.statusCode).toBe(200);
    expect(
      contextResponse
        .json<ActionContextV1>()
        .hardContentBlockers.map((blocker) => blocker.findingId),
    ).toContain(lastFinding.id);

    const different = structuredClone(result);
    different.id = "synthetic-other-report";
    different.report.id = different.id;
    different.report.logicalContentDigest = "d".repeat(64);
    store.insert("reports", different.id, different);
    expect(firstCursor).not.toBeNull();
    expect(
      (
        await get(
          app,
          `/api/reports/${different.id}/findings?cursor=${encodeURIComponent(firstCursor ?? "")}`,
        )
      ).statusCode,
    ).toBe(400);
  });

  it("rejects report budgets above the server cap while accepting the exact boundary", async () => {
    const { app, item } = await harness();
    const budget = {
      maxRounds: 12,
      maxDurationMs: 60_000,
      maxTokens: 20_000,
      maxReportBytes: 64 * 1024 * 1024,
    };
    expect(
      (
        await post(app, "/api/tasks", {
          idempotencyKey: "at-report-cap",
          workItemId: item.id,
          kind: "pr-review",
          budget,
        })
      ).statusCode,
    ).toBe(201);
    const above = await post(app, "/api/tasks", {
      idempotencyKey: "above-report-cap",
      workItemId: item.id,
      kind: "pr-review",
      budget: { ...budget, maxReportBytes: budget.maxReportBytes + 1 },
    });
    expect(above.statusCode).toBe(400);
    expect(above.json()).toMatchObject({ code: "report_budget_exceeds_server_limit" });
  });

  it("requires an explicit audited budget increase before resuming an exhausted investigation", async () => {
    const { app, item, store, advance, operator } = await harness();
    const budget = {
      maxRounds: 1,
      maxDurationMs: 60_000,
      maxTokens: 20_000,
      maxReportBytes: 1024 * 1024,
    };
    const created = await post(app, "/api/tasks", {
      idempotencyKey: "budget-task",
      workItemId: item.id,
      kind: "pr-review",
      budget,
    });
    const task = created.json<InvestigationTaskV1>();
    const first = await claim(app);
    const checkpoint = first.checkpoint;
    if (checkpoint === null) throw new Error("Expected an accepted checkpoint.");
    checkpoint.round = 1;
    checkpoint.consumed.rounds = 1;
    checkpoint.stopReason = "budget_exhausted";
    const { digest: _digest, ...content } = checkpoint;
    checkpoint.digest = investigationContentDigest(content);
    store.put("checkpoints", task.id, checkpoint);
    advance(1_001);
    const exhausted = await post(app, `/api/tasks/${task.id}/resume`, {
      idempotencyKey: "without-increase",
    });
    expect(exhausted.statusCode).toBe(409);
    expect(exhausted.json()).toMatchObject({ code: "resume_budget_exhausted" });
    const acceptedBeforeIncrease = store.get<NonNullable<InvestigationClaim["checkpoint"]>>(
      "checkpoints",
      task.id,
    );
    const increased = await post(app, `/api/tasks/${task.id}/resume`, {
      idempotencyKey: "increase-budget",
      budget: { ...budget, maxRounds: 2 },
    });
    expect(increased.statusCode).toBe(200);
    expect(increased.json<InvestigationTaskV1>().budget.maxRounds).toBe(2);
    const second = await claim(app);
    expect(second.checkpoint?.consumed.rounds).toBe(1);
    expect(second.checkpoint?.budget.maxRounds).toBe(2);
    expect(second.checkpoint?.analysis).toEqual(acceptedBeforeIncrease?.analysis);
    const changedReplay = await post(app, `/api/tasks/${task.id}/resume`, {
      idempotencyKey: "increase-budget",
      budget: { ...budget, maxRounds: 3 },
    });
    expect(changedReplay.statusCode).toBe(409);
    expect(changedReplay.json()).toMatchObject({ code: "idempotency_conflict" });
    const audit = store
      .list<{
        actorId?: string;
        previousBudget?: { maxRounds: number };
        budget?: { maxRounds: number };
      }>("idempotency")
      .find(
        (record) =>
          record.actorId === operator.id &&
          record.previousBudget?.maxRounds === 1 &&
          record.budget?.maxRounds === 2,
      );
    expect(audit).toBeDefined();
  });

  it.each([0, 127, null])(
    "retains unaccepted model usage %s without adding an accepted round or losing prior tokens",
    async (tokens) => {
      const { app, item, store } = await harness();
      const task = await createTask(app, item);
      const claimed = await claim(app);
      const accepted = await acceptAnalysis(app, claimed, checkpointFor(claimed), 41);
      const response = await post(
        app,
        `/api/worker/tasks/${task.id}/checkpoints`,
        {
          kind: "interrupt",
          lease: claimed.lease,
          reason: "error",
          diagnostics: [unacceptedUsageDiagnostic],
          modelUsage: { round: 2, tokens },
        },
        "worker",
      );
      expect(response.statusCode, response.body).toBe(200);
      const checkpoint = response.json<InvestigationCheckpointResponse>().checkpoint;
      expect(checkpoint).toMatchObject({
        round: 1,
        stopReason: "error",
        consumed: { rounds: 1, tokens: 41 + (tokens ?? 0) },
        runtime: {
          unacceptedModelUsage: [{ attemptId: claimed.attempt.id, round: 2, tokens }],
        },
      });
      expect(checkpoint.analysis.summary).toBe(accepted.analysis.summary);
      expect(checkpoint.analysis.findings).toEqual(accepted.analysis.findings);
      expect(checkpoint.runtime.modelExecutions).toEqual(accepted.runtime.modelExecutions);
      expect(checkpoint.analysis.diagnostics).toContainEqual(unacceptedUsageDiagnostic);
      if (tokens === null)
        expect(checkpoint.analysis.diagnostics).toEqual(
          expect.arrayContaining([expect.objectContaining({ code: "MODEL_USAGE_UNAVAILABLE" })]),
        );
      expect(store.get("checkpoints", task.id)).toEqual(checkpoint);
    },
  );

  it.each([187, null])(
    "deduplicates unaccepted usage %s across changed diagnostics and rejects conflicting tokens",
    async (tokens) => {
      const { app, item, store, advance } = await harness();
      const task = await createTask(app, item);
      const claimed = await claim(app);
      const path = `/api/worker/tasks/${task.id}/checkpoints`;
      const request = {
        kind: "interrupt",
        lease: claimed.lease,
        reason: "error",
        diagnostics: [unacceptedUsageDiagnostic],
        modelUsage: { round: 1, tokens },
      };
      const first = await post(app, path, request, "worker");
      expect(first.statusCode, first.body).toBe(200);
      advance(100);
      const replay = await post(
        app,
        path,
        {
          ...request,
          diagnostics: [{ ...unacceptedUsageDiagnostic, id: "synthetic-delayed-ack" }],
        },
        "worker",
      );
      expect(replay.statusCode, replay.body).toBe(200);
      const checkpoint = replay.json<InvestigationCheckpointResponse>().checkpoint;
      expect(checkpoint.consumed.tokens).toBe(tokens ?? 0);
      expect(checkpoint.consumed.rounds).toBe(0);
      expect(checkpoint.round).toBe(0);
      expect(checkpoint.runtime.unacceptedModelUsage).toEqual([
        { attemptId: claimed.attempt.id, round: 1, tokens },
      ]);
      const conflict = await post(
        app,
        path,
        { ...request, modelUsage: { round: 1, tokens: tokens === null ? 1 : tokens + 1 } },
        "worker",
      );
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ code: "model_usage_receipt_conflict" });
      expect(store.get("checkpoints", task.id)).toEqual(checkpoint);
    },
  );

  it.each([
    { legacy: false, tokens: 41 },
    { legacy: false, tokens: null },
    { legacy: true, tokens: 41 },
    { legacy: true, tokens: null },
  ])(
    "does not charge an accepted round again after a lost ACK (legacy=$legacy, tokens=$tokens)",
    async ({ legacy, tokens }) => {
      const { app, item, store } = await harness();
      const task = await createTask(app, item);
      const claimed = await claim(app);
      const accepted = await acceptAnalysis(app, claimed, checkpointFor(claimed), 41);
      const key = `checkpoint:${claimed.attempt.id}:analysis:1`;
      const receipt = store.get<{
        digest: string;
        checkpoint: InvestigationLoopCheckpointV1;
        usageTokens?: number;
      }>("idempotency", key);
      expect(receipt?.usageTokens).toBe(41);
      if (receipt === undefined) throw new Error("Expected the accepted analysis receipt.");
      if (legacy) {
        const { usageTokens: _usageTokens, ...legacyReceipt } = receipt;
        store.put("idempotency", key, legacyReceipt);
      }
      const response = await post(
        app,
        `/api/worker/tasks/${task.id}/checkpoints`,
        {
          kind: "interrupt",
          lease: claimed.lease,
          reason: "error",
          diagnostics: [unacceptedUsageDiagnostic],
          modelUsage: { round: 1, tokens },
        },
        "worker",
      );
      expect(response.statusCode, response.body).toBe(200);
      const checkpoint = response.json<InvestigationCheckpointResponse>().checkpoint;
      expect(checkpoint.consumed.tokens).toBe(41);
      expect(checkpoint.consumed.rounds).toBe(1);
      expect(checkpoint.round).toBe(1);
      expect(checkpoint.analysis.summary).toBe(accepted.analysis.summary);
      expect(checkpoint.runtime.unacceptedModelUsage ?? []).toEqual([]);
      expect(checkpoint.analysis.diagnostics).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "MODEL_USAGE_UNAVAILABLE" })]),
      );
    },
  );

  it("rejects conflicting known usage for an already accepted analysis round", async () => {
    const { app, item, store } = await harness();
    const task = await createTask(app, item);
    const claimed = await claim(app);
    const accepted = await acceptAnalysis(app, claimed, checkpointFor(claimed), 41);
    const response = await post(
      app,
      `/api/worker/tasks/${task.id}/checkpoints`,
      {
        kind: "interrupt",
        lease: claimed.lease,
        reason: "error",
        diagnostics: [unacceptedUsageDiagnostic],
        modelUsage: { round: 1, tokens: 42 },
      },
      "worker",
    );
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "model_usage_receipt_conflict" });
    expect(store.get("checkpoints", task.id)).toEqual(accepted);
  });

  it("returns completed analysis unchanged when its final ACK is lost", async () => {
    const { app, item, store } = await harness();
    const task = await createTask(app, item);
    const claimed = await claim(app);
    const subject = task.subjects.find((entry) => entry.id === task.subjectRef);
    if (subject?.kind !== "original_pr") throw new Error("Expected the original PR subject.");
    const manifestContent = {
      schemaVersion: "InvestigationPrDiffManifestV1" as const,
      subjectRef: subject.id,
      baseSha: subject.baseSha,
      headSha: subject.headSha,
      mergeBaseSha: subject.baseSha,
      files: [],
      chunks: [],
    };
    const source = await post(
      app,
      `/api/worker/tasks/${task.id}/checkpoints`,
      {
        kind: "source",
        lease: claimed.lease,
        manifest: { ...manifestContent, digest: investigationContentDigest(manifestContent) },
      },
      "worker",
    );
    expect(source.statusCode, source.body).toBe(200);
    const checkpoint = source.json<InvestigationCheckpointResponse>().checkpoint;
    const analysis = structuredClone(checkpoint.analysis);
    analysis.coverage.includedUnits = analysis.coverage.includedUnits.map((unit) => ({
      ...unit,
      status: "completed",
    }));
    analysis.coverage.completedUnitRefs = analysis.coverage.includedUnits.map((unit) => unit.id);
    analysis.coverage.unresolvedUnitRefs = [];
    // Local checkout review completes in its first sufficiently evidenced invocation.
    // Losing that response retries the same round, never a new paid finalize invocation.
    const completed = await acceptAnalysis(app, claimed, checkpoint, 41, { analysis });
    expect(completed.stopReason).toBe("complete");
    expect(await acceptAnalysis(app, claimed, checkpoint, 41, { analysis })).toEqual(completed);
    const response = await post(
      app,
      `/api/worker/tasks/${task.id}/checkpoints`,
      {
        kind: "interrupt",
        lease: claimed.lease,
        reason: "error",
        diagnostics: [unacceptedUsageDiagnostic],
        modelUsage: { round: 1, tokens: 41 },
      },
      "worker",
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<InvestigationCheckpointResponse>().checkpoint).toEqual(completed);
    expect(store.get("checkpoints", task.id)).toEqual(completed);
    expect(completed.consumed).toMatchObject({ rounds: 1, tokens: 41 });
  });

  it.each([187, null])(
    "does not record model usage %s from expired or superseded leases",
    async (tokens) => {
      const { app, item, store, advance } = await harness();
      const task = await createTask(app, item);
      const expiredClaim = await claim(app);
      const path = `/api/worker/tasks/${task.id}/checkpoints`;
      const request = {
        kind: "interrupt",
        lease: expiredClaim.lease,
        reason: "error",
        diagnostics: [unacceptedUsageDiagnostic],
        modelUsage: { round: 1, tokens },
      };
      advance(1_001);
      const expired = await post(app, path, request, "worker");
      expect(expired.statusCode).toBe(409);
      expect(expired.json()).toMatchObject({ code: "lease_lost" });
      expect(store.get("checkpoints", task.id)).toEqual(expiredClaim.checkpoint);
      const resume = await post(app, `/api/tasks/${task.id}/resume`, {
        idempotencyKey: "resume-after-rejected-stale-usage",
      });
      expect(resume.statusCode, resume.body).toBe(200);
      const current = await claim(app);
      expect(current.attempt.id).not.toBe(expiredClaim.attempt.id);
      const superseded = await post(app, path, request, "worker");
      expect(superseded.statusCode).toBe(409);
      expect(superseded.json()).toMatchObject({ code: "lease_lost" });
      expect(store.get("checkpoints", task.id)).toEqual(current.checkpoint);
      expect(checkpointFor(current).consumed.tokens).toBe(0);
      expect(checkpointFor(current).runtime.unacceptedModelUsage ?? []).toEqual([]);
    },
  );

  it("persists a large checkpoint and protects accepted terminal delivery from cancellation", async () => {
    const { app, item, store } = await harness();
    const task = await createTask(app, item);
    const claimed = await claim(app);
    const message = "x".repeat(33 * 1024 * 1024);
    const response = await post(
      app,
      `/api/worker/tasks/${task.id}/checkpoints`,
      {
        kind: "interrupt",
        lease: claimed.lease,
        reason: "blocked",
        diagnostics: [
          {
            id: "large-complete-diagnostic",
            code: "SOURCE_UNAVAILABLE",
            category: "blocker",
            message,
            retryable: true,
            evidenceRefs: [],
            prerequisiteRefs: [],
          },
        ],
      },
      "worker",
    );
    expect(response.statusCode).toBe(200);
    const saved = store.get<{ analysis: { diagnostics: { message: string }[] } }>(
      "checkpoints",
      task.id,
    );
    expect(saved?.analysis.diagnostics[0]?.message).toHaveLength(message.length);
    const cancelled = await post(app, `/api/tasks/${task.id}/cancel`, {});
    expect(cancelled.statusCode).toBe(409);
    expect(cancelled.json()).toMatchObject({ code: "terminal_analysis_accepted" });
  }, 30_000);

  it("verifies artifact bytes and allows content access only within the authorized task scope", async () => {
    const { app, item, store } = await harness({ staticConcurrency: 2 });
    const task = await createTask(app, item);
    const claimed = await claim(app);
    const bytes = Buffer.from("Isolated synthetic artifact bytes.\n");
    const artifact = artifactFor(claimed, bytes);
    const uploadPath = `/api/worker/tasks/${task.id}/artifacts`;
    const upload = { lease: claimed.lease, artifact, contentBase64: bytes.toString("base64") };
    for (const invalid of [
      { ...upload, artifact: { ...artifact, digest: "0".repeat(64) } },
      { ...upload, artifact: { ...artifact, byteLength: bytes.length + 1 } },
      { ...upload, contentBase64: `${upload.contentBase64}\n` },
      { ...upload, artifact: { ...artifact, taskId: "synthetic-unrelated-task" } },
    ]) {
      expect((await post(app, uploadPath, invalid, "worker")).statusCode).toBe(400);
    }
    expect(store.list("evidenceAssets")).toEqual([]);
    expect((await post(app, uploadPath, upload, "worker")).statusCode).toBe(200);
    expect((await post(app, uploadPath, upload, "worker")).statusCode).toBe(200);
    expect(store.list("evidenceAssets")).toHaveLength(1);

    const content = await get(app, `/api/artifacts/${artifact.id}/content`);
    expect(content.statusCode).toBe(200);
    expect(content.rawPayload).toEqual(bytes);
    expect(content.headers["content-length"]).toBe(String(bytes.length));
    expect(content.headers.etag).toBe(`"${artifact.digest}"`);
    expect(content.headers["content-disposition"]).toContain("%27trace%27");
    expect(
      (await get(app, `/api/artifacts/${artifact.id}/content`, "other-operator")).statusCode,
    ).toBe(403);
    const ownRead = await post(
      app,
      `/api/worker/tasks/${task.id}/artifact-content`,
      { lease: claimed.lease, artifactId: artifact.id },
      "worker",
    );
    expect(ownRead.statusCode).toBe(200);
    expect(ownRead.json()).toEqual({ artifact, contentBase64: upload.contentBase64 });

    const secondTask = await createTask(app, item, "second-task");
    const secondClaim = await claim(app);
    expect(secondClaim.task.id).toBe(secondTask.id);
    const crossTaskRead = await post(
      app,
      `/api/worker/tasks/${secondTask.id}/artifact-content`,
      { lease: secondClaim.lease, artifactId: artifact.id },
      "worker",
    );
    expect(crossTaskRead.statusCode).toBe(403);
    expect(crossTaskRead.json()).toMatchObject({ code: "artifact_scope_mismatch" });
  });

  it("exposes current expiration separately and authorizes before revealing expired content", async () => {
    const { app, item, store, advance } = await harness({
      evidencePolicy: { retentionSeconds: 1 },
    });
    const task = await createTask(app, item);
    const claimed = await claim(app);
    const bytes = Buffer.from("Synthetic retained content");
    const artifact = artifactFor(claimed, bytes);
    expect(
      (
        await post(
          app,
          `/api/worker/tasks/${task.id}/artifacts`,
          {
            lease: claimed.lease,
            artifact,
            contentBase64: bytes.toString("base64"),
          },
          "worker",
        )
      ).statusCode,
    ).toBe(200);
    const metadataPath = `/api/artifacts/${artifact.id}`;
    expect((await get(app, metadataPath)).json()).toMatchObject({
      artifact,
      expiredAt: null,
      retentionProtected: true,
    });
    expect((await get(app, metadataPath, "other-operator")).statusCode).toBe(403);
    store.put("tasks", task.id, { ...task, state: "completed" });
    advance(2_000);
    new InvestigationEvidenceStore(
      store,
      { retentionSeconds: 1 },
      () => new Date(startedAt + 2_000),
    ).cleanup();
    expect((await get(app, metadataPath)).json()).toMatchObject({
      artifact: { ...artifact, availability: "expired" },
      expiredAt: new Date(startedAt + 2_000).toISOString(),
      retentionProtected: false,
    });
    const expired = await get(app, `${metadataPath}/content`);
    expect(expired.statusCode).toBe(410);
    expect(expired.json()).toMatchObject({ code: "artifact_expired", retryable: false });
    expect((await get(app, `${metadataPath}/content`, "other-operator")).statusCode).toBe(403);
    expect(
      store.get<{ artifact: InvestigationArtifactV1 }>("evidenceMetadata", artifact.id)?.artifact,
    ).toEqual(artifact);
  });

  it("rejects excess uploads without disclosing foreign storage usage", async () => {
    const { app, item, store } = await harness({
      evidencePolicy: { maximumBytes: 1, maximumCount: 1 },
    });
    const task = await createTask(app, item);
    const claimed = await claim(app);
    const bytes = Buffer.from("a");
    const artifact = artifactFor(claimed, bytes);
    const path = `/api/worker/tasks/${task.id}/artifacts`;
    const payload = { artifact, lease: claimed.lease, contentBase64: bytes.toString("base64") };
    expect((await post(app, path, payload, "worker")).statusCode).toBe(200);
    expect((await post(app, path, payload, "worker")).statusCode).toBe(200);
    const rejected = await post(
      app,
      path,
      { ...payload, artifact: { ...artifact, id: "second-artifact" } },
      "worker",
    );
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({ code: "evidence_quota_exceeded", retryable: false });
    expect(rejected.json()).not.toHaveProperty("usage");
    expect(store.list("evidenceAssets")).toHaveLength(1);
  });
});

describe("ledger-owned checkpoint budgets", () => {
  function registration(
    claimed: InvestigationClaim,
    invocationId: string,
    purpose: InvestigationModelInvocationReceipt["purpose"] = "analysis",
  ): InvestigationModelInvocationReceipt {
    return {
      invocationId,
      taskId: claimed.task.id,
      attemptId: claimed.attempt.id,
      purpose,
      engine: "codex",
      model: null,
      startedAt: new Date(startedAt).toISOString(),
      updatedAt: new Date(startedAt).toISOString(),
      revision: 1,
      state: "registered",
      disposition: "pending",
      completeness: "unavailable",
      usage: unavailableInvestigationTokenUsage(),
    };
  }

  it("commits usage and a durable comment wakeup before notifying the current task state", async () => {
    let usageStore: InvestigationStore | undefined;
    const notifications: InvestigationTaskV1[] = [];
    const onTaskUsageChanged = vi.fn((task: InvestigationTaskV1) => {
      expect(usageStore?.inTransaction).toBe(false);
      expect(usageStore?.has("idempotency", investigationUsagePublicationPendingKey(task.id))).toBe(
        true,
      );
      notifications.push(structuredClone(task));
      throw new Error("Synthetic publisher interruption after accounting commit.");
    });
    const { app, item, store, advance } = await harness({ onTaskUsageChanged });
    usageStore = store;
    const task = await createTask(app, item);
    const claimed = await claim(app);
    const path = `/api/worker/tasks/${task.id}/model-usage`;
    const first = registration(claimed, "usage-comment-notification");
    const admitted = await post(app, path, { lease: claimed.lease, receipt: first }, "worker");
    expect(admitted.statusCode, admitted.body).toBe(200);
    expect(admitted.json()).toMatchObject({ executionAllowed: true, revision: 1 });
    expect(
      (await post(app, path, { lease: claimed.lease, receipt: first }, "worker")).statusCode,
    ).toBe(200);
    expect(onTaskUsageChanged).toHaveBeenCalledTimes(1);
    const running = {
      ...first,
      revision: 2,
      state: "running",
      completeness: "partial",
      usage: { ...unavailableInvestigationTokenUsage(), totalTokens: 20 },
    };
    expect(
      (await post(app, path, { lease: claimed.lease, receipt: running }, "worker")).statusCode,
    ).toBe(200);
    expect((await get(app, `/api/tasks/${task.id}/usage`)).json().usage).toMatchObject({
      reportedTokens: 20,
      activeInvocationCount: 1,
    });
    const cancellation = await post(app, `/api/tasks/${task.id}/cancel`, {});
    expect(cancellation.statusCode).toBe(200);
    expect(cancellation.json()).toMatchObject({ id: task.id, state: "running" });
    // Active cancellation is a request until the Worker stops or its lease expires.
    advance(1_001);
    const reaped = await post(
      app,
      "/api/worker/claims",
      { supportedKinds: ["pr-review"] },
      "worker",
    );
    expect(reaped.statusCode, reaped.body).toBe(200);
    expect(reaped.json()).toEqual({ claim: null });
    expect(store.get<InvestigationTaskV1>("tasks", task.id)?.state).toBe("cancelled");
    const cancelled = {
      ...running,
      revision: 3,
      state: "cancelled",
      completeness: "complete",
      usage: { ...unavailableInvestigationTokenUsage(), totalTokens: 30 },
    };
    expect(
      (await post(app, path, { lease: claimed.lease, receipt: cancelled }, "worker")).statusCode,
    ).toBe(200);
    expect(notifications.map((item) => item.state)).toEqual(["running", "running", "cancelled"]);
    expect((await get(app, `/api/tasks/${task.id}/usage`)).json().usage).toMatchObject({
      reportedTokens: 30,
      activeInvocationCount: 0,
    });
    expect(store.has("idempotency", investigationUsagePublicationPendingKey(task.id))).toBe(true);
  });

  it("charges failed model edits before admitting another model process", async () => {
    const { app, item, store } = await harness();
    const task = await createTask(app, item);
    store.put("tasks", task.id, { ...task, budget: { ...task.budget, maxTokens: 50 } });
    const claimed = await claim(app);
    const path = `/api/worker/tasks/${task.id}/model-usage`;
    const first = registration(claimed, "failed-edit", "model_edit");
    expect(
      (await post(app, path, { lease: claimed.lease, receipt: first }, "worker")).json()
        .executionAllowed,
    ).toBe(true);
    const failed = {
      ...first,
      revision: 2,
      state: "failed",
      disposition: "rejected",
      completeness: "complete",
      usage: { ...unavailableInvestigationTokenUsage(), totalTokens: 50 },
    };
    expect(
      (await post(app, path, { lease: claimed.lease, receipt: failed }, "worker")).statusCode,
    ).toBe(200);
    expect(
      (await post(app, path, { lease: claimed.lease, receipt: failed }, "worker")).statusCode,
    ).toBe(200);
    const denied = registration(claimed, "not-dispatched");
    expect(
      (await post(app, path, { lease: claimed.lease, receipt: denied }, "worker")).json()
        .executionAllowed,
    ).toBe(false);
    expect(
      (
        await post(
          app,
          path,
          { lease: claimed.lease, receipt: { ...denied, revision: 2, state: "running" } },
          "worker",
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await post(
          app,
          path,
          {
            lease: claimed.lease,
            receipt: {
              ...denied,
              revision: 2,
              state: "failed",
              disposition: "rejected",
              completeness: "complete",
              usage: { ...unavailableInvestigationTokenUsage(), totalTokens: 0 },
            },
          },
          "worker",
        )
      ).statusCode,
    ).toBe(200);
    const interrupted = await post(
      app,
      `/api/worker/tasks/${task.id}/checkpoints`,
      { kind: "interrupt", lease: claimed.lease, reason: "budget_exhausted", diagnostics: [] },
      "worker",
    );
    expect(interrupted.statusCode, interrupted.body).toBe(200);
    expect(interrupted.json().checkpoint).toMatchObject({
      consumed: { tokens: 50 },
      stopReason: "budget_exhausted",
    });
    expect((await get(app, `/api/tasks/${task.id}/usage`)).json().usage.reportedTokens).toBe(50);
  });

  it("binds one invocation to one analysis round and projects rather than recharges its tokens", async () => {
    const { app, item } = await harness();
    const task = await createTask(app, item);
    const claimed = await claim(app);
    const checkpoint = checkpointFor(claimed);
    const path = `/api/worker/tasks/${task.id}/model-usage`;
    const first = registration(claimed, "analysis-call");
    await post(app, path, { lease: claimed.lease, receipt: first }, "worker");
    await post(
      app,
      path,
      {
        lease: claimed.lease,
        receipt: {
          ...first,
          revision: 2,
          state: "completed",
          completeness: "complete",
          usage: { ...unavailableInvestigationTokenUsage(), totalTokens: 40 },
        },
      },
      "worker",
    );
    const request = {
      kind: "analysis",
      lease: claimed.lease,
      invocationId: first.invocationId,
      usage: { durationMs: 0, tokens: 40, reportBytes: 0 },
      round: {
        schemaVersion: "InvestigationLoopRoundV1",
        taskId: task.id,
        attemptId: claimed.attempt.id,
        inputCheckpointRef: {
          id: checkpoint.id,
          version: checkpoint.version,
          digest: checkpoint.digest,
        },
        round: 1,
        phase: "discovery",
        analysis: structuredClone(checkpoint.analysis),
        continue: true,
        continuationReason: "Review pending synthetic scope.",
      },
    };
    const checkpointPath = `/api/worker/tasks/${task.id}/checkpoints`;
    expect(
      (
        await post(
          app,
          checkpointPath,
          { ...request, usage: { ...request.usage, tokens: 41 } },
          "worker",
        )
      ).statusCode,
    ).toBe(409);
    const accepted = await post(app, checkpointPath, request, "worker");
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().checkpoint.consumed.tokens).toBe(40);
    expect((await post(app, checkpointPath, request, "worker")).json()).toEqual(accepted.json());
    const current = accepted.json().checkpoint;
    const reuse = await post(
      app,
      checkpointPath,
      {
        ...request,
        round: {
          ...request.round,
          round: 2,
          inputCheckpointRef: { id: current.id, version: current.version, digest: current.digest },
        },
      },
      "worker",
    );
    expect(reuse.statusCode).toBe(409);
    expect(reuse.json().code).toBe("analysis_invocation_already_used");
    expect((await get(app, `/api/tasks/${task.id}/usage`)).json().usage.reportedTokens).toBe(40);
  });

  it("records a late first registration as not admitted and accepts only zero-cost termination", async () => {
    const { app, item, advance } = await harness();
    const task = await createTask(app, item);
    const claimed = await claim(app);
    advance(2_000);
    await get(app, `/api/tasks/${task.id}`);
    const first = registration(claimed, "late-registration");
    const path = `/api/worker/tasks/${task.id}/model-usage`;
    expect(
      (await post(app, path, { lease: claimed.lease, receipt: first }, "worker")).json()
        .executionAllowed,
    ).toBe(false);
    expect(
      (
        await post(
          app,
          path,
          {
            lease: claimed.lease,
            receipt: {
              ...first,
              revision: 2,
              state: "completed",
              completeness: "complete",
              usage: { ...unavailableInvestigationTokenUsage(), totalTokens: 1 },
            },
          },
          "worker",
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await post(
          app,
          path,
          {
            lease: claimed.lease,
            receipt: {
              ...first,
              revision: 2,
              state: "failed",
              disposition: "rejected",
              completeness: "complete",
              usage: { ...unavailableInvestigationTokenUsage(), totalTokens: 0 },
            },
          },
          "worker",
        )
      ).statusCode,
    ).toBe(200);
  });
});

describe("recorded E2E analysis recovery accounting", () => {
  async function claimE2e(app: FastifyInstance): Promise<InvestigationClaim> {
    const response = await post(
      app,
      "/api/worker/claims",
      { supportedKinds: ["pr-e2e"] },
      "worker",
    );
    expect(response.statusCode, response.body).toBe(200);
    const claimed = response.json<InvestigationClaimResponse>().claim;
    if (claimed === null || claimed.checkpoint === null)
      throw new Error("Expected the synthetic E2E claim.");
    return claimed;
  }
  async function billInvocation(
    app: FastifyInstance,
    claimed: InvestigationClaim,
    purpose: InvestigationModelInvocationReceipt["purpose"],
  ) {
    const receipt: InvestigationModelInvocationReceipt = {
      invocationId: "original-e2e-model",
      taskId: claimed.task.id,
      attemptId: claimed.attempt.id,
      purpose,
      engine: "codex",
      model: null,
      startedAt: new Date(startedAt).toISOString(),
      updatedAt: new Date(startedAt).toISOString(),
      revision: 1,
      state: "registered",
      disposition: "pending",
      completeness: "unavailable",
      usage: unavailableInvestigationTokenUsage(),
    };
    const path = `/api/worker/tasks/${claimed.task.id}/model-usage`;
    const registered = await post(app, path, { lease: claimed.lease, receipt }, "worker");
    expect(registered.statusCode, registered.body).toBe(200);
    const completed = await post(
      app,
      path,
      {
        lease: claimed.lease,
        receipt: {
          ...receipt,
          revision: 2,
          state: "completed",
          completeness: "complete",
          usage: { ...unavailableInvestigationTokenUsage(), totalTokens: 70 },
        },
      },
      "worker",
    );
    expect(completed.statusCode, completed.body).toBe(200);
  }
  function analysisRequest(
    claimed: InvestigationClaim,
    checkpoint: InvestigationLoopCheckpointV1,
    analysis = checkpoint.analysis,
  ) {
    return {
      kind: "analysis" as const,
      lease: claimed.lease,
      usage: { durationMs: 0, tokens: 0, reportBytes: 0 },
      round: {
        schemaVersion: "InvestigationLoopRoundV1" as const,
        taskId: claimed.task.id,
        attemptId: claimed.attempt.id,
        inputCheckpointRef: {
          id: checkpoint.id,
          version: checkpoint.version,
          digest: checkpoint.digest,
        },
        round: checkpoint.round + 1,
        phase: "finalize" as const,
        analysis,
        continue: false,
        continuationReason:
          "Reconstruct the report from accepted E2E observations without invoking a model.",
      },
    };
  }

  it("recovers accepted execution across attempts, seals a report, and retains exactly one original model charge", async () => {
    const { app, item, advance } = await harness({
      allowRepositoryExecution: true,
      enableWorkerE2e: true,
    });
    const created = await post(app, "/api/tasks", {
      workItemId: item.id,
      kind: "pr-e2e",
      executionMode: "execute",
      idempotencyKey: "e2e-recovery",
    });
    expect(created.statusCode, created.body).toBe(201);
    const first = await claimE2e(app);
    const firstCheckpoint = checkpointFor(first);
    const subject = first.task.subjects.find((entry) => entry.id === first.task.subjectRef);
    if (subject?.kind !== "original_pr") throw new Error("Expected the pinned PR subject.");
    const marker = {
      attemptId: first.attempt.id,
      status: "started" as const,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: null,
    };
    const start = await post(
      app,
      `/api/worker/tasks/${first.task.id}/checkpoints`,
      {
        kind: "execution",
        lease: first.lease,
        execution: { ...firstCheckpoint.runtime, e2eExecution: marker },
      },
      "worker",
    );
    expect(start.statusCode, start.body).toBe(200);
    const started = start.json<InvestigationCheckpointResponse>().checkpoint;
    await billInvocation(app, first, "e2e");
    const incomplete = await post(
      app,
      `/api/worker/tasks/${first.task.id}/checkpoints`,
      analysisRequest(first, started),
      "worker",
    );
    expect(incomplete.statusCode).toBe(409);
    expect(incomplete.json().code).toBe("analysis_usage_mismatch");

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
      "base64",
    );
    const artifact: InvestigationArtifactV1 = {
      id: "recorded-feature-image",
      taskId: first.task.id,
      attemptId: first.attempt.id,
      subjectRef: subject.id,
      kind: "image",
      name: "synthetic-feature.png",
      mediaType: "image/png",
      digest: createHash("sha256").update(png).digest("hex"),
      byteLength: png.length,
      availability: "available",
    };
    const uploaded = await post(
      app,
      `/api/worker/tasks/${first.task.id}/artifacts`,
      { lease: first.lease, artifact, contentBase64: png.toString("base64") },
      "worker",
    );
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    const runtime: InvestigationRuntimeState = {
      ...structuredClone(started.runtime),
      artifacts: [artifact],
      e2eExecution: {
        ...marker,
        status: "completed",
        completedAt: new Date(startedAt).toISOString(),
      },
      evidence: [
        {
          id: "recorded-observation",
          subjectRef: subject.id,
          source: "executor_observation",
          authority: "worker",
          summary: "The synthetic feature displayed its expected value.",
          artifactRefs: [artifact.id],
          evidenceRefs: [],
          provenance: {
            taskId: first.task.id,
            attemptId: first.attempt.id,
            producer: "e2e-tool-server",
            recordedAt: new Date(startedAt).toISOString(),
          },
        },
      ],
      checks: [
        {
          id: "recorded-assertion",
          scenarioId: "recorded-feature",
          subjectRef: subject.id,
          planRef: null,
          required: true,
          description: "The expected value is displayed.",
          status: "passed",
          executor: "e2e-tool-server",
          evidenceRefs: ["recorded-observation"],
          authoritativeAttemptId: first.attempt.id,
        },
      ],
      e2e: {
        headSha: subject.headSha,
        buildIdentity: "Synthetic build of the exact pinned revision",
        cleanup: {
          confirmed: true,
          recordedAt: new Date(startedAt).toISOString(),
          summary: "Synthetic owned processes are stopped.",
        },
        features: [
          {
            id: "recorded-feature",
            title: "Changed feature",
            paths: ["src/feature.cs"],
            scenario: "Operate the changed feature.",
            userVisible: true,
            outcome: "passed",
            assertions: [
              {
                id: "recorded-assertion",
                expected: "Expected value",
                observed: "Expected value",
                outcome: "passed",
                evidenceRefs: ["recorded-observation"],
              },
            ],
            artifactRefs: [artifact.id],
            limitations: [],
          },
        ],
      },
    };
    const executed = await post(
      app,
      `/api/worker/tasks/${first.task.id}/checkpoints`,
      { kind: "execution", lease: first.lease, execution: runtime },
      "worker",
    );
    expect(executed.statusCode, executed.body).toBe(200);
    const recorded = executed.json<InvestigationCheckpointResponse>().checkpoint;
    expect(recorded.consumed.tokens).toBe(70);
    const forged = projectRecordedE2eAnalysis(first.task, recorded).analysis;
    forged.summary = "Unrecorded model-authored replacement summary.";
    const mismatch = await post(
      app,
      `/api/worker/tasks/${first.task.id}/checkpoints`,
      analysisRequest(first, recorded, forged),
      "worker",
    );
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().code).toBe("e2e_recovery_analysis_mismatch");
    const interrupted = await post(
      app,
      `/api/worker/tasks/${first.task.id}/checkpoints`,
      { kind: "interrupt", lease: first.lease, reason: "interrupted", diagnostics: [] },
      "worker",
    );
    expect(interrupted.statusCode, interrupted.body).toBe(200);
    expect(
      (
        await post(
          app,
          `/api/worker/tasks/${first.task.id}/cleanup`,
          { lease: first.lease, ownedProcessesStopped: true, desktopRestored: true },
          "worker",
        )
      ).statusCode,
    ).toBe(200);
    advance(2_000);
    await get(app, `/api/tasks/${first.task.id}`);
    const resumed = await post(app, `/api/tasks/${first.task.id}/resume`, {
      idempotencyKey: "resume-recorded-e2e",
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
    const second = await claimE2e(app);
    const checkpoint = checkpointFor(second);
    expect(second.attempt.id).not.toBe(first.attempt.id);
    expect(checkpoint.runtime.e2eExecution?.attemptId).toBe(first.attempt.id);
    const projection = projectRecordedE2eAnalysis(second.task, checkpoint);
    const recoveryRequest = analysisRequest(second, checkpoint, projection.analysis);
    const accepted = await post(
      app,
      `/api/worker/tasks/${second.task.id}/checkpoints`,
      recoveryRequest,
      "worker",
    );
    expect(accepted.statusCode, accepted.body).toBe(200);
    const recovered = accepted.json<InvestigationCheckpointResponse>().checkpoint;
    expect(recovered).toMatchObject({ stopReason: "complete", consumed: { tokens: 70 } });
    const disabled = await post(
      app,
      "/api/workers/synthetic-worker/e2e",
      { version: 2, e2eEnabled: false },
      "administrator",
    );
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(disabled.json()).toMatchObject({ e2eEnabled: false, status: "disabling" });
    const heartbeat = await post(
      app,
      `/api/worker/tasks/${second.task.id}/heartbeat`,
      { lease: second.lease },
      "worker",
    );
    expect(heartbeat.statusCode, heartbeat.body).toBe(200);
    expect(heartbeat.json().cancelRequested).toBe(false);
    const executionAfterCompletion = await post(
      app,
      `/api/worker/tasks/${second.task.id}/checkpoints`,
      { kind: "execution", lease: second.lease, execution: recovered.runtime },
      "worker",
    );
    expect(executionAfterCompletion.statusCode).toBe(409);
    expect(executionAfterCompletion.json().code).toBe("loop_already_stopped");
    expect(
      (
        await post(
          app,
          `/api/worker/tasks/${second.task.id}/checkpoints`,
          recoveryRequest,
          "worker",
        )
      ).json(),
    ).toEqual(accepted.json());
    const extraRound = await post(
      app,
      `/api/worker/tasks/${second.task.id}/checkpoints`,
      analysisRequest(
        second,
        recovered,
        projectRecordedE2eAnalysis(second.task, recovered).analysis,
      ),
      "worker",
    );
    expect(extraRound.statusCode).toBe(409);
    expect(extraRound.json().code).toBe("loop_already_stopped");
    const usageResponse = await post(
      app,
      `/api/worker/tasks/${second.task.id}/report-usage`,
      { lease: second.lease },
      "worker",
    );
    expect(usageResponse.statusCode, usageResponse.body).toBe(200);
    const usage = usageResponse.json<{ summary: InvestigationUsageSummary }>().summary;
    expect(usage).toMatchObject({ reportedTokens: 70, invocationCount: 1 });
    const { buildInvestigationReportSubmission } = await import(
      "../../../worker/src/investigation/report-builder.js"
    );
    const submission = buildInvestigationReportSubmission({
      task: second.task,
      attempt: second.attempt,
      checkpoint: recovered,
      reportId: second.reportId,
      outcome: "completed",
      usage,
    });
    for (const part of submission.parts) {
      const uploadedPart = await post(
        app,
        `/api/worker/tasks/${second.task.id}/report-parts`,
        { lease: second.lease, part },
        "worker",
      );
      expect(uploadedPart.statusCode, uploadedPart.body).toBe(200);
    }
    const finalized = await post(
      app,
      `/api/worker/tasks/${second.task.id}/finalize`,
      { lease: second.lease, header: submission.header, manifest: submission.manifest },
      "worker",
    );
    expect(finalized.statusCode, finalized.body).toBe(200);
    const detail = (await get(app, `/api/tasks/${second.task.id}`)).json();
    expect(detail).toMatchObject({
      task: { state: "completed" },
      usage: { reportedTokens: 70, invocationCount: 1 },
    });
    expect(detail.invocations).toHaveLength(1);
    expect(detail.invocations[0].attemptId).toBe(first.attempt.id);
    const cleanup = await post(
      app,
      `/api/worker/tasks/${second.task.id}/cleanup`,
      { lease: second.lease, ownedProcessesStopped: true, desktopRestored: true },
      "worker",
    );
    expect(cleanup.statusCode, cleanup.body).toBe(200);
    const workerState = await get(app, "/api/workers", "administrator");
    expect(workerState.json().items).toContainEqual(
      expect.objectContaining({ id: "synthetic-worker", e2eEnabled: false, status: "static_only" }),
    );
  });

  it("does not allow a static task to replace a registered model call with zero-cost analysis", async () => {
    const { app, item } = await harness();
    await createTask(app, item);
    const claimed = await claim(app);
    await billInvocation(app, claimed, "analysis");
    const rejected = await post(
      app,
      `/api/worker/tasks/${claimed.task.id}/checkpoints`,
      analysisRequest(claimed, checkpointFor(claimed)),
      "worker",
    );
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().code).toBe("analysis_usage_mismatch");
    expect((await get(app, `/api/tasks/${claimed.task.id}/usage`)).json().usage).toMatchObject({
      reportedTokens: 70,
      invocationCount: 1,
    });
  });
});

describe("pre-dispatch attempt usage coverage", () => {
  const measured = {
    inputTokens: 377466,
    cachedReadTokens: 321355,
    outputTokens: 8569,
    reasoningTokens: 4351,
    cacheWriteTokens: 56081,
    totalTokens: 386035,
    providerCounters: {},
  };
  async function completeMeasuredInvocation(
    app: FastifyInstance,
    claimed: InvestigationClaim,
    onRegistered?: () => void,
  ) {
    const receipt: InvestigationModelInvocationReceipt = {
      invocationId: "measured-resumed-call",
      taskId: claimed.task.id,
      attemptId: claimed.attempt.id,
      purpose: "analysis",
      engine: "codex",
      model: null,
      startedAt: new Date(startedAt + 2_000).toISOString(),
      updatedAt: new Date(startedAt + 2_000).toISOString(),
      revision: 1,
      state: "registered",
      disposition: "pending",
      completeness: "unavailable",
      usage: unavailableInvestigationTokenUsage(),
    };
    const path = `/api/worker/tasks/${claimed.task.id}/model-usage`;
    const registered = await post(app, path, { lease: claimed.lease, receipt }, "worker");
    expect(registered.statusCode, registered.body).toBe(200);
    onRegistered?.();
    const complete = await post(
      app,
      path,
      {
        lease: claimed.lease,
        receipt: {
          ...receipt,
          revision: 2,
          state: "completed",
          disposition: "accepted",
          completeness: "complete",
          usage: measured,
        },
      },
      "worker",
    );
    expect(complete.statusCode, complete.body).toBe(200);
  }

  it.each(["legacy source-tree receipt", "explicit pre-dispatch declaration"])(
    "preserves complete resumed usage after %s without rewriting the old empty baseline",
    async (proof) => {
      const { app, item, store, advance } = await harness();
      const task = await createTask(app, item);
      const first = await claim(app);
      const interrupted = await post(
        app,
        `/api/worker/tasks/${task.id}/checkpoints`,
        {
          kind: "interrupt",
          lease: first.lease,
          reason: "blocked",
          ...(proof === "explicit pre-dispatch declaration"
            ? { modelInvocationState: "not_started" }
            : {}),
          diagnostics: [
            {
              id: "preparation-stopped",
              code:
                proof === "legacy source-tree receipt"
                  ? "SOURCE_TREE_UNSUPPORTED"
                  : "SOURCE_UNAVAILABLE",
              category: "blocker",
              message: "A required source or trusted execution prerequisite was unavailable.",
              retryable: true,
              evidenceRefs: [],
              prerequisiteRefs: [],
            },
          ],
        },
        "worker",
      );
      expect(interrupted.statusCode, interrupted.body).toBe(200);
      const originalReceipt = store.pagePrefix<{
        digest: string;
        checkpoint: InvestigationLoopCheckpointV1;
      }>("idempotency", `checkpoint:${first.attempt.id}:interrupt:`, 10)[0]!;
      advance(2_000);
      await get(app, `/api/tasks/${task.id}`);
      const resumed = await post(app, `/api/tasks/${task.id}/resume`, {
        idempotencyKey: "resume-after-source-preparation",
      });
      expect(resumed.statusCode, resumed.body).toBe(200);
      const second = await claim(app);
      const baselineKey = `model-usage:v1:task:${Buffer.from(task.id).toString("hex")}:baseline`;
      const historicalBaseline = { taskId: task.id, tokens: 0, unknown: true };
      await completeMeasuredInvocation(app, second, () => {
        // Reproduce the old deployment's persisted baseline inside this isolated database.
        store.put("idempotency", baselineKey, historicalBaseline);
      });
      const detail = (await get(app, `/api/tasks/${task.id}`)).json();
      expect(detail.usage).toMatchObject({
        completeness: "complete",
        legacyTokens: 0,
        reportedTokens: measured.totalTokens,
        invocationCount: 1,
        unknownInvocationCount: 0,
        usage: measured,
      });
      expect(detail.invocations).toHaveLength(1);
      expect(detail.invocations[0].attemptId).toBe(second.attempt.id);
      expect((await get(app, "/api/tasks")).json().usageByTaskId[task.id]).toEqual(detail.usage);
      expect(
        (
          await post(
            app,
            `/api/worker/tasks/${task.id}/report-usage`,
            { lease: second.lease },
            "worker",
          )
        ).json().summary,
      ).toEqual(detail.usage);
      expect(store.get("idempotency", baselineKey)).toEqual(historicalBaseline);
      expect(
        store.pagePrefix("idempotency", `checkpoint:${first.attempt.id}:interrupt:`, 10)[0],
      ).toEqual(originalReceipt);
    },
  );

  it.each(["missing receipt after lease expiry", "cancelled model with unavailable usage"])(
    "keeps earlier %s unknown when a later invocation has complete metrics",
    async (failure) => {
      const { app, item, advance } = await harness();
      const task = await createTask(app, item);
      const first = await claim(app);
      if (failure === "cancelled model with unavailable usage") {
        const interrupted = await post(
          app,
          `/api/worker/tasks/${task.id}/checkpoints`,
          {
            kind: "interrupt",
            lease: first.lease,
            reason: "cancelled",
            diagnostics: [],
            modelUsage: { round: 1, tokens: null },
          },
          "worker",
        );
        expect(interrupted.statusCode, interrupted.body).toBe(200);
      }
      advance(2_000);
      await get(app, `/api/tasks/${task.id}`);
      const resumed = await post(app, `/api/tasks/${task.id}/resume`, {
        idempotencyKey: "resume-with-unknown-prior-cost",
      });
      expect(resumed.statusCode, resumed.body).toBe(200);
      const second = await claim(app);
      await completeMeasuredInvocation(app, second);
      expect((await get(app, `/api/tasks/${task.id}/usage`)).json().usage).toMatchObject({
        completeness: "partial",
        reportedTokens: measured.totalTokens,
        usage: { totalTokens: null, inputTokens: null, cachedReadTokens: null },
      });
    },
  );

  it("rejects a pre-dispatch declaration after a model has already registered", async () => {
    const { app, item } = await harness();
    const task = await createTask(app, item);
    const claimed = await claim(app);
    await completeMeasuredInvocation(app, claimed);
    const rejected = await post(
      app,
      `/api/worker/tasks/${task.id}/checkpoints`,
      {
        kind: "interrupt",
        lease: claimed.lease,
        reason: "blocked",
        diagnostics: [],
        modelInvocationState: "not_started",
      },
      "worker",
    );
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().code).toBe("model_dispatch_already_recorded");
    expect((await get(app, `/api/tasks/${task.id}/usage`)).json().usage).toMatchObject({
      completeness: "complete",
      reportedTokens: measured.totalTokens,
      usage: measured,
    });
  });
});

describe("pre-dispatch proof against missing usage", () => {
  it("does not erase an observed model stage just because its invocation receipt is missing", async () => {
    const { app, item } = await harness();
    const task = await createTask(app, item);
    const claimed = await claim(app);
    const activity = await post(
      app,
      `/api/worker/tasks/${task.id}/progress`,
      { lease: claimed.lease, sequence: 1, kind: "stage", stage: "model" },
      "worker",
    );
    expect(activity.statusCode, activity.body).toBe(200);
    const rejected = await post(
      app,
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
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().code).toBe("model_dispatch_already_recorded");
    expect((await get(app, `/api/tasks/${task.id}/usage`)).json().usage).toMatchObject({
      completeness: "unavailable",
      usage: { totalTokens: null },
    });
  });
});
