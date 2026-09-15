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
});
