import {
  createInvestigationPreview,
  type InvestigationCheckpointRequest,
  type InvestigationLoopCheckpointV1,
  type InvestigationModelInvocationReceipt,
  type InvestigationSourceProvenance,
  type InvestigationTaskV1,
  unavailableInvestigationTokenUsage,
} from "@agentic-review/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildInvestigationApp } from "../../dist/investigation/app.js";
import { InvestigationService } from "../../dist/investigation/service.js";
import { InvestigationStore } from "../../dist/investigation/store.js";
import { investigationTaskProgress } from "../../dist/investigation/task-progress.js";
import type {
  InvestigationOperatorPrincipal,
  InvestigationWorkerPrincipal,
} from "../../dist/investigation/types.js";

type ProvenanceRequest = Extract<InvestigationCheckpointRequest, { kind: "source_provenance" }>;
const stores: InvestigationStore[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const store of stores.splice(0)) store.close();
});

/** All source records are synthetic and the service has no external transport. */
function fixture() {
  const store = new InvestigationStore();
  stores.push(store);
  const original = createInvestigationPreview("pr", { findingCount: 0 }).task;
  let now = Date.parse("2026-09-20T12:00:00.000Z");
  let sequence = 0;
  const task: InvestigationTaskV1 = {
    ...original,
    id: "source-provenance-task",
    state: "queued",
    latestReportRef: null,
    scope: {
      ...original.scope,
      includedUnits: original.scope.includedUnits.map((unit) => ({
        ...unit,
        status: "pending",
        evidenceRefs: [],
      })),
      completedUnitRefs: [],
      unresolvedUnitRefs: original.scope.includedUnits.map((unit) => unit.id),
    },
  };
  const worker: InvestigationWorkerPrincipal = {
    id: "synthetic-provenance-worker",
    repositoryIds: [task.repository.id],
  };
  const operator: InvestigationOperatorPrincipal = {
    id: "synthetic-provenance-operator",
    displayName: "Synthetic Operator",
    repositoryIds: worker.repositoryIds,
    isAdmin: true,
    permissions: ["task:cancel"],
    actionCapabilities: [],
    allowRepositoryExecution: false,
  };
  const onTaskProgress = vi.fn();
  const options = {
    store,
    now: () => new Date(now),
    idFactory: () => `synthetic-provenance-${++sequence}`,
    leaseDurationMs: 600_000,
    onTaskProgress,
  };
  const service = new InvestigationService(options);
  store.insert("tasks", task.id, task);
  store.insert("idempotency", `input:${task.id}`, {
    inputSnapshot: {
      schemaVersion: "InvestigationInputSnapshotV1",
      repositoryId: task.repository.id,
      workItemId: task.workItem.id,
      subjectRef: task.subjectRef,
      subjectRevisionKey: task.subjects[0]!.revisionKey,
      title: task.workItem.title,
      body: "Synthetic source-provenance fixture.",
      comments: [],
      source: null,
    },
    plan: null,
    execution: null,
  });
  const claim = service.workerClaim(worker, { supportedKinds: ["pr-review"] }).claim;
  if (claim === null || claim.checkpoint === null)
    throw new Error("The synthetic source task must be claimed with a checkpoint.");
  const primary = task.subjects.find((subject) => subject.id === task.subjectRef);
  if (primary?.kind !== "original_pr") throw new Error("The source fixture must identify a PR.");
  const provenance: InvestigationSourceProvenance = {
    subjectRef: primary.id,
    sourceSha: primary.headSha,
    submodules: [
      {
        path: "vendor/library",
        repository: "Example/Library",
        commitSha: "a".repeat(40),
        parentPath: null,
        parentCommitSha: primary.headSha,
      },
      {
        path: "vendor/library/deps/nested",
        repository: "Example/Nested",
        commitSha: "b".repeat(40),
        parentPath: "vendor/library",
        parentCommitSha: "a".repeat(40),
      },
    ],
  };
  const request = (): ProvenanceRequest => ({
    kind: "source_provenance",
    lease: claim.lease,
    provenance: structuredClone(provenance),
  });
  return {
    store,
    options,
    service,
    task,
    worker,
    operator,
    claim,
    checkpoint: claim.checkpoint,
    provenance,
    request,
    accept: (value = request(), instance = service) =>
      instance.workerCheckpoint(worker, task.id, value).checkpoint,
    advance: (durationMs: number) => {
      now += durationMs;
    },
  };
}

