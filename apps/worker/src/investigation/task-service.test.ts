import {
  createInvestigationPreview as createInvestigationFixture,
  type InvestigationClaim,
  type InvestigationTaskKind,
} from "@agentic-review/contracts";
import { createInvestigationCheckpoint } from "@agentic-review/domain";
import { describe, expect, it, vi } from "vitest";
import { type InvestigationWorkerClient, InvestigationWorkerClientError } from "./http-client.js";
import {
  type InvestigationClaimExecutor,
  InvestigationTaskService,
  InvestigationWorkerShutdown,
} from "./task-service.js";

function claimFixture(): InvestigationClaim {
  const { task, attempt, result } = createInvestigationFixture("bug");
  return {
    task,
    attempt,
    checkpoint: createInvestigationCheckpoint({
      task,
      attemptId: attempt.id,
      checkpointId: "checkpoint-1",
      leaseVersion: 1,
      recordedAt: "2026-09-15T04:00:00.000Z",
    }),
    lease: { attemptId: attempt.id, fence: 1, leaseToken: "fixture-lease" },
    reportId: result.id,
    inputSnapshot: {
      schemaVersion: "InvestigationInputSnapshotV1",
      repositoryId: task.repository.id,
      workItemId: task.workItem.id,
      subjectRef: task.subjectRef,
      subjectRevisionKey: task.subjects[0]!.revisionKey,
      title: task.workItem.title,
      body: "Synthetic issue body.",
      comments: [],
      source: null,
    },
    plan: null,
    execution: null,
  };
}

