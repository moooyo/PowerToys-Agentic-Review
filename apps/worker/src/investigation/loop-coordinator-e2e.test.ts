import { createHash } from "node:crypto";
import {
  createInvestigationPreview,
  type InvestigationCheckpointRequest,
  type InvestigationClaim,
  type InvestigationE2eResult,
  type InvestigationFinalizeRequest,
  type InvestigationLoopCheckpointV1,
  type InvestigationRuntimeState,
} from "@agentic-review/contracts";
import {
  applyInvestigationLoopRound,
  applyInvestigationRuntimeCheckpoint,
  createInvestigationCheckpoint,
  interruptInvestigationLoop,
  restoreInvestigationCheckpoint,
} from "@agentic-review/domain";
import { describe, expect, it, vi } from "vitest";
import type {
  ProcessHostClient,
  ProcessResourceLimits,
} from "../execution/process-host-protocol.js";
import {
  buildE2eAgentExecutionResult,
  createE2eAgentRunner,
  type E2eAgentRunner,
} from "./e2e-agent-runner.js";
import type { InvestigationWorkerClient } from "./http-client.js";
import { InvestigationLoopCoordinator } from "./loop-coordinator.js";
import type { ModelTurnRunnerOptions } from "./model-turn-runner.js";
import type { PreparedInvestigationWorkspace } from "./workspace.js";

const recordedAt = "2026-09-19T00:00:00.000Z";
const completedAt = "2026-09-19T00:01:00.000Z";
const screenshotBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
  "base64",
);
type FeatureOutcome = InvestigationE2eResult["features"][number]["outcome"];

function finishedRuntime(
  claim: InvestigationClaim,
  checkpoint: InvestigationLoopCheckpointV1,
  outcome: FeatureOutcome = "passed",
): InvestigationRuntimeState {
  const subject = claim.task.subjects.find((entry) => entry.id === claim.task.subjectRef);
  if (subject?.kind !== "original_pr") throw new Error("The fixture requires a PR subject.");
  const executed = outcome === "passed" || outcome === "failed";
  const evidenceRefs = executed ? ["assertion-observation"] : [];
  return {
    ...structuredClone(checkpoint.runtime),
    e2eExecution: {
      attemptId: claim.attempt.id,
      status: "completed",
      startedAt: checkpoint.runtime.e2eExecution?.startedAt ?? recordedAt,
      completedAt,
    },
    artifacts: executed
      ? [
          {
            id: "screenshot",
            taskId: claim.task.id,
            attemptId: claim.attempt.id,
            subjectRef: subject.id,
            kind: "image",
            name: "feature.png",
            mediaType: "image/png",
            digest: createHash("sha256").update(screenshotBytes).digest("hex"),
            byteLength: screenshotBytes.byteLength,
            availability: "available",
          },
        ]
      : [],
    evidence: executed
      ? [
          {
            id: "assertion-observation",
            subjectRef: subject.id,
            source: "executor_observation",
            authority: "worker",
            summary: `Recorded assertion outcome: ${outcome}.`,
            artifactRefs: ["screenshot"],
            evidenceRefs: [],
            provenance: {
              taskId: claim.task.id,
              attemptId: claim.attempt.id,
              producer: "e2e-tool-server",
              recordedAt,
            },
          },
        ]
      : [],
    checks: [
      {
        id: "feature-assertion",
        scenarioId: "feature",
        subjectRef: subject.id,
        planRef: null,
        required: true,
        description: "The changed UI displays the expected value.",
        status: outcome,
        executor: executed ? "e2e-tool-server" : null,
        evidenceRefs,
        authoritativeAttemptId: executed ? claim.attempt.id : null,
      },
    ],
    e2e: {
      headSha: subject.headSha,
      buildIdentity: "Worker build from the pinned PR revision",
      cleanup: { confirmed: true, recordedAt: completedAt, summary: "Owned processes exited." },
      features: [
        {
          id: "feature",
          title: "Changed UI behavior",
          paths: ["src/feature.cs"],
          scenario: "Operate the changed UI and inspect the displayed value.",
          userVisible: true,
          outcome,
          assertions: [
            {
              id: "feature-assertion",
              expected: "The expected value is displayed.",
              observed: `Recorded assertion outcome: ${outcome}.`,
              outcome,
              evidenceRefs,
            },
          ],
          artifactRefs: executed ? ["screenshot"] : [],
          limitations: outcome === "blocked" ? ["The required application could not launch."] : [],
        },
      ],
    },
  };
}

