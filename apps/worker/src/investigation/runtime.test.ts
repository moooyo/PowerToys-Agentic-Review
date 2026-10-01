import {
  createInvestigationPreview as createInvestigationFixture,
  INVESTIGATION_EXECUTION_DURATION_LIMIT_MS,
  type InvestigationModelInvocationReceipt,
  unavailableInvestigationTokenUsage,
} from "@agentic-review/contracts";
import { createInvestigationCheckpoint, interruptInvestigationLoop } from "@agentic-review/domain";
import { describe, expect, it, vi } from "vitest";
import type { StdioProcessHostClientOptions } from "../execution/process-host-client.js";
import type { Logger } from "../logging/logger.js";
import type {
  AgentVerificationPlanAdapter,
  AgentVerificationPlanAdapterOptions,
} from "./agent-verification-plan-adapter.js";
import type {
  AttemptCleanupJournal,
  AttemptCleanupJournalOptions,
} from "./attempt-cleanup-journal.js";
import type { AttemptDesktopGuard } from "./attempt-desktop-guard.js";
import type { E2eAgentRunnerOptions } from "./e2e-agent-runner.js";
import type { InvestigationGitSourceOptions } from "./git-source.js";
import type { InvestigationWorkerClient } from "./http-client.js";
import type { InvestigationLoopCoordinatorOptions } from "./loop-coordinator.js";
import type { ModelTurnRunnerOptions } from "./model-turn-runner.js";
import type {
  InvestigationModelUsageJournal,
  ModelUsageJournalOptions,
} from "./model-usage-journal.js";
import type {
  InvestigationOutputJournal,
  InvestigationOutputJournalOptions,
} from "./output-journal.js";
import type { ProductionInvestigationPlanExecutorOptions } from "./plan-executor.js";
import type {
  InvestigationRecipePlanAdapter,
  RecipePlanAdapterOptions,
} from "./recipe-plan-adapter.js";
import {
  createInvestigationExecutionRuntime,
  type InvestigationRuntimeDependencies,
} from "./runtime.js";
import { loadInvestigationWorkerRuntimeConfig } from "./runtime-config.js";
import {
  type ClaimedInvestigationTask,
  type InvestigationClaimExecutor,
  InvestigationTaskService,
  type InvestigationTaskServiceOptions,
} from "./task-service.js";

const never = async (): Promise<never> => {
  throw new Error("This fixture does not execute a model, command, or request.");
};
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function claimFixture(): ClaimedInvestigationTask {
  const { task, attempt } = createInvestigationFixture("pr");
  return {
    task,
    attempt,
    lease: { attemptId: attempt.id, fence: attempt.leaseVersion, leaseToken: "synthetic-lease" },
    checkpoint: null,
    reportId: "synthetic-report",
    inputSnapshot: null,
    plan: null,
    execution: null,
  } as unknown as ClaimedInvestigationTask;
}

function claimWithConsumedDuration(
  durationMs: number,
  kind: "pr-review" | "pr-e2e" = "pr-review",
): ClaimedInvestigationTask {
  const claim = claimFixture();
  const task = { ...claim.task, kind };
  const recordedAt = "2026-10-02T00:00:00.000Z";
  const checkpoint = createInvestigationCheckpoint({
    task,
    attemptId: claim.attempt.id,
    checkpointId: "checkpoint-before-runtime-admission",
    leaseVersion: claim.lease.fence,
    recordedAt,
  });
  return {
    ...claim,
    task,
    checkpoint: interruptInvestigationLoop(checkpoint, "interrupted", recordedAt, [], durationMs),
  };
}

function fixture() {
  const config = loadInvestigationWorkerRuntimeConfig({
    SYSTEMROOT: "C:\\Windows",
    INVESTIGATION_WORKER_SERVER_URL: "https://worker.example.test",
    INVESTIGATION_WORKER_TOKEN: "synthetic_worker_token_".padEnd(48, "x"),
    INVESTIGATION_WORKER_DATA_DIRECTORY: "D:\\WorkerData",
    INVESTIGATION_WORKER_TRUSTED_EXECUTABLE_ROOT: "D:\\Trusted",
    INVESTIGATION_WORKER_PROCESS_HOST_PATH: "D:\\Trusted\\host.exe",
    INVESTIGATION_WORKER_PROCESS_HOST_SHA256: "a".repeat(64),
    INVESTIGATION_WORKER_GIT_PATH: "D:\\Trusted\\git.exe",
    INVESTIGATION_WORKER_GIT_SHA256: "b".repeat(64),
    INVESTIGATION_WORKER_CLI_PATH: "C:\\Tools\\codex.exe",
    INVESTIGATION_WORKER_CLI_SHA256: "c".repeat(64),
    INVESTIGATION_WORKER_MODEL_ENVIRONMENT_JSON: JSON.stringify({
      USERPROFILE: "C:\\WorkerAccount",
      CODEX_HOME: "C:\\WorkerAccount\\.codex",
    }),
    INVESTIGATION_WORKER_STATIC_CONFIG_VERIFIED: "true",
    INVESTIGATION_WORKER_ALLOWED_REPOSITORIES_JSON: JSON.stringify(["moooyo/PowerToys"]),
  });
  const events: string[] = [];
  const client: InvestigationWorkerClient = {
    workerPolicy: async (request) => ({
      workerId: "synthetic-worker",
      version: 1,
      e2eEnabled: true,
      effectiveKinds: [...request.supportedKinds],
    }),
    claim: never,
    heartbeat: never,
    checkpoint: never,
    uploadArtifact: never,
    readArtifact: never,
    uploadReportPart: never,
    finalize: never,
  };
  const captured: {
    host?: StdioProcessHostClientOptions;
    model?: ModelTurnRunnerOptions;
    source?: InvestigationGitSourceOptions;
    coordinator?: InvestigationLoopCoordinatorOptions;
    service?: InvestigationTaskServiceOptions;
    usageJournal?: ModelUsageJournalOptions;
    modelEdit?: ModelTurnRunnerOptions;
    e2e?: E2eAgentRunnerOptions;
    recipe?: RecipePlanAdapterOptions;
    agentVerification?: AgentVerificationPlanAdapterOptions;
    plan?: ProductionInvestigationPlanExecutorOptions;
    cleanupJournal?: AttemptCleanupJournalOptions;
    outputJournal?: InvestigationOutputJournalOptions;
  } = {};
  const replayUsage = vi.fn(async () => {});
  const outputJournal: InvestigationOutputJournal = {
    openAttempt: vi.fn(async () => {}),
    append: vi.fn(),
    closeAttempt: vi.fn(),
    replay: vi.fn(async () => {}),
    flush: vi.fn(async () => true),
    stop: vi.fn(async () => true),
  };
  const usageJournal = {
    begin: never,
    update: never,
    replay: replayUsage,
  } as unknown as InvestigationModelUsageJournal;
  const cleanupJournal: AttemptCleanupJournal = {
    register: vi.fn(async (input) => ({
      ...input,
      schemaVersion: "InvestigationAttemptCleanupIdentityV1" as const,
      registeredAt: "2026-09-19T00:00:00.000Z",
      journalDirectory: "D:\\WorkerData\\attempt-cleanup",
      guardOwnerToken: "12345678-1234-1234-1234-123456789abc",
    })),
    executionStarted: vi.fn(async () => {}),
    workspaceOwned: vi.fn(async () => {}),
    localCleanupConfirmed: vi.fn(async () => {}),
    guardReleased: vi.fn(async () => {}),
    acknowledged: vi.fn(async () => {}),
    failed: vi.fn(async () => {}),
    confirmRecovery: vi.fn(async () => {}),
    statuses: vi.fn(async () => []),
    recover: vi.fn(async () => []),
  };
  const host = {
    start: never,
    terminateAll: async () => {
      events.push("host.terminateAll");
    },
    close: async () => {
      events.push("host.close");
    },
  };
  const coordinator = {
    execute: vi.fn<InvestigationClaimExecutor["execute"]>(async () => {
      events.push("coordinator.execute");
    }),
  };
  const recipeAdapter: InvestigationRecipePlanAdapter = { execute: never };
  const agentVerificationAdapter: AgentVerificationPlanAdapter = { execute: never };
  const service = {
    run: async () => {
      events.push("service.run");
    },
    requestDrain: () => {
      events.push("service.drain");
    },
    stop: async () => {
      events.push("service.stop");
    },
  };
  const dependencies: InvestigationRuntimeDependencies = {
    prepareDirectories: async () => {
      events.push("directories.prepare");
    },
    verifyDeployment: async () => ({
      processHostPath: config.processHost.path,
      gitPath: config.git.path,
      cliPath: config.cli.path,
      executables: {},
    }),
    createClient: () => client,
    createCleanupJournal: (options) => {
      captured.cleanupJournal = options;
      return cleanupJournal;
    },
    createCleanupRecoveryOperations: () => ({
      acquireGuard: async () => {},
      cleanupWorkspace: async () => {},
      releaseGuard: async () => {},
    }),
    acquireDesktopGuard: async () => desktopGuardFixture([]),
    createUsageJournal: (options) => {
      captured.usageJournal = options;
      return usageJournal;
    },
    createOutputJournal: (options) => {
      captured.outputJournal = options;
      return outputJournal;
    },
    createProcessHost: async (options) => {
      captured.host = options;
      return host;
    },
    createModelTurnRunner: (options) => {
      captured.model = options;
      return { execute: never };
    },
    createE2eAgentRunner: (options) => {
      captured.e2e = options;
      return { execute: never };
    },
    createRecipePlanAdapter: (options) => {
      captured.recipe = options;
      return recipeAdapter;
    },
    createAgentVerificationPlanAdapter: (options) => {
      captured.agentVerification = options;
      return agentVerificationAdapter;
    },
    createModelEditAdapter: (options) => {
      captured.modelEdit = options;
      return { execute: never };
    },
    createPlanExecutor: (options) => {
      captured.plan = options;
      return { execute: never };
    },
    createSourceMaterializer: (options) => {
      captured.source = options;
      return { materialize: never };
    },
    createWorkspaceProvider: () => ({ prepare: never }),
    createCoordinator: (options) => {
      captured.coordinator = options;
      return coordinator;
    },
    createTaskService: (options) => {
      captured.service = options;
      return service;
    },
  };
  return {
    config,
    events,
    client,
    captured,
    host,
    coordinator,
    recipeAdapter,
    agentVerificationAdapter,
    service,
    dependencies,
    usageJournal,
    replayUsage,
    cleanupJournal,
    outputJournal,
  };
}