function analysisRequest(
  f: ReturnType<typeof fixture>,
  checkpoint: InvestigationLoopCheckpointV1,
): Extract<InvestigationCheckpointRequest, { kind: "analysis" }> {
  return {
    kind: "analysis",
    lease: f.claim.lease,
    usage: { durationMs: 0, tokens: 0, reportBytes: 0 },
    round: {
      schemaVersion: "InvestigationLoopRoundV1",
      taskId: f.task.id,
      attemptId: f.claim.attempt.id,
      inputCheckpointRef: {
        id: checkpoint.id,
        version: checkpoint.version,
        digest: checkpoint.digest,
      },
      round: checkpoint.round + 1,
      phase: "investigation",
      analysis: structuredClone(checkpoint.analysis),
      continue: true,
      continuationReason: "Continue the synthetic source investigation.",
    },
  };
}

function recordModelInvocation(
  f: ReturnType<typeof fixture>,
  state: "registered" | "running" | "completed",
): void {
  const registered: InvestigationModelInvocationReceipt = {
    invocationId: "synthetic-source-invocation",
    taskId: f.task.id,
    attemptId: f.claim.attempt.id,
    purpose: "analysis",
    engine: "codex",
    model: null,
    startedAt: f.checkpoint.recordedAt,
    updatedAt: f.checkpoint.recordedAt,
    revision: 1,
    state: "registered",
    disposition: "pending",
    completeness: "unavailable",
    usage: unavailableInvestigationTokenUsage(),
  };
  f.service.workerModelUsage(f.worker, f.task.id, { lease: f.claim.lease, receipt: registered });
  if (state !== "registered")
    f.service.workerModelUsage(f.worker, f.task.id, {
      lease: f.claim.lease,
      receipt: {
        ...registered,
        revision: 2,
        state,
        disposition: state === "completed" ? "accepted" : "pending",
        completeness: state === "completed" ? "complete" : "unavailable",
        usage: {
          ...unavailableInvestigationTokenUsage(),
          totalTokens: state === "completed" ? 0 : null,
        },
      },
    });
}

