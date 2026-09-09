import { describe, expect, it, vi } from "vitest";
import {
  DatabaseRequestDispatcher,
  DatabaseWorkerShuttingDownError,
} from "./request-dispatcher.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolved, rejected) => {
    resolve = resolved;
    reject = rejected;
  });
  return { promise, resolve, reject };
}

describe("DatabaseRequestDispatcher", () => {
  it("invokes work immediately and lets a heartbeat pass a pending verification", async () => {
    const dispatcher = new DatabaseRequestDispatcher();
    const gate = deferred<string>();
    const events: string[] = [];
    const verification = dispatcher.run(() => {
      events.push("verification-started");
      return gate.promise;
    });
    expect(events).toEqual(["verification-started"]);
    const heartbeat = dispatcher.run((signal) => {
      expect(signal).toBe(dispatcher.signal);
      events.push("heartbeat");
      return { extended: true };
    });
    expect(events).toEqual(["verification-started", "heartbeat"]);
    await expect(heartbeat).resolves.toEqual({ extended: true });
    gate.resolve("verified");
    await expect(verification).resolves.toBe("verified");
    await dispatcher.drain();
  });

  it("preserves synchronous results and turns synchronous throws into rejections", async () => {
    const dispatcher = new DatabaseRequestDispatcher();
    const failure = new Error("business failure");
    await expect(dispatcher.run(() => 42)).resolves.toBe(42);
    let rejected: Promise<never> | undefined;
    expect(() => {
      rejected = dispatcher.run(() => {
        throw failure;
      });
    }).not.toThrow();
    await expect(rejected).rejects.toBe(failure);
    await expect(dispatcher.drain()).resolves.toBeUndefined();
  });

  it("stops admission and aborts synchronously before waiting for settlement", async () => {
    const dispatcher = new DatabaseRequestDispatcher();
    const gate = deferred<string>();
    let aborted = false;
    const result = dispatcher.run((signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return gate.promise;
    });
    const rejected = expect(result).rejects.toMatchObject({
      code: "DATABASE_WORKER_SHUTTING_DOWN",
    });
    const closing = dispatcher.drain();
    expect(dispatcher.draining).toBe(true);
    expect(aborted).toBe(true);
    expect(dispatcher.signal.reason).toBeInstanceOf(DatabaseWorkerShuttingDownError);
    const unexpectedWork = vi.fn(() => 1);
    await expect(dispatcher.run(unexpectedWork)).rejects.toMatchObject({
      code: "DATABASE_WORKER_SHUTTING_DOWN",
    });
    expect(unexpectedWork).not.toHaveBeenCalled();
    let drained = false;
    void closing.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    gate.resolve("late success");
    await rejected;
    await closing;
    expect(drained).toBe(true);
  });

  it("does not confuse an abort signal with an uncooperative task having stopped", async () => {
    const dispatcher = new DatabaseRequestDispatcher();
    const gate = deferred<void>();
    const result = dispatcher.run(async () => {
      await gate.promise;
      return "finished";
    });
    const rejected = expect(result).rejects.toMatchObject({
      code: "DATABASE_WORKER_SHUTTING_DOWN",
    });
    const closing = dispatcher.drain();
    let settled = false;
    void closing.then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve();
    await rejected;
    await closing;
    expect(settled).toBe(true);
  });

  it("settles all requests without propagating their business errors into drain", async () => {
    const dispatcher = new DatabaseRequestDispatcher();
    const first = deferred<string>();
    const second = deferred<number>();
    const failure = new Error("validation rejected");
    const firstResult = dispatcher.run(() => first.promise);
    const secondResult = dispatcher.run(() => second.promise);
    const firstRejected = expect(firstResult).rejects.toBe(failure);
    const secondRejected = expect(secondResult).rejects.toMatchObject({
      code: "DATABASE_WORKER_SHUTTING_DOWN",
    });
    const closing = dispatcher.drain();
    first.reject(failure);
    second.resolve(1);
    await Promise.all([firstRejected, secondRejected]);
    await expect(closing).resolves.toBeUndefined();
  });

  it("reserves a task before synchronous reentrant drain", async () => {
    const dispatcher = new DatabaseRequestDispatcher();
    const gate = deferred<number>();
    let closing: Promise<void> | undefined;
    const result = dispatcher.run(() => {
      closing = dispatcher.drain();
      return gate.promise;
    });
    const rejected = expect(result).rejects.toMatchObject({
      code: "DATABASE_WORKER_SHUTTING_DOWN",
    });
    let drained = false;
    void closing?.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    gate.resolve(1);
    await rejected;
    await closing;
    expect(drained).toBe(true);
  });

  it("memoizes drain before reentrant abort listeners observe it", async () => {
    const dispatcher = new DatabaseRequestDispatcher();
    let reentrant: Promise<void> | undefined;
    dispatcher.signal.addEventListener("abort", () => {
      reentrant = dispatcher.drain();
    });
    const closing = dispatcher.drain();
    expect(reentrant).toBe(closing);
    expect(dispatcher.drain()).toBe(closing);
    await closing;
  });

  it("delivers request response reactions before the shutdown acknowledgement", async () => {
    const dispatcher = new DatabaseRequestDispatcher();
    const gate = deferred<string>();
    const events: string[] = [];
    const result = dispatcher.run(() => gate.promise);
    const response = result.then(
      () => {
        events.push("success");
      },
      () => {
        events.push("request-error-response");
      },
    );
    const closing = dispatcher.drain().then(() => {
      events.push("shutdown-acknowledgement");
    });
    gate.resolve("late");
    await Promise.all([response, closing]);
    expect(events).toEqual(["request-error-response", "shutdown-acknowledgement"]);
  });
});
