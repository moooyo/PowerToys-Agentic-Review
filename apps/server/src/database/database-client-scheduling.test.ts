import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  attachDatabaseClientForTest,
  type DatabaseClient,
  type DatabaseWorkerTransport,
} from "./database-client.js";

class FakeDatabaseWorker extends EventEmitter {
  readonly posted: { id: number; operation: string }[] = [];
  postMessage(value: { id: number; operation: string }): void {
    this.posted.push(value);
    if (value.operation === "shutdown")
      queueMicrotask(() => {
        this.emit("message", {
          type: "response",
          id: value.id,
          ok: true,
          output: { closed: true },
        });
        this.emit("exit", 0);
      });
  }
  terminate(): Promise<number> {
    queueMicrotask(() => this.emit("exit", 1));
    return Promise.resolve(1);
  }
}
async function setup() {
  const worker = new FakeDatabaseWorker();
  const attaching = attachDatabaseClientForTest(worker as unknown as DatabaseWorkerTransport);
  worker.emit("message", { type: "ready" });
  return { worker, client: await attaching };
}
async function respond(
  client: DatabaseClient,
  worker: FakeDatabaseWorker,
  operation: string,
  input: unknown,
  output: unknown,
  ok = true,
) {
  const result = client
    .request(operation as never, input as never)
    .catch((error: unknown) => error);
  await Promise.resolve();
  const request = worker.posted.at(-1);
  expect(request?.operation).toBe(operation);
  worker.emit(
    "message",
    ok
      ? { type: "response", id: request?.id, ok: true, output }
      : {
          type: "response",
          id: request?.id,
          ok: false,
          error: { code: "REJECTED", message: "Rejected." },
        },
  );
  return result;
}

