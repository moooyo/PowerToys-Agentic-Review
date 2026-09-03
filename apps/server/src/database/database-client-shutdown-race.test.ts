import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  attachDatabaseClientForTest,
  type DatabaseWorkerTransport,
} from "../../dist/database/database-client.js";

class FakeDatabaseWorker extends EventEmitter {
  readonly posted: unknown[] = [];
  terminateCalls = 0;
  onTerminate: (() => void) | undefined;

  postMessage(value: unknown): void {
    this.posted.push(value);
  }

  terminate(): Promise<number> {
    this.terminateCalls += 1;
    this.onTerminate?.();
    return Promise.resolve(1);
  }
}

const attach = async (worker: FakeDatabaseWorker) => {
  const connecting = attachDatabaseClientForTest(worker as unknown as DatabaseWorkerTransport);
  worker.emit("message", { type: "ready" });
  return connecting;
};

const flush = async (): Promise<void> => {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
};

const shutdownRequest = (worker: FakeDatabaseWorker): { readonly id: number } => {
  const request = worker.posted.find(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      "operation" in entry &&
      entry.operation === "shutdown",
  );
  if (typeof request !== "object" || request === null || !("id" in request)) {
    throw new Error("Expected a shutdown request.");
  }
  return request as { readonly id: number };
};

describe("DatabaseClient shutdown exit races", () => {
  it.each([0, 1])(
    "preserves an unexpected exit %i observed before close starts",
    async (exitCode) => {
      const worker = new FakeDatabaseWorker();
      const client = await attach(worker);

      worker.emit("exit", exitCode);
      const close = client.close();
      expect(client.close()).toBe(close);

      await expect(close).rejects.toMatchObject({
        message: `Database worker exited unexpectedly with code ${exitCode}.`,
      });
      expect(worker.posted).toEqual([]);
      expect(worker.terminateCalls).toBe(0);
    },
  );

  it("preserves a Worker error observed before close while still awaiting exit proof", async () => {
    const worker = new FakeDatabaseWorker();
    const client = await attach(worker);
    const failure = new Error("database worker failed");
    worker.emit("error", failure);

    const close = client.close();
    expect(client.close()).toBe(close);
    let settled = false;
    void close.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await flush();
    expect(settled).toBe(false);
    expect(worker.posted).toEqual([]);

    worker.emit("exit", 1);
    await expect(close).rejects.toBe(failure);
    expect(worker.terminateCalls).toBe(0);
  });

  it.each([0, 1])(
    "rejects every pending request when exit %i precedes the shutdown response",
    async (exitCode) => {
      const worker = new FakeDatabaseWorker();
      const client = await attach(worker);
      const ping = client.request("ping", {});
      const close = client.close();
      expect(client.close()).toBe(close);
      const settlement = Promise.allSettled([ping, close]);
      await flush();
      const shutdown = shutdownRequest(worker);

      worker.emit("exit", exitCode);
      const settled = await settlement;
      expect(settled.every((entry) => entry.status === "rejected")).toBe(true);
      const pingError = (settled[0] as PromiseRejectedResult).reason;
      const closeError = (settled[1] as PromiseRejectedResult).reason;
      expect(closeError).toBe(pingError);
      expect(closeError).toMatchObject({
        name: "DatabaseRequestError",
        code: "DATABASE_WORKER_SHUTDOWN_INCOMPLETE",
        message: "Database Worker exited before completing graceful shutdown.",
      });
      expect(worker.terminateCalls).toBe(1);

      worker.emit("message", {
        type: "response",
        id: shutdown.id,
        ok: true,
        output: { closed: true },
      });
      await flush();
    },
  );

  it("waits for a clean exit after the shutdown response", async () => {
    const worker = new FakeDatabaseWorker();
    const client = await attach(worker);
    const close = client.close();
    await flush();
    const shutdown = shutdownRequest(worker);
    worker.emit("message", {
      type: "response",
      id: shutdown.id,
      ok: true,
      output: { closed: true },
    });
    let settled = false;
    void close.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await flush();
    expect(settled).toBe(false);

    worker.emit("exit", 0);
    await expect(close).resolves.toBeUndefined();
    expect(settled).toBe(true);
    expect(worker.terminateCalls).toBe(0);
  });

  it("rejects a nonzero exit even after shutdown acknowledgement", async () => {
    const worker = new FakeDatabaseWorker();
    const client = await attach(worker);
    const close = client.close();
    await flush();
    const shutdown = shutdownRequest(worker);
    worker.emit("message", {
      type: "response",
      id: shutdown.id,
      ok: true,
      output: { closed: true },
    });
    worker.emit("exit", 1);

    await expect(close).rejects.toMatchObject({
      code: "DATABASE_WORKER_SHUTDOWN_INCOMPLETE",
    });
    expect(worker.terminateCalls).toBe(0);
  });

  it("forces termination when graceful shutdown never responds", async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeDatabaseWorker();
      worker.onTerminate = () => queueMicrotask(() => worker.emit("exit", 1));
      const client = await attach(worker);
      const closeResult = client.close().catch((error: unknown) => error);
      await flush();
      shutdownRequest(worker);

      await vi.advanceTimersByTimeAsync(30_000);
      const error = await closeResult;
      expect(error).toMatchObject({
        name: "DatabaseRequestError",
        code: "DATABASE_WORKER_SHUTDOWN_INCOMPLETE",
      });
      expect(worker.terminateCalls).toBe(1);
      await expect(client.ownerExit).resolves.toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
