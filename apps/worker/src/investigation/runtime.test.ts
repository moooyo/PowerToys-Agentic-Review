import { createInvestigationPreview as createInvestigationFixture } from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import type { StdioProcessHostClientOptions } from "../execution/process-host-client.js";
import type { Logger } from "../logging/logger.js";
import type { InvestigationGitSourceOptions } from "./git-source.js";
import type { InvestigationWorkerClient } from "./http-client.js";
import type { InvestigationLoopCoordinatorOptions } from "./loop-coordinator.js";
import type { ModelTurnRunnerOptions } from "./model-turn-runner.js";
import {
  createInvestigationExecutionRuntime,
  type InvestigationRuntimeDependencies,
} from "./runtime.js";
import { loadInvestigationWorkerRuntimeConfig } from "./runtime-config.js";
import {
  type ClaimedInvestigationTask,
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
  } = {};
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
    execute: vi.fn(async () => {
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
    createProcessHost: async (options) => {
      captured.host = options;
      return host;
    },
    createModelTurnRunner: (options) => {
      captured.model = options;
      return { execute: never };
    },
    createModelEditAdapter: () => ({ execute: never }),
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
  return { config, events, client, captured, host, coordinator, service, dependencies };
}

describe("production investigation runtime composition", () => {
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
    expect(f.captured.host?.maximumConcurrentRequests).toBe(2);
    expect(f.captured.service?.supportedKinds).toContain("issue-investigate");
    await runtime.stop();
  });

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

  it("rejects a node lifecycle fault after the active attempt and process host stop", async () => {
    const f = fixture();
    const claim = vi.fn(async () => claimFixture());
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
    expect(claim).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual(["directories.prepare", "coordinator.terminal.cleanup", "host.close"]);
  });

  it("rejects a terminal submission failure and still closes the process host exactly once", async () => {
    const f = fixture();
    const claim = vi.fn(async () => claimFixture());
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
    expect(claim).toHaveBeenCalledTimes(1);
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
