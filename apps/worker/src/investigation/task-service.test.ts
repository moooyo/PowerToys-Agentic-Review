import {
  createInvestigationPreview as createInvestigationFixture,
  type InvestigationClaim,
} from "@agentic-review/contracts";
import { createInvestigationCheckpoint } from "@agentic-review/domain";
import { describe, expect, it, vi } from "vitest";
import type { InvestigationWorkerClient } from "./http-client.js";
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

describe("InvestigationTaskService", () => {
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

  it("aborts concurrent attempts and waits for their cleanup before rejecting", async () => {
    const f = fixture();
    const first = claimFixture();
    const second = {
      ...claimFixture(),
      attempt: { ...first.attempt, id: "second-attempt" },
    };
    f.claim.mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValue(null);
    const secondStarted = Promise.withResolvers<void>();
    const secondAborted = Promise.withResolvers<void>();
    const finishCleanup = Promise.withResolvers<void>();
    const order: string[] = [];
    const service = new InvestigationTaskService({
      client: f.client,
      executor: {
        execute: async (claim, signal) => {
          if (claim.attempt.id === first.attempt.id) {
            await secondStarted.promise;
            throw new Error("Synthetic terminal submission failure.");
          }
          secondStarted.resolve();
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          order.push("peer.aborted");
          secondAborted.resolve();
          await finishCleanup.promise;
          order.push("peer.cleanup");
        },
      },
      supportedKinds: ["issue-investigate"],
      maximumConcurrentTasks: 2,
      logger: f.logger,
    });
    const running = service.run().catch((error: unknown) => {
      order.push("run.rejected");
      return error;
    });
    await secondAborted.promise;
    expect(order).toEqual(["peer.aborted"]);
    finishCleanup.resolve();
    expect(await running).toMatchObject({
      message: "Investigation attempt could not complete its terminal submission.",
    });
    await expect(service.stop()).rejects.toThrow(/terminal submission/);
    expect(order).toEqual(["peer.aborted", "peer.cleanup", "run.rejected"]);
    expect(f.claim).toHaveBeenCalledTimes(2);
  });
});
