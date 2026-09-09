import type {
  ClaimLeaseResponse,
  JobExecutionEnvelope,
  RunCompletionSubmission,
  RunFailureDiagnostics,
  RunFailureSubmission,
  RunTerminalResponse,
  WorkerHeartbeatRequest,
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
  public completeHandler: WorkerApi["completeRun"] = async (runAttemptId, submission) =>
    createTerminalResponse(submission.jobId, runAttemptId, "succeeded", "succeeded");
  public failHandler: WorkerApi["failRun"] = async (runAttemptId, submission) =>
    createTerminalResponse(submission.jobId, runAttemptId, "failed", "failed");

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

describe("WorkerService control-plane transport failures", () => {
  it("fails registration immediately for a permanent TLS client error", async () => {
    const api = new FakeWorkerApi();
    const fatal = codedError("ERR_OSSL_PKCS12_MAC_VERIFY_FAILURE");
    let registrationCalls = 0;
    api.registerHandler = async () => {
      registrationCalls += 1;
      throw fatal;
    };
    const service = new WorkerService(
      createConfig(),
      api,
      createImmediateExecutor(),
      processHost,
      logger,
    );

    await expect(service.run()).rejects.toBe(fatal);
    expect(registrationCalls).toBe(1);
    await service.stop("test_complete");
  });

  it("retries registration for a transient DNS failure", async () => {
    useFakeTime();
    const api = new FakeWorkerApi();
    let registrationCalls = 0;
    api.registerHandler = async () => {
      registrationCalls += 1;
      if (registrationCalls === 1) {
        throw codedError("ENOTFOUND");
      }
      return createRegistration();
    };
    const service = new WorkerService(
      createConfig(),
      api,
      createImmediateExecutor(),
      processHost,
      logger,
    );
    const runPromise = service.run();

    await waitFor(() => registrationCalls === 1);
    await vi.advanceTimersByTimeAsync(999);
    expect(registrationCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() => registrationCalls === 2);

    await service.stop("test_complete");
    await runPromise;
  });

  it("fails a lease claim permanently and aborts active work", async () => {
    const api = new FakeWorkerApi();
    const fatal = codedError("CERT_HAS_EXPIRED");
    let workerInstanceId = "";
    let claimCalls = 0;
    let executionSignal: AbortSignal | undefined;
    let attemptSignal: AbortSignal | undefined;
    api.registerHandler = async (request) => {
      workerInstanceId = request.workerInstanceId;
      return createRegistration();
    };
    api.claimHandler = async () => {
      claimCalls += 1;
      if (claimCalls === 1) {
        return createGrantedResponse(createEnvelope(workerInstanceId));
      }
      throw fatal;
    };
    const executor: JobExecutor = {
      execute: async (_envelope, context) => {
        executionSignal = context.signal;
        attemptSignal = context.attemptSignal;
        return await new Promise<never>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason), {
            once: true,
          });
        });
      },
    };
    const service = new WorkerService(
      { ...createConfig(), maxSlots: 2 },
      api,
      executor,
      processHost,
      logger,
    );

    await expect(service.run()).rejects.toBe(fatal);
    expect(claimCalls).toBe(2);
    expect(executionSignal?.aborted).toBe(true);
    expect(attemptSignal).toBe(executionSignal);
    await service.stop("test_complete");
  });

  it("retries a lease claim after a transient connection reset", async () => {
    useFakeTime();
    const api = new FakeWorkerApi();
    let claimCalls = 0;
    api.claimHandler = async () => {
      claimCalls += 1;
      if (claimCalls === 1) {
        throw codedError("ECONNRESET");
      }
      return createNoWorkResponse();
    };
    const service = new WorkerService(
      createConfig(),
      api,
      createImmediateExecutor(),
      processHost,
      logger,
    );
    const runPromise = service.run();

    await waitFor(() => claimCalls === 1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(claimCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() => claimCalls === 2);

    await service.stop("test_complete");
    await runPromise;
  });

  it("fails a heartbeat permanently and aborts active work", async () => {
    const api = new FakeWorkerApi();
    const fatal = codedError("ERR_TLS_CERT_ALTNAME_INVALID");
    let workerInstanceId = "";
    let claimCalls = 0;
    let executionSignal: AbortSignal | undefined;
    let rejectHeartbeat: ((reason: unknown) => void) | undefined;
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
    api.heartbeatHandler = async () =>
      await new Promise<never>((_resolve, reject) => {
        rejectHeartbeat = reject;
      });
    const executor: JobExecutor = {
      execute: async (_envelope, context) => {
        executionSignal = context.signal;
        return await new Promise<never>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason), {
            once: true,
          });
        });
      },
    };
    const service = new WorkerService(createConfig(), api, executor, processHost, logger);
    const runPromise = service.run();
    await waitFor(() => executionSignal !== undefined && rejectHeartbeat !== undefined);

    rejectHeartbeat?.(fatal);
    await expect(runPromise).rejects.toBe(fatal);
    expect(executionSignal?.aborted).toBe(true);
    await service.stop("test_complete");
  });

  it("retries a heartbeat after a transient timeout", async () => {
    useFakeTime();
    const api = new FakeWorkerApi();
    let heartbeatCalls = 0;
    api.heartbeatHandler = async () => {
      heartbeatCalls += 1;
      if (heartbeatCalls === 1) {
        throw codedError("ETIMEDOUT");
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

    await waitFor(() => heartbeatCalls === 1);
    await vi.advanceTimersByTimeAsync(999);
    expect(heartbeatCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() => heartbeatCalls === 2);

    await service.stop("test_complete");
    await runPromise;
  });
});

