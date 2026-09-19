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
  createInvestigationCheckpoint,
  interruptInvestigationLoop,
  investigationContentDigest,
  restoreInvestigationCheckpoint,
} from "@agentic-review/domain";
import { describe, expect, it, vi } from "vitest";
import type { ProcessHostClient } from "../execution/process-host-protocol.js";
import { InvestigationLeaseLost } from "./attempt-heartbeat.js";
import type { InvestigationWorkerClient } from "./http-client.js";
import {
  InvestigationLoopCoordinator,
  type InvestigationLoopCoordinatorOptions,
} from "./loop-coordinator.js";
import type {
  ModelTurnExecutionInput,
  ModelTurnExecutionResult,
  ModelTurnRunner,
} from "./model-turn-runner.js";
import type { InvestigationPlanExecutor } from "./plan-executor.js";
import { InvestigationWorkerShutdown } from "./task-service.js";
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
      else {
        current = interruptInvestigationLoop(
          current,
          request.reason === "error" ? "failed" : request.reason,
          recordedAt,
          request.diagnostics,
          0,
          request.modelUsage,
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
  };
}

describe("InvestigationLoopCoordinator", () => {
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
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(f.model.execute).toHaveBeenCalledTimes(1);
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

  it("delivers an already complete checkpoint without preparing a workspace or repeating any work", async () => {
    const f = fixture();
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
  });

  it("does not claim zero token consumption when the CLI omitted usage", async () => {
    const f = fixture();
    vi.mocked(f.model.execute).mockImplementation(async (input) => ({
      ...modelRound(input, proposedAnalysis(f.initial.result), "discovery"),
      usage: { tokens: null, source: "unavailable" },
    }));
    await f.coordinator.execute(f.claim, f.shutdown.signal);
    expect(f.submissions[0]?.header.outcome).toBe("interrupted");
    expect(
      f
        .current()
        .analysis.diagnostics.some((diagnostic) => diagnostic.code === "MODEL_USAGE_UNAVAILABLE"),
    ).toBe(true);
    expect(f.current().round).toBe(0);
    expect(f.current().runtime.unacceptedModelUsage).toEqual([
      { attemptId: f.claim.attempt.id, round: 1, tokens: null },
    ]);
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

  it.each([null, 999])(
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
