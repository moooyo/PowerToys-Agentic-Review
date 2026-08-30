import type {
  ClaimLeaseResponse,
  JobExecutionEnvelope,
  RunCompletionSubmission,
  RunFailureSubmission,
  WorkerHeartbeatResponse,
  WorkerRegistrationResponse,
} from "@agentic-review/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerConfig } from "./config.js";
import type { JobExecutor } from "./execution/job-executor.js";
import type { ProcessHostClient } from "./execution/process-host-protocol.js";
import type { Logger } from "./logging/logger.js";
import { WorkerApiError } from "./server-client/errors.js";
import type { WorkerApi } from "./server-client/worker-api.js";
import { WorkerService } from "./worker-service.js";

vi.mock("node:fs/promises", () => ({
  statfs: vi.fn(async () => ({ bavail: 1_000, bsize: 4_096 })),
}));

const baseTime = Date.parse("2026-08-30T00:00:00.000Z");
const digest = "0".repeat(64);

class FakeWorkerApi implements WorkerApi {
  public registerHandler: WorkerApi["register"] = async () => createRegistration();
  public claimHandler: WorkerApi["claimLease"] = async () => createNoWorkResponse();
  public heartbeatHandler: WorkerApi["heartbeat"] = async () => createHeartbeatResponse();
  public completeHandler: WorkerApi["completeRun"] = async () => undefined;
  public failHandler: WorkerApi["failRun"] = async () => undefined;

  public register: WorkerApi["register"] = (request, signal) =>
    this.registerHandler(request, signal);

  public claimLease: WorkerApi["claimLease"] = (request, signal) =>
    this.claimHandler(request, signal);

  public heartbeat: WorkerApi["heartbeat"] = (workerInstanceId, request, signal) =>
    this.heartbeatHandler(workerInstanceId, request, signal);

  public completeRun: WorkerApi["completeRun"] = (runAttemptId, submission, signal) =>
    this.completeHandler(runAttemptId, submission, signal);

  public failRun: WorkerApi["failRun"] = (runAttemptId, submission, signal) =>
    this.failHandler(runAttemptId, submission, signal);
}

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const processHost: ProcessHostClient = {
  start: async () => {
    throw new Error("ProcessHost start was not expected in this test.");
  },
  terminateAll: async () => undefined,
  close: async () => undefined,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("WorkerService registration recovery", () => {
  it("serializes claim and heartbeat recovery behind retry backoff", async () => {
    useFakeTime();
    const api = new FakeWorkerApi();
    let workerInstanceId = "";
    let registrationCalls = 0;
    let claimCalls = 0;
    let heartbeatCalls = 0;

    api.registerHandler = async (request) => {
      workerInstanceId = request.workerInstanceId;
      registrationCalls += 1;
      if (registrationCalls === 2) {
        throw new Error("temporary registration network error");
      }
      return createRegistration();
    };
    api.claimHandler = async () => {
      claimCalls += 1;
      if (claimCalls === 1) {
        return {
          outcome: "worker_unavailable",
          serverTime: nowIso(),
          reason: "not_registered",
        };
      }
      return createNoWorkResponse();
    };
    api.heartbeatHandler = async () => {
      heartbeatCalls += 1;
      if (heartbeatCalls === 1) {
        throw new WorkerApiError("worker registration is missing", 409, "worker_unavailable");
      }
      return createHeartbeatResponse();
    };

    const service = new WorkerService(
      createConfig(),
      api,
      createImmediateExecutor(),
      processHost,
      logger,
    );
    const runPromise = service.run();

    await waitFor(() => registrationCalls === 2 && heartbeatCalls === 1);
    expect(workerInstanceId).not.toBe("");
    await vi.advanceTimersByTimeAsync(999);
    await flushAsyncWork();
    expect(registrationCalls).toBe(2);

    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() => registrationCalls === 3);
    expect(registrationCalls).toBe(3);

    await service.stop("test_complete");
    await runPromise;
  });
});