describe("WorkerService capacity recovery", () => {
  it("keeps heartbeats online with no slots until disk capacity recovers", async () => {
    useFakeTime();
    const api = new FakeWorkerApi();
    let capacityAvailable = false;
    const canAcceptWork = vi.fn(async (_signal: AbortSignal) => capacityAvailable);
    const claimSlots: number[] = [];
    const heartbeats: WorkerHeartbeatRequest[] = [];
    api.claimHandler = async (request) => {
      claimSlots.push(request.availableSlots);
      return createNoWorkResponse();
    };
    api.heartbeatHandler = async (_instanceId, request) => {
      heartbeats.push(request);
      return createHeartbeatResponse();
    };
    const service = new WorkerService(
      { ...createConfig(), maxSlots: 2 },
      api,
      createImmediateExecutor(),
      processHost,
      logger,
      canAcceptWork,
    );
    const runPromise = service.run();
    await waitFor(() => canAcceptWork.mock.calls.length === 1);
    await flushAsyncWork();
    heartbeats.length = 0;

    await vi.advanceTimersByTimeAsync(9_999);
    expect(canAcceptWork).toHaveBeenCalledTimes(2);
    expect(claimSlots).toEqual([]);
    expect(heartbeats.length).toBeGreaterThan(0);
    expect(heartbeats.every((request) => request.health.state === "online")).toBe(true);
    expect(heartbeats.every((request) => request.availableSlots === 0)).toBe(true);

    capacityAvailable = true;
    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() => claimSlots.length === 1);
    expect(canAcceptWork).toHaveBeenCalledTimes(3);
    expect(claimSlots).toEqual([2]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(heartbeats.at(-1)).toMatchObject({ availableSlots: 2, health: { state: "online" } });

    await service.stop("test_complete");
    await runPromise;
  });

  it("invalidates cached capacity and pauses lease claims after an execution capacity failure", async () => {
    useFakeTime();
    const api = new FakeWorkerApi();
    let workerInstanceId = "";
    let capacityAvailable = true;
    let claimCalls = 0;
    let pendingClaimSignal: AbortSignal | undefined;
    let resolveExecution:
      | ((result: Awaited<ReturnType<JobExecutor["execute"]>>) => void)
      | undefined;
    const canAcceptWork = vi.fn(async (_signal: AbortSignal) => capacityAvailable);
    const failures: RunFailureSubmission[] = [];
    const heartbeats: WorkerHeartbeatRequest[] = [];
    api.registerHandler = async (request) => {
      workerInstanceId = request.workerInstanceId;
      return createRegistration();
    };
    api.claimHandler = async (_request, signal) => {
      claimCalls += 1;
      if (claimCalls === 1) {
        return createGrantedResponse(createEnvelope(workerInstanceId));
      }
      if (claimCalls === 2) {
        if (signal === undefined) {
          throw new Error("WorkerService did not provide a lease claim abort signal.");
        }
        pendingClaimSignal = signal;
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return createNoWorkResponse();
    };
    api.failHandler = async (runAttemptId, submission) => {
      failures.push(submission);
      return createTerminalResponse(submission.jobId, runAttemptId, "failed", "failed");
    };
    api.heartbeatHandler = async (_instanceId, request) => {
      heartbeats.push(request);
      return createHeartbeatResponse();
    };
    const executor: JobExecutor = {
      execute: async () =>
        await new Promise((resolve) => {
          resolveExecution = resolve;
        }),
    };
    const service = new WorkerService(
      { ...createConfig(), maxSlots: 2 },
      api,
      executor,
      processHost,
      logger,
      canAcceptWork,
    );
    const runPromise = service.run();
    await waitFor(() => pendingClaimSignal !== undefined && resolveExecution !== undefined);
    expect(canAcceptWork).toHaveBeenCalledTimes(1);

    capacityAvailable = false;
    resolveExecution?.({
      outcome: "failed",
      code: "REVIEW_WORKSPACE_DISK_CAPACITY_UNAVAILABLE",
      message: "Workspace disk capacity is temporarily unavailable.",
      retryable: true,
    });
    await waitFor(() => failures.length === 1 && canAcceptWork.mock.calls.length === 2);
    expect(pendingClaimSignal?.aborted).toBe(true);
    expect(claimCalls).toBe(2);
    expect(failures[0]).toMatchObject({
      code: "REVIEW_WORKSPACE_DISK_CAPACITY_UNAVAILABLE",
      retryable: true,
    });
    await flushAsyncWork();
    heartbeats.length = 0;

    await vi.advanceTimersByTimeAsync(9_999);
    expect(claimCalls).toBe(2);
    expect(canAcceptWork).toHaveBeenCalledTimes(3);
    expect(heartbeats.length).toBeGreaterThan(0);
    expect(heartbeats.every((request) => request.health.state === "online")).toBe(true);
    expect(heartbeats.every((request) => request.availableSlots === 0)).toBe(true);

    capacityAvailable = true;
    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() => claimCalls === 3);
    expect(canAcceptWork).toHaveBeenCalledTimes(4);

    await service.stop("test_complete");
    await runPromise;
  });

  it("releases a late lease grant after capacity failure without starting another execution", async () => {
    useFakeTime();
    const api = new FakeWorkerApi();
    let workerInstanceId = "";
    let capacityAvailable = true;
    let claimCalls = 0;
    let pendingClaimSignal: AbortSignal | undefined;
    let resolvePendingClaim: ((response: ClaimLeaseResponse) => void) | undefined;
    let resolveExecution:
      | ((result: Awaited<ReturnType<JobExecutor["execute"]>>) => void)
      | undefined;
    const canAcceptWork = vi.fn(async (_signal: AbortSignal) => capacityAvailable);
    const executedAttempts: string[] = [];
    const failures: RunFailureSubmission[] = [];
    api.registerHandler = async (request) => {
      workerInstanceId = request.workerInstanceId;
      return createRegistration();
    };
    api.claimHandler = async (_request, signal) => {
      claimCalls += 1;
      if (claimCalls === 1) {
        return createGrantedResponse(createEnvelope(workerInstanceId));
      }
      if (claimCalls === 2) {
        pendingClaimSignal = signal;
        return await new Promise((resolve) => {
          resolvePendingClaim = resolve;
        });
      }
      return createNoWorkResponse();
    };
    api.failHandler = async (runAttemptId, submission) => {
      failures.push(submission);
      return createTerminalResponse(submission.jobId, runAttemptId, "failed", "failed");
    };
    const executor: JobExecutor = {
      execute: async (envelope) => {
        executedAttempts.push(envelope.lease.runAttemptId);
        if (executedAttempts.length > 1) {
          return { outcome: "succeeded", resultDigest: digest, result: { ok: true } };
        }
        return await new Promise((resolve) => {
          resolveExecution = resolve;
        });
      },
    };
    const service = new WorkerService(
      { ...createConfig(), maxSlots: 2 },
      api,
      executor,
      processHost,
      logger,
      canAcceptWork,
    );
    const runPromise = service.run();
    await waitFor(() => resolvePendingClaim !== undefined && resolveExecution !== undefined);

    capacityAvailable = false;
    resolveExecution?.({
      outcome: "failed",
      code: "REVIEW_WORKSPACE_DISK_CAPACITY_UNAVAILABLE",
      message: "Workspace disk capacity is temporarily unavailable.",
      retryable: true,
    });
    await waitFor(() => failures.length === 1);
    expect(pendingClaimSignal?.aborted).toBe(true);

    const lateEnvelope = createEnvelope(workerInstanceId);
    resolvePendingClaim?.(
      createGrantedResponse({
        ...lateEnvelope,
        lease: { ...lateEnvelope.lease, runAttemptId: "late-run-attempt-id" },
      }),
    );
    await waitFor(() => failures.length === 2 && canAcceptWork.mock.calls.length === 2);

    expect(failures[1]).toMatchObject({
      runAttemptId: "late-run-attempt-id",
      code: "WORKER_CAPACITY_UNAVAILABLE",
      retryable: true,
    });
    expect(executedAttempts).toEqual(["run-attempt-id"]);
    expect(claimCalls).toBe(2);

    await service.stop("test_complete");
    await runPromise;
  });

  it("drains instead of resuming claims when a capacity safety check fails", async () => {
    useFakeTime();
    const api = new FakeWorkerApi();
    const claimLease = vi.fn(async () => createNoWorkResponse());
    api.claimHandler = claimLease;
    const heartbeats: WorkerHeartbeatRequest[] = [];
    api.heartbeatHandler = async (_instanceId, request) => {
      heartbeats.push(request);
      return createHeartbeatResponse();
    };
    const canAcceptWork = vi.fn(async (_signal: AbortSignal) => {
      throw Object.assign(new Error("Workspace root is unsafe."), {
        code: "WORKSPACE_ROOT_UNSAFE",
      });
    });
    const service = new WorkerService(
      createConfig(),
      api,
      createImmediateExecutor(),
      processHost,
      logger,
      canAcceptWork,
    );
    const runPromise = service.run();
    await waitFor(() => canAcceptWork.mock.calls.length === 1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(canAcceptWork).toHaveBeenCalledTimes(1);
    expect(claimLease).not.toHaveBeenCalled();
    expect(heartbeats.at(-1)).toMatchObject({ availableSlots: 0, health: { state: "draining" } });

    await service.stop("test_complete");
    await runPromise;
  });
});

describe("WorkerService terminal reporting", () => {
  it("forwards optional execution failure diagnostics in the terminal submission", async () => {
    useFakeTime();
    const api = new FakeWorkerApi();
    let workerInstanceId = "";
    let claimCalls = 0;
    const failures: RunFailureSubmission[] = [];
    const diagnostics: RunFailureDiagnostics = {
      category: "workspace",
      exitCode: null,
      summary: "The workspace disk budget cannot accept another attempt.",
      correlationId: "workspace-capacity-check",
    };
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
    api.failHandler = async (runAttemptId, submission) => {
      failures.push(submission);
      return createTerminalResponse(submission.jobId, runAttemptId, "failed", "failed");
    };
    const executor: JobExecutor = {
      execute: async () => ({
        outcome: "failed",
        code: "REVIEW_WORKSPACE_DISK_CAPACITY_UNAVAILABLE",
        message: "Workspace disk capacity is temporarily unavailable.",
        retryable: true,
        diagnostics,
      }),
    };
    const service = new WorkerService(createConfig(), api, executor, processHost, logger);
    const runPromise = service.run();
    await waitFor(() => failures.length === 1);

    expect(failures[0]).toMatchObject({
      code: "REVIEW_WORKSPACE_DISK_CAPACITY_UNAVAILABLE",
      retryable: true,
      diagnostics,
    });
    expect(failures[0]?.diagnostics).toBe(diagnostics);

    await service.stop("test_complete");
    await runPromise;
  });

  it("runs deferred cleanups once in LIFO order after completion reporting finishes", async () => {
    useFakeTime();
    const api = new FakeWorkerApi();
    let workerInstanceId = "";
    let claimCalls = 0;
    let releaseCompletion: (() => void) | undefined;
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    const events: string[] = [];

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
    api.completeHandler = async (runAttemptId, submission) => {
      events.push("completion-started");
      await completionGate;
      events.push("completion-finished");
      return createTerminalResponse(submission.jobId, runAttemptId, "succeeded", "succeeded");
    };
    const executor: JobExecutor = {
      execute: async (_envelope, context) => {
        const deferCleanup = context.deferCleanup;
        if (deferCleanup === undefined) {
          throw new Error("WorkerService did not provide deferred cleanup registration.");
        }
        deferCleanup(async () => {
          events.push("cleanup-first");
        });
        deferCleanup(async () => {
          events.push("cleanup-second");
        });
        return { outcome: "succeeded", resultDigest: digest, result: { ok: true } };
      },
    };

    const service = new WorkerService(createConfig(), api, executor, processHost, logger);
    const runPromise = service.run();
    await waitFor(() => events.includes("completion-started"));
    expect(events).toEqual(["completion-started"]);

    releaseCompletion?.();
    await waitFor(() => events.includes("cleanup-first"));
    expect(events).toEqual([
      "completion-started",
      "completion-finished",
      "cleanup-second",
      "cleanup-first",
    ]);

    await service.stop("test_complete");
    await runPromise;
    expect(events.filter((event) => event.startsWith("cleanup-"))).toHaveLength(2);
  });

  it("attempts every deferred cleanup, preserves the terminal outcome, and drains the worker", async () => {
    useFakeTime();
    const api = new FakeWorkerApi();
    let workerInstanceId = "";
    let claimCalls = 0;
    const events: string[] = [];
    const failureSubmissions: RunFailureSubmission[] = [];
    const warnings: string[] = [];
    const heartbeatStates: string[] = [];
    const cleanupLogger: Logger = {
      ...logger,
      warn: (message) => warnings.push(message),
    };

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
    api.failHandler = async (runAttemptId, submission) => {
      failureSubmissions.push(submission);
      events.push("failure-reported");
      return createTerminalResponse(submission.jobId, runAttemptId, "failed", "failed");
    };
    api.heartbeatHandler = async (_instanceId, request) => {
      heartbeatStates.push(request.health.state);
      return createHeartbeatResponse();
    };
    const executor: JobExecutor = {
      execute: async (_envelope, context) => {
        const deferCleanup = context.deferCleanup;
        if (deferCleanup === undefined) {
          throw new Error("WorkerService did not provide deferred cleanup registration.");
        }
        deferCleanup(async () => {
          events.push("cleanup-first");
        });
        deferCleanup(async () => {
          events.push("cleanup-second");
          throw new Error("injected cleanup failure");
        });
        return {
          outcome: "failed",
          code: "REVIEW_FAILED",
          message: "The review failed.",
          retryable: false,
        };
      },
    };

    const service = new WorkerService(createConfig(), api, executor, processHost, cleanupLogger);
    const runPromise = service.run();
    await waitFor(() => events.includes("cleanup-first"));

    expect(events).toEqual(["failure-reported", "cleanup-second", "cleanup-first"]);
    expect(failureSubmissions).toHaveLength(1);
    expect(failureSubmissions[0]).toMatchObject({ code: "REVIEW_FAILED", retryable: false });
    expect(warnings).toContain("Deferred run cleanup failed.");

    await vi.advanceTimersByTimeAsync(1_000);
    await waitFor(() => heartbeatStates.includes("draining"));
    await vi.advanceTimersByTimeAsync(9_000);
    await flushAsyncWork();
    expect(claimCalls).toBe(1);

    await service.stop("test_complete");
    await runPromise;
    expect(events).toEqual(["failure-reported", "cleanup-second", "cleanup-first"]);
  });

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
    let cleanupCalls = 0;

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
    api.failHandler = async (runAttemptId, submission) => {
      failSubmissions.push(submission);
      if (failSubmissions.length === 1) {
        throw new Error("temporary terminal network error");
      }
      return createTerminalResponse(submission.jobId, runAttemptId, "cancelled", "cancelled");
    };
    const executor: JobExecutor = {
      execute: async (_envelope, context) => {
        executionSignal = context.signal;
        context.deferCleanup?.(async () => {
          cleanupCalls += 1;
        });
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
    expect(cleanupCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(250);
    await waitFor(() => failSubmissions.length === 2);
    await waitFor(() => cleanupCalls === 1);

    expect(failSubmissions[0]).toBe(failSubmissions[1]);
    expect(failSubmissions[0]).toMatchObject({
      code: "CANCELLED_BY_SERVER",
      retryable: false,
    });

    await service.stop("test_complete");
    await runPromise;
    expect(cleanupCalls).toBe(1);
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
    let cleanupCalls = 0;

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

    const executor: JobExecutor = {
      execute: async (_envelope, context) => {
        context.deferCleanup?.(async () => {
          cleanupCalls += 1;
        });
        return { outcome: "succeeded", resultDigest: digest, result: { ok: true } };
      },
    };
    const service = new WorkerService(createConfig(), api, executor, processHost, logger);
    const runPromise = service.run();
    await waitFor(() => completionCalls === 1);
    await waitFor(() => cleanupCalls === 1);
    await vi.advanceTimersByTimeAsync(2_000);
    await flushAsyncWork();

    expect(completionCalls).toBe(1);
    expect(cleanupCalls).toBe(1);

    await service.stop("test_complete");
    await runPromise;
  });

  it("does not retry a semantically inconsistent terminal response", async () => {
    useFakeTime();
    const api = new FakeWorkerApi();
    let workerInstanceId = "";
    let claimCalls = 0;
    let completionCalls = 0;
    let cleanupCalls = 0;

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
    api.completeHandler = async (runAttemptId, submission) => {
      completionCalls += 1;
      return createTerminalResponse(submission.jobId, runAttemptId, "cancelled", "failed");
    };
    const executor: JobExecutor = {
      execute: async (_envelope, context) => {
        context.deferCleanup?.(async () => {
          cleanupCalls += 1;
        });
        return { outcome: "succeeded", resultDigest: digest, result: { ok: true } };
      },
    };

    const service = new WorkerService(createConfig(), api, executor, processHost, logger);
    const runPromise = service.run();
    await waitFor(() => cleanupCalls === 1);
    await vi.advanceTimersByTimeAsync(2_000);
    await flushAsyncWork();

    expect(completionCalls).toBe(1);
    await service.stop("test_complete");
    await runPromise;
  });
});

describe("WorkerService shutdown convergence", () => {
  it("aborts a stuck terminal request and completes cleanup before stop returns", async () => {
    useFakeTime();
    const api = new FakeWorkerApi();
    let workerInstanceId = "";
    let claimCalls = 0;
    let completionSignal: AbortSignal | undefined;
    let cleanupCalls = 0;
    const events: string[] = [];

    api.registerHandler = async (request) => {
      workerInstanceId = request.workerInstanceId;
      return createRegistration();
    };
    api.claimHandler = async () => {
      claimCalls += 1;
      return claimCalls === 1
        ? createGrantedResponse(createEnvelope(workerInstanceId, { leaseBudgetMs: 30_000 }))
        : createNoWorkResponse();
    };
    api.completeHandler = async (_runAttemptId, _submission, signal) => {
      completionSignal = signal;
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            events.push("completion-aborted");
            reject(signal.reason);
          },
          { once: true },
        );
      });
      throw new Error("Aborted terminal request unexpectedly resumed.");
    };
    const executor: JobExecutor = {
      execute: async (_envelope, context) => {
        context.deferCleanup?.(async () => {
          cleanupCalls += 1;
          events.push("cleanup-finished");
        });
        return { outcome: "succeeded", resultDigest: digest, result: { ok: true } };
      },
    };

    const service = new WorkerService(createConfig(), api, executor, processHost, logger);
    const runPromise = service.run();
    await waitFor(() => completionSignal !== undefined);

    let stopResolved = false;
    const stopPromise = service.stop("test_shutdown").then(() => {
      stopResolved = true;
      events.push("stop-resolved");
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(completionSignal?.aborted).toBe(false);
    expect(cleanupCalls).toBe(0);
    expect(stopResolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() => cleanupCalls === 1);
    await stopPromise;
    await runPromise;

    expect(completionSignal?.aborted).toBe(true);
    expect(events).toEqual(["completion-aborted", "cleanup-finished", "stop-resolved"]);
  });

  it("cancels a terminal retry delay and does not start another request after forced shutdown", async () => {
    useFakeTime();
    const api = new FakeWorkerApi();
    let workerInstanceId = "";
    let claimCalls = 0;
    let completionCalls = 0;
    let failureCalls = 0;
    let cleanupCalls = 0;

    api.registerHandler = async (request) => {
      workerInstanceId = request.workerInstanceId;
      return createRegistration();
    };
    api.claimHandler = async () => {
      claimCalls += 1;
      return claimCalls === 1
        ? createGrantedResponse(createEnvelope(workerInstanceId, { leaseBudgetMs: 30_000 }))
        : createNoWorkResponse();
    };
    api.completeHandler = async () => {
      completionCalls += 1;
      throw new Error("temporary terminal network error");
    };
    api.failHandler = async (runAttemptId, submission) => {
      failureCalls += 1;
      return createTerminalResponse(submission.jobId, runAttemptId, "failed", "failed");
    };
    const executor: JobExecutor = {
      execute: async (_envelope, context) => {
        context.deferCleanup?.(async () => {
          cleanupCalls += 1;
        });
        return { outcome: "succeeded", resultDigest: digest, result: { ok: true } };
      },
    };

    const service = new WorkerService(createConfig(), api, executor, processHost, logger);
    const runPromise = service.run();
    await waitFor(() => completionCalls === 1);
    const stopPromise = service.stop("test_shutdown");

    await vi.advanceTimersByTimeAsync(250);
    await waitFor(() => completionCalls === 2);
    await vi.advanceTimersByTimeAsync(500);
    await waitFor(() => completionCalls === 3);
    await vi.advanceTimersByTimeAsync(250);
    await waitFor(() => cleanupCalls === 1);
    await stopPromise;
    await runPromise;

    expect(completionCalls).toBe(3);
    expect(failureCalls).toBe(0);
    expect(cleanupCalls).toBe(1);
  });

  it("logs when deferred cleanup cannot settle within the forced shutdown timeout", async () => {
    useFakeTime();
    const api = new FakeWorkerApi();
    let workerInstanceId = "";
    let claimCalls = 0;
    let cleanupStarted = false;
    const errors: string[] = [];
    const infos: string[] = [];
    let processHostClosed = false;
    const shutdownLogger: Logger = {
      ...logger,
      info: (message) => infos.push(message),
      error: (message) => errors.push(message),
    };
    const shutdownProcessHost: ProcessHostClient = {
      ...processHost,
      close: async () => {
        processHostClosed = true;
      },
    };

    api.registerHandler = async (request) => {
      workerInstanceId = request.workerInstanceId;
      return createRegistration();
    };
    api.claimHandler = async () => {
      claimCalls += 1;
      return claimCalls === 1
        ? createGrantedResponse(createEnvelope(workerInstanceId, { leaseBudgetMs: 30_000 }))
        : createNoWorkResponse();
    };
    const executor: JobExecutor = {
      execute: async (_envelope, context) => {
        context.deferCleanup?.(async () => {
          cleanupStarted = true;
          await new Promise<void>(() => undefined);
        });
        return { outcome: "succeeded", resultDigest: digest, result: { ok: true } };
      },
    };

    const service = new WorkerService(
      createConfig(),
      api,
      executor,
      shutdownProcessHost,
      shutdownLogger,
    );
    const runPromise = service.run();
    await waitFor(() => cleanupStarted);

    let stopResolved = false;
    const stopPromise = service.stop("test_shutdown").then(() => {
      stopResolved = true;
    });
    const expectedShutdownFailure = {
      name: "WorkerShutdownError",
      message:
        "Worker shutdown failed because active runs or deferred cleanup did not settle within 5000 ms.",
    };
    const stopRejection = expect(stopPromise).rejects.toMatchObject(expectedShutdownFailure);
    const runRejection = expect(runPromise).rejects.toMatchObject(expectedShutdownFailure);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(stopResolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await stopRejection;
    await runRejection;

    expect(stopResolved).toBe(false);
    expect(processHostClosed).toBe(true);
    expect(errors).toContain(
      "Active runs or deferred cleanup did not settle during forced shutdown.",
    );
    expect(infos).not.toContain("Worker shutdown completed.");
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
    let cleanupCalls = 0;

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
    api.failHandler = async (runAttemptId, submission) => {
      failures.push(submission);
      return createTerminalResponse(submission.jobId, runAttemptId, "failed", "failed");
    };
    const executor: JobExecutor = {
      execute: async (_envelope, context) => {
        executionSignal = context.signal;
        context.deferCleanup?.(async () => {
          cleanupCalls += 1;
        });
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
    await waitFor(() => cleanupCalls === 1);
    expect(failures[0]).toMatchObject({ code: "EXECUTION_TIMEOUT", retryable: false });
    expect(cleanupCalls).toBe(1);

    await service.stop("test_complete");
    await runPromise;
  });
});

describe("WorkerService node health faults", () => {
  it("logs once and enters drain mode with a stable reason", async () => {
    const api = new FakeWorkerApi();
    let workerInstanceId = "";
    let claimCalls = 0;
    const errorLogs: Array<{
      readonly message: string;
      readonly fields: Readonly<Record<string, unknown>> | undefined;
    }> = [];
    const infoLogs: Array<{
      readonly message: string;
      readonly fields: Readonly<Record<string, unknown>> | undefined;
    }> = [];
    const healthLogger: Logger = {
      debug: () => undefined,
      warn: () => undefined,
      error: (message, fields) => errorLogs.push({ message, fields }),
      info: (message, fields) => infoLogs.push({ message, fields }),
    };
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
    const executor: JobExecutor = {
      execute: async (_envelope, context) => {
        const fault = Object.assign(new Error("unsafe workspace root"), {
          code: "WORKSPACE_ROOT_UNSAFE",
        });
        context.reportNodeHealthFault(fault);
        context.reportNodeHealthFault(fault);
        return { outcome: "succeeded", resultDigest: digest, result: { ok: true } };
      },
    };

    const service = new WorkerService(createConfig(), api, executor, processHost, healthLogger);
    const runPromise = service.run();
    await waitFor(() => errorLogs.length === 1);

    expect(errorLogs[0]).toMatchObject({
      message: "Worker node health fault requested drain mode.",
      fields: { reason: "node_health_fault:WORKSPACE_ROOT_UNSAFE" },
    });
    expect(
      infoLogs.filter(
        (entry) =>
          entry.message === "Worker entered drain mode." &&
          entry.fields?.reason === "node_health_fault:WORKSPACE_ROOT_UNSAFE",
      ),
    ).toHaveLength(1);

    await service.stop("test_complete");
    await runPromise;
  });
});

function createConfig(): WorkerConfig {
  return {
    serverUrl: new URL("http://127.0.0.1:3000"),
    protocolVersion: "1.0",
    workerNodeId: "worker-node",
    workerToken: `arw1_${"A".repeat(43)}`,
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

function createTerminalResponse(
  jobId: string,
  runAttemptId: string,
  jobState: RunTerminalResponse["jobState"],
  runState: RunTerminalResponse["runState"],
): RunTerminalResponse {
  return { jobId, runAttemptId, jobState, runState };
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

function codedError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error("Worker control request failed."), { code });
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