describe("trusted source provenance checkpoints", () => {
  it("persists immutable source metadata without advancing the analysis round", () => {
    const f = fixture();
    f.advance(125);
    const request = f.request();
    const next = f.accept(request);
    expect(next).toMatchObject({
      version: f.checkpoint.version + 1,
      round: 0,
      consumed: { rounds: 0, tokens: 0, durationMs: 125 },
      runtime: { sourceProvenance: f.provenance },
    });
    expect(next.analysis).toEqual(f.checkpoint.analysis);
    expect(next.lastPhase).toBe(f.checkpoint.lastPhase);
    expect(next.stopReason).toBe(f.checkpoint.stopReason);
    expect(next.digest).not.toBe(f.checkpoint.digest);
    request.provenance.submodules[0]!.repository = "Example/Mutated";
    expect(f.store.get("checkpoints", f.task.id)).toEqual(next);
    const progress = investigationTaskProgress(f.store, f.task.id);
    const restarted = new InvestigationService(f.options);
    f.advance(250);
    expect(f.accept(f.request(), restarted)).toEqual(next);
    expect(investigationTaskProgress(f.store, f.task.id)).toEqual(progress);
    expect(f.options.onTaskProgress).toHaveBeenCalledTimes(1);
  });

  it("returns the current checkpoint when an acknowledgement arrives after later analysis", () => {
    const f = fixture();
    const registered = f.accept();
    const next = f.service.workerCheckpoint(
      f.worker,
      f.task.id,
      analysisRequest(f, registered),
    ).checkpoint;
    expect(next.round).toBe(1);
    f.options.onTaskProgress.mockClear();
    const progress = investigationTaskProgress(f.store, f.task.id);
    const restarted = new InvestigationService(f.options);
    f.advance(250);
    expect(f.accept(f.request(), restarted)).toEqual(next);
    expect(f.store.get("checkpoints", f.task.id)).toEqual(next);
    expect(investigationTaskProgress(f.store, f.task.id)).toEqual(progress);
    expect(f.options.onTaskProgress).not.toHaveBeenCalled();
  });

  it.each(["registered", "running", "completed"] as const)(
    "rejects first registration after a %s model invocation but permits an immutable retry",
    (state) => {
      const late = fixture();
      recordModelInvocation(late, state);
      expect(() => late.accept()).toThrow(/before any model invocation begins/);
      expect(late.store.get("checkpoints", late.task.id)).toEqual(late.checkpoint);

      const retry = fixture();
      const registered = retry.accept();
      recordModelInvocation(retry, state);
      expect(retry.accept()).toEqual(registered);
      expect(retry.options.onTaskProgress).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["repository", "commitSha", "path", "drop"] as const)(
    "rejects replacement of accepted provenance: %s",
    (field) => {
      const f = fixture();
      const next = f.accept();
      const request = f.request();
      if (field === "repository") request.provenance.submodules[1]!.repository = "Example/Other";
      if (field === "commitSha") request.provenance.submodules[1]!.commitSha = "c".repeat(40);
      if (field === "path") request.provenance.submodules[1]!.path += "-other";
      if (field === "drop") request.provenance.submodules.pop();
      expect(() => f.accept(request)).toThrow(/cannot be replaced/);
      expect(f.store.get("checkpoints", f.task.id)).toEqual(next);
    },
  );

  it.each(["subjectRef", "sourceSha", "parentCommitSha", "parentPath"] as const)(
    "rejects provenance outside the frozen source pins: %s",
    (field) => {
      const f = fixture();
      const request = f.request();
      if (field === "subjectRef") request.provenance.subjectRef = "foreign-primary";
      if (field === "sourceSha") request.provenance.sourceSha = "c".repeat(40);
      if (field === "parentCommitSha")
        request.provenance.submodules[1]!.parentCommitSha = "c".repeat(40);
      if (field === "parentPath") request.provenance.submodules[1]!.parentPath = null;
      expect(() => f.accept(request)).toThrow(/frozen source and dependency pins/);
      expect(f.store.get("checkpoints", f.task.id)).toEqual(f.checkpoint);
    },
  );

  it.each([
    "snapshot",
    "unauthorized_execution",
    "not_allowed",
    "foreign_repository",
    "foreign_work_item",
  ] as const)("requires source access to the permitted primary subject: %s", (scope) => {
    const f = fixture();
    const task = structuredClone(f.claim.task);
    if (scope === "snapshot") task.executionPolicy.mode = "snapshot_only";
    if (scope === "unauthorized_execution") task.executionPolicy.mode = "execute";
    if (scope === "not_allowed") task.executionPolicy.allowedSubjectRefs = [];
    if (scope === "foreign_repository") task.subjects[0]!.repositoryId = "foreign-repository";
    if (scope === "foreign_work_item") task.subjects[0]!.workItemId = "foreign-work-item";
    f.store.put("tasks", task.id, task);
    expect(() => f.accept()).toThrow(/source access to the frozen primary subject/);
    expect(f.store.get("checkpoints", f.task.id)).toEqual(f.checkpoint);
  });

  it("rejects cancellation, expired or forged leases, foreign workers, and task mismatch", () => {
    const cancelled = fixture();
    cancelled.service.cancelTask(cancelled.operator, cancelled.task.id);
    expect(() => cancelled.accept()).toThrow(/Cancellation was accepted/);

    const expired = fixture();
    expired.advance(600_000);
    expect(() => expired.accept()).toThrow(/lease expired/);

    const f = fixture();
    for (const lease of [
      { ...f.claim.lease, leaseToken: "forged-token" },
      { ...f.claim.lease, fence: f.claim.lease.fence + 1 },
    ])
      expect(() => f.accept({ ...f.request(), lease })).toThrow(/lease expired/);
    expect(() =>
      f.service.workerCheckpoint({ ...f.worker, id: "other-worker" }, f.task.id, f.request()),
    ).toThrow(/lease expired/);
    f.store.insert("tasks", "other-task", { ...f.claim.task, id: "other-task" });
    expect(() => f.service.workerCheckpoint(f.worker, "other-task", f.request())).toThrow(
      /lease expired/,
    );
    expect(f.store.get("checkpoints", f.task.id)).toEqual(f.checkpoint);
  });

  it("accepts only the dedicated worker protocol, with no model metadata promotion", async () => {
    const f = fixture();
    const app = buildInvestigationApp({
      ...f.options,
      authenticateWorker: () => f.worker,
      authenticateOperator: () => null,
    });
    apps.push(app);
    const analysis = analysisRequest(f, f.checkpoint);
    for (const payload of [
      { ...f.request(), durationMs: 0 },
      { ...analysis, provenance: f.provenance },
      {
        ...analysis,
        round: {
          ...analysis.round,
          analysis: { ...analysis.round.analysis, sourceProvenance: f.provenance },
        },
      },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/worker/tasks/${f.task.id}/checkpoints`,
        payload,
      });
      expect(response.statusCode, response.body).toBe(400);
    }
    expect(f.store.get("checkpoints", f.task.id)).toEqual(f.checkpoint);
    const accepted = await app.inject({
      method: "POST",
      url: `/api/worker/tasks/${f.task.id}/checkpoints`,
      payload: f.request(),
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().checkpoint.runtime.sourceProvenance).toEqual(f.provenance);
  });
});