describe("WorkerService terminal reporting", () => {
  it("acknowledges cancellation when the executor returns normally and retries the same payload", async () => {
    useFakeTime();
    const api = new FakeWorkerApi();
    let workerInstanceId = "";
    let claimCalls = 0;
    let executionSignal: AbortSignal | undefined;
    let resolveExecution:
      | ((result: Awaited<ReturnType<JobExecutor["execute"]>>) => void)
      | undefined;
    const failSubmissions: RunFailureSubmission[] = [];

    api.registerHandler = async (request) => {
      workerInstanceId = request.workerInstanceId;
      return createRegistration();
    };
    api.claimHandler = async () => {
      claimCalls += 1;
      return claimCalls === 1
        ? createGrantedResponse(createEnvelope(workerInstanceId, { leaseBudgetMs: 10_000 }))
        : createNoWorkResponse();
    };
    api.heartbeatHandler = async (_instanceId, request) => ({
      ...createHeartbeatResponse(),
      commands: request.activeLeases.map((lease) => ({
        runAttemptId: lease.runAttemptId,
        leaseGeneration: lease.leaseGeneration,
        action: "cancel" as const,
        leaseExpiresAt: new Date(Date.now() + 5_000).toISOString(),
        reasonCode: "requested_by_user",
      })),
    });
    api.failHandler = async (_runAttemptId, submission) => {
      failSubmissions.push(submission);
      if (failSubmissions.length === 1) {
        throw new Error("temporary terminal network error");
      }
    };
    const executor: JobExecutor = {
      execute: async (_envelope, context) => {
        executionSignal = context.signal;
        return await new Promise((resolve) => {
          resolveExecution = resolve;
        });
      },
    };

    const service = new WorkerService(createConfig(), api, executor, processHost, logger);
    const runPromise = service.run();
    await waitFor(() => executionSignal !== undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    await waitFor(() => executionSignal?.aborted === true);

    resolveExecution?.({ outcome: "succeeded", resultDigest: digest, result: { ok: true } });
    await waitFor(() => failSubmissions.length === 1);
    await vi.advanceTimersByTimeAsync(250);
    await waitFor(() => failSubmissions.length === 2);

    expect(failSubmissions[0]).toBe(failSubmissions[1]);
    expect(failSubmissions[0]).toMatchObject({
      code: "CANCELLED_BY_SERVER",
      retryable: false,
    });

    await service.stop("test_complete");
    await runPromise;
  });

  it("retries completion only while the lease remains authoritative", async () => {
    useFakeTime();
    const api = new FakeWorkerApi();
    let workerInstanceId = "";
    let claimCalls = 0;
    const completionSubmissions: RunCompletionSubmission[] = [];

    api.registerHandler = async (request) => {
      workerInstanceId = request.workerInstanceId;
      return createRegistration();
    };
    api.claimHandler = async () => {
      claimCalls += 1;
      return claimCalls === 1
        ? createGrantedResponse(createEnvelope(workerInstanceId, { leaseBudgetMs: 400 }))
        : createNoWorkResponse();
    };
    api.completeHandler = async (_runAttemptId, submission) => {
      completionSubmissions.push(submission);
      throw new Error("temporary terminal network error");
    };

    const service = new WorkerService(
      createConfig(),
      api,
      createImmediateExecutor(),
      processHost,
      logger,
    );
    const runPromise = service.run();
    await waitFor(() => completionSubmissions.length === 1);

    await vi.advanceTimersByTimeAsync(250);
    await waitFor(() => completionSubmissions.length === 2);
    await vi.advanceTimersByTimeAsync(500);
    await flushAsyncWork();

    expect(completionSubmissions).toHaveLength(2);
    expect(completionSubmissions[0]).toBe(completionSubmissions[1]);

    await service.stop("test_complete");
    await runPromise;
  });

  it("does not retry a terminal submission after authoritative lease loss", async () => {
    useFakeTime();
    const api = new FakeWorkerApi();
    let workerInstanceId = "";
    let claimCalls = 0;
    let completionCalls = 0;

    api.registerHandler = async (request) => {
      workerInstanceId = request.workerInstanceId;
      return createRegistration();
    };
    api.claimHandler = async () => {
      claimCalls += 1;
      return claimCalls === 1
        ? createGrantedResponse(createEnvelope(workerInstanceId))
        : createNoWorkResponse();
    };
    api.completeHandler = async () => {
      completionCalls += 1;
      throw new WorkerApiError("lease was lost", 409, "lease_lost");
    };

    const service = new WorkerService(
      createConfig(),
      api,
      createImmediateExecutor(),
      processHost,
      logger,
    );
    const runPromise = service.run();
    await waitFor(() => completionCalls === 1);
    await vi.advanceTimersByTimeAsync(2_000);
    await flushAsyncWork();

    expect(completionCalls).toBe(1);

    await service.stop("test_complete");
    await runPromise;
  });
});

describe("WorkerService execution deadline", () => {
  it("uses the remaining absolute server budget instead of the assignment duration", async () => {
    useFakeTime();
    const api = new FakeWorkerApi();
    let workerInstanceId = "";
    let claimCalls = 0;
    let executionSignal: AbortSignal | undefined;
    let resolveExecution:
      | ((result: Awaited<ReturnType<JobExecutor["execute"]>>) => void)
      | undefined;
    const failures: RunFailureSubmission[] = [];

    api.registerHandler = async (request) => {
      workerInstanceId = request.workerInstanceId;
      return createRegistration();
    };
    api.claimHandler = async () => {
      claimCalls += 1;
      return claimCalls === 1
        ? createGrantedResponse(
            createEnvelope(workerInstanceId, {
              serverClockOffsetMs: 60_000,
              assignedOffsetMs: -9_500,
              executionBudgetMs: 500,
              hardTimeoutMs: 10_000,
            }),
            new Date(Date.now() + 60_000).toISOString(),
          )
        : createNoWorkResponse();
    };
    api.failHandler = async (_runAttemptId, submission) => {
      failures.push(submission);
    };
    const executor: JobExecutor = {
      execute: async (_envelope, context) => {
        executionSignal = context.signal;
        return await new Promise((resolve) => {
          resolveExecution = resolve;
        });
      },
    };

    const service = new WorkerService(createConfig(), api, executor, processHost, logger);
    const runPromise = service.run();
    await waitFor(() => executionSignal !== undefined);

    await vi.advanceTimersByTimeAsync(499);
    expect(executionSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(executionSignal?.aborted).toBe(true);

    resolveExecution?.({ outcome: "succeeded", resultDigest: digest, result: { ok: true } });
    await waitFor(() => failures.length === 1);
    expect(failures[0]).toMatchObject({ code: "EXECUTION_TIMEOUT", retryable: false });

    await service.stop("test_complete");
    await runPromise;
  });
});

function createConfig(): WorkerConfig {
  return {
    serverUrl: new URL("http://127.0.0.1:3000"),
    protocolVersion: "1.0",
    workerNodeId: "worker-node",
    displayName: "Test worker",
    workerVersion: "0.1.0-test",
    maxSlots: 1,
    dataDirectory: ".",
    executionEnabled: true,
    claimWaitSeconds: 1,
    registrationRetrySeconds: 1,
    idleDelayMilliseconds: 10_000,
    heartbeatIntervalSeconds: 1,
    heartbeatSafetyMarginSeconds: 0,
    shutdownGraceSeconds: 1,
    requestTimeoutSeconds: 1,
    logLevel: "error",
    capabilities: {
      operatingSystem: "windows",
      architecture: "x64",
      headless: true,
      interactiveDesktop: false,
      codexVersion: "not-configured",
      recipeIds: [],
      labels: { execution: "enabled", processHost: "unavailable" },
    },
    allowInsecureHttp: true,
  };
}

function createRegistration(): WorkerRegistrationResponse {
  return {
    protocolVersion: "1.0",
    workerId: "worker-id",
    state: "online",
    heartbeatIntervalMs: 1_000,
    leaseTtlMs: 10_000,
    serverTime: nowIso(),
  };
}

function createHeartbeatResponse(): WorkerHeartbeatResponse {
  return {
    serverTime: nowIso(),
    nextHeartbeatInMs: 1_000,
    workerState: "online",
    commands: [],
  };
}

function createNoWorkResponse(): ClaimLeaseResponse {
  return {
    outcome: "no_work",
    serverTime: nowIso(),
    retryAfterMs: 10_000,
  };
}

function createGrantedResponse(
  envelope: JobExecutionEnvelope,
  serverTime = nowIso(),
): ClaimLeaseResponse {
  return { outcome: "granted", serverTime, envelope };
}

function createEnvelope(
  workerInstanceId: string,
  options: {
    readonly serverClockOffsetMs?: number;
    readonly assignedOffsetMs?: number;
    readonly leaseBudgetMs?: number;
    readonly executionBudgetMs?: number;
    readonly hardTimeoutMs?: number;
  } = {},
): JobExecutionEnvelope {
  const serverNow = Date.now() + (options.serverClockOffsetMs ?? 0);
  const assignedAt = serverNow + (options.assignedOffsetMs ?? 0);
  return {
    protocolVersion: "1.0",
    envelopeVersion: 1,
    assignedAt: new Date(assignedAt).toISOString(),
    leaseExpiresAt: new Date(serverNow + (options.leaseBudgetMs ?? 5_000)).toISOString(),
    executionDeadlineAt: new Date(serverNow + (options.executionBudgetMs ?? 10_000)).toISOString(),
    lease: {
      jobId: "job-id",
      runAttemptId: "run-attempt-id",
      workerNodeId: "worker-node",
      workerInstanceId,
      leaseToken: "x".repeat(32),
      leaseGeneration: 1,
    },
    job: {
      jobId: "job-id",
      kind: "issue_triage",
      priority: 1,
      attempt: 1,
      maxAttempts: 3,
      generation: 1,
      intentVersion: 1,
      semanticKey: "issue:1",
    },
    repository: { githubRepositoryId: 1, fullName: "owner/repository" },
    resource: {
      kind: "issue",
      githubNodeId: "I_issue",
      number: 1,
      title: "Test issue",
      author: { githubUserId: 1, login: "author" },
      canonicalSnapshot: {},
      revisionDigest: digest,
    },
    prompt: {
      name: "test-prompt",
      version: "1",
      renderedPrompt: "Review the issue.",
      promptSha256: digest,
      outputSchema: {},
      outputSchemaSha256: digest,
    },
    executionPolicy: {
      hardTimeoutMs: options.hardTimeoutMs ?? 10_000,
      noProgressTimeoutMs: 10_000,
      maxCodexTurns: 1,
      allowedRecipeIds: [],
      requiredCapabilityLabels: {},
    },
  };
}

function createImmediateExecutor(): JobExecutor {
  return {
    execute: async () => ({
      outcome: "succeeded",
      resultDigest: digest,
      result: { ok: true },
    }),
  };
}

function nowIso(): string {
  return new Date(Date.now()).toISOString();
}

function useFakeTime(): void {
  vi.useFakeTimers();
  vi.setSystemTime(baseTime);
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) {
      return;
    }
    await flushAsyncWork();
  }
  throw new Error("Timed out while waiting for asynchronous test work.");
}
