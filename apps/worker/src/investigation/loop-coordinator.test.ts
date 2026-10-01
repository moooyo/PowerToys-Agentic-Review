import {
  createInvestigationPreview as createInvestigationFixture,
  type InvestigationAnalysisV1,
  type InvestigationCheckpointRequest,
  type InvestigationClaim,
  type InvestigationFinalizeRequest,
  type InvestigationLoopCheckpointV1,
  type InvestigationLoopRoundV1,
  type InvestigationReportPartV1,
  type InvestigationResultV1,
} from "@agentic-review/contracts";
import {
  applyInvestigationLoopRound,
  applyInvestigationRuntimeCheckpoint,
  applyInvestigationSourceCheckpoint,
  applyInvestigationSourceProvenanceCheckpoint,
  createInvestigationCheckpoint,
  interruptInvestigationLoop,
  investigationContentDigest,
  rejectInvestigationModelOutput,
  restoreInvestigationCheckpoint,
} from "@agentic-review/domain";
import { describe, expect, it, vi } from "vitest";
import type { ProcessHostClient } from "../execution/process-host-protocol.js";
import { InvestigationAttemptHeartbeat, InvestigationLeaseLost } from "./attempt-heartbeat.js";
import { type InvestigationWorkerClient, InvestigationWorkerClientError } from "./http-client.js";
import {
  InvestigationLoopCoordinator,
  type InvestigationLoopCoordinatorOptions,
} from "./loop-coordinator.js";
import { ModelBudgetExceededError } from "./model-budget.js";
import { ModelOutputValidationError } from "./model-output-diagnostics.js";
import type {
  ModelTurnExecutionInput,
  ModelTurnExecutionResult,
  ModelTurnRunner,
} from "./model-turn-runner.js";
import type { InvestigationPlanExecutor } from "./plan-executor.js";
import * as progressReporter from "./progress-reporter.js";
import * as reportBuilder from "./report-builder.js";
import { IsolatedInvestigationReportDeliveryError } from "./report-delivery-error.js";
import { InvestigationTaskService, InvestigationWorkerShutdown } from "./task-service.js";
import type { PreparedInvestigationWorkspace } from "./workspace.js";

const recordedAt = "2026-09-15T04:00:00.000Z";

function proposedAnalysis(result: InvestigationResultV1): InvestigationAnalysisV1 {
  return {
    schemaVersion: "InvestigationAnalysisV1",
    summary: result.report.summary,
    coverage: structuredClone(result.report.coverage),
    findings: structuredClone(result.findings),
    assessment: structuredClone(result.assessment),
    candidates: structuredClone(result.report.loop.candidates),
    rechecks: [],
    evidence: result.verificationEvidence.map((entry) => ({
      id: entry.id,
      subjectRef: entry.subjectRef,
      source: entry.source === "reporter_statement" ? "reporter_statement" : "static_analysis",
      summary: entry.summary,
      evidenceRefs: entry.evidenceRefs,
    })),
    plans: result.plans.map(
      ({ digest: _digest, state: _state, sourceReportRef: _source, ...plan }) =>
        structuredClone(plan),
    ),
    nextActions: result.nextActions.map(({ state: _state, sourceReportRef: _source, ...action }) =>
      structuredClone(action),
    ),
    feedbackDrafts: structuredClone(result.feedbackDrafts),
    diagnostics: [],
    limitations: structuredClone(result.report.limitations),
  };
}

function modelRound(
  input: ModelTurnExecutionInput,
  analysis: InvestigationAnalysisV1,
  phase: InvestigationLoopRoundV1["phase"],
): ModelTurnExecutionResult {
  if (input.checkpoint === null) throw new Error("A persisted checkpoint is required.");
  return {
    round: {
      schemaVersion: "InvestigationLoopRoundV1",
      taskId: input.task.id,
      attemptId: input.attempt.id,
      inputCheckpointRef: {
        id: input.checkpoint.id,
        version: input.checkpoint.version,
        digest: input.checkpoint.digest,
      },
      round: input.checkpoint.round + 1,
      phase,
      analysis,
      continue: false,
      continuationReason:
        "Request completion only after the server verifies every required unit and finding version.",
    },
    usage: { tokens: 100, source: "cli" },
  };
}

