import {
  createInvestigationPreview as createInvestigationFixture,
  type InvestigationModelInvocationReceipt,
  unavailableInvestigationTokenUsage,
} from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import type { StdioProcessHostClientOptions } from "../execution/process-host-client.js";
import type { Logger } from "../logging/logger.js";
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
    cleanupJournal?: AttemptCleanupJournalOptions;
  } = {};
  const replayUsage = vi.fn(async () => {});
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
    createModelEditAdapter: (options) => {
      captured.modelEdit = options;
      return { execute: never };
    },
    createPlanExecutor: () => ({ execute: never }),
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
    service,
    dependencies,
    usageJournal,
    replayUsage,
    cleanupJournal,
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