function fixture() {
  const initial = createInvestigationPreview("pr", { findingCount: 0 });
  const task = structuredClone(initial.task);
  task.kind = "pr-e2e";
  task.state = "running";
  task.parentTaskId = null;
  task.parentReportRef = null;
  task.planRef = null;
  task.executionPolicy = {
    mode: "execute",
    allowedSubjectRefs: [task.subjectRef],
    allowRepositoryExecution: true,
    authorizationRef: "synthetic-e2e-authorization",
  };
  task.scope.includedUnits = [
    {
      id: "e2e-features",
      kind: "e2e_features",
      subjectRef: task.subjectRef,
      paths: [],
      requiredWork: "Verify each changed feature with runtime assertions and captured media.",
      status: "pending",
      evidenceRefs: [],
    },
  ];
  task.scope.completedUnitRefs = [];
  task.scope.unresolvedUnitRefs = ["e2e-features"];
  const attempt = { ...initial.attempt, state: "running" as const, finishedAt: null };
  const checkpoint = createInvestigationCheckpoint({
    task,
    attemptId: attempt.id,
    checkpointId: "e2e-checkpoint",
    leaseVersion: attempt.leaseVersion,
    recordedAt,
  });
  const subject = task.subjects.find((entry) => entry.id === task.subjectRef);
  if (subject?.kind !== "original_pr") throw new Error("The fixture requires a PR subject.");
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
      subjectRef: subject.id,
      subjectRevisionKey: subject.revisionKey,
      title: task.workItem.title,
      body: "Synthetic E2E coordinator integration fixture.",
      comments: [],
      source: null,
    },
    plan: null,
    execution: null,
  };
  let current = checkpoint;
  const order: string[] = [];
  const requests: InvestigationCheckpointRequest[] = [];
  const submissions: InvestigationFinalizeRequest[] = [];
  const analysisInputs: InvestigationLoopCheckpointV1[] = [];
  const forbidden = vi.fn(async (): Promise<never> => {
    throw new Error("This coordinator fixture must not perform filesystem or process operations.");
  });
  const client: InvestigationWorkerClient = {
    claim: vi.fn(async () => claim),
    heartbeat: vi.fn(async () => ({
      cancelRequested: false,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      serverTime: new Date().toISOString(),
    })),
    checkpoint: vi.fn(async (_taskId, request) => {
      requests.push(structuredClone(request));
      order.push(`checkpoint:${request.kind}`);
      if (request.kind === "analysis") {
        analysisInputs.push(structuredClone(current));
        current = applyInvestigationLoopRound(current, request.round, {
          recordedAt,
          usage: request.usage,
          sourceUnitIds: request.sourceUnitIds ?? [],
        });
      } else if (request.kind === "execution") {
        current = applyInvestigationRuntimeCheckpoint(current, request.execution, { recordedAt });
      } else if (request.kind === "interrupt") {
        current = interruptInvestigationLoop(
          current,
          request.reason,
          recordedAt,
          request.diagnostics,
          0,
          request.modelUsage,
        );
      } else {
        throw new Error("A root E2E task must not enter the static diff review protocol.");
      }
      return { checkpoint: structuredClone(current) };
    }),
    uploadArtifact: vi.fn(async () => {
      order.push("artifact-uploaded");
      return { accepted: true as const };
    }),
    readArtifact: forbidden,
    uploadReportPart: vi.fn(async () => ({ accepted: true as const })),
    finalize: vi.fn(async (_taskId, request) => {
      order.push("report-finalized");
      submissions.push(request);
      return {
        reportRef: {
          id: request.header.id,
          version: request.header.version,
          digest: request.manifest.logicalContentDigest,
        },
      };
    }),
    cleanup: vi.fn(async (_taskId, request) => {
      order.push("server-slot-released");
      return { released: true as const, attemptId: request.lease.attemptId };
    }),
  };
  const workspace: PreparedInvestigationWorkspace = {
    attemptDirectory: "C:/Synthetic/E2E/attempt",
    modelInputDirectory: "C:/Synthetic/E2E/input",
    modelInputPath: "C:/Synthetic/E2E/input/snapshot.json",
    modelInputDigest: "1".repeat(64),
    controlDirectory: "C:/Synthetic/E2E/control",
    tempDirectory: "C:/Synthetic/E2E/temp",
    sourceDirectory: "C:/Synthetic/E2E/source",
    sourceBinding: {
      subjectRef: subject.id,
      revisionKey: subject.revisionKey,
      sourceSha: subject.headSha,
      patchDigest: null,
      artifactRef: null,
    },
    assertIntegrity: vi.fn(async () => undefined),
    assertSourceBinding: vi.fn(async () => undefined),
    resolveSourcePath: forbidden,
    readSourceFile: forbidden,
    readPrDiffManifest: forbidden,
    readPrDiffChunk: forbidden,
    applyEdits: forbidden,
    capturePatch: forbidden,
    writeArtifact: forbidden,
    writePatchArtifact: forbidden,
    readArtifact: vi.fn(async () => screenshotBytes),
    cleanup: vi.fn(async () => {
      order.push("workspace-cleaned");
    }),
  };
  const processHost: ProcessHostClient = {
    start: forbidden,
    terminateAll: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const confirmed = vi.fn(async () => {
    order.push("desktop-guard-released");
  });
  const unconfirmed = vi.fn(async (_code: string) => {
    order.push("quarantined");
  });
  const staticModel = { execute: forbidden };
  const planExecutor = { execute: forbidden };
  return {
    claim,
    client,
    workspace,
    processHost,
    order,
    requests,
    submissions,
    analysisInputs,
    confirmed,
    unconfirmed,
    forbidden,
    current: () => current,
    acceptRuntime(runtime: InvestigationRuntimeState) {
      current = applyInvestigationRuntimeCheckpoint(current, runtime, { recordedAt });
    },
    resume() {
      const nextAttempt = {
        ...claim.attempt,
        id: "resumed-e2e-attempt",
        number: claim.attempt.number + 1,
        leaseVersion: claim.attempt.leaseVersion + 1,
      };
      current = restoreInvestigationCheckpoint({
        task,
        checkpoint: interruptInvestigationLoop(current, "interrupted", recordedAt),
        attemptId: nextAttempt.id,
        leaseVersion: nextAttempt.leaseVersion,
        recordedAt,
      });
      claim.attempt = nextAttempt;
      claim.lease = {
        attemptId: nextAttempt.id,
        fence: nextAttempt.leaseVersion,
        leaseToken: "synthetic-resumed-lease",
      };
      claim.checkpoint = structuredClone(current);
    },
    async run(runner: E2eAgentRunner) {
      const coordinator = new InvestigationLoopCoordinator({
        client,
        processHost,
        modelTurnRunner: staticModel,
        e2eAgentRunner: runner,
        workspaceProvider: { prepare: vi.fn(async () => workspace) },
        planExecutor,
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        onAttemptCleanupConfirmed: confirmed,
        onAttemptCleanupUnconfirmed: unconfirmed,
        requestRetryMs: 1,
        now: () => Date.parse(recordedAt),
      });
      await coordinator.execute(claim, new AbortController().signal);
    },
  };
}