function fixture(
  count = 2,
  maxRounds = 8,
  kind: "pr" | "bug" = "bug",
  options: Partial<InvestigationLoopCoordinatorOptions> = {},
) {
  const initial = createInvestigationFixture(kind, { findingCount: count });
  const task = structuredClone(initial.task);
  task.state = "running";
  task.budget.maxRounds = maxRounds;
  if (kind === "pr") {
    task.scope.includedUnits = [
      {
        id: "full-diff",
        kind: "full_diff",
        subjectRef: task.subjectRef,
        paths: [],
        requiredWork: "Inspect the entire immutable PR diff and every affected behavior.",
        status: "pending",
        evidenceRefs: [],
      },
    ];
    task.scope.completedUnitRefs = [];
    task.scope.unresolvedUnitRefs = ["full-diff"];
  }
  const attempt = { ...initial.attempt, state: "running" as const, finishedAt: null };
  const checkpoint = createInvestigationCheckpoint({
    task,
    attemptId: attempt.id,
    checkpointId: "checkpoint-1",
    leaseVersion: attempt.leaseVersion,
    recordedAt,
  });
  const claim: InvestigationClaim = {
    task,
    attempt,
    checkpoint,
    reportId: initial.result.id,
    lease: { attemptId: attempt.id, fence: attempt.leaseVersion, leaseToken: "synthetic-lease" },
    inputSnapshot: {
      schemaVersion: "InvestigationInputSnapshotV1",
      repositoryId: task.repository.id,
      workItemId: task.workItem.id,
      subjectRef: task.subjectRef,
      subjectRevisionKey: task.subjects[0]!.revisionKey,
      title: task.workItem.title,
      body: "Synthetic frozen source investigation.",
      comments: [],
      source: null,
    },
    plan: null,
    execution: null,
  };
  let current = checkpoint;
  const order: string[] = [];
  const parts: InvestigationReportPartV1[] = [];
  const submissions: InvestigationFinalizeRequest[] = [];
  const invocationTokens = new Map<string, number | null>();
  const client: InvestigationWorkerClient = {
    claim: vi.fn(async () => claim),
    heartbeat: vi.fn(async () => ({
      cancelRequested: false,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      serverTime: new Date(Date.now()).toISOString(),
    })),
    checkpoint: vi.fn(async (_taskId, request: InvestigationCheckpointRequest) => {
      order.push(`checkpoint:${request.kind}`);
      if (request.kind === "analysis")
        current = applyInvestigationLoopRound(current, request.round, {
          recordedAt,
          usage: request.usage,
          sourceUnitIds: request.sourceUnitIds ?? [],
          ...(request.modelIdentity === undefined ? {} : { modelIdentity: request.modelIdentity }),
        });
      else if (request.kind === "execution")
        current = applyInvestigationRuntimeCheckpoint(current, request.execution, { recordedAt });
      else if (request.kind === "source")
        current = applyInvestigationSourceCheckpoint(current, request.manifest, {
          task,
          recordedAt,
        });
      else if (request.kind === "source_provenance")
        current = applyInvestigationSourceProvenanceCheckpoint(current, request.provenance, {
          task,
          recordedAt,
        });
      else if (request.kind === "rejected_analysis") {
        const tokens = invocationTokens.get(request.invocationId);
        if (tokens === undefined)
          throw new Error("The rejected invocation has no fixture receipt.");
        current = rejectInvestigationModelOutput(
          current,
          { ...request, attemptId: attempt.id },
          { recordedAt, durationMs: 0, accountedTokens: current.consumed.tokens + (tokens ?? 0) },
        );
      } else {
        current = interruptInvestigationLoop(
          current,
          request.reason === "error" ? "failed" : request.reason,
          recordedAt,
          request.diagnostics,
          0,
          request.modelUsage === undefined
            ? undefined
            : { round: request.modelUsage.round, tokens: request.modelUsage.tokens },
        );
      }
      return { checkpoint: structuredClone(current) };
    }),
    uploadArtifact: vi.fn(async () => {
      order.push("artifact");
      return { accepted: true as const };
    }),
    readArtifact: vi.fn(async () => {
      throw new Error("No remote artifact is needed by this fixture.");
    }),
    uploadReportPart: vi.fn(async (_taskId, request) => {
      order.push("part");
      parts.push(request.part);
      return { accepted: true as const };
    }),
    finalize: vi.fn(async (_taskId, request) => {
      order.push("finalize");
      submissions.push(request);
      return {
        reportRef: {
          id: request.header.id,
          version: request.header.version,
          digest: request.manifest.logicalContentDigest,
        },
      };
    }),
  };
  const workspace: PreparedInvestigationWorkspace = {
    attemptDirectory: "C:\\fixture\\attempt",
    modelInputDirectory: "C:\\fixture\\attempt\\input",
    modelInputPath: "C:\\fixture\\attempt\\input\\snapshot.json",
    modelInputDigest: "1".repeat(64),
    controlDirectory: "C:\\fixture\\attempt\\control",
    tempDirectory: "C:\\fixture\\attempt\\temp",
    sourceDirectory: null,
    sourceBinding: null,
    assertIntegrity: vi.fn(async () => undefined),
    assertSourceBinding: vi.fn(async () => undefined),
    resolveSourcePath: vi.fn(async () => {
      throw new Error("No actual source file is used by the fixture.");
    }),
    readSourceFile: vi.fn(async () => {
      throw new Error("No actual source file is used by the fixture.");
    }),
    applyEdits: vi.fn(async () => {
      throw new Error("No actual source edits are applied by the fixture.");
    }),
    readPrDiffManifest: vi.fn(async () => {
      throw new Error("Issue fixtures must not request a PR diff.");
    }),
    readPrDiffChunk: vi.fn(async () => {
      throw new Error("Issue fixtures must not request a PR diff chunk.");
    }),
    capturePatch: vi.fn(async () => {
      throw new Error("No actual source patch is used by the fixture.");
    }),
    writeArtifact: vi.fn(async () => {
      throw new Error("No actual artifact file is used by the fixture.");
    }),
    writePatchArtifact: vi.fn(async () => {
      throw new Error("No actual patch file is used by the fixture.");
    }),
    readArtifact: vi.fn(async () => {
      throw new Error("No actual artifact file is read by the fixture.");
    }),
    cleanup: vi.fn(async () => {
      order.push("cleanup");
    }),
  };
  const model: ModelTurnRunner = {
    execute: vi.fn(async (input) => {
      order.push("model");
      if (input.checkpoint?.round === 0)
        return modelRound(input, proposedAnalysis(initial.result), "discovery");
      const analysis = structuredClone(input.checkpoint!.analysis);
      analysis.rechecks = initial.result.report.recheck.records.map((record) => ({
        ...record,
        round: input.checkpoint!.round + 1,
      }));
      return modelRound(input, analysis, "finalize");
    }),
  };
  const processHost: ProcessHostClient = {
    start: vi.fn(async () => {
      throw new Error("Fixtures must not launch processes.");
    }),
    terminateAll: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const plan: InvestigationPlanExecutor = {
    execute: vi.fn(async () => {
      throw new Error("Review fixtures must not execute a plan.");
    }),
  };
  const shutdown = new AbortController();
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const prepare = vi.fn(async () => workspace);
  const coordinator = new InvestigationLoopCoordinator({
    client,
    processHost,
    modelTurnRunner: model,
    workspaceProvider: { prepare },
    planExecutor: plan,
    logger,
    requestRetryMs: 1,
    maximumPartBytes: 16 * 1024,
    ...options,
  });
  return {
    claim,
    initial,
    current: () => current,
    replaceCurrent(value: InvestigationLoopCheckpointV1) {
      current = value;
    },
    client,
    model,
    plan,
    workspace,
    prepare,
    coordinator,
    shutdown,
    order,
    parts,
    submissions,
    invocationTokens,
  };
}

function attachPinnedDependency(f: ReturnType<typeof fixture>) {
  const sourceSha = "b".repeat(40);
  const previous = f.claim.task.subjects.find((entry) => entry.id === f.claim.task.subjectRef)!;
  const source = {
    id: previous.id,
    kind: "source_commit" as const,
    repositoryId: previous.repositoryId,
    workItemId: previous.workItemId,
    revisionKey: investigationContentDigest({ kind: "source_commit", commitSha: sourceSha }),
    commitSha: sourceSha,
  };
  f.claim.task.subjects = f.claim.task.subjects.map((entry) =>
    entry.id === source.id ? source : entry,
  );
  f.claim.task.executionPolicy.mode = "source_read";
  f.claim.inputSnapshot.subjectRevisionKey = source.revisionKey;
  const checkpoint = createInvestigationCheckpoint({
    task: f.claim.task,
    attemptId: f.claim.attempt.id,
    checkpointId: f.claim.checkpoint!.id,
    leaseVersion: f.claim.attempt.leaseVersion,
    recordedAt,
  });
  f.claim.checkpoint = checkpoint;
  f.replaceCurrent(checkpoint);
  const provenance = {
    subjectRef: source.id,
    sourceSha,
    submodules: [
      {
        path: "deps/library",
        repository: "vendor/library",
        commitSha: "a".repeat(40),
        parentPath: null,
        parentCommitSha: sourceSha,
      },
    ],
  };
  const workspace = {
    ...f.workspace,
    sourceDirectory: "C:\\fixture\\attempt\\source",
    sourceBinding: {
      subjectRef: source.id,
      revisionKey: source.revisionKey,
      sourceSha,
      patchDigest: null,
      artifactRef: null,
      submodules: structuredClone(provenance.submodules),
    },
  };
  f.prepare.mockResolvedValue(workspace);
  return { provenance, workspace };
}

function reportDeliveryFixture(options: Partial<InvestigationLoopCoordinatorOptions> = {}) {
  const f = fixture(0, 8, "bug", options);
  const failure = new InvestigationWorkerClientError("E2E_PLAN_REQUIRED", false, 422);
  const finalize = vi.mocked(f.client.finalize).getMockImplementation()!;
  vi.mocked(f.client.finalize).mockRejectedValue(failure);
  const cleanup = vi.fn<NonNullable<InvestigationWorkerClient["cleanup"]>>(
    async (_taskId, request) => ({ released: true, attemptId: request.lease.attemptId }),
  );
  f.client.cleanup = cleanup;
  return { ...f, failure, finalize, cleanup };
}

describe("InvestigationLoopCoordinator", () => {
  it("registers trusted source provenance before model dispatch without consuming an analysis round", async () => {
    const f = fixture(0);
    const { provenance, workspace } = attachPinnedDependency(f);
    const execute = f.model.execute;
    vi.mocked(f.model.execute).mockImplementation(async (input) => {
      expect(input.checkpoint?.round).toBe(0);
      expect(input.checkpoint?.runtime.sourceProvenance).toEqual(provenance);
      expect(f.order[0]).toBe("checkpoint:source_provenance");
      workspace.sourceBinding.submodules[0]!.repository = "changed/original-input";
      return modelRound(input, proposedAnalysis(f.initial.result), "discovery");
    });
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(execute).toHaveBeenCalledOnce();
    expect(f.current().runtime.sourceProvenance).toEqual(provenance);
    expect(f.submissions[0]?.header.context.sourceProvenance).toEqual(provenance);
    expect(f.current().consumed.rounds).toBe(1);
  });

  it.each(["changed", "missing"])(
    "blocks a %s prepared dependency graph before model dispatch and preserves registered provenance",
    async (mutation) => {
      const f = fixture(0);
      const { provenance, workspace } = attachPinnedDependency(f);
      const checkpoint = applyInvestigationSourceProvenanceCheckpoint(
        f.claim.checkpoint!,
        provenance,
        { task: f.claim.task, recordedAt },
      );
      f.claim.checkpoint = checkpoint;
      f.replaceCurrent(checkpoint);
      if (mutation === "changed") workspace.sourceBinding.submodules[0]!.commitSha = "f".repeat(40);
      else workspace.sourceBinding.submodules.length = 0;
      await f.coordinator.execute(f.claim, f.shutdown.signal);
      expect(f.model.execute).not.toHaveBeenCalled();
      expect(f.current().runtime.sourceProvenance).toEqual(provenance);
      expect(f.submissions[0]?.header).toMatchObject({
        outcome: "blocked",
        context: { sourceProvenance: provenance },
      });
      expect(f.order).not.toContain("checkpoint:source_provenance");
    },
  );

  it("reuses registered provenance when source preparation confirms the same graph", async () => {
    const f = fixture(0);
    const { provenance } = attachPinnedDependency(f);
    const checkpoint = applyInvestigationSourceProvenanceCheckpoint(
      f.claim.checkpoint!,
      provenance,
      { task: f.claim.task, recordedAt },
    );
    f.claim.checkpoint = checkpoint;
    f.replaceCurrent(checkpoint);
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(f.order).not.toContain("checkpoint:source_provenance");
    expect(f.model.execute).toHaveBeenCalledOnce();
    expect(f.submissions[0]?.header.context.sourceProvenance).toEqual(provenance);
  });

  it("does not dispatch a model if the provenance acknowledgement omits the registered graph", async () => {
    const f = fixture(0);
    attachPinnedDependency(f);
    const original = vi.mocked(f.client.checkpoint).getMockImplementation()!;
    vi.mocked(f.client.checkpoint).mockImplementation(async (taskId, request, signal) => {
      if (request.kind === "source_provenance") return { checkpoint: structuredClone(f.current()) };
      return original(taskId, request, signal);
    });
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(f.model.execute).not.toHaveBeenCalled();
    expect(f.current().runtime.sourceProvenance).toBeUndefined();
    expect(f.submissions[0]?.header.outcome).toBe("failed");
  });

  it("seals a complete fresh snapshot investigation after one model invocation", async () => {
    const f = fixture(0);
    expect(f.current().runtime.reviewMode).toBe("local_snapshot");
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(f.model.execute).toHaveBeenCalledOnce();
    expect(f.current().consumed).toMatchObject({ rounds: 1, tokens: 100 });
    expect(f.submissions[0]?.header.outcome).toBe("completed");
    expect(f.plan.execute).not.toHaveBeenCalled();
    expect(f.workspace.readPrDiffManifest).not.toHaveBeenCalled();
  });

  it("confirms owned cleanup before releasing the desktop and acknowledging the Server slot", async () => {
    const events: string[] = [];
    const f = fixture(0, 8, "bug", {
      onAttemptCleanupConfirmed: async () => {
        events.push("desktop_released");
      },
      onAttemptCleanupUnconfirmed: async () => {
        events.push("quarantined");
      },
    });
    vi.mocked(f.workspace.cleanup).mockImplementation(async () => {
      events.push("workspace_cleaned");
    });
    f.client.cleanup = vi.fn(async (_taskId, request) => {
      events.push("server_acknowledged");
      expect(request).toEqual({
        lease: f.claim.lease,
        ownedProcessesStopped: true,
        desktopRestored: true,
      });
      return { released: true as const, attemptId: f.claim.attempt.id };
    });
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(events).toEqual(["workspace_cleaned", "desktop_released", "server_acknowledged"]);
  });

  it("keeps execution resources quarantined when workspace cleanup cannot be confirmed", async () => {
    const confirmed = vi.fn(async () => undefined);
    const unconfirmed = vi.fn(async () => undefined);
    const f = fixture(0, 8, "bug", {
      onAttemptCleanupConfirmed: confirmed,
      onAttemptCleanupUnconfirmed: unconfirmed,
    });
    vi.mocked(f.workspace.cleanup).mockRejectedValue(new Error("Synthetic owned cleanup failure."));
    f.client.cleanup = vi.fn(async () => ({
      released: true as const,
      attemptId: f.claim.attempt.id,
    }));
    await expect(f.coordinator.execute(f.claim, f.shutdown.signal)).rejects.toThrow(
      "Synthetic owned cleanup failure.",
    );
    expect(confirmed).not.toHaveBeenCalled();
    expect(unconfirmed).toHaveBeenCalledWith("ATTEMPT_CLEANUP_UNCONFIRMED");
    expect(f.client.cleanup).not.toHaveBeenCalled();
  });

  describe("report delivery failure isolation", () => {
    it("isolates a rejected final report only after ordered cleanup, acknowledgement, and progress flush", async () => {
      const events: string[] = [];
      const confirmed = vi.fn(async () => {
        events.push("desktop_released");
      });
      const unconfirmed = vi.fn(async () => undefined);
      const f = reportDeliveryFixture({
        onAttemptCleanupConfirmed: confirmed,
        onAttemptCleanupUnconfirmed: unconfirmed,
      });
      vi.mocked(f.client.finalize).mockImplementation(async () => {
        events.push("finalize_rejected");
        throw f.failure;
      });
      vi.mocked(f.workspace.cleanup).mockImplementation(async () => {
        events.push("workspace_cleaned");
      });
      f.cleanup.mockImplementation(async (_taskId, request) => {
        events.push("server_acknowledged");
        expect(request).toEqual({
          lease: f.claim.lease,
          ownedProcessesStopped: true,
          desktopRestored: true,
          reportDeliveryFailure: { code: "E2E_PLAN_REQUIRED", retryable: false },
        });
        return { released: true, attemptId: f.claim.attempt.id };
      });
      const createProgress = progressReporter.createInvestigationProgressReporter;
      const progressHook = vi
        .spyOn(progressReporter, "createInvestigationProgressReporter")
        .mockImplementation((options) => {
          const reporter = createProgress(options);
          return {
            ...reporter,
            flush: async () => {
              await reporter.flush();
              events.push("progress_flushed");
            },
          };
        });
      try {
        const execution = f.coordinator.execute(f.claim, f.shutdown.signal);
        await expect(execution).rejects.toBeInstanceOf(IsolatedInvestigationReportDeliveryError);
        await expect(execution).rejects.toMatchObject({
          code: "E2E_PLAN_REQUIRED",
          retryable: false,
        });
        expect(events).toEqual([
          "finalize_rejected",
          "workspace_cleaned",
          "desktop_released",
          "server_acknowledged",
          "progress_flushed",
        ]);
        expect(f.current().stopReason).toBe("complete");
        expect(f.model.execute).toHaveBeenCalledOnce();
        expect(unconfirmed).not.toHaveBeenCalled();
      } finally {
        progressHook.mockRestore();
      }
    });

    it("redelivers the stopped checkpoint after an isolated failure without repeating model or workspace work", async () => {
      const f = reportDeliveryFixture();
      await expect(f.coordinator.execute(f.claim, f.shutdown.signal)).rejects.toBeInstanceOf(
        IsolatedInvestigationReportDeliveryError,
      );
      const stopped = structuredClone(f.current());
      f.claim.checkpoint = stopped;
      vi.mocked(f.client.finalize).mockImplementation(f.finalize);
      vi.mocked(f.model.execute).mockClear();
      vi.mocked(f.plan.execute).mockClear();
      f.prepare.mockClear();
      vi.mocked(f.workspace.cleanup).mockClear();
      await f.coordinator.execute(f.claim, f.shutdown.signal);
      expect(f.current()).toEqual(stopped);
      expect(f.model.execute).not.toHaveBeenCalled();
      expect(f.plan.execute).not.toHaveBeenCalled();
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.workspace.cleanup).not.toHaveBeenCalled();
      expect(f.submissions[0]?.header.outcome).toBe("completed");
      expect(f.cleanup).toHaveBeenLastCalledWith(
        f.claim.task.id,
        { lease: f.claim.lease, ownedProcessesStopped: true, desktopRestored: true },
        expect.any(AbortSignal),
      );
    });

    it("continues another task after the coordinator isolates a final report rejection", async () => {
      const f = reportDeliveryFixture();
      const next = structuredClone(f.claim);
      next.task.id = "task-after-report-rejection";
      next.attempt.id = "attempt-after-report-rejection";
      next.attempt.taskId = next.task.id;
      next.lease.attemptId = next.attempt.id;
      next.checkpoint = null;
      vi.mocked(f.client.claim)
        .mockResolvedValueOnce(f.claim)
        .mockResolvedValueOnce(next)
        .mockRejectedValue(new Error("No further task should be claimed after draining."));
      const executed: string[] = [];
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const service = new InvestigationTaskService({
        client: f.client,
        supportedKinds: [f.claim.task.kind],
        role: "static",
        maximumConcurrentStaticTasks: 1,
        logger,
        executor: {
          execute: async (claim, signal) => {
            executed.push(claim.task.id);
            if (claim.task.id === f.claim.task.id) await f.coordinator.execute(claim, signal);
            else service.requestDrain();
          },
        },
      });
      await service.run();
      expect(executed).toEqual([f.claim.task.id, next.task.id]);
      expect(f.client.claim).toHaveBeenCalledTimes(2);
      expect(f.client.finalize).toHaveBeenCalledOnce();
      expect(f.cleanup).toHaveBeenCalledOnce();
      expect(f.model.execute).toHaveBeenCalledOnce();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it.each([
      {
        label: "retryable usage request",
        failure: new InvestigationWorkerClientError("usage_unavailable", true, 503),
        expected: { code: "usage_unavailable", retryable: true },
      },
      {
        label: "unsafe remote error code",
        failure: new InvestigationWorkerClientError("unsafe\nresponse", true, 503),
        expected: { code: "REPORT_DELIVERY_FAILED", retryable: false },
      },
      {
        label: "untyped exception with claimed metadata",
        failure: Object.assign(new Error("Synthetic private response body."), {
          code: "untrusted_code",
          retryable: true,
        }),
        expected: { code: "REPORT_DELIVERY_FAILED", retryable: false },
      },
      {
        label: "plain object with claimed metadata",
        failure: { code: "forged_code", retryable: true, message: "Synthetic private detail." },
        expected: { code: "REPORT_DELIVERY_FAILED", retryable: false },
      },
    ])("retains only bounded typed failure metadata for $label", async ({ failure, expected }) => {
      const f = reportDeliveryFixture();
      f.client.reportUsage = vi.fn(async () => {
        throw failure;
      });
      const execution = f.coordinator.execute(f.claim, f.shutdown.signal);
      await expect(execution).rejects.toBeInstanceOf(IsolatedInvestigationReportDeliveryError);
      await expect(execution).rejects.toMatchObject(expected);
      expect(f.cleanup.mock.calls[0]?.[1]).toEqual({
        lease: f.claim.lease,
        ownedProcessesStopped: true,
        desktopRestored: true,
        reportDeliveryFailure: expected,
      });
      expect(f.client.uploadReportPart).not.toHaveBeenCalled();
      expect(f.client.finalize).not.toHaveBeenCalled();
    });

    it("retains a typed report build failure after cleanup without leaking its details", async () => {
      const f = reportDeliveryFixture();
      const failure = new reportBuilder.InvestigationReportBuildError(
        "INVALID_INPUT",
        "Synthetic private build details.",
      );
      const buildHook = vi
        .spyOn(reportBuilder, "buildInvestigationReportSubmission")
        .mockImplementation(() => {
          throw failure;
        });
      try {
        const execution = f.coordinator.execute(f.claim, f.shutdown.signal);
        await expect(execution).rejects.toBeInstanceOf(IsolatedInvestigationReportDeliveryError);
        await expect(execution).rejects.toMatchObject({ code: "INVALID_INPUT", retryable: false });
        expect(f.cleanup.mock.calls[0]?.[1]).toEqual({
          lease: f.claim.lease,
          ownedProcessesStopped: true,
          desktopRestored: true,
          reportDeliveryFailure: { code: "INVALID_INPUT", retryable: false },
        });
        expect(f.client.uploadReportPart).not.toHaveBeenCalled();
        expect(f.client.finalize).not.toHaveBeenCalled();
      } finally {
        buildHook.mockRestore();
      }
    });

    it("isolates a report part rejection before finalization after cleanup acknowledgement", async () => {
      const f = reportDeliveryFixture();
      vi.mocked(f.client.uploadReportPart).mockRejectedValue(f.failure);
      await expect(f.coordinator.execute(f.claim, f.shutdown.signal)).rejects.toBeInstanceOf(
        IsolatedInvestigationReportDeliveryError,
      );
      expect(f.client.finalize).not.toHaveBeenCalled();
      expect(f.workspace.cleanup).toHaveBeenCalledOnce();
      expect(f.cleanup).toHaveBeenCalledOnce();
    });

    it("keeps the original report failure fatal when no cleanup API can acknowledge release", async () => {
      const confirmed = vi.fn(async () => undefined);
      const f = reportDeliveryFixture({ onAttemptCleanupConfirmed: confirmed });
      delete f.client.cleanup;
      await expect(f.coordinator.execute(f.claim, f.shutdown.signal)).rejects.toBe(f.failure);
      expect(f.workspace.cleanup).toHaveBeenCalledOnce();
      expect(confirmed).toHaveBeenCalledOnce();
      expect(f.cleanup).not.toHaveBeenCalled();
    });

    it.each(["workspace", "acknowledgement"] as const)(
      "keeps a %s cleanup failure fatal instead of isolating the report failure",
      async (stage) => {
        const confirmed = vi.fn(async () => undefined);
        const unconfirmed = vi.fn(async () => undefined);
        const f = reportDeliveryFixture({
          onAttemptCleanupConfirmed: confirmed,
          onAttemptCleanupUnconfirmed: unconfirmed,
        });
        const failure = new Error(`Synthetic ${stage} cleanup failure.`);
        if (stage === "workspace") vi.mocked(f.workspace.cleanup).mockRejectedValue(failure);
        else f.cleanup.mockRejectedValue(failure);
        await expect(f.coordinator.execute(f.claim, f.shutdown.signal)).rejects.toBe(failure);
        expect(unconfirmed).toHaveBeenCalledWith("ATTEMPT_CLEANUP_UNCONFIRMED");
        expect(confirmed).toHaveBeenCalledTimes(stage === "workspace" ? 0 : 1);
        expect(f.cleanup).toHaveBeenCalledTimes(stage === "workspace" ? 0 : 1);
      },
    );

    it.each(["wrong-attempt", "unreleased"] as const)(
      "rejects a %s cleanup acknowledgement instead of isolating the report failure",
      async (condition) => {
        const unconfirmed = vi.fn(async () => undefined);
        const f = reportDeliveryFixture({ onAttemptCleanupUnconfirmed: unconfirmed });
        f.cleanup.mockResolvedValue({
          released: condition !== "unreleased",
          attemptId: condition === "wrong-attempt" ? "another-attempt" : f.claim.attempt.id,
        } as Awaited<ReturnType<NonNullable<InvestigationWorkerClient["cleanup"]>>>);
        const execution = f.coordinator.execute(f.claim, f.shutdown.signal);
        await expect(execution).rejects.toBeInstanceOf(InvestigationWorkerClientError);
        await expect(execution).rejects.toMatchObject({
          code: "invalid_response",
          retryable: false,
        });
        expect(unconfirmed).toHaveBeenCalledWith("ATTEMPT_CLEANUP_UNCONFIRMED");
      },
    );

    it("keeps a progress flush failure fatal after the cleanup acknowledgement", async () => {
      const f = reportDeliveryFixture();
      const failure = new Error("Synthetic progress flush failure.");
      const createProgress = progressReporter.createInvestigationProgressReporter;
      const progressHook = vi
        .spyOn(progressReporter, "createInvestigationProgressReporter")
        .mockImplementation((options) => {
          const reporter = createProgress(options);
          return {
            ...reporter,
            flush: async () => {
              await reporter.flush();
              throw failure;
            },
          };
        });
      try {
        await expect(f.coordinator.execute(f.claim, f.shutdown.signal)).rejects.toBe(failure);
        expect(f.cleanup).toHaveBeenCalledOnce();
      } finally {
        progressHook.mockRestore();
      }
    });

    it("keeps best effort progress delivery failure separate from report isolation", async () => {
      const f = reportDeliveryFixture();
      f.client.progress = vi.fn(async () => {
        throw new Error("Synthetic progress endpoint failure.");
      });
      await expect(f.coordinator.execute(f.claim, f.shutdown.signal)).rejects.toBeInstanceOf(
        IsolatedInvestigationReportDeliveryError,
      );
      expect(f.cleanup).toHaveBeenCalledOnce();
    });

    it("does not isolate a failed interrupt checkpoint before a stopped checkpoint was accepted", async () => {
      const f = reportDeliveryFixture();
      vi.mocked(f.model.execute).mockRejectedValue(new Error("Synthetic model failure."));
      vi.mocked(f.client.checkpoint).mockRejectedValue(f.failure);
      await expect(f.coordinator.execute(f.claim, f.shutdown.signal)).rejects.toBe(f.failure);
      expect(f.current().stopReason).toBe("continuing");
      expect(f.cleanup.mock.calls[0]?.[1]).not.toHaveProperty("reportDeliveryFailure");
      expect(f.client.uploadReportPart).not.toHaveBeenCalled();
      expect(f.client.finalize).not.toHaveBeenCalled();
    });

    it("does not isolate report failure after the heartbeat loses lease ownership", async () => {
      const unconfirmed = vi.fn(async () => undefined);
      const f = reportDeliveryFixture({ onAttemptCleanupUnconfirmed: unconfirmed });
      const leaseHook = vi
        .spyOn(InvestigationAttemptHeartbeat.prototype, "leaseLost", "get")
        .mockReturnValue(false);
      f.client.reportUsage = vi.fn(async () => {
        leaseHook.mockReturnValue(true);
        throw f.failure;
      });
      try {
        await expect(f.coordinator.execute(f.claim, f.shutdown.signal)).rejects.toBe(f.failure);
        expect(unconfirmed).toHaveBeenCalledWith("LEASE_LOST");
        expect(f.cleanup).not.toHaveBeenCalled();
      } finally {
        leaseHook.mockRestore();
      }
    });

    it.each([
      new InvestigationLeaseLost(),
      new InvestigationWorkerClientError("lease_lost", false, 409),
    ])("keeps lease errors from finalization fatal", async (failure) => {
      const f = reportDeliveryFixture();
      vi.mocked(f.client.finalize).mockRejectedValue(failure);
      await expect(f.coordinator.execute(f.claim, f.shutdown.signal)).rejects.toBe(failure);
      expect(f.cleanup.mock.calls[0]?.[1]).not.toHaveProperty("reportDeliveryFailure");
    });

    it("does not isolate a logging failure after the report was successfully finalized", async () => {
      const failure = new Error("Synthetic report logging failure.");
      const f = reportDeliveryFixture({
        logger: {
          debug: vi.fn(),
          info: (message) => {
            if (message === "Investigation report sealed.") throw failure;
          },
          warn: vi.fn(),
          error: vi.fn(),
        },
      });
      vi.mocked(f.client.finalize).mockImplementation(f.finalize);
      await expect(f.coordinator.execute(f.claim, f.shutdown.signal)).rejects.toBe(failure);
      expect(f.submissions).toHaveLength(1);
      expect(f.cleanup.mock.calls[0]?.[1]).not.toHaveProperty("reportDeliveryFailure");
    });
  });

  it("does not release a slot after a failed preparation also lost its owned cleanup", async () => {
    const confirmed = vi.fn(async () => undefined);
    const unconfirmed = vi.fn(async () => undefined);
    const f = fixture(0, 8, "bug", {
      onAttemptCleanupConfirmed: confirmed,
      onAttemptCleanupUnconfirmed: unconfirmed,
    });
    vi.mocked(f.prepare).mockRejectedValue(
      Object.assign(new AggregateError([], "Synthetic preparation cleanup failure."), {
        code: "WORKSPACE_CLEANUP_UNCONFIRMED",
      }),
    );
    f.client.cleanup = vi.fn(async () => ({
      released: true as const,
      attemptId: f.claim.attempt.id,
    }));
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(confirmed).not.toHaveBeenCalled();
    expect(unconfirmed).toHaveBeenCalledWith("OWNED_PROCESS_CLEANUP_UNCONFIRMED");
    expect(f.client.cleanup).not.toHaveBeenCalled();
  });

  it("binds usage receipts to accepted rounds and passes the original lease to the runner", async () => {
    const f = fixture();
    const original = vi.mocked(f.model.execute).getMockImplementation()!;
    const dispositions = vi.fn(async () => undefined);
    f.model.markUsageDisposition = dispositions;
    vi.mocked(f.model.execute).mockImplementation(async (input) => {
      expect(input.usageLease).toEqual(f.claim.lease);
      const result = await original(input);
      return {
        ...result,
        usage: { ...result.usage, invocationId: `invocation-${result.round.round}` },
      };
    });
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(dispositions.mock.calls).toEqual([
      ["invocation-1", "accepted"],
      ["invocation-2", "accepted"],
    ]);
    const analyses = vi
      .mocked(f.client.checkpoint)
      .mock.calls.map(([, request]) => request)
      .filter((request) => request.kind === "analysis");
    expect(analyses.map((request) => request.invocationId)).toEqual([
      "invocation-1",
      "invocation-2",
    ]);
  });

  it("sends trusted model identities with accepted analysis rounds and preserves them in the report", async () => {
    const f = fixture();
    const original = vi.mocked(f.model.execute).getMockImplementation()!;
    vi.mocked(f.model.execute).mockImplementation(async (input) => ({
      ...(await original(input)),
      modelIdentity:
        input.checkpoint!.round === 0
          ? { engine: "codex", model: "provider/analysis-model" }
          : { engine: "copilot", model: null },
    }));
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    const expected = [
      {
        attemptId: f.claim.attempt.id,
        round: 1,
        engine: "codex",
        model: "provider/analysis-model",
      },
      { attemptId: f.claim.attempt.id, round: 2, engine: "copilot", model: null },
    ];
    expect(f.current().runtime.modelExecutions).toEqual(expected);
    expect(f.submissions[0]?.header.context.modelExecutions).toEqual(expected);
    const requests = vi.mocked(f.client.checkpoint).mock.calls.map(([, request]) => request);
    expect(requests.filter((request) => request.kind === "analysis")).toEqual([
      expect.objectContaining({
        modelIdentity: { engine: "codex", model: "provider/analysis-model" },
      }),
      expect.objectContaining({ modelIdentity: { engine: "copilot", model: null } }),
    ]);
  });

  it("preserves legacy chunk coverage before allowing a full diff conclusion", async () => {
    const f = fixture(0, 8, "pr");
    // A persisted checkpoint without a review mode keeps its original chunk-brokered semantics.
    const legacy = f.current();
    delete legacy.runtime.reviewMode;
    const { digest: _digest, ...legacyContent } = legacy;
    legacy.digest = investigationContentDigest(legacyContent);
    const base = {
      schemaVersion: "InvestigationPrDiffManifestV1" as const,
      subjectRef: f.claim.task.subjectRef,
      baseSha: "d".repeat(40),
      headSha: "b".repeat(40),
      mergeBaseSha: "d".repeat(40),
      files: [
        {
          path: "new.ts",
          previousPath: null,
          status: "added" as const,
          chunkIds: ["chunk-diff", "chunk-head"],
        },
      ],
      chunks: [
        {
          id: "chunk-diff",
          path: "new.ts",
          kind: "diff" as const,
          ordinal: 0,
          encoding: "utf8" as const,
          contentDigest: "a".repeat(64),
          byteLength: 20,
        },
        {
          id: "chunk-head",
          path: "new.ts",
          kind: "head" as const,
          ordinal: 0,
          encoding: "utf8" as const,
          contentDigest: "b".repeat(64),
          byteLength: 10,
        },
      ],
    };
    const manifest = { ...base, digest: investigationContentDigest(base) };
    vi.mocked(f.workspace.readPrDiffManifest).mockResolvedValue(manifest);
    vi.mocked(f.model.execute).mockImplementation(async (input) => {
      expect(input.checkpoint?.runtime.sourceCoverage?.manifest.digest).toBe(manifest.digest);
      const analysis = proposedAnalysis(f.initial.result);
      analysis.coverage = structuredClone(input.checkpoint!.analysis.coverage);
      for (const unit of analysis.coverage.includedUnits) {
        if (unit.kind === "pr_diff_chunk" || input.checkpoint!.round > 0) unit.status = "completed";
      }
      analysis.coverage.completedUnitRefs = analysis.coverage.includedUnits
        .filter((unit) => unit.status === "completed")
        .map((unit) => unit.id);
      analysis.coverage.unresolvedUnitRefs = analysis.coverage.includedUnits
        .filter((unit) => unit.status !== "completed")
        .map((unit) => unit.id);
      return {
        ...modelRound(input, analysis, input.checkpoint!.round === 0 ? "discovery" : "finalize"),
        sourceUnitIds: input.checkpoint!.round === 0 ? ["chunk-diff", "chunk-head"] : [],
      };
    });
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(f.order[0]).toBe("checkpoint:source");
    expect(f.current().runtime.sourceCoverage?.brokeredUnitIds).toEqual([
      "chunk-diff",
      "chunk-head",
    ]);
    expect(f.submissions[0]?.header).toMatchObject({
      outcome: "completed",
      report: { coverage: { includedUnitCount: 3 } },
    });
  });

  it("forwards the frozen prior findings without accepting their evidence as current analysis", async () => {
    const f = fixture(0, 8, "pr");
    const previous = createInvestigationFixture("pr", { findingCount: 2 });
    const previousSubject = previous.task.subjects.find(
      (subject) => subject.id === previous.task.subjectRef,
    )!;
    if (previousSubject.kind !== "original_pr")
      throw new Error("The fixture requires a PR source.");
    f.claim.task.reviewBaseline = {
      reportRef: { id: "previous-native-review", version: 1, digest: "a".repeat(64) },
      sourceTaskId: "previous-review-task",
      subject: previousSubject,
      findings: previous.result.findings.map(({ id, version, title }) => ({ id, version, title })),
    };
    f.claim.reviewBaseline = {
      descriptor: structuredClone(f.claim.task.reviewBaseline),
      findings: structuredClone(previous.result.findings),
    };
    const checkpoint = createInvestigationCheckpoint({
      task: f.claim.task,
      attemptId: f.claim.attempt.id,
      checkpointId: "rereview-checkpoint",
      leaseVersion: f.claim.attempt.leaseVersion,
      recordedAt,
    });
    f.claim.checkpoint = checkpoint;
    f.replaceCurrent(checkpoint);
    const content = {
      schemaVersion: "InvestigationPrDiffManifestV1" as const,
      subjectRef: f.claim.task.subjectRef,
      baseSha: previousSubject.baseSha,
      headSha: previousSubject.headSha,
      mergeBaseSha: previousSubject.baseSha,
      files: [],
      chunks: [],
    };
    vi.mocked(f.workspace.readPrDiffManifest).mockResolvedValue({
      ...content,
      digest: investigationContentDigest(content),
    });
    vi.mocked(f.model.execute).mockImplementation(async (input) => {
      expect(input.reviewBaseline).toEqual(f.claim.reviewBaseline);
      expect(input.checkpoint?.analysis.findings).toEqual([]);
      expect(input.checkpoint?.analysis.evidence).toEqual([]);
      expect(input.checkpoint?.analysis.rechecks).toEqual([]);
      expect(input.checkpoint?.analysis.candidates).toHaveLength(2);
      expect(
        input.checkpoint?.analysis.candidates.every(
          (candidate) =>
            candidate.reviewDisposition === "pending" &&
            candidate.subjectRef === input.task.subjectRef,
        ),
      ).toBe(true);
      throw new Error("Synthetic model failure leaves the rereview pending.");
    });
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(f.model.execute).toHaveBeenCalledOnce();
    expect(f.current().round).toBe(0);
    expect(
      f
        .current()
        .analysis.candidates.every((candidate) => candidate.reviewDisposition === "pending"),
    ).toBe(true);
    expect(f.submissions[0]?.header.outcome).toBe("failed");
  });

  it("blocks a PR when its real complete diff cannot be provided", async () => {
    const f = fixture(0, 8, "pr");
    vi.mocked(f.workspace.readPrDiffManifest).mockRejectedValue(
      Object.assign(new Error("No trusted diff."), { code: "SOURCE_UNAVAILABLE" }),
    );
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(f.model.execute).not.toHaveBeenCalled();
    expect(f.submissions[0]?.header.outcome).toBe("blocked");
    expect(f.current().analysis.coverage.unresolvedUnitRefs).toContain("full-diff");
  });

  it("discovers and separately rechecks all 137 findings before sealing every report part", async () => {
    const f = fixture(137);
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(f.model.execute).toHaveBeenCalledTimes(2);
    expect(f.current().analysis.findings).toHaveLength(137);
    expect(f.current().analysis.rechecks).toHaveLength(137);
    expect(
      f.parts.filter((part) => part.collection === "findings").flatMap((part) => part.items),
    ).toHaveLength(137);
    expect(f.submissions[0]?.header).toMatchObject({
      outcome: "completed",
      report: { completeness: "complete" },
    });
    expect(f.order.slice(0, 4)).toEqual([
      "model",
      "checkpoint:analysis",
      "model",
      "checkpoint:analysis",
    ]);
    expect(f.order.at(-2)).toBe("finalize");
    expect(f.order.at(-1)).toBe("cleanup");
  });

  it("preserves the entire partial ledger when the budget ends after discovery", async () => {
    const f = fixture(137, 1);
    vi.mocked(f.model.execute)
      .mockImplementationOnce(async (input) =>
        modelRound(input, proposedAnalysis(f.initial.result), "discovery"),
      )
      .mockImplementationOnce(async () => {
        throw new ModelBudgetExceededError("duration");
      });
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(f.model.execute).toHaveBeenCalledTimes(2);
    expect(f.submissions[0]?.header).toMatchObject({
      outcome: "interrupted",
      report: { completeness: "partial" },
    });
    expect(
      f.parts.filter((part) => part.collection === "findings").flatMap((part) => part.items),
    ).toHaveLength(137);
    expect(f.current().analysis.rechecks).toHaveLength(0);
    expect(f.current().consumed.tokens).toBe(100);
    expect(f.current().runtime.unacceptedModelUsage).toBeUndefined();
    const interrupt = vi
      .mocked(f.client.checkpoint)
      .mock.calls.find(([, request]) => request.kind === "interrupt")?.[1];
    expect(interrupt).toBeDefined();
    expect(interrupt).not.toHaveProperty("modelUsage");
  });

  it("keeps the task deadline across source preparation and every round", async () => {
    const startedAt = Date.parse(recordedAt);
    let now = startedAt;
    const f = fixture(2, 8, "bug", { now: () => now });
    f.prepare.mockImplementation(async () => {
      now += 5_000;
      return f.workspace;
    });
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    const calls = vi.mocked(f.model.execute).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![0].invocationBudget).toEqual({
      deadlineAtMs: startedAt + 7_200_000,
    });
    expect(calls[1]![0].invocationBudget).toEqual({
      deadlineAtMs: startedAt + 7_200_000,
    });
  });

  it("continues past the legacy token and twenty-four-round limits while retaining usage", async () => {
    const f = fixture(30, 24);
    vi.mocked(f.model.execute).mockImplementation(async (input) => {
      const analysis =
        input.checkpoint!.round === 0
          ? proposedAnalysis(f.initial.result)
          : structuredClone(input.checkpoint!.analysis);
      if (input.checkpoint!.round > 0)
        analysis.rechecks.push({
          ...f.initial.result.report.recheck.records[input.checkpoint!.round - 1]!,
          round: input.checkpoint!.round + 1,
        });
      const result = modelRound(
        input,
        analysis,
        input.checkpoint!.round === 0 ? "discovery" : "finalize",
      );
      return { ...result, usage: { tokens: 1_000_000, source: "cli" } };
    });
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(f.model.execute).toHaveBeenCalledTimes(31);
    expect(f.current().consumed).toMatchObject({ rounds: 31, tokens: 31_000_000 });
    expect(f.submissions[0]?.header.outcome).toBe("completed");
    expect(f.workspace.cleanup).toHaveBeenCalledOnce();
  });

  it("accounts runtime admission time without restarting the deadline at coordinator entry", async () => {
    const startedAt = Date.parse(recordedAt);
    let now = startedAt + 5_000;
    const f = fixture(0, 8, "bug", {
      now: () => now,
      executionStartedAtMs: startedAt,
      executionDeadlineAtMs: startedAt + 7_200_000,
    });
    vi.mocked(f.model.execute).mockImplementationOnce(async (input) => {
      expect(input.invocationBudget).toEqual({ deadlineAtMs: startedAt + 7_200_000 });
      now += 100;
      return modelRound(input, proposedAnalysis(f.initial.result), "discovery");
    });
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(f.current().consumed.durationMs).toBe(5_100);
    expect(f.submissions[0]?.header.outcome).toBe("completed");
  });

  it("accepts the final complete checkpoint at the exact cumulative duration limit", async () => {
    const startedAt = Date.parse(recordedAt);
    let now = startedAt;
    const f = fixture(0, 8, "bug", { now: () => now });
    vi.mocked(f.model.execute).mockImplementationOnce(async (input) => {
      now += 7_200_000;
      return modelRound(input, proposedAnalysis(f.initial.result), "discovery");
    });
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(f.current().consumed.durationMs).toBe(7_200_000);
    expect(f.current().stopReason).toBe("complete");
    expect(f.submissions[0]?.header.outcome).toBe("completed");
    expect(f.workspace.cleanup).toHaveBeenCalledOnce();
  });

  it("uses only the remaining task duration after restoring an accepted checkpoint", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const discovered = applyInvestigationLoopRound(
      f.claim.checkpoint!,
      modelRound(
        {
          task: f.claim.task,
          attempt: f.claim.attempt,
          checkpoint: f.claim.checkpoint,
          signal: f.shutdown.signal,
          workspace: f.workspace,
        },
        proposedAnalysis(f.initial.result),
        "discovery",
      ).round,
      { recordedAt, usage: { durationMs: 7_199_900, tokens: 12_000_000, reportBytes: 0 } },
    );
    f.claim.attempt = { ...f.claim.attempt, id: "attempt-resumed", number: 2, leaseVersion: 2 };
    f.claim.lease = { attemptId: f.claim.attempt.id, fence: 2, leaseToken: "resumed-lease" };
    f.claim.checkpoint = restoreInvestigationCheckpoint({
      checkpoint: discovered,
      task: f.claim.task,
      attemptId: f.claim.attempt.id,
      leaseVersion: 2,
      recordedAt,
    });
    f.replaceCurrent(f.claim.checkpoint);
    const modelStarted = Promise.withResolvers<void>();
    const startedAt = Date.now();
    vi.mocked(f.model.execute).mockImplementation(async (input) => {
      expect(input.invocationBudget).toEqual({ deadlineAtMs: startedAt + 100 });
      modelStarted.resolve();
      await new Promise<void>((_resolve, reject) => {
        input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
      });
      throw new Error("Unreachable.");
    });
    const execution = f.coordinator.execute(f.claim, f.shutdown.signal);
    try {
      await modelStarted.promise;
      await vi.advanceTimersByTimeAsync(99);
      expect(f.submissions).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await execution;
      expect(f.model.execute).toHaveBeenCalledOnce();
      expect(f.submissions[0]?.header.outcome).toBe("interrupted");
      expect(f.current().consumed.tokens).toBe(12_000_000);
      expect(f.workspace.cleanup).toHaveBeenCalledOnce();
    } finally {
      f.shutdown.abort(new InvestigationWorkerShutdown());
      await execution;
      vi.useRealTimers();
    }
  });

  it("retains partial invocation usage and seals an interrupted budget report after a live stop", async () => {
    const f = fixture();
    vi.mocked(f.model.execute).mockImplementation(async (input) => {
      input.onUsage?.({ tokens: 71, source: "cli", completeness: "partial" });
      throw new AggregateError(
        [new ModelBudgetExceededError("duration")],
        "Synthetic accounting wrapper.",
      );
    });
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    const interrupt = vi
      .mocked(f.client.checkpoint)
      .mock.calls.find(([, request]) => request.kind === "interrupt")?.[1];
    expect(interrupt).toMatchObject({
      reason: "budget_exhausted",
      modelUsage: { round: 1, tokens: 71 },
    });
    expect(f.current().stopReason).toBe("budget_exhausted");
    expect(f.current().round).toBe(0);
    expect(f.current().consumed.tokens).toBe(71);
    expect(f.model.execute).toHaveBeenCalledOnce();
    expect(f.submissions[0]?.header).toMatchObject({
      outcome: "interrupted",
      report: { completeness: "partial" },
    });
    expect(f.workspace.cleanup).toHaveBeenCalledOnce();
  });

  it("keeps cleanup failure visible instead of replacing it with the nested budget stop", async () => {
    const onNodeFault = vi.fn();
    const cleanupUnconfirmed = vi.fn(async () => undefined);
    const f = fixture(2, 8, "bug", {
      onNodeFault,
      onAttemptCleanupUnconfirmed: cleanupUnconfirmed,
    });
    vi.mocked(f.model.execute).mockRejectedValue(
      new AggregateError(
        [
          new ModelBudgetExceededError("duration"),
          Object.assign(new Error("The owned process did not exit."), {
            code: "MODEL_PROCESS_CLEANUP_UNCONFIRMED",
          }),
        ],
        "Synthetic combined failure.",
      ),
    );
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(onNodeFault).toHaveBeenCalledWith("MODEL_PROCESS_CLEANUP_UNCONFIRMED");
    expect(cleanupUnconfirmed).toHaveBeenCalledWith("OWNED_PROCESS_CLEANUP_UNCONFIRMED");
    expect(f.workspace.cleanup).not.toHaveBeenCalled();
    expect(f.submissions[0]?.header.outcome).toBe("failed");
    const interrupt = vi
      .mocked(f.client.checkpoint)
      .mock.calls.find(([, request]) => request.kind === "interrupt")?.[1];
    expect(interrupt).toMatchObject({
      reason: "error",
      diagnostics: [expect.objectContaining({ code: "MODEL_PROCESS_CLEANUP_UNCONFIRMED" })],
    });
  });

  it("retains the last valid checkpoint when a later model turn drops a candidate", async () => {
    const f = fixture();
    vi.mocked(f.model.execute).mockImplementation(async (input) => {
      const analysis =
        input.checkpoint!.round === 0
          ? proposedAnalysis(f.initial.result)
          : structuredClone(input.checkpoint!.analysis);
      if (input.checkpoint!.round > 0) analysis.candidates.pop();
      return modelRound(input, analysis, "discovery");
    });
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(f.submissions[0]?.header.outcome).toBe("failed");
    expect(f.current().round).toBe(1);
    expect(f.current().analysis.findings).toHaveLength(2);
    expect(f.current().analysis.candidates).toHaveLength(2);
  });

  it("cancels execution while still submitting the accepted partial report before cleanup", async () => {
    const f = fixture();
    vi.mocked(f.model.execute).mockImplementation(async (input) => {
      if (input.checkpoint!.round === 0)
        return modelRound(input, proposedAnalysis(f.initial.result), "discovery");
      f.shutdown.abort(new InvestigationWorkerShutdown());
      input.signal.throwIfAborted();
      throw new Error("Unreachable.");
    });
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(f.current().round).toBe(1);
    expect(f.submissions[0]?.header.outcome).toBe("interrupted");
    expect(f.workspace.cleanup).toHaveBeenCalledTimes(1);
  });

  it("does not start a model or write a report after losing lease ownership", async () => {
    const f = fixture();
    vi.mocked(f.client.heartbeat).mockRejectedValue(new InvestigationLeaseLost());
    await expect(f.coordinator.execute(f.claim, f.shutdown.signal)).rejects.toBeInstanceOf(
      InvestigationLeaseLost,
    );
    expect(f.model.execute).not.toHaveBeenCalled();
    expect(f.client.checkpoint).not.toHaveBeenCalled();
    expect(f.client.finalize).not.toHaveBeenCalled();
  });

  it("resumes the accepted candidate ledger on the next attempt without repeating discovery", async () => {
    const f = fixture(137);
    const firstRound = modelRound(
      {
        task: f.claim.task,
        attempt: f.claim.attempt,
        checkpoint: f.claim.checkpoint,
        signal: f.shutdown.signal,
        workspace: f.workspace,
      },
      proposedAnalysis(f.initial.result),
      "discovery",
    ).round;
    const discovered = applyInvestigationLoopRound(f.claim.checkpoint!, firstRound, {
      recordedAt,
      usage: { durationMs: 10, tokens: 100, reportBytes: 0 },
    });
    f.claim.attempt = { ...f.claim.attempt, id: "attempt-resumed", number: 2, leaseVersion: 2 };
    f.claim.lease = { attemptId: f.claim.attempt.id, fence: 2, leaseToken: "resumed-lease" };
    f.claim.checkpoint = restoreInvestigationCheckpoint({
      checkpoint: discovered,
      task: f.claim.task,
      attemptId: f.claim.attempt.id,
      leaseVersion: 2,
      recordedAt,
    });
    f.replaceCurrent(f.claim.checkpoint);
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(f.model.execute).toHaveBeenCalledTimes(1);
    expect(f.current().round).toBe(2);
    expect(f.submissions[0]?.header.context.adoptedAttemptIds).toHaveLength(2);
    expect(f.submissions[0]?.header.report.collections.findings).toBe(137);
  });

  it("reports an unavailable source as blocked without pretending to inspect it", async () => {
    const f = fixture();
    f.prepare.mockRejectedValue(
      Object.assign(new Error("Unavailable source."), { code: "SOURCE_UNAVAILABLE" }),
    );
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(f.model.execute).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(f.client.checkpoint)
        .mock.calls.find(([, request]) => request.kind === "interrupt")?.[1],
    ).toMatchObject({ modelInvocationState: "not_started" });
    expect(f.submissions[0]?.header).toMatchObject({
      outcome: "blocked",
      report: { completeness: "partial" },
    });
  });

  it.each([
    "SOURCE_SUBMODULE_UNAVAILABLE",
    "SOURCE_SUBMODULE_UNSUPPORTED",
    "SOURCE_SUBMODULE_LIMIT_EXCEEDED",
    "SOURCE_SUBMODULE_BINDING_MISMATCH",
  ])("reports %s as a safe actionable prerequisite before model dispatch", async (code) => {
    const f = fixture();
    f.prepare.mockRejectedValue(
      Object.assign(new Error("private-token=secret unsafe upstream text"), { code }),
    );
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(f.model.execute).not.toHaveBeenCalled();
    const interrupt = vi
      .mocked(f.client.checkpoint)
      .mock.calls.find(([, request]) => request.kind === "interrupt")?.[1];
    expect(interrupt).toMatchObject({ modelInvocationState: "not_started" });
    expect(f.submissions[0]?.header).toMatchObject({
      outcome: "blocked",
      report: { completeness: "partial" },
    });
    expect(JSON.stringify(interrupt)).toContain(code);
    expect(JSON.stringify(interrupt)).toContain("resuming");
    expect(JSON.stringify(interrupt)).not.toContain("private-token");
    expect(JSON.stringify(interrupt)).not.toContain("unsafe upstream text");
  });

  it("does not declare pre-dispatch zero consumption after entering the model runner", async () => {
    const f = fixture();
    vi.mocked(f.model.execute).mockRejectedValue(
      Object.assign(new Error("Synthetic model transport failed."), {
        code: "MODEL_PROCESS_FAILED",
      }),
    );
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(f.model.execute).toHaveBeenCalledOnce();
    expect(
      vi
        .mocked(f.client.checkpoint)
        .mock.calls.find(([, request]) => request.kind === "interrupt")?.[1],
    ).not.toHaveProperty("modelInvocationState");
  });

  it("retains safe validation diagnostics and completed usage without accepting the rejected round", async () => {
    const f = fixture();
    vi.mocked(f.model.execute).mockImplementation(async (input) => {
      input.onUsage?.({ tokens: 371, source: "cli" });
      const error = new ModelOutputValidationError("reference_outside_batch", [
        "analysis",
        "assessment",
        "evidenceRefs",
      ]);
      error.message = "private-token-from-model";
      throw error;
    });
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(f.current().round).toBe(0);
    expect(f.current().consumed.tokens).toBe(371);
    expect(f.model.execute).toHaveBeenCalledOnce();
    expect(f.submissions[0]?.header.outcome).toBe("failed");
    expect(f.current().analysis.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "MODEL_OUTPUT_INVALID",
          message: expect.stringContaining(
            "[reference_outside_batch] at /analysis/assessment/evidenceRefs",
          ),
        }),
      ]),
    );
    expect(JSON.stringify(f.parts)).not.toContain("private-token-from-model");
    expect(JSON.stringify(f.submissions)).not.toContain("private-token-from-model");
  });

  it("does not copy arbitrary model validation exceptions into the terminal report", async () => {
    const f = fixture();
    vi.mocked(f.model.execute).mockRejectedValue(
      Object.assign(new Error("private-token-from-model"), {
        code: "MODEL_OUTPUT_INVALID",
        rule: "reference_outside_batch",
      }),
    );
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(f.current().analysis.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "MODEL_OUTPUT_INVALID",
          message:
            "The investigation executor or model protocol failed; the last accepted checkpoint was retained.",
        }),
      ]),
    );
    expect(JSON.stringify(f.parts)).not.toContain("private-token-from-model");
    expect(JSON.stringify(f.submissions)).not.toContain("private-token-from-model");
  });

  it("corrects one rejected static response after receipt and checkpoint acknowledgement", async () => {
    const f = fixture(0);
    const issue = {
      rule: "reference_outside_batch",
      paths: ["/analysis/candidates/0/findingId", "/analysis/candidates/1/findingId"],
    };
    f.invocationTokens.set("rejected-call", 371);
    f.model.markUsageDisposition = vi.fn(async (_invocationId, disposition) => {
      f.order.push(`disposition:${disposition}`);
    });
    vi.mocked(f.model.execute)
      .mockImplementationOnce(async (input) => {
        input.onUsage?.({
          tokens: 371,
          source: "cli",
          invocationId: "rejected-call",
          completeness: "complete",
        });
        throw new ModelOutputValidationError(
          "reference_outside_batch",
          ["analysis", "candidates", 1, "findingId"],
          [["analysis", "candidates", 0, "findingId"]],
        );
      })
      .mockImplementationOnce(async (input) => {
        f.order.push("corrected-model");
        expect(input.correction).toMatchObject({ issue });
        expect(input.checkpoint?.round).toBe(0);
        expect(input.checkpoint?.consumed.tokens).toBe(371);
        expect(input.invocationBudget).toEqual({
          deadlineAtMs: expect.any(Number),
        });
        expect(input.checkpoint?.version).toBeGreaterThan(f.claim.checkpoint!.version);
        const result = modelRound(input, proposedAnalysis(f.initial.result), "discovery");
        return { ...result, usage: { ...result.usage, invocationId: "accepted-call" } };
      });

    await f.coordinator.execute(f.claim, f.shutdown.signal);

    expect(f.model.execute).toHaveBeenCalledTimes(2);
    expect(f.model.markUsageDisposition).toHaveBeenNthCalledWith(1, "rejected-call", "rejected");
    expect(f.model.markUsageDisposition).toHaveBeenNthCalledWith(2, "accepted-call", "accepted");
    expect(f.order.indexOf("disposition:rejected")).toBeLessThan(
      f.order.indexOf("checkpoint:rejected_analysis"),
    );
    expect(f.order.indexOf("checkpoint:rejected_analysis")).toBeLessThan(
      f.order.indexOf("corrected-model"),
    );
    expect(f.current().round).toBe(1);
    expect(f.current().consumed).toMatchObject({ tokens: 471, rounds: 1 });
    expect(f.current().runtime.modelOutputRejections).toHaveLength(1);
    expect(f.current().runtime.unacceptedModelUsage ?? []).toEqual([]);
    const analysisRequest = vi
      .mocked(f.client.checkpoint)
      .mock.calls.map(([, request]) => request)
      .find((request) => request.kind === "analysis");
    expect(analysisRequest).toMatchObject({
      invocationId: "accepted-call",
      usage: { tokens: 100 },
    });
    expect(f.submissions[0]?.header.outcome).toBe("completed");
  });

  it("stops after the one correction and retains only its final unaccepted usage", async () => {
    const f = fixture(0);
    f.invocationTokens.set("rejected-call", 371);
    f.model.markUsageDisposition = vi.fn(async () => undefined);
    let invocation = 0;
    vi.mocked(f.model.execute).mockImplementation(async (input) => {
      invocation++;
      input.onUsage?.({
        tokens: invocation === 1 ? 371 : 17,
        source: "cli",
        invocationId: invocation === 1 ? "rejected-call" : "failed-correction",
        completeness: "complete",
      });
      throw new ModelOutputValidationError("duplicate_record_id", [
        "analysis",
        "candidates",
        0,
        "id",
      ]);
    });
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(f.model.execute).toHaveBeenCalledTimes(2);
    expect(f.current().round).toBe(0);
    expect(f.current().consumed.tokens).toBe(388);
    expect(f.current().runtime.modelOutputRejections).toHaveLength(1);
    expect(f.current().runtime.unacceptedModelUsage).toEqual([
      { attemptId: f.claim.attempt.id, round: 1, tokens: 17 },
    ]);
    expect(f.current().analysis.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MODEL_OUTPUT_INVALID" })]),
    );
    expect(f.submissions[0]?.header.outcome).toBe("failed");
  });

  it("respects a correction already recorded for the same attempt and round", async () => {
    const f = fixture(0);
    const previous = f.claim.checkpoint!;
    const retained = rejectInvestigationModelOutput(
      previous,
      {
        attemptId: f.claim.attempt.id,
        inputCheckpointRef: { id: previous.id, version: previous.version, digest: previous.digest },
        round: 1,
        invocationId: "previous-rejected-call",
        issue: { rule: "duplicate_record_id", paths: ["/analysis/candidates/0/id"] },
      },
      { recordedAt, durationMs: 0, accountedTokens: 31 },
    );
    f.claim.checkpoint = retained;
    f.replaceCurrent(retained);
    f.model.markUsageDisposition = vi.fn(async () => undefined);
    vi.mocked(f.model.execute).mockImplementation(async (input) => {
      input.onUsage?.({
        tokens: 17,
        source: "cli",
        invocationId: "current-call",
        completeness: "complete",
      });
      throw new ModelOutputValidationError("duplicate_record_id", [
        "analysis",
        "candidates",
        0,
        "id",
      ]);
    });
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(f.model.execute).toHaveBeenCalledOnce();
    expect(f.current().consumed.tokens).toBe(48);
    expect(f.current().runtime.modelOutputRejections).toHaveLength(1);
    expect(f.order).not.toContain("checkpoint:rejected_analysis");
  });

  it.each(["missing_identity", "unsafe_reference", "cleanup", "forged"] as const)(
    "does not correct a response with %s state",
    async (condition) => {
      const f = fixture(0);
      f.model.markUsageDisposition = vi.fn(async () => undefined);
      vi.mocked(f.model.execute).mockImplementation(async (input) => {
        input.onUsage?.({
          tokens: 371,
          source: "cli",
          ...(condition === "missing_identity" ? {} : { invocationId: "rejected-call" }),
          completeness: "complete",
        });
        if (condition === "forged")
          throw Object.assign(new Error("private-token"), {
            code: "MODEL_OUTPUT_INVALID",
            rule: "duplicate_record_id",
            paths: ["/analysis/candidates/0/id"],
          });
        const error = new ModelOutputValidationError("reference_outside_batch", [
          "analysis",
          "candidates",
          0,
          condition === "unsafe_reference" ? "subjectRef" : "findingId",
        ]);
        if (condition === "cleanup")
          Object.assign(error, { cause: { code: "MODEL_PROCESS_CLEANUP_UNCONFIRMED" } });
        throw error;
      });
      await f.coordinator.execute(f.claim, f.shutdown.signal);
      expect(f.model.execute).toHaveBeenCalledOnce();
      expect(f.order).not.toContain("checkpoint:rejected_analysis");
      expect(f.submissions[0]?.header.outcome).toBe("failed");
      expect(JSON.stringify(f.submissions)).not.toContain("private-token");
    },
  );

  it("admits a correction after the rejected call reaches the legacy token limit", async () => {
    const f = fixture(0);
    const tokens = f.claim.task.budget.maxTokens ?? 12_000_000;
    f.invocationTokens.set("rejected-call", tokens);
    f.model.markUsageDisposition = vi.fn(async () => undefined);
    vi.mocked(f.model.execute).mockImplementationOnce(async (input) => {
      input.onUsage?.({
        tokens,
        source: "cli",
        invocationId: "rejected-call",
        completeness: "complete",
      });
      throw new ModelOutputValidationError("duplicate_record_id", [
        "analysis",
        "candidates",
        0,
        "id",
      ]);
    });
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(f.model.execute).toHaveBeenCalledTimes(2);
    expect(f.current().consumed.tokens).toBe(tokens + 100);
    expect(f.current().runtime.unacceptedModelUsage ?? []).toEqual([]);
    expect(f.current().runtime.modelOutputRejections).toHaveLength(1);
    expect(f.submissions[0]?.header.outcome).toBe("completed");
  });

  it.each(["missing", "partial"] as const)(
    "admits one bounded output correction with %s token accounting",
    async (accounting) => {
      const f = fixture(0);
      const tokens = accounting === "missing" ? null : 371;
      f.invocationTokens.set("rejected-call", tokens);
      f.model.markUsageDisposition = vi.fn(async () => undefined);
      vi.mocked(f.model.execute).mockImplementationOnce(async (input) => {
        input.onUsage?.({
          tokens,
          source: tokens === null ? "unavailable" : "cli",
          invocationId: "rejected-call",
          completeness: accounting === "missing" ? "unavailable" : "partial",
        });
        throw new ModelOutputValidationError("duplicate_record_id", [
          "analysis",
          "candidates",
          0,
          "id",
        ]);
      });
      await f.coordinator.execute(f.claim, f.shutdown.signal);
      expect(f.model.execute).toHaveBeenCalledTimes(2);
      expect(f.current().consumed.tokens).toBe((tokens ?? 0) + 100);
      expect(f.current().runtime.modelOutputRejections).toHaveLength(1);
      expect(f.submissions[0]?.header.outcome).toBe("completed");
      expect(f.workspace.cleanup).toHaveBeenCalledOnce();
    },
  );

  it("retries a lost rejection acknowledgement before dispatching the correction", async () => {
    const f = fixture(0);
    f.invocationTokens.set("rejected-call", 371);
    f.model.markUsageDisposition = vi.fn(async () => undefined);
    const checkpoint = vi.mocked(f.client.checkpoint).getMockImplementation()!;
    let retained: Awaited<ReturnType<typeof f.client.checkpoint>> | undefined;
    let rejectionRequests = 0;
    vi.mocked(f.client.checkpoint).mockImplementation(async (...args) => {
      if (args[1].kind !== "rejected_analysis") return checkpoint(...args);
      rejectionRequests++;
      if (retained === undefined) {
        retained = await checkpoint(...args);
        throw Object.assign(new Error("The rejection acknowledgement was lost."), {
          retryable: true,
        });
      }
      return retained;
    });
    vi.mocked(f.model.execute).mockImplementationOnce(async (input) => {
      input.onUsage?.({
        tokens: 371,
        source: "cli",
        invocationId: "rejected-call",
        completeness: "complete",
      });
      throw new ModelOutputValidationError("duplicate_record_id", [
        "analysis",
        "candidates",
        0,
        "id",
      ]);
    });
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(rejectionRequests).toBe(2);
    expect(f.model.execute).toHaveBeenCalledTimes(2);
    expect(f.current().consumed.tokens).toBe(471);
    expect(f.current().runtime.modelOutputRejections).toHaveLength(1);
    expect(f.submissions[0]?.header.outcome).toBe("completed");
  });

  it("requires a rejected usage receipt acknowledgement before another model call", async () => {
    const f = fixture(0);
    f.model.markUsageDisposition = vi.fn(async () => {
      throw new Error("Receipt delivery failed.");
    });
    vi.mocked(f.model.execute).mockImplementation(async (input) => {
      input.onUsage?.({
        tokens: 371,
        source: "cli",
        invocationId: "rejected-call",
        completeness: "complete",
      });
      throw new ModelOutputValidationError("duplicate_record_id", [
        "analysis",
        "candidates",
        0,
        "id",
      ]);
    });
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(f.model.execute).toHaveBeenCalledOnce();
    expect(f.order).not.toContain("checkpoint:rejected_analysis");
    expect(f.current().consumed.tokens).toBe(371);
    expect(f.submissions[0]?.header.outcome).toBe("failed");
  });

  it("honors shutdown after rejection acknowledgement without accounting its usage twice", async () => {
    const f = fixture(0);
    f.invocationTokens.set("rejected-call", 371);
    f.model.markUsageDisposition = vi.fn(async () => undefined);
    const checkpoint = vi.mocked(f.client.checkpoint).getMockImplementation()!;
    vi.mocked(f.client.checkpoint).mockImplementation(async (...args) => {
      const response = await checkpoint(...args);
      if (args[1].kind === "rejected_analysis") f.shutdown.abort(new InvestigationWorkerShutdown());
      return response;
    });
    vi.mocked(f.model.execute).mockImplementation(async (input) => {
      input.onUsage?.({
        tokens: 371,
        source: "cli",
        invocationId: "rejected-call",
        completeness: "complete",
      });
      throw new ModelOutputValidationError("duplicate_record_id", [
        "analysis",
        "candidates",
        0,
        "id",
      ]);
    });
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(f.model.execute).toHaveBeenCalledOnce();
    expect(f.current().consumed.tokens).toBe(371);
    expect(f.current().runtime.unacceptedModelUsage ?? []).toEqual([]);
    expect(f.submissions[0]?.header.outcome).toBe("interrupted");
    expect(
      vi
        .mocked(f.client.checkpoint)
        .mock.calls.find(([, request]) => request.kind === "interrupt")?.[1],
    ).not.toHaveProperty("modelUsage");
  });

  it.each([false, true])(
    "delivers an already complete checkpoint without preparing a workspace or repeating any work: source provenance=%s",
    async (withProvenance) => {
      const f = fixture();
      const provenance = withProvenance ? attachPinnedDependency(f).provenance : undefined;
      if (provenance !== undefined) {
        const checkpoint = applyInvestigationSourceProvenanceCheckpoint(
          f.claim.checkpoint!,
          provenance,
          { task: f.claim.task, recordedAt },
        );
        f.claim.checkpoint = checkpoint;
        f.replaceCurrent(checkpoint);
      }
      const input = {
        task: f.claim.task,
        attempt: f.claim.attempt,
        checkpoint: f.claim.checkpoint,
        signal: f.shutdown.signal,
        workspace: f.workspace,
      };
      const discovery = modelRound(input, proposedAnalysis(f.initial.result), "discovery");
      const first = applyInvestigationLoopRound(f.claim.checkpoint!, discovery.round, {
        recordedAt,
        usage: { durationMs: 10, tokens: 100, reportBytes: 0 },
      });
      const analysis = structuredClone(first.analysis);
      analysis.rechecks = f.initial.result.report.recheck.records.map((record) => ({
        ...record,
        round: 2,
      }));
      const final = modelRound({ ...input, checkpoint: first }, analysis, "finalize");
      const complete = applyInvestigationLoopRound(first, final.round, {
        recordedAt,
        usage: { durationMs: 10, tokens: 100, reportBytes: 0 },
      });
      f.claim.checkpoint = complete;
      f.replaceCurrent(complete);
      await f.coordinator.execute(f.claim, f.shutdown.signal);
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.model.execute).not.toHaveBeenCalled();
      expect(f.plan.execute).not.toHaveBeenCalled();
      expect(f.workspace.cleanup).not.toHaveBeenCalled();
      expect(f.submissions[0]?.header.outcome).toBe("completed");
      expect(f.submissions[0]?.header.context.sourceProvenance).toEqual(provenance);
    },
  );

  it("does not claim zero token consumption when the CLI omitted usage", async () => {
    const f = fixture();
    vi.mocked(f.model.execute).mockImplementationOnce(async (input) => ({
      ...modelRound(input, proposedAnalysis(f.initial.result), "discovery"),
      usage: { tokens: null, source: "unavailable" },
    }));
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(f.submissions[0]?.header.outcome).toBe("completed");
    expect(f.model.execute).toHaveBeenCalledTimes(2);
    expect(f.current().round).toBe(2);
    expect(f.current().consumed.tokens).toBe(100);
    expect(
      vi
        .mocked(f.client.checkpoint)
        .mock.calls.find(([, request]) => request.kind === "analysis")?.[1],
    ).toMatchObject({ usage: { tokens: null } });
  });

  it.each(["runner", "analysis", "cancellation"] as const)(
    "accounts completed model usage after a %s failure without accepting its analysis",
    async (stage) => {
      const f = fixture();
      vi.mocked(f.model.execute).mockImplementation(async (input) => {
        input.onUsage?.({ tokens: null, source: "unavailable" });
        input.onUsage?.({ tokens: 371, source: "cli" });
        if (stage === "runner") throw new Error("Synthetic merge failure.");
        const analysis = proposedAnalysis(f.initial.result);
        if (stage === "analysis") {
          const candidate = analysis.candidates[0]!;
          candidate.status = "unresolved";
          candidate.findingId = null;
          candidate.findingVersion = null;
        } else f.shutdown.abort(new InvestigationWorkerShutdown());
        return {
          ...modelRound(input, analysis, "discovery"),
          usage: { tokens: 371, source: "cli" },
        };
      });
      await f.coordinator.execute(f.claim, f.shutdown.signal);
      expect(f.current().round).toBe(0);
      expect(f.current().consumed.tokens).toBe(371);
      expect(f.current().runtime.unacceptedModelUsage).toEqual([
        { attemptId: f.claim.attempt.id, round: 1, tokens: 371 },
      ]);
      expect(f.model.execute).toHaveBeenCalledOnce();
      expect(f.submissions[0]?.header.outcome).toBe(
        stage === "cancellation" ? "interrupted" : "failed",
      );
      expect(f.submissions[0]?.header.report.loop.consumed.tokens).toBe(371);
    },
  );

  it("persists unknown usage when a dispatched call is cancelled without a CLI usage record", async () => {
    const f = fixture();
    vi.mocked(f.model.execute).mockImplementation(async (input) => {
      input.onUsage?.({ tokens: null, source: "unavailable" });
      f.shutdown.abort(new InvestigationWorkerShutdown());
      throw f.shutdown.signal.reason;
    });
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(f.current().consumed.tokens).toBe(0);
    expect(f.current().runtime.unacceptedModelUsage).toEqual([
      { attemptId: f.claim.attempt.id, round: 1, tokens: null },
    ]);
    expect(f.current().analysis.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MODEL_USAGE_UNAVAILABLE" })]),
    );
    expect(f.submissions[0]?.header.outcome).toBe("interrupted");
  });

  it.each([999])(
    "retains the first complete usage receipt when a runner later reports %s",
    async (laterTokens) => {
      const f = fixture();
      vi.mocked(f.model.execute).mockImplementation(async (input) => {
        input.onUsage?.({ tokens: 371, source: "cli" });
        return {
          ...modelRound(input, proposedAnalysis(f.initial.result), "discovery"),
          usage: { tokens: laterTokens, source: laterTokens === null ? "unavailable" : "cli" },
        };
      });
      await f.coordinator.execute(f.claim, f.shutdown.signal);
      expect(f.current().round).toBe(0);
      expect(f.current().consumed.tokens).toBe(371);
      expect(f.current().runtime.unacceptedModelUsage).toEqual([
        { attemptId: f.claim.attempt.id, round: 1, tokens: 371 },
      ]);
      expect(f.model.execute).toHaveBeenCalledOnce();
    },
  );

  it("keeps observed token consumption when final accounting is unavailable and continues", async () => {
    const f = fixture();
    vi.mocked(f.model.execute).mockImplementationOnce(async (input) => {
      input.onUsage?.({ tokens: 371, source: "cli", completeness: "partial" });
      return {
        ...modelRound(input, proposedAnalysis(f.initial.result), "discovery"),
        usage: { tokens: null, source: "unavailable", completeness: "unavailable" },
      };
    });
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(f.model.execute).toHaveBeenCalledTimes(2);
    expect(f.current().consumed.tokens).toBe(471);
    expect(f.current().round).toBe(2);
    expect(f.submissions[0]?.header.outcome).toBe("completed");
  });

  it("delivers a complete checkpoint when terminal usage reconciliation finds a lost analysis acknowledgement", async () => {
    const f = fixture();
    const checkpoint = vi.mocked(f.client.checkpoint).getMockImplementation()!;
    vi.mocked(f.client.checkpoint).mockImplementation(async (...args) => {
      const request = args[1];
      if (request.kind === "interrupt") {
        expect(request.modelUsage).toEqual({ round: 2, tokens: 100 });
        return { checkpoint: structuredClone(f.current()) };
      }
      const response = await checkpoint(...args);
      if (request.kind === "analysis" && request.round.round === 2)
        throw new Error("The final acknowledgement was lost after acceptance.");
      return response;
    });
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(f.current().consumed.tokens).toBe(200);
    expect(f.current().runtime.unacceptedModelUsage).toBeUndefined();
    expect(f.submissions[0]?.header.outcome).toBe("completed");
    expect(f.model.execute).toHaveBeenCalledTimes(2);
  });

  it("retains owned files when a model process cannot be confirmed stopped", async () => {
    const f = fixture();
    vi.mocked(f.model.execute).mockRejectedValue(
      Object.assign(new Error("Unconfirmed teardown."), {
        code: "MODEL_PROCESS_CLEANUP_UNCONFIRMED",
      }),
    );
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(f.workspace.cleanup).not.toHaveBeenCalled();
    expect(f.submissions[0]?.header.outcome).toBe("failed");
  });
});
