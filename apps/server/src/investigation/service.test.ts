import { createHash } from "node:crypto";
import {
  type ActionContextV1,
  createInvestigationPreview as createInvestigationFixture,
  type InvestigationArtifactV1,
  type InvestigationClaim,
  type InvestigationClaimResponse,
  type InvestigationCreateTaskRequestV1,
  type InvestigationFindingsPageV1,
  type InvestigationHeartbeatResponse,
  type InvestigationPlanExecutionBinding,
  type InvestigationResultV1,
  type InvestigationTaskV1,
} from "@agentic-review/contracts";
import { investigationContentDigest } from "@agentic-review/domain";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildInvestigationApp } from "../../dist/investigation/app.js";
import {
  type InvestigationEvidencePolicy,
  InvestigationEvidenceStore,
} from "../../dist/investigation/evidence-store.js";
import type { InvestigationPreparedTaskInput } from "../../dist/investigation/service.js";
import { InvestigationStore } from "../../dist/investigation/store.js";
import type {
  InvestigationActionTransport,
  InvestigationOperatorPrincipal,
  InvestigationRepositoryRecord,
  InvestigationWorkerPrincipal,
  InvestigationWorkItemRecord,
} from "../../dist/investigation/types.js";

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
    evidencePolicy?: Partial<InvestigationEvidencePolicy>;
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
  const app = buildInvestigationApp({
    store,
    now: () => new Date(time),
    idFactory: () => `synthetic-generated-${++sequence}`,
    leaseDurationMs: 1_000,
    ...(options.evidencePolicy === undefined ? {} : { evidencePolicy: options.evidencePolicy }),
    ...(options.actionTransport === undefined ? {} : { actionTransport: options.actionTransport }),
    authenticateOperator: (request) =>
      request.headers.authorization === "operator"
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

describe("investigation service API", () => {
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
    const { app, item, repository } = await harness();
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
    const { app, store, item, operator } = await harness({ allowRepositoryExecution: true });
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
    const { app, item, store } = await harness();
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