describe("DatabaseClient scheduling notifications", () => {
  it.each([
    "completeLease",
    "failLease",
    "registerWorker",
    "rotateWorkerToken",
    "revokeWorkerToken",
    "createReviewRun",
    "createOperatorReviewRun",
    "rerunValidationRequest",
    "createManagedRepository",
    "updateManagedRepository",
    "updateRepositoryConnection",
    "updatePlatformSchedulingConfiguration",
  ])("notifies only after successful %s completion", async (operation) => {
    const { client, worker } = await setup();
    const listener = vi.fn();
    client.subscribeSchedulingChanges(listener);
    await respond(client, worker, operation, {}, {}, false);
    expect(listener).not.toHaveBeenCalled();
    await respond(client, worker, operation, {}, { saved: true });
    expect(listener).toHaveBeenCalledOnce();
    await client.close();
  });

  it("captures the inner operator operation and isolates listener errors from the committed response", async () => {
    const { client, worker } = await setup();
    const failure = vi.fn(() => {
      throw new Error("Observer unavailable.");
    });
    const listener = vi.fn();
    const unsubscribe = client.subscribeSchedulingChanges(failure);
    client.subscribeSchedulingChanges(listener);
    const input = { operation: "updateManagedRepository", input: {}, context: {} };
    const result = client.request("operatorRequest", input as never);
    await Promise.resolve();
    input.operation = "getManagedRepository";
    worker.emit("message", {
      type: "response",
      id: worker.posted.at(-1)?.id,
      ok: true,
      output: { enabled: true },
    });
    await expect(result).resolves.toEqual({ enabled: true });
    expect(failure).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    unsubscribe();
    await respond(client, worker, "operatorRequest", { operation: "rerunValidationRequest" }, {});
    expect(failure).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledTimes(2);
    await client.close();
  });

  it.each([
    "ping",
    "getJob",
    "listJobs",
    "getPlatformJobScheduling",
    "getRepositoryJobScheduling",
    "getRepositorySchedulingStatus",
    "getPlatformSchedulingStatus",
    "listPlatformSchedulingConfigurationAudit",
    "getPlatformSchedulingConfigurationAudit",
    "heartbeatLease",
    "authenticateWorkerToken",
    "savePromptDraft",
    "dispatchPendingReviewRuns",
    "admitPendingJobs",
    "cleanupEvidenceAssets",
  ])("does not turn %s responses into scheduling wakes", async (operation) => {
    const { client, worker } = await setup();
    const listener = vi.fn();
    client.subscribeSchedulingChanges(listener);
    await respond(client, worker, operation, {}, { createdJobs: [{}], admittedJobCount: 32 });
    await respond(client, worker, "operatorRequest", { operation }, {});
    expect(listener).not.toHaveBeenCalled();
    await client.close();
  });

  it("wakes after a committed operator scheduling configuration change but not a CAS failure", async () => {
    const { client, worker } = await setup();
    const listener = vi.fn();
    client.subscribeSchedulingChanges(listener);
    const input = {
      operation: "updatePlatformSchedulingConfiguration",
      input: { request: { expectedVersion: 1, limits: { maxActiveLeases: 1, maxQueuedJobs: 1 } } },
    };
    await respond(client, worker, "operatorRequest", input, {}, false);
    expect(listener).not.toHaveBeenCalled();
    await respond(client, worker, "operatorRequest", input, { version: 2 });
    expect(listener).toHaveBeenCalledOnce();
    await client.close();
  });

  it("ignores unchanged heartbeats but observes capacity, state and instance changes", async () => {
    const { client, worker } = await setup();
    const listener = vi.fn();
    client.subscribeSchedulingChanges(listener);
    const input = { workerNodeId: "node", workerInstanceId: "instance-1", availableSlots: 0 };
    await respond(client, worker, "heartbeatWorker", input, { state: "online" });
    await respond(
      client,
      worker,
      "heartbeatWorker",
      { ...input, heartbeatSequence: 2 },
      { state: "online" },
    );
    expect(listener).toHaveBeenCalledOnce();
    await respond(
      client,
      worker,
      "heartbeatWorker",
      { ...input, availableSlots: 1 },
      { state: "online" },
    );
    await respond(
      client,
      worker,
      "heartbeatWorker",
      { ...input, availableSlots: 1 },
      { state: "draining" },
    );
    await respond(
      client,
      worker,
      "heartbeatWorker",
      { ...input, workerInstanceId: "instance-2" },
      { state: "online" },
    );
    expect(listener).toHaveBeenCalledTimes(4);
    await client.close();
  });

  it.each([
    ["claimLease", { outcome: "no_work" }, { outcome: "granted" }],
    ["reapExpiredLeases", { expiredCount: 0 }, { expiredCount: 1 }],
    ["ingestSchedulingEvent", { outcome: "duplicate" }, { outcome: "processed" }],
    [
      "commitGitHubPollingReconciliation",
      { eventResults: [{ outcome: "duplicate" }] },
      { eventResults: [{ outcome: "processed" }] },
    ],
    ["dispatchReviewRun", { createdJobs: [] }, { createdJobs: [{ jobId: "job" }] }],
    ["cancelValidationJob", { changed: false }, { changed: true }],
    ["bootstrapManagedRepositories", { imported: 0 }, { imported: 1 }],
  ])("uses the %s receipt to skip no-op wakes", async (operation, unchanged, changed) => {
    const { client, worker } = await setup();
    const listener = vi.fn();
    client.subscribeSchedulingChanges(listener);
    await respond(client, worker, operation as string, {}, unchanged);
    expect(listener).not.toHaveBeenCalled();
    await respond(client, worker, operation as string, {}, changed);
    expect(listener).toHaveBeenCalledOnce();
    await client.close();
  });

  it("ignores duplicate, unsubscribed and shutdown-racing response wakes", async () => {
    const { client, worker } = await setup();
    const listener = vi.fn();
    const unsubscribe = client.subscribeSchedulingChanges(listener);
    await respond(client, worker, "completeLease", {}, {});
    worker.emit("message", {
      type: "response",
      id: worker.posted.at(-1)?.id,
      ok: true,
      output: {},
    });
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    await respond(client, worker, "completeLease", {}, {});
    client.subscribeSchedulingChanges(listener);
    const pending = client.request("completeLease", {} as never);
    await Promise.resolve();
    const id = worker.posted.at(-1)?.id;
    const closing = client.close();
    worker.emit("message", { type: "response", id, ok: true, output: {} });
    await pending;
    await closing;
    expect(listener).toHaveBeenCalledOnce();
    client.subscribeSchedulingChanges(listener)();
  });
});