function fixture() {
  const unavailable = async (): Promise<never> => {
    throw new Error("The fixture must not call a live worker endpoint.");
  };
  const claim = vi.fn<InvestigationWorkerClient["claim"]>(async () => claimFixture());
  const client: InvestigationWorkerClient = {
    workerPolicy: async (request) => ({
      workerId: "synthetic-worker",
      version: 1,
      e2eEnabled: true,
      effectiveKinds: [...request.supportedKinds],
    }),
    claim,
    heartbeat: unavailable,
    checkpoint: unavailable,
    uploadArtifact: unavailable,
    readArtifact: unavailable,
    uploadReportPart: unavailable,
    finalize: unavailable,
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { client, claim, logger };
}

function schedulingClaim(kind: InvestigationTaskKind, id: string): InvestigationClaim {
  const claim = claimFixture();
  return {
    ...claim,
    task: { ...claim.task, id: `task-${id}`, kind },
    attempt: { ...claim.attempt, id: `attempt-${id}`, taskId: `task-${id}` },
    lease: { ...claim.lease, attemptId: `attempt-${id}` },
    checkpoint: null,
  };
}

const executionKinds = [
  "pr-e2e",
  "pr-verify",
  "issue-verify",
  "reproduction-setup",
  "issue-fix",
  "feature-implement",
] as const satisfies readonly InvestigationTaskKind[];

describe("InvestigationTaskService", () => {
  it.each(["disabled", "missing"] as const)(
    "keeps static work available when the E2E policy is %s",
    async (mode) => {
      const f = fixture();
      if (mode === "missing") delete f.client.workerPolicy;
      else
        f.client.workerPolicy = async () => ({
          workerId: "synthetic-worker",
          version: 2,
          e2eEnabled: false,
          effectiveKinds: ["issue-investigate"],
        });
      const service = new InvestigationTaskService({
        client: f.client,
        executor: {
          execute: async () => {
            service.requestDrain();
          },
        },
        supportedKinds: ["issue-investigate", ...executionKinds],
        logger: f.logger,
      });
      await service.run();
      expect(f.claim).toHaveBeenCalledTimes(1);
      expect(f.claim.mock.calls[0]![0].supportedKinds).toEqual(["issue-investigate"]);
    },
  );

  it("does not issue an empty claim when an execution-only Worker is disabled", async () => {
    const f = fixture();
    f.client.workerPolicy = async () => {
      service.requestDrain();
      return { workerId: "synthetic-worker", version: 2, e2eEnabled: false, effectiveKinds: [] };
    };
    const execute = vi.fn(async () => {});
    const service = new InvestigationTaskService({
      client: f.client,
      executor: { execute },
      supportedKinds: [...executionKinds],
      role: "e2e",
      logger: f.logger,
    });
    await service.run();
    expect(f.claim).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["execute", "permission", "authorization", "binding"] as const)(
    "rejects a static task carrying %s authority before its executor runs",
    async (mode) => {
      const f = fixture();
      const claim = claimFixture();
      if (mode === "execute") claim.task.executionPolicy.mode = "execute";
      if (mode === "permission") claim.task.executionPolicy.allowRepositoryExecution = true;
      if (mode === "authorization")
        claim.task.executionPolicy.authorizationRef = "unexpected-grant";
      if (mode === "binding") claim.execution = {} as NonNullable<InvestigationClaim["execution"]>;
      f.claim.mockResolvedValue(claim);
      const execute = vi.fn(async () => {});
      const service = new InvestigationTaskService({
        client: f.client,
        executor: { execute },
        supportedKinds: ["issue-investigate"],
        role: "static",
        logger: f.logger,
      });
      await expect(service.run()).rejects.toThrow(/cannot carry repository execution authority/);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each(["static-first", "e2e-first"] as const)(
    "fills independent pools and excludes full pools from claims (%s)",
    async (order) => {
      const f = fixture();
      const staticClaims = [
        schedulingClaim("pr-review", "static-1"),
        schedulingClaim("issue-investigate", "static-2"),
      ];
      const executionClaim = schedulingClaim("pr-e2e", "e2e");
      const claims =
        order === "static-first"
          ? [...staticClaims, executionClaim]
          : [executionClaim, ...staticClaims];
      let nextClaim = 0;
      f.claim.mockImplementation(async () => claims[nextClaim++] ?? null);
      const allStarted = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const signals: AbortSignal[] = [];
      const service = new InvestigationTaskService({
        client: f.client,
        executor: {
          execute: async (_claim, signal) => {
            signals.push(signal);
            if (signals.length === claims.length) allStarted.resolve();
            await finish.promise;
          },
        },
        supportedKinds: ["pr-review", "issue-investigate", ...executionKinds],
        maximumConcurrentStaticTasks: 2,
        logger: f.logger,
      });
      const running = service.run();
      await allStarted.promise;
      expect(f.claim).toHaveBeenCalledTimes(3);
      const requests = f.claim.mock.calls.map(([request]) => request.supportedKinds);
      expect(requests[0]).toEqual(["pr-review", "issue-investigate", ...executionKinds]);
      if (order === "static-first") {
        expect(requests[1]).toEqual(requests[0]);
        expect(requests[2]).toEqual(executionKinds);
      } else {
        expect(requests[1]).toEqual(["pr-review", "issue-investigate"]);
        expect(requests[2]).toEqual(["pr-review", "issue-investigate"]);
      }
      service.requestDrain();
      expect(signals.every((signal) => !signal.aborted)).toBe(true);
      finish.resolve();
      await running;
    },
  );

  it.each(executionKinds)("keeps %s in the single-slot execution pool", async (kind) => {
    const f = fixture();
    const first = schedulingClaim(kind, "first");
    const second = schedulingClaim("pr-e2e", "second");
    f.claim.mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValue(null);
    const firstStarted = Promise.withResolvers<void>();
    const finishFirst = Promise.withResolvers<void>();
    const order: string[] = [];
    const service = new InvestigationTaskService({
      client: f.client,
      executor: {
        execute: async (claim) => {
          order.push(claim.attempt.id);
          if (claim.attempt.id === first.attempt.id) {
            firstStarted.resolve();
            await finishFirst.promise;
          } else service.requestDrain();
        },
      },
      supportedKinds: [...executionKinds],
      maximumConcurrentStaticTasks: 4,
      logger: f.logger,
    });
    const running = service.run();
    await firstStarted.promise;
    expect(f.claim).toHaveBeenCalledTimes(1);
    finishFirst.resolve();
    await running;
    expect(order).toEqual([first.attempt.id, second.attempt.id]);
    expect(f.claim).toHaveBeenCalledTimes(2);
  });

  it.each(["static", "e2e"] as const)(
    "restricts new claims to the %s Worker role",
    async (role) => {
      const f = fixture();
      const kind = role === "static" ? "pr-review" : "pr-e2e";
      f.claim.mockResolvedValue(schedulingClaim(kind, role));
      const service = new InvestigationTaskService({
        client: f.client,
        executor: { execute: async () => service.requestDrain() },
        supportedKinds: ["pr-review", "issue-investigate", ...executionKinds],
        role,
        logger: f.logger,
      });
      await service.run();
      expect(f.claim).toHaveBeenCalledWith(
        {
          supportedKinds:
            role === "static" ? ["pr-review", "issue-investigate"] : [...executionKinds],
        },
        expect.any(AbortSignal),
      );
    },
  );

  it("rejects a role with no configured matching kinds", () => {
    const f = fixture();
    expect(
      () =>
        new InvestigationTaskService({
          client: f.client,
          executor: { execute: async () => undefined },
          supportedKinds: ["issue-investigate"],
          role: "e2e",
          logger: f.logger,
        }),
    ).toThrow(/match the Worker role/);
  });

  it("drains an accepted native task and prevents any additional claim", async () => {
    const f = fixture();
    const execute = vi.fn<InvestigationClaimExecutor["execute"]>(async () => {
      service.requestDrain();
    });
    const service = new InvestigationTaskService({
      client: f.client,
      executor: { execute },
      supportedKinds: ["issue-investigate"],
      logger: f.logger,
    });
    await service.run();
    expect(f.claim).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0].task.kind).toBe("issue-investigate");
  });

  it("stops a running attempt using the shutdown signal and waits for its cleanup", async () => {
    const f = fixture();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const order: string[] = [];
    const service = new InvestigationTaskService({
      client: f.client,
      executor: {
        execute: async (_claim, signal) => {
          entered();
          await new Promise<void>((resolve) =>
            signal.addEventListener(
              "abort",
              () => {
                expect(signal.reason).toBeInstanceOf(InvestigationWorkerShutdown);
                order.push("checkpoint");
                resolve();
              },
              { once: true },
            ),
          );
          order.push("cleanup");
        },
      },
      supportedKinds: ["issue-investigate"],
      logger: f.logger,
    });
    const running = service.run();
    await started;
    await service.stop();
    await running;
    expect(order).toEqual(["checkpoint", "cleanup"]);
    expect(f.claim).toHaveBeenCalledTimes(1);
  });

  it("does not retry a permanent worker authentication failure", async () => {
    const f = fixture();
    f.claim.mockRejectedValue({ code: "unauthorized", retryable: false });
    const execute = vi.fn(async () => undefined);
    const service = new InvestigationTaskService({
      client: f.client,
      executor: { execute },
      supportedKinds: ["issue-investigate"],
      logger: f.logger,
    });
    await expect(service.run()).rejects.toMatchObject({ code: "unauthorized" });
    expect(f.claim).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects after a terminal submission failure without leaking the executor error", async () => {
    const f = fixture();
    const execute = vi.fn<InvestigationClaimExecutor["execute"]>(async () => {
      throw new Error("Synthetic sensitive upstream response.");
    });
    const service = new InvestigationTaskService({
      client: f.client,
      executor: { execute },
      supportedKinds: ["issue-investigate"],
      logger: f.logger,
    });
    await expect(service.run()).rejects.toThrow(
      "Investigation attempt could not complete its terminal submission.",
    );
    await expect(service.stop()).rejects.toThrow(/terminal submission/);
    expect(f.claim).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(f.logger.error).toHaveBeenCalledWith(
      "Investigation attempt could not complete its terminal submission.",
      {
        taskId: execute.mock.calls[0]![0].task.id,
        attemptId: execute.mock.calls[0]![0].attempt.id,
      },
    );
    expect(JSON.stringify(f.logger.error.mock.calls)).not.toContain("sensitive upstream response");
  });

  it("retains safe terminal HTTP metadata without its message or arbitrary error fields", async () => {
    const f = fixture();
    const error = new InvestigationWorkerClientError(
      "invalid_logical_report_semantics",
      false,
      422,
    );
    error.message = "Synthetic sensitive upstream response.";
    Object.assign(error, { responseBody: "Synthetic private report.", credential: "secret" });
    const execute = vi.fn<InvestigationClaimExecutor["execute"]>(async () => {
      throw error;
    });
    const service = new InvestigationTaskService({
      client: f.client,
      executor: { execute },
      supportedKinds: ["issue-investigate"],
      logger: f.logger,
    });
    await expect(service.run()).rejects.toThrow(/terminal submission/);
    await expect(service.stop()).rejects.toThrow(/terminal submission/);
    expect(f.logger.error).toHaveBeenCalledWith(
      "Investigation attempt could not complete its terminal submission.",
      {
        taskId: execute.mock.calls[0]![0].task.id,
        attemptId: execute.mock.calls[0]![0].attempt.id,
        code: "invalid_logical_report_semantics",
        statusCode: 422,
        retryable: false,
      },
    );
    expect(JSON.stringify(f.logger.error.mock.calls)).not.toMatch(
      /sensitive|private report|secret/,
    );
  });

  it.each(["issue-investigate", "pr-e2e"] as const)(
    "drains after a failure without aborting a concurrent %s attempt",
    async (peerKind) => {
      const f = fixture();
      const first = schedulingClaim("issue-investigate", "first");
      const second = schedulingClaim(peerKind, "second");
      f.claim.mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValue(null);
      const secondStarted = Promise.withResolvers<void>();
      const failureRecorded = Promise.withResolvers<void>();
      f.logger.error.mockImplementation(() => failureRecorded.resolve());
      const finishCleanup = Promise.withResolvers<void>();
      const order: string[] = [];
      let peerSignal: AbortSignal | undefined;
      const service = new InvestigationTaskService({
        client: f.client,
        executor: {
          execute: async (claim, signal) => {
            if (claim.attempt.id === first.attempt.id) {
              await secondStarted.promise;
              throw new Error("Synthetic terminal submission failure.");
            }
            peerSignal = signal;
            secondStarted.resolve();
            await finishCleanup.promise;
            order.push("peer.cleanup");
          },
        },
        supportedKinds:
          peerKind === "issue-investigate"
            ? ["issue-investigate"]
            : ["issue-investigate", "pr-e2e"],
        maximumConcurrentTasks: peerKind === "issue-investigate" ? 2 : 1,
        logger: f.logger,
      });
      const running = service.run().catch((error: unknown) => {
        order.push("run.rejected");
        return error;
      });
      await failureRecorded.promise;
      expect(peerSignal?.aborted).toBe(false);
      expect(order).toEqual([]);
      finishCleanup.resolve();
      expect(await running).toMatchObject({
        message: "Investigation attempt could not complete its terminal submission.",
      });
      await expect(service.stop()).rejects.toThrow(/terminal submission/);
      expect(order).toEqual(["peer.cleanup", "run.rejected"]);
      expect(f.claim).toHaveBeenCalledTimes(2);
    },
  );

  it("waits for active attempts before rejecting a permanent claim failure", async () => {
    const f = fixture();
    const claimFailed = Promise.withResolvers<void>();
    f.claim.mockResolvedValueOnce(claimFixture()).mockImplementation(async () => {
      claimFailed.resolve();
      throw { code: "unauthorized", retryable: false };
    });
    const finish = Promise.withResolvers<void>();
    const order: string[] = [];
    let activeSignal: AbortSignal | undefined;
    const service = new InvestigationTaskService({
      client: f.client,
      executor: {
        execute: async (_claim, signal) => {
          activeSignal = signal;
          await finish.promise;
          order.push("attempt.finished");
        },
      },
      supportedKinds: ["issue-investigate"],
      maximumConcurrentStaticTasks: 2,
      logger: f.logger,
    });
    const running = service.run().catch((error: unknown) => {
      order.push("run.rejected");
      return error;
    });
    await claimFailed.promise;
    expect(activeSignal?.aborted).toBe(false);
    expect(order).toEqual([]);
    finish.resolve();
    expect(await running).toMatchObject({ code: "unauthorized" });
    expect(order).toEqual(["attempt.finished", "run.rejected"]);
  });

  it.each(["drain", "stop"] as const)(
    "tracks a claim accepted while %s is requested",
    async (operation) => {
      const f = fixture();
      const accepted = Promise.withResolvers<InvestigationClaim>();
      f.claim.mockReturnValueOnce(accepted.promise);
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      let acceptedSignal: AbortSignal | undefined;
      const service = new InvestigationTaskService({
        client: f.client,
        executor: {
          execute: async (_claim, signal) => {
            acceptedSignal = signal;
            started.resolve();
            await finish.promise;
          },
        },
        supportedKinds: ["issue-investigate"],
        logger: f.logger,
      });
      const running = service.run();
      const stopping = operation === "stop" ? service.stop() : undefined;
      if (operation === "drain") service.requestDrain();
      accepted.resolve(claimFixture());
      await started.promise;
      expect(acceptedSignal?.aborted).toBe(operation === "stop");
      expect(f.claim).toHaveBeenCalledTimes(1);
      finish.resolve();
      await running;
      await stopping;
    },
  );
});