function recoveryRunner(processHost: ProcessHostClient) {
  const execute = vi.fn(async (): Promise<never> => {
    throw new Error("Recovery must not invoke a model.");
  });
  const createTools = vi.fn((): never => {
    throw new Error("Recovery must not reopen the desktop.");
  });
  const runner = createE2eAgentRunner({
    modelOptions: {} as ModelTurnRunnerOptions,
    processHost,
    environment: {},
    processLimits: {} as ProcessResourceLimits,
    powershellExecutablePath: "C:/Synthetic/powershell.exe",
    gitExecutablePath: "C:/Synthetic/git.exe",
    jsonRunner: { execute },
    createTools,
  });
  return { runner, execute, createTools };
}

describe("E2E coordinator durable execution", () => {
  it("persists observations before continuing, uploads media once, and binds analysis to accepted execution", async () => {
    const f = fixture();
    const dispositions = vi.fn(async () => undefined);
    const execute = vi.fn<E2eAgentRunner["execute"]>(async (input) => {
      f.order.push("e2e-model");
      expect(f.current().runtime.e2eExecution).toEqual({
        attemptId: f.claim.attempt.id,
        status: "started",
        startedAt: recordedAt,
        completedAt: null,
      });
      expect(input.checkpoint).toEqual(f.current());
      const runtime = finishedRuntime(f.claim, input.checkpoint!);
      const observation = { evidence: runtime.evidence, artifacts: runtime.artifacts };
      await input.onRuntimeObservation!(observation);
      expect(f.current().runtime.evidence).toEqual(runtime.evidence);
      expect(f.current().runtime.artifacts).toEqual(runtime.artifacts);
      expect(f.current().round).toBe(0);
      expect(f.submissions).toHaveLength(0);
      await input.onRuntimeObservation!(observation);
      return buildE2eAgentExecutionResult(input, runtime, {
        tokens: 73,
        source: "cli",
        invocationId: "synthetic-e2e-invocation",
      });
    });

    await f.run({ execute, markUsageDisposition: dispositions });

    expect(execute).toHaveBeenCalledOnce();
    expect(f.order.slice(0, 3)).toEqual(["checkpoint:execution", "e2e-model", "artifact-uploaded"]);
    expect(f.client.uploadArtifact).toHaveBeenCalledOnce();
    expect(f.workspace.readArtifact).toHaveBeenCalledOnce();
    expect(vi.mocked(f.client.uploadArtifact).mock.calls[0]?.[1].contentBase64).toBe(
      screenshotBytes.toString("base64"),
    );
    const analysis = f.requests.find((request) => request.kind === "analysis");
    const acceptedExecution = f.analysisInputs[0]!;
    expect(analysis?.kind).toBe("analysis");
    if (analysis?.kind !== "analysis") throw new Error("An accepted analysis is required.");
    expect(analysis.round.inputCheckpointRef).toEqual({
      id: acceptedExecution.id,
      version: acceptedExecution.version,
      digest: acceptedExecution.digest,
    });
    expect(acceptedExecution.runtime.e2eExecution?.status).toBe("completed");
    expect(f.current().consumed).toMatchObject({ rounds: 1, tokens: 73 });
    expect(f.submissions[0]?.header.outcome).toBe("completed");
    expect(dispositions).toHaveBeenCalledExactlyOnceWith("synthetic-e2e-invocation", "accepted");
    expect(f.order.slice(-4)).toEqual([
      "report-finalized",
      "workspace-cleaned",
      "desktop-guard-released",
      "server-slot-released",
    ]);
    expect(f.client.cleanup).toHaveBeenCalledWith(
      f.claim.task.id,
      {
        lease: f.claim.lease,
        ownedProcessesStopped: true,
        desktopRestored: true,
      },
      expect.any(AbortSignal),
    );
    expect(f.unconfirmed).not.toHaveBeenCalled();
    expect(f.forbidden).not.toHaveBeenCalled();
  });

  it("seals previously accepted execution on a new attempt without another model, desktop operation, or upload", async () => {
    const f = fixture();
    const originalAttemptId = f.claim.attempt.id;
    const completed = finishedRuntime(f.claim, f.current());
    f.acceptRuntime({
      ...f.current().runtime,
      e2eExecution: {
        ...completed.e2eExecution!,
        status: "started",
        completedAt: null,
      },
    });
    f.acceptRuntime(completed);
    f.resume();
    const recovery = recoveryRunner(f.processHost);

    await f.run(recovery.runner);

    expect(recovery.execute).not.toHaveBeenCalled();
    expect(recovery.createTools).not.toHaveBeenCalled();
    expect(f.client.uploadArtifact).not.toHaveBeenCalled();
    expect(f.workspace.readArtifact).not.toHaveBeenCalled();
    expect(f.current().runtime.e2eExecution?.attemptId).toBe(originalAttemptId);
    expect(f.current().consumed).toMatchObject({ rounds: 1, tokens: 0 });
    expect(f.submissions[0]?.header.outcome).toBe("completed");
    expect(f.submissions[0]?.header.context.e2e?.features[0]?.outcome).toBe("passed");
    expect(f.client.cleanup).toHaveBeenCalledOnce();
    expect(f.forbidden).not.toHaveBeenCalled();
  });

  it("blocks an incomplete earlier attempt without replacing its durable marker or replaying side effects", async () => {
    const f = fixture();
    const marker = {
      attemptId: f.claim.attempt.id,
      status: "started" as const,
      startedAt: recordedAt,
      completedAt: null,
    };
    f.acceptRuntime({ ...f.current().runtime, e2eExecution: marker });
    f.resume();
    const recovery = recoveryRunner(f.processHost);

    await f.run(recovery.runner);

    expect(recovery.execute).not.toHaveBeenCalled();
    expect(recovery.createTools).not.toHaveBeenCalled();
    expect(f.requests.some((request) => request.kind === "execution")).toBe(false);
    expect(f.current().runtime.e2eExecution).toEqual(marker);
    expect(f.current().round).toBe(0);
    expect(f.current().analysis.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "E2E_EXECUTION_ALREADY_STARTED",
        retryable: false,
      }),
    );
    expect(f.submissions[0]?.header.outcome).toBe("blocked");
    expect(f.client.uploadArtifact).not.toHaveBeenCalled();
    expect(f.forbidden).not.toHaveBeenCalled();
  });

  it.each(["failed", "blocked"] as const)(
    "preserves a recorded %s feature in the terminal report",
    async (outcome) => {
      const f = fixture();
      const execute = vi.fn<E2eAgentRunner["execute"]>(async (input) =>
        buildE2eAgentExecutionResult(input, finishedRuntime(f.claim, input.checkpoint!, outcome), {
          tokens: 41,
          source: "cli",
        }),
      );

      await f.run({ execute });

      expect(execute).toHaveBeenCalledOnce();
      expect(f.submissions[0]?.header.outcome).toBe(outcome);
      expect(f.submissions[0]?.header.context.e2e?.features[0]?.outcome).toBe(outcome);
      expect(f.current().consumed).toMatchObject({ rounds: 1, tokens: 41 });
      expect(f.current().analysis.coverage.completedUnitRefs).toEqual([]);
      expect(f.current().analysis.diagnostics.map((entry) => entry.code)).toContain(
        outcome === "failed" ? "E2E_ASSERTION_FAILED" : "E2E_COVERAGE_BLOCKED",
      );
      expect(f.client.cleanup).toHaveBeenCalledOnce();
      expect(f.forbidden).not.toHaveBeenCalled();
    },
  );

  it("retains partial evidence and quarantines the slot when E2E process cleanup is unconfirmed", async () => {
    const f = fixture();
    const execute = vi.fn<E2eAgentRunner["execute"]>(async (input) => {
      const runtime = finishedRuntime(f.claim, input.checkpoint!);
      await input.onRuntimeObservation!({
        evidence: runtime.evidence,
        artifacts: runtime.artifacts,
      });
      throw Object.assign(new Error("The application process did not confirm exit."), {
        code: "E2E_CLEANUP_UNCONFIRMED",
      });
    });

    await f.run({ execute });

    expect(f.current().runtime.evidence.map((entry) => entry.id)).toEqual([
      "assertion-observation",
    ]);
    expect(f.current().runtime.artifacts.map((entry) => entry.id)).toEqual(["screenshot"]);
    expect(f.current().runtime.e2eExecution?.status).toBe("started");
    expect(f.current().runtime.e2e).toBeUndefined();
    expect(f.current().round).toBe(0);
    expect(f.submissions[0]?.header.outcome).toBe("failed");
    expect(f.client.uploadArtifact).toHaveBeenCalledOnce();
    expect(f.workspace.cleanup).not.toHaveBeenCalled();
    expect(f.confirmed).not.toHaveBeenCalled();
    expect(f.client.cleanup).not.toHaveBeenCalled();
    expect(f.unconfirmed).toHaveBeenCalledWith("OWNED_PROCESS_CLEANUP_UNCONFIRMED");
    expect(f.forbidden).not.toHaveBeenCalled();
  });
});