function desktopGuardFixture(events: string[]): AttemptDesktopGuard {
  let state: AttemptDesktopGuard["state"] = "held";
  return {
    ownerToken: "12345678-1234-1234-1234-123456789abc",
    get state() {
      return state;
    },
    async releaseRestored() {
      events.push("guard.release");
      state = "released";
    },
    async quarantine(reasonCode) {
      if (state !== "held") return;
      events.push(`guard.quarantine:${reasonCode}`);
      state = "quarantined";
    },
    async settleManagedCleanup(next) {
      if (state === "released" || state === "quarantined") return;
      events.push(next === "released" ? "guard.release" : "guard.quarantine");
      state = next;
    },
  };
}

describe("production investigation runtime composition", () => {
  it("shares deployment-pinned E2E tools with the saved recipe adapter and injects it into the plan executor", async () => {
    const f = fixture();
    const msbuildToolchain = { vcToolsVersion: "14.50.35717", platformToolset: "v145" as const };
    const msbuild = { path: "C:\\BuildTools\\MSBuild.exe", sha256: "d".repeat(64) };
    const config = {
      ...f.config,
      msbuildToolchain,
      executables: { ...f.config.executables, msbuild },
    };
    const runtime = await createInvestigationExecutionRuntime(config, logger, {
      ...f.dependencies,
      verifyDeployment: async () => ({
        processHostPath: config.processHost.path,
        gitPath: config.git.path,
        cliPath: config.cli.path,
        executables: { msbuild: "D:\\VerifiedTools\\MSBuild.exe" },
      }),
    });
    expect(f.captured.e2e?.msbuildToolchain).toEqual(msbuildToolchain);
    expect(f.captured.e2e?.buildTools).toEqual({ msbuild: "D:\\VerifiedTools\\MSBuild.exe" });
    expect(f.captured.e2e?.buildToolDigests).toEqual({ msbuild: msbuild.sha256 });
    expect(f.captured.e2e?.environment).not.toHaveProperty("VCToolsVersion");
    expect(f.captured.recipe).toMatchObject({
      msbuildToolchain,
      buildTools: { msbuild: "D:\\VerifiedTools\\MSBuild.exe" },
      buildToolDigests: { msbuild: msbuild.sha256 },
      gitExecutablePath: config.git.path,
      processLimits: config.processLimits,
    });
    expect(f.captured.e2e).toMatchObject(f.captured.recipe!);
    expect(f.captured.plan?.recipeAdapter).toBe(f.recipeAdapter);
    expect(f.captured.agentVerification).toMatchObject(f.captured.recipe!);
    expect(f.captured.agentVerification?.modelOptions).toBe(f.captured.model);
    expect(f.captured.agentVerification?.modelOptions.usageJournal).toBe(f.usageJournal);
    expect(f.captured.plan?.agentVerificationAdapter).toBe(f.agentVerificationAdapter);
    await runtime.stop();
  });

  it("preserves server E2E cancellation, the renewed lease, and cleanup", async () => {
    const f = fixture();
    const heartbeat = {
      cancelRequested: true,
      serverTime: "2026-09-19T00:00:00.000Z",
      leaseExpiresAt: "2026-09-19T00:02:00.000Z",
    };
    f.client.heartbeat = vi.fn(async () => heartbeat);
    f.coordinator.execute.mockImplementation(async (claim) => {
      const observed = await f.captured.coordinator!.client.heartbeat(claim.task.id, {
        lease: claim.lease,
      });
      expect(observed).toEqual({ ...heartbeat, cancelRequested: true });
      await f.captured.coordinator!.onAttemptCleanupConfirmed?.();
    });
    const runtime = await createInvestigationExecutionRuntime(f.config, logger, f.dependencies);
    const claim = claimFixture();
    claim.task.kind = "pr-e2e";
    await f.captured.service!.executor.execute(claim, new AbortController().signal);
    expect(f.cleanupJournal.localCleanupConfirmed).toHaveBeenCalledWith(claim.attempt.id);
    expect(f.cleanupJournal.guardReleased).toHaveBeenCalledWith(claim.attempt.id);
    await runtime.stop();
  });

  it("rechecks E2E permission on an already-running attempt without stopping static heartbeats", async () => {
    const f = fixture();
    let enabled = true;
    f.client.workerPolicy = vi.fn<NonNullable<InvestigationWorkerClient["workerPolicy"]>>(
      async (request) => ({
        workerId: "synthetic-worker",
        version: enabled ? 2 : 3,
        e2eEnabled: enabled,
        effectiveKinds: enabled ? request.supportedKinds : ["pr-review", "issue-investigate"],
      }),
    );
    const heartbeat = {
      cancelRequested: false,
      serverTime: "2026-09-19T00:00:00.000Z",
      leaseExpiresAt: "2026-09-19T00:02:00.000Z",
    };
    f.client.heartbeat = vi.fn<InvestigationWorkerClient["heartbeat"]>(async (taskId) => ({
      ...heartbeat,
      cancelRequested: taskId !== "static-task" && !enabled,
    }));
    f.coordinator.execute.mockImplementation(async (claim) => {
      const client = f.captured.coordinator!.client;
      expect((await client.heartbeat(claim.task.id, { lease: claim.lease })).cancelRequested).toBe(
        false,
      );
      enabled = false;
      expect((await client.heartbeat(claim.task.id, { lease: claim.lease })).cancelRequested).toBe(
        true,
      );
      expect(
        (
          await client.heartbeat("static-task", {
            lease: { ...claim.lease, attemptId: "static-attempt" },
          })
        ).cancelRequested,
      ).toBe(false);
      await f.captured.coordinator!.onAttemptCleanupConfirmed?.();
    });
    const runtime = await createInvestigationExecutionRuntime(f.config, logger, f.dependencies);
    const claim = claimFixture();
    claim.task.kind = "pr-e2e";
    await f.captured.service!.executor.execute(claim, new AbortController().signal);
    expect(f.client.workerPolicy).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("replays retained cleanup and usage while an execution-only Worker has no permitted claims", async () => {
    const f = fixture();
    f.client.workerPolicy = async () => ({
      workerId: "synthetic-worker",
      version: 3,
      e2eEnabled: false,
      effectiveKinds: [],
    });
    const runtime = await createInvestigationExecutionRuntime(f.config, logger, f.dependencies);
    expect(f.cleanupJournal.recover).toHaveBeenCalledTimes(1);
    const policy = await f.captured.service!.client.workerPolicy!({ supportedKinds: ["pr-e2e"] });
    expect(policy.effectiveKinds).toEqual([]);
    expect(f.cleanupJournal.recover).toHaveBeenCalledTimes(2);
    expect(f.replayUsage).toHaveBeenCalledTimes(2);
    await runtime.stop();
  });

  it("coalesces stalled output replay across policy, claim and heartbeat polling without delaying cancellation or shutdown", async () => {
    const f = fixture();
    const firstReplay = Promise.withResolvers<void>();
    const secondReplay = Promise.withResolvers<void>();
    vi.mocked(f.outputJournal.replay)
      .mockImplementationOnce(() => firstReplay.promise)
      .mockImplementationOnce(() => secondReplay.promise);
    f.client.claim = vi.fn(async () => null);
    f.client.heartbeat = vi.fn(async () => ({
      cancelRequested: true,
      serverTime: "2026-09-20T00:00:00.000Z",
      leaseExpiresAt: "2026-09-20T00:02:00.000Z",
    }));
    const runtime = await createInvestigationExecutionRuntime(f.config, logger, f.dependencies);
    const client = f.captured.service!.client;
    const claim = claimFixture();
    for (let index = 0; index < 100; index++) {
      await client.workerPolicy!({ supportedKinds: ["pr-review"] });
      expect(await client.claim({ supportedKinds: ["pr-review"] })).toBeNull();
      expect((await client.heartbeat(claim.task.id, { lease: claim.lease })).cancelRequested).toBe(
        true,
      );
    }
    expect(f.outputJournal.replay).toHaveBeenCalledTimes(1);
    expect(f.client.claim).toHaveBeenCalledTimes(100);
    expect(f.client.heartbeat).toHaveBeenCalledTimes(100);

    firstReplay.resolve();
    await firstReplay.promise;
    await Promise.resolve();
    await Promise.resolve();
    await client.workerPolicy!({ supportedKinds: ["pr-review"] });
    expect(f.outputJournal.replay).toHaveBeenCalledTimes(2);
    await runtime.stop();
    expect(f.outputJournal.stop).toHaveBeenCalledTimes(1);
    expect(f.events).toContain("host.close");
    // A late storage completion after shutdown cannot schedule another replay.
    secondReplay.resolve();
    await secondReplay.promise;
    await Promise.resolve();
    await client.workerPolicy!({ supportedKinds: ["pr-review"] });
    expect(f.outputJournal.replay).toHaveBeenCalledTimes(2);
  });

  it("rejects forged static execution authority at the runtime boundary", async () => {
    const f = fixture();
    const runtime = await createInvestigationExecutionRuntime(f.config, logger, f.dependencies);
    const claim = claimFixture();
    claim.task.executionPolicy.mode = "execute";
    await expect(
      f.captured.service!.executor.execute(claim, new AbortController().signal),
    ).rejects.toThrow(/cannot carry repository execution authority/);
    expect(f.coordinator.execute).not.toHaveBeenCalled();
    expect(f.cleanupJournal.register).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("enforces a static local role at the execution boundary even when E2E is advertised", async () => {
    const f = fixture();
    const runtime = await createInvestigationExecutionRuntime(
      { ...f.config, role: "static" },
      logger,
      f.dependencies,
    );
    const claim = claimFixture();
    claim.task.kind = "pr-e2e";
    await expect(
      f.captured.service!.executor.execute(claim, new AbortController().signal),
    ).rejects.toThrow(/configured task role/);
    expect(f.coordinator.execute).not.toHaveBeenCalled();
    expect(f.cleanupJournal.register).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("awaits the private durable cleanup identity before any E2E guard or source side effect", async () => {
    const f = fixture();
    const registrationStarted = Promise.withResolvers<void>();
    const durable = Promise.withResolvers<void>();
    const acquireDesktopGuard = vi.fn(async () => desktopGuardFixture([]));
    f.coordinator.execute.mockImplementation(async () => {
      await f.captured.coordinator!.onAttemptCleanupConfirmed?.();
    });
    const runtime = await createInvestigationExecutionRuntime(f.config, logger, {
      ...f.dependencies,
      acquireDesktopGuard,
      createCleanupJournal: () => ({
        ...f.cleanupJournal,
        async register(input) {
          registrationStarted.resolve();
          await durable.promise;
          return f.cleanupJournal.register(input);
        },
      }),
    });
    const original = claimFixture();
    const running = f.captured.service!.executor.execute(
      {
        ...original,
        task: { ...original.task, kind: "pr-e2e" },
      },
      new AbortController().signal,
    );
    await registrationStarted.promise;
    expect(acquireDesktopGuard).not.toHaveBeenCalled();
    expect(f.captured.source).toBeUndefined();
    expect(f.coordinator.execute).not.toHaveBeenCalled();
    durable.resolve();
    await running;
    expect(f.cleanupJournal.executionStarted).toHaveBeenCalledWith(original.attempt.id);
    expect(f.cleanupJournal.localCleanupConfirmed).toHaveBeenCalledWith(original.attempt.id);
    expect(f.cleanupJournal.guardReleased).toHaveBeenCalledWith(original.attempt.id);
    expect(f.captured.host?.namedJobRecovery).toBe(true);
    await runtime.stop();
  });

  it("runs pending cleanup recovery before any task is claimed", async () => {
    const f = fixture();
    const recovering = Promise.withResolvers<void>();
    const recovered = Promise.withResolvers<void>();
    const creating = createInvestigationExecutionRuntime(f.config, logger, {
      ...f.dependencies,
      createCleanupJournal: () => ({
        ...f.cleanupJournal,
        async recover() {
          recovering.resolve();
          await recovered.promise;
          return [];
        },
      }),
    });
    await recovering.promise;
    expect(f.captured.service).toBeUndefined();
    expect(f.coordinator.execute).not.toHaveBeenCalled();
    recovered.resolve();
    const runtime = await creating;
    await runtime.stop();
  });

  it("retains native exclusive ownership until an operator cleanup operation has finished", async () => {
    const f = fixture();
    const recovering = Promise.withResolvers<void>();
    const recovered = Promise.withResolvers<void>();
    vi.mocked(f.cleanupJournal.recover)
      .mockResolvedValueOnce([])
      .mockImplementationOnce(async () => {
        recovering.resolve();
        await recovered.promise;
        return [];
      });
    const runtime = await createInvestigationExecutionRuntime(f.config, logger, f.dependencies);
    const pending = runtime.confirmCleanupRecovery("retained-attempt", {
      operator: "test-operator",
      reason: "Restored the dedicated desktop.",
      desktopRestored: true,
      ownedProcessTreeStopped: false,
    });
    await recovering.promise;
    const stopping = runtime.stop();
    await Promise.resolve();
    expect(f.events).not.toContain("host.close");
    recovered.resolve();
    await pending;
    await stopping;
    expect(f.events).toContain("host.close");
  });

  it("shares a durable model usage journal outside workspaces and replays it before task dispatch", async () => {
    const f = fixture();
    const runtime = await createInvestigationExecutionRuntime(f.config, logger, f.dependencies);
    expect(f.captured.usageJournal?.directory).toBe("D:\\WorkerData\\model-usage");
    expect(f.captured.model?.usageJournal).toBe(f.usageJournal);
    expect(f.captured.modelEdit?.usageJournal).toBe(f.usageJournal);
    expect(f.replayUsage).toHaveBeenCalledTimes(1);
    expect(f.coordinator.execute).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("shares isolated visible output across analysis, E2E and saved model edits and closes it on shutdown", async () => {
    const f = fixture();
    const runtime = await createInvestigationExecutionRuntime(f.config, logger, f.dependencies);
    expect(f.captured.outputJournal?.directory).toBe("D:\\WorkerData\\visible-output");
    expect(f.captured.outputJournal?.protectedValues).toEqual([f.config.workerToken]);
    expect(f.captured.model?.outputJournal).toBe(f.outputJournal);
    expect(f.captured.modelEdit?.outputJournal).toBe(f.outputJournal);
    expect(f.captured.e2e?.modelOptions.outputJournal).toBe(f.outputJournal);
    expect(f.outputJournal.replay).toHaveBeenCalled();
    const claim = claimFixture();
    await f.captured.service!.executor.execute(claim, new AbortController().signal);
    expect(f.outputJournal.openAttempt).toHaveBeenCalledWith(
      claim.task.id,
      claim.lease,
      expect.any(AbortSignal),
    );
    expect(f.outputJournal.append).toHaveBeenCalledWith(
      claim.task.id,
      claim.attempt.id,
      null,
      expect.objectContaining({ kind: "system", text: "The Worker started this claimed attempt." }),
    );
    expect(f.outputJournal.closeAttempt).toHaveBeenCalledWith(claim.task.id, claim.attempt.id);
    await runtime.stop();
    expect(f.outputJournal.stop).toHaveBeenCalled();
  });

  it.each([false, true])(
    "executes after output initialization times out and ignores late settlement: reject=%s",
    async (reject) => {
      const f = fixture();
      const opening = Promise.withResolvers<void>();
      vi.mocked(f.outputJournal.openAttempt).mockImplementation(() => opening.promise);
      const runtime = await createInvestigationExecutionRuntime(f.config, logger, {
        ...f.dependencies,
        outputInitializationTimeoutMs: 5,
      });
      const claim = claimFixture();
      await f.captured.service!.executor.execute(claim, new AbortController().signal);
      expect(f.coordinator.execute).toHaveBeenCalledTimes(1);
      expect(f.captured.model?.outputInitializationTimeoutMs).toBe(5);
      expect(f.captured.modelEdit?.outputInitializationTimeoutMs).toBe(5);
      expect(f.captured.e2e?.modelOptions.outputInitializationTimeoutMs).toBe(5);
      expect(vi.mocked(f.outputJournal.openAttempt).mock.calls[0]?.[2]?.aborted).toBe(true);
      expect(f.outputJournal.closeAttempt).toHaveBeenCalledWith(claim.task.id, claim.attempt.id);
      if (reject) opening.reject(new Error("Late synthetic output initialization failure"));
      else opening.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(f.outputJournal.append).not.toHaveBeenCalled();
      expect(f.outputJournal.flush).not.toHaveBeenCalled();
      await runtime.stop();
      expect(f.events).toContain("host.close");
    },
  );

  it("cancels pending output initialization before coordinator dispatch and still closes the attempt", async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const opening = Promise.withResolvers<void>();
    vi.mocked(f.outputJournal.openAttempt).mockImplementation(() => {
      entered.resolve();
      return opening.promise;
    });
    const runtime = await createInvestigationExecutionRuntime(f.config, logger, f.dependencies);
    const claim = claimFixture();
    const controller = new AbortController();
    const reason = new Error("Synthetic cancellation during visible output initialization");
    const execution = f.captured.service!.executor.execute(claim, controller.signal);
    const cancelled = expect(execution).rejects.toBe(reason);
    await entered.promise;
    controller.abort(reason);
    await cancelled;
    expect(f.coordinator.execute).not.toHaveBeenCalled();
    expect(vi.mocked(f.outputJournal.openAttempt).mock.calls[0]?.[2]?.aborted).toBe(true);
    expect(f.outputJournal.closeAttempt).toHaveBeenCalledWith(claim.task.id, claim.attempt.id);
    expect(f.outputJournal.append).not.toHaveBeenCalled();
    expect(f.outputJournal.flush).not.toHaveBeenCalled();
    opening.resolve();
    await Promise.resolve();
    await runtime.stop();
    expect(f.events).toContain("host.close");
  });

  it.each(["output", "cleanup-register", "desktop-guard", "execution-started"] as const)(
    "charges %s preparation time against the shared attempt deadline",
    async (stage) => {
      vi.useFakeTimers({ now: new Date("2026-10-02T00:00:00.000Z") });
      const f = fixture();
      const entered = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const waitForPreparation = async () => {
        entered.resolve();
        await released.promise;
      };
      if (stage === "output")
        vi.mocked(f.outputJournal.openAttempt).mockImplementation(waitForPreparation);
      const runtime = await createInvestigationExecutionRuntime(f.config, logger, {
        ...f.dependencies,
        createCleanupJournal: () => ({
          ...f.cleanupJournal,
          async register(input) {
            if (stage === "cleanup-register") await waitForPreparation();
            return f.cleanupJournal.register(input);
          },
          async executionStarted(attemptId) {
            if (stage === "execution-started") await waitForPreparation();
            await f.cleanupJournal.executionStarted(attemptId);
          },
        }),
        acquireDesktopGuard: async () => {
          if (stage === "desktop-guard") await waitForPreparation();
          return desktopGuardFixture(f.events);
        },
      });
      const claim = claimWithConsumedDuration(
        INVESTIGATION_EXECUTION_DURATION_LIMIT_MS - 1_000,
        "pr-e2e",
      );
      const signal = new AbortController().signal;
      const startedAtMs = Date.now();
      f.coordinator.execute.mockImplementation(async (accepted, observedSignal) => {
        expect(accepted).toBe(claim);
        expect(observedSignal).toBe(signal);
        expect(observedSignal.aborted).toBe(false);
        expect(f.captured.coordinator?.executionStartedAtMs).toBe(startedAtMs);
        expect(f.captured.coordinator?.executionDeadlineAtMs).toBe(startedAtMs + 1_000);
        expect(f.captured.coordinator!.executionDeadlineAtMs! - Date.now()).toBe(800);
        await f.captured.coordinator!.onAttemptCleanupConfirmed!();
      });
      const execution = f.captured.service!.executor.execute(claim, signal);
      try {
        await entered.promise;
        expect(f.coordinator.execute).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(200);
        released.resolve();
        await execution;
        expect(f.coordinator.execute).toHaveBeenCalledOnce();
        expect(f.outputJournal.closeAttempt).toHaveBeenCalledWith(claim.task.id, claim.attempt.id);
        expect(f.cleanupJournal.localCleanupConfirmed).toHaveBeenCalledWith(claim.attempt.id);
        expect(f.cleanupJournal.guardReleased).toHaveBeenCalledWith(claim.attempt.id);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        released.resolve();
        try {
          await execution.catch(() => undefined);
          await runtime.stop();
        } finally {
          vi.useRealTimers();
        }
      }
    },
  );

  it("dispatches terminal coordination after the shared deadline expires during output initialization", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-02T00:00:00.000Z") });
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const opening = Promise.withResolvers<void>();
    vi.mocked(f.outputJournal.openAttempt).mockImplementation(() => {
      entered.resolve();
      return opening.promise;
    });
    const executeModel = vi.fn(never);
    const runtime = await createInvestigationExecutionRuntime(f.config, logger, {
      ...f.dependencies,
      createModelTurnRunner: (options) => {
        f.captured.model = options;
        return { execute: executeModel };
      },
    });
    const claim = claimWithConsumedDuration(INVESTIGATION_EXECUTION_DURATION_LIMIT_MS - 100);
    const signal = new AbortController().signal;
    const startedAtMs = Date.now();
    f.coordinator.execute.mockImplementation(async (accepted, observedSignal) => {
      expect(accepted).toBe(claim);
      expect(observedSignal).toBe(signal);
      expect(observedSignal.aborted).toBe(false);
      expect(f.captured.coordinator?.executionStartedAtMs).toBe(startedAtMs);
      expect(f.captured.coordinator?.executionDeadlineAtMs).toBe(startedAtMs + 100);
      expect(f.captured.coordinator!.executionDeadlineAtMs).toBeLessThanOrEqual(Date.now());
    });
    const execution = f.captured.service!.executor.execute(claim, signal);
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(99);
      expect(f.coordinator.execute).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await execution;
      expect(f.coordinator.execute).toHaveBeenCalledOnce();
      expect(executeModel).not.toHaveBeenCalled();
      expect(vi.mocked(f.outputJournal.openAttempt).mock.calls[0]?.[2]?.reason).toMatchObject({
        name: "ModelBudgetExceededError",
        kind: "duration",
      });
      expect(f.outputJournal.closeAttempt).toHaveBeenCalledWith(claim.task.id, claim.attempt.id);
      expect(f.outputJournal.append).not.toHaveBeenCalled();
      expect(f.outputJournal.flush).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      opening.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(f.outputJournal.append).not.toHaveBeenCalled();
    } finally {
      opening.resolve();
      try {
        await execution.catch(() => undefined);
        await runtime.stop();
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it.each(["cleanup-register", "execution-started"] as const)(
    "seals an expired attempt without waiting for a pending %s record",
    async (stage) => {
      vi.useFakeTimers({ now: new Date("2026-10-02T00:00:00.000Z") });
      const f = fixture();
      const entered = Promise.withResolvers<void>();
      const recorded = Promise.withResolvers<void>();
      const lateCleanupRecorded = Promise.withResolvers<void>();
      const guard = desktopGuardFixture(f.events);
      const acquireDesktopGuard = vi.fn(async () => guard);
      const releaseGuard = vi.fn(async () => {});
      const cleanupWorkspace = vi.fn(async () => {});
      const executeModel = vi.fn(never);
      vi.mocked(f.cleanupJournal.guardReleased).mockImplementation(async () => {
        lateCleanupRecorded.resolve();
      });
      const runtime = await createInvestigationExecutionRuntime(f.config, logger, {
        ...f.dependencies,
        acquireDesktopGuard,
        createCleanupJournal: () => ({
          ...f.cleanupJournal,
          async register(input) {
            if (stage === "cleanup-register") {
              entered.resolve();
              await recorded.promise;
            }
            return f.cleanupJournal.register(input);
          },
          async executionStarted(attemptId) {
            if (stage === "execution-started") {
              entered.resolve();
              await recorded.promise;
            }
            await f.cleanupJournal.executionStarted(attemptId);
          },
        }),
        createCleanupRecoveryOperations: () => ({
          acquireGuard: never,
          cleanupWorkspace,
          releaseGuard,
        }),
        createModelTurnRunner: () => ({ execute: executeModel }),
        createE2eAgentRunner: () => ({ execute: executeModel }),
      });
      const claim = claimWithConsumedDuration(
        INVESTIGATION_EXECUTION_DURATION_LIMIT_MS - 100,
        "pr-e2e",
      );
      const signal = new AbortController().signal;
      const startedAtMs = Date.now();
      f.coordinator.execute.mockImplementation(async (accepted, observedSignal) => {
        expect(accepted).toBe(claim);
        expect(observedSignal).toBe(signal);
        expect(observedSignal.aborted).toBe(false);
        expect(f.captured.coordinator?.executionStartedAtMs).toBe(startedAtMs);
        expect(f.captured.coordinator?.executionDeadlineAtMs).toBe(startedAtMs + 100);
        expect(f.captured.coordinator!.executionDeadlineAtMs).toBeLessThanOrEqual(Date.now());
        await f.captured.coordinator!.onAttemptCleanupConfirmed?.();
      });
      const execution = f.captured.service!.executor.execute(claim, signal);
      try {
        await entered.promise;
        await vi.advanceTimersByTimeAsync(99);
        expect(f.coordinator.execute).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await execution;
        expect(f.coordinator.execute).toHaveBeenCalledOnce();
        expect(f.outputJournal.closeAttempt).toHaveBeenCalledWith(claim.task.id, claim.attempt.id);
        expect(f.cleanupJournal.localCleanupConfirmed).not.toHaveBeenCalled();
        expect(f.cleanupJournal.guardReleased).not.toHaveBeenCalled();
        expect(f.cleanupJournal.acknowledged).not.toHaveBeenCalled();
        expect(executeModel).not.toHaveBeenCalled();
        expect(cleanupWorkspace).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        if (stage === "cleanup-register") {
          expect(acquireDesktopGuard).not.toHaveBeenCalled();
          expect(releaseGuard).not.toHaveBeenCalled();
          expect(f.cleanupJournal.executionStarted).not.toHaveBeenCalled();
        } else {
          expect(acquireDesktopGuard).toHaveBeenCalledOnce();
          expect(releaseGuard).toHaveBeenCalledOnce();
          expect(guard.state).toBe("released");
        }
        recorded.resolve();
        await lateCleanupRecorded.promise;
        expect(f.cleanupJournal.localCleanupConfirmed).toHaveBeenCalledExactlyOnceWith(
          claim.attempt.id,
        );
        expect(f.cleanupJournal.guardReleased).toHaveBeenCalledExactlyOnceWith(claim.attempt.id);
        expect(f.cleanupJournal.acknowledged).not.toHaveBeenCalled();
        expect(f.coordinator.execute).toHaveBeenCalledOnce();
        expect(executeModel).not.toHaveBeenCalled();
        expect(acquireDesktopGuard).toHaveBeenCalledTimes(stage === "cleanup-register" ? 0 : 1);
        expect(releaseGuard).toHaveBeenCalledTimes(stage === "cleanup-register" ? 0 : 1);
      } finally {
        recorded.resolve();
        try {
          await execution.catch(() => undefined);
          await runtime.stop();
        } finally {
          vi.useRealTimers();
        }
      }
    },
  );

  it("releases an owned guard marker before coordinating an expired acquisition", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-02T00:00:00.000Z") });
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const executeModel = vi.fn(never);
    const acquireGuard = vi.fn(never);
    const cleanupWorkspace = vi.fn(async () => {});
    const releaseGuard = vi.fn(async () => {
      f.events.push("guard.marker.release");
    });
    let acquisitionSignal: AbortSignal | undefined;
    const acquireDesktopGuard = vi.fn<
      NonNullable<InvestigationRuntimeDependencies["acquireDesktopGuard"]>
    >(async (options) => {
      acquisitionSignal = options.signal;
      options.signal!.throwIfAborted();
      entered.resolve();
      await new Promise<void>((_resolve, reject) => {
        options.signal!.addEventListener("abort", () => reject(options.signal!.reason), {
          once: true,
        });
      });
      throw new Error("An aborted guard acquisition cannot return a held guard.");
    });
    const runtime = await createInvestigationExecutionRuntime(f.config, logger, {
      ...f.dependencies,
      acquireDesktopGuard,
      createCleanupRecoveryOperations: () => ({ acquireGuard, cleanupWorkspace, releaseGuard }),
      createModelTurnRunner: () => ({ execute: executeModel }),
      createE2eAgentRunner: () => ({ execute: executeModel }),
    });
    const claim = claimWithConsumedDuration(
      INVESTIGATION_EXECUTION_DURATION_LIMIT_MS - 100,
      "pr-e2e",
    );
    const signal = new AbortController().signal;
    const startedAtMs = Date.now();
    f.coordinator.execute.mockImplementation(async (accepted, observedSignal) => {
      expect(accepted).toBe(claim);
      expect(observedSignal).toBe(signal);
      expect(observedSignal.aborted).toBe(false);
      expect(f.captured.coordinator?.executionDeadlineAtMs).toBe(startedAtMs + 100);
      expect(f.captured.coordinator!.executionDeadlineAtMs).toBeLessThanOrEqual(Date.now());
      expect(releaseGuard).toHaveBeenCalledOnce();
      f.events.push("coordinator.expired");
      await f.captured.coordinator!.onAttemptCleanupConfirmed!();
    });
    const execution = f.captured.service!.executor.execute(claim, signal);
    try {
      await entered.promise;
      expect(acquisitionSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(99);
      expect(releaseGuard).not.toHaveBeenCalled();
      expect(f.coordinator.execute).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await execution;
      expect(acquisitionSignal?.reason).toMatchObject({
        name: "ModelBudgetExceededError",
        kind: "duration",
      });
      expect(releaseGuard).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ attemptId: claim.attempt.id }),
      );
      expect(f.events).toEqual([
        "directories.prepare",
        "guard.marker.release",
        "coordinator.expired",
      ]);
      expect(f.coordinator.execute).toHaveBeenCalledOnce();
      expect(f.cleanupJournal.localCleanupConfirmed).toHaveBeenCalledWith(claim.attempt.id);
      expect(f.cleanupJournal.guardReleased).toHaveBeenCalledWith(claim.attempt.id);
      expect(f.cleanupJournal.executionStarted).not.toHaveBeenCalled();
      expect(f.cleanupJournal.acknowledged).not.toHaveBeenCalled();
      expect(executeModel).not.toHaveBeenCalled();
      expect(acquireGuard).not.toHaveBeenCalled();
      expect(cleanupWorkspace).not.toHaveBeenCalled();
      expect(f.outputJournal.closeAttempt).toHaveBeenCalledWith(claim.task.id, claim.attempt.id);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      try {
        await vi.advanceTimersByTimeAsync(100);
        await execution.catch(() => undefined);
        await runtime.stop();
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("reports permanent output delivery failures using only the journal's bounded diagnostic", async () => {
    const f = fixture();
    const error = vi.fn();
    const runtime = await createInvestigationExecutionRuntime(
      f.config,
      { ...logger, error },
      f.dependencies,
    );
    const claim = claimFixture();
    for (const code of ["output_lease_lost", "output_archive_capacity"] as const)
      f.captured.outputJournal?.onTerminalFailure?.({
        taskId: claim.task.id,
        attemptId: claim.attempt.id,
        code,
      });
    expect(error.mock.calls).toEqual(
      ["output_lease_lost", "output_archive_capacity"].map((code) => [
        "Visible output delivery permanently stopped for this attempt.",
        { taskId: claim.task.id, attemptId: claim.attempt.id, code },
      ]),
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain(f.config.workerToken);
    expect(JSON.stringify(error.mock.calls)).not.toContain(claim.lease.leaseToken);
    await runtime.stop();
  });

  it("delivers terminal accounting with its retained original lease and rejects an absent lease", async () => {
    const f = fixture();
    const claim = claimFixture();
    const receipt: InvestigationModelInvocationReceipt = {
      invocationId: "retained-invocation",
      taskId: claim.task.id,
      attemptId: claim.attempt.id,
      purpose: "analysis",
      engine: "codex",
      model: null,
      startedAt: "2026-09-19T00:00:00.000Z",
      updatedAt: "2026-09-19T00:01:00.000Z",
      revision: 3,
      state: "cancelled",
      disposition: "rejected",
      completeness: "partial",
      usage: { ...unavailableInvestigationTokenUsage(), totalTokens: 15 },
    };
    const acknowledgement = { invocationId: receipt.invocationId, revision: receipt.revision };
    f.client.modelUsage = vi.fn(async () => acknowledgement);
    const runtime = await createInvestigationExecutionRuntime(f.config, logger, f.dependencies);
    await expect(f.captured.usageJournal!.deliver!(receipt, claim.lease)).resolves.toEqual(
      acknowledgement,
    );
    expect(f.client.modelUsage).toHaveBeenCalledWith(
      claim.task.id,
      { lease: claim.lease, receipt },
      expect.any(AbortSignal),
    );
    await expect(f.captured.usageJournal!.deliver!(receipt, undefined)).rejects.toThrow(
      /delivery context/u,
    );
    expect(f.client.modelUsage).toHaveBeenCalledTimes(1);
    await runtime.stop();
  });

  it("retries accounting on heartbeats without delaying renewal or duplicating an in-flight replay", async () => {
    const f = fixture();
    const claim = claimFixture();
    const response = {
      cancelRequested: true,
      serverTime: "2026-09-19T00:00:00.000Z",
      leaseExpiresAt: "2026-09-19T00:01:00.000Z",
    };
    f.client.heartbeat = vi.fn(async () => response);
    const runtime = await createInvestigationExecutionRuntime(f.config, logger, f.dependencies);
    const pending = Promise.withResolvers<void>();
    f.replayUsage.mockImplementationOnce(() => pending.promise);
    const client = f.captured.service!.client;
    await expect(client.heartbeat(claim.task.id, { lease: claim.lease })).resolves.toEqual(
      response,
    );
    await expect(client.heartbeat(claim.task.id, { lease: claim.lease })).resolves.toEqual(
      response,
    );
    expect(f.replayUsage).toHaveBeenCalledTimes(2);
    expect(f.coordinator.execute).not.toHaveBeenCalled();
    pending.resolve();
    await runtime.stop();
  });

  it("retries terminal accounting during idle claim polling without replaying on a failed poll", async () => {
    const f = fixture();
    const claim = vi.fn<InvestigationWorkerClient["claim"]>().mockResolvedValue(null);
    f.client.claim = claim;
    const runtime = await createInvestigationExecutionRuntime(f.config, logger, f.dependencies);
    const pending = Promise.withResolvers<void>();
    f.replayUsage.mockImplementationOnce(() => pending.promise);
    const client = f.captured.service!.client;
    await expect(client.claim({ supportedKinds: ["issue-investigate"] })).resolves.toBeNull();
    await expect(client.claim({ supportedKinds: ["issue-investigate"] })).resolves.toBeNull();
    expect(f.replayUsage).toHaveBeenCalledTimes(2);
    claim.mockRejectedValueOnce(new Error("Synthetic claim transport failure."));
    await expect(client.claim({ supportedKinds: ["issue-investigate"] })).rejects.toThrow(
      /claim transport/u,
    );
    expect(f.replayUsage).toHaveBeenCalledTimes(2);
    expect(f.coordinator.execute).not.toHaveBeenCalled();
    pending.resolve();
    await runtime.stop();
  });

  it("retains failed startup replay for the next heartbeat without logging private delivery errors", async () => {
    const f = fixture();
    const claim = claimFixture();
    const warning = vi.fn();
    f.replayUsage.mockRejectedValueOnce(
      new Error(`Private retained lease: ${claim.lease.leaseToken}`),
    );
    f.client.heartbeat = vi.fn(async () => ({
      cancelRequested: false,
      serverTime: "2026-09-19T00:00:00.000Z",
      leaseExpiresAt: "2026-09-19T00:01:00.000Z",
    }));
    const runtime = await createInvestigationExecutionRuntime(
      f.config,
      { ...logger, warn: warning },
      f.dependencies,
    );
    await f.captured.service!.client.heartbeat(claim.task.id, { lease: claim.lease });
    expect(f.replayUsage).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warning.mock.calls)).not.toContain(claim.lease.leaseToken);
    await runtime.stop();
  });

  it("rejects a journal location inside disposable workspace storage", async () => {
    const f = fixture();
    await expect(
      createInvestigationExecutionRuntime(
        { ...f.config, workspaceRootDirectory: f.config.dataDirectory },
        logger,
        f.dependencies,
      ),
    ).rejects.toThrow(/outside disposable workspaces/u);
    expect(f.events).toEqual([]);
  });

  it("drains the native task service before closing the real process-host boundary, once", async () => {
    const f = fixture();
    const runtime = await createInvestigationExecutionRuntime(f.config, logger, f.dependencies);
    await runtime.run();
    await runtime.stop();
    expect(f.events).toEqual(["directories.prepare", "service.run", "service.stop", "host.close"]);
  });

  it("passes the service token only to HTTP authentication and model redaction, never child environments", async () => {
    const f = fixture();
    const runtime = await createInvestigationExecutionRuntime(f.config, logger, f.dependencies);
    expect(JSON.stringify(f.captured.host?.hostEnvironment)).not.toContain(f.config.workerToken);
    expect(JSON.stringify(f.captured.model?.environment)).not.toContain(f.config.workerToken);
    expect(f.captured.model?.protectedValues).toContain(f.config.workerToken);
    expect(f.captured.host?.maximumConcurrentRequests).toBe(8);
    expect(f.captured.e2e?.modelOptions.usageJournal).toBe(f.usageJournal);
    expect(JSON.stringify(f.captured.e2e?.environment)).not.toContain(f.config.workerToken);
    expect(f.captured.e2e?.powershellExecutablePath).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(f.captured.service?.supportedKinds).toContain("issue-investigate");
    expect(f.captured.service?.maximumConcurrentStaticTasks).toBe(1);
    expect(f.captured.service?.role).toBe("all");
    await runtime.stop();
  });

  it.each([
    { role: "all", expected: 12 },
    { role: "static", expected: 6 },
    { role: "e2e", expected: 6 },
  ] as const)(
    "allocates process capacity for the $role Worker role",
    async ({ role, expected }) => {
      const f = fixture();
      const runtime = await createInvestigationExecutionRuntime(
        { ...f.config, role, maximumConcurrentStaticTasks: 3 },
        logger,
        f.dependencies,
      );
      expect(f.captured.host?.maximumConcurrentRequests).toBe(expected);
      expect(f.captured.service?.maximumConcurrentStaticTasks).toBe(3);
      expect(f.captured.service?.role).toBe(role);
      await runtime.stop();
    },
  );

  it("constructs an independent source adapter for the exact claim without making legacy job envelopes", async () => {
    const f = fixture();
    const runtime = await createInvestigationExecutionRuntime(f.config, logger, f.dependencies);
    const claim = claimFixture();
    const signal = new AbortController().signal;
    await f.captured.service!.executor.execute(claim, signal);
    expect(f.coordinator.execute).toHaveBeenCalledWith(claim, signal);
    expect(f.captured.source?.gitExecutablePath).toBe(f.config.git.path);
    expect(f.captured.source?.allowedRepositories).toEqual(["moooyo/PowerToys"]);
    expect(JSON.stringify(f.captured.source?.environment)).not.toContain(f.config.workerToken);
    await runtime.stop();
  });

  it.each(["pr-review", "issue-investigate"] as const)(
    "does not acquire the machine desktop guard for %s",
    async (kind) => {
      const f = fixture();
      const acquireDesktopGuard = vi.fn(never);
      const runtime = await createInvestigationExecutionRuntime(f.config, logger, {
        ...f.dependencies,
        acquireDesktopGuard,
      });
      const original = claimFixture();
      await f.captured.service!.executor.execute(
        { ...original, task: { ...original.task, kind } },
        new AbortController().signal,
      );
      expect(acquireDesktopGuard).not.toHaveBeenCalled();
      expect(f.captured.coordinator?.onAttemptCleanupConfirmed).toBeUndefined();
      await runtime.stop();
    },
  );

  it.each([
    "pr-e2e",
    "pr-verify",
    "issue-verify",
    "reproduction-setup",
    "issue-fix",
    "feature-implement",
  ] as const)("holds the machine desktop guard for the entire %s attempt", async (kind) => {
    const f = fixture();
    const guard = desktopGuardFixture(f.events);
    const acquireDesktopGuard = vi.fn(async () => {
      f.events.push("guard.acquire");
      return guard;
    });
    f.coordinator.execute.mockImplementation(async () => {
      f.events.push("coordinator.execute", "cleanup.local");
      await f.captured.coordinator!.onAttemptCleanupConfirmed!();
      f.events.push("cleanup.server");
    });
    const runtime = await createInvestigationExecutionRuntime(f.config, logger, {
      ...f.dependencies,
      acquireDesktopGuard,
      createSourceMaterializer: (options) => {
        f.events.push("source.create");
        return f.dependencies.createSourceMaterializer!(options);
      },
      createWorkspaceProvider: (options) => {
        f.events.push("workspace.create");
        return f.dependencies.createWorkspaceProvider!(options);
      },
    });
    const original = claimFixture();
    const claim = { ...original, task: { ...original.task, kind } };
    await f.captured.service!.executor.execute(claim, new AbortController().signal);
    expect(acquireDesktopGuard).toHaveBeenCalledWith({
      lockDirectory: f.config.desktopLockDirectory,
      ownerId: `${claim.attempt.id}:${claim.lease.fence}`,
      ownerToken: "12345678-1234-1234-1234-123456789abc",
      signal: expect.any(AbortSignal),
    });
    expect(f.events).toEqual([
      "directories.prepare",
      "guard.acquire",
      "source.create",
      "workspace.create",
      "coordinator.execute",
      "cleanup.local",
      "guard.release",
      "cleanup.server",
    ]);
    await runtime.stop();
  });

  it("quarantines an execution attempt when its coordinator omits cleanup confirmation", async () => {
    const f = fixture();
    const guard = desktopGuardFixture(f.events);
    const runtime = await createInvestigationExecutionRuntime(f.config, logger, {
      ...f.dependencies,
      acquireDesktopGuard: async () => guard,
    });
    const original = claimFixture();
    await expect(
      f.captured.service!.executor.execute(
        { ...original, task: { ...original.task, kind: "pr-e2e" } },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "DESKTOP_ATTEMPT_CLEANUP_UNCONFIRMED" });
    expect(guard.state).toBe("quarantined");
    expect(f.events).toContain("guard.quarantine");
    await runtime.stop();
  });

  it("does not construct an execution workspace when another process holds the machine guard", async () => {
    const f = fixture();
    const runtime = await createInvestigationExecutionRuntime(f.config, logger, {
      ...f.dependencies,
      acquireDesktopGuard: async () => {
        throw new Error("Synthetic existing execution guard.");
      },
    });
    const original = claimFixture();
    await expect(
      f.captured.service!.executor.execute(
        { ...original, task: { ...original.task, kind: "pr-e2e" } },
        new AbortController().signal,
      ),
    ).rejects.toThrow("existing execution guard");
    expect(f.captured.source).toBeUndefined();
    expect(f.coordinator.execute).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("rejects a node lifecycle fault after the active attempt and process host stop", async () => {
    const f = fixture();
    const claim = vi
      .fn<InvestigationWorkerClient["claim"]>()
      .mockResolvedValueOnce(claimFixture())
      .mockResolvedValue(null);
    f.coordinator.execute.mockImplementation(async () => {
      f.captured.coordinator!.onNodeFault!("MODEL_PROCESS_CLEANUP_UNCONFIRMED");
      await Promise.resolve();
      f.events.push("coordinator.terminal.cleanup");
    });
    const runtime = await createInvestigationExecutionRuntime(f.config, logger, {
      ...f.dependencies,
      createClient: () => ({ ...f.client, claim }),
      createTaskService: (options) => new InvestigationTaskService(options),
    });
    await expect(runtime.run()).rejects.toThrow("MODEL_PROCESS_CLEANUP_UNCONFIRMED");
    await runtime.stop();
    expect(claim).toHaveBeenCalledTimes(2);
    expect(f.events).toEqual(["directories.prepare", "coordinator.terminal.cleanup", "host.close"]);
  });

  it("drains a node lifecycle fault without aborting the other active pool", async () => {
    const f = fixture();
    const first = claimFixture();
    const second: ClaimedInvestigationTask = {
      ...claimFixture(),
      task: { ...first.task, id: "peer-task", kind: "pr-verify" },
      attempt: { ...first.attempt, id: "peer-attempt", taskId: "peer-task" },
      lease: { ...first.lease, attemptId: "peer-attempt" },
    };
    const claim = vi
      .fn<InvestigationWorkerClient["claim"]>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValue(null);
    const peerStarted = Promise.withResolvers<void>();
    const faultObserved = Promise.withResolvers<void>();
    const finishPeer = Promise.withResolvers<void>();
    let peerSignal: AbortSignal | undefined;
    const runtime = await createInvestigationExecutionRuntime(f.config, logger, {
      ...f.dependencies,
      createClient: () => ({ ...f.client, claim }),
      createTaskService: (options) => new InvestigationTaskService(options),
      createCoordinator: (options) => ({
        execute: async (accepted, signal) => {
          if (accepted.attempt.id === first.attempt.id) {
            await peerStarted.promise;
            options.onNodeFault!("MODEL_PROCESS_CLEANUP_UNCONFIRMED");
            f.events.push("faulting.cleanup");
            faultObserved.resolve();
          } else {
            peerSignal = signal;
            peerStarted.resolve();
            await finishPeer.promise;
            f.events.push("peer.cleanup");
            await options.onAttemptCleanupConfirmed?.();
          }
        },
      }),
    });
    const running = runtime.run().catch((error: unknown) => {
      f.events.push("run.rejected");
      return error;
    });
    await faultObserved.promise;
    expect(peerSignal?.aborted).toBe(false);
    expect(f.events).toEqual(["directories.prepare", "faulting.cleanup"]);
    finishPeer.resolve();
    expect(await running).toMatchObject({
      message: expect.stringContaining("MODEL_PROCESS_CLEANUP_UNCONFIRMED"),
    });
    expect(f.events).toEqual([
      "directories.prepare",
      "faulting.cleanup",
      "peer.cleanup",
      "host.close",
      "run.rejected",
    ]);
    expect(claim).toHaveBeenCalledTimes(2);
  });

  it("rejects a terminal submission failure and still closes the process host exactly once", async () => {
    const f = fixture();
    const claim = vi
      .fn<InvestigationWorkerClient["claim"]>()
      .mockResolvedValueOnce(claimFixture())
      .mockResolvedValue(null);
    f.coordinator.execute.mockImplementation(async () => {
      throw new Error("Synthetic sensitive upstream response.");
    });
    const runtime = await createInvestigationExecutionRuntime(f.config, logger, {
      ...f.dependencies,
      createClient: () => ({ ...f.client, claim }),
      createTaskService: (options) => new InvestigationTaskService(options),
    });
    await expect(runtime.run()).rejects.toThrow(/terminal submission/);
    await expect(runtime.stop()).rejects.toThrow(/terminal submission/);
    expect(claim).toHaveBeenCalledTimes(2);
    expect(f.events).toEqual(["directories.prepare", "host.close"]);
  });

  it("closes ProcessHost when a dependent runtime factory fails during startup", async () => {
    const f = fixture();
    await expect(
      createInvestigationExecutionRuntime(f.config, logger, {
        ...f.dependencies,
        createPlanExecutor: () => {
          throw new Error("Synthetic startup failure.");
        },
      }),
    ).rejects.toThrow("Synthetic startup failure");
    expect(f.events).toEqual(["directories.prepare", "host.close"]);
  });

  it("does not start directories or processes before static model policy is confirmed", async () => {
    const f = fixture();
    await expect(
      createInvestigationExecutionRuntime(
        { ...f.config, modelStaticConfiguration: { verified: false, disabledMcpServers: [] } },
        logger,
        f.dependencies,
      ),
    ).rejects.toThrow(/verify/);
    expect(f.events).toEqual([]);
  });
});
