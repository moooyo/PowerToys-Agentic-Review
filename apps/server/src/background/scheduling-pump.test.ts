import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startSchedulingPump } from "./scheduling-pump.js";

afterEach(() => vi.useRealTimers());
function fixture(request = vi.fn(async (_operation: string, _input: unknown) => ({}))) {
  const listeners = new Set<() => void>();
  const unsubscribe = vi.fn();
  const database = {
    request,
    subscribeSchedulingChanges(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        unsubscribe();
      };
    },
  };
  const logger = { error: vi.fn() } as unknown as FastifyBaseLogger;
  const controller = new AbortController();
  const pump = startSchedulingPump(database as never, logger, controller.signal);
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return { pump, notify, request, controller, logger, unsubscribe, listeners };
}

describe("startSchedulingPump", () => {
  it("coalesces startup and mutation bursts into one bounded ordered batch without self-refill", async () => {
    vi.useFakeTimers();
    const value = fixture();
    value.notify();
    value.notify();
    value.pump.wake();
    expect(value.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(value.request.mock.calls).toEqual([
      ["dispatchPendingReviewRuns", { limit: 32 }],
      ["admitPendingJobs", { limit: 32 }],
    ]);
    await vi.advanceTimersByTimeAsync(60000);
    expect(value.request).toHaveBeenCalledTimes(2);
    await value.pump.stop();
    expect(value.unsubscribe).toHaveBeenCalledOnce();
  });

  it("retains one follow-up wake while an operation is active", async () => {
    vi.useFakeTimers();
    const first = Promise.withResolvers<unknown>();
    let dispatches = 0;
    const value = fixture(
      vi.fn(async (operation) => {
        if (operation === "dispatchPendingReviewRuns" && ++dispatches === 1) return first.promise;
        return {};
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    value.notify();
    value.notify();
    value.pump.wake();
    await vi.advanceTimersByTimeAsync(5000);
    expect(value.request).toHaveBeenCalledTimes(1);
    first.resolve({});
    await vi.advanceTimersByTimeAsync(1);
    expect(value.request.mock.calls.map(([operation]) => operation)).toEqual([
      "dispatchPendingReviewRuns",
      "admitPendingJobs",
      "dispatchPendingReviewRuns",
      "admitPendingJobs",
    ]);
    await value.pump.stop();
  });

  it("attempts admission after dispatch failure and accepts later wakes after both failures", async () => {
    vi.useFakeTimers();
    const dispatchFailure = new Error("Dispatch unavailable.");
    const admissionFailure = new Error("Admission unavailable.");
    const value = fixture(
      vi.fn(async (operation) => {
        throw operation === "dispatchPendingReviewRuns" ? dispatchFailure : admissionFailure;
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(value.request).toHaveBeenCalledTimes(2);
    expect(value.logger.error).toHaveBeenCalledWith(
      { error: dispatchFailure },
      "Pending validation dispatch failed.",
    );
    expect(value.logger.error).toHaveBeenCalledWith(
      { error: admissionFailure },
      "Pending job admission failed.",
    );
    value.notify();
    await vi.advanceTimersByTimeAsync(0);
    expect(value.request).toHaveBeenCalledTimes(4);
    await value.pump.stop();
  });

  it.each(["dispatchPendingReviewRuns", "admitPendingJobs"])(
    "stops wakes and drains active %s",
    async (operation) => {
      vi.useFakeTimers();
      const blocked = Promise.withResolvers<unknown>();
      const value = fixture(vi.fn(async (name) => (name === operation ? blocked.promise : {})));
      await vi.advanceTimersByTimeAsync(0);
      value.notify();
      value.controller.abort();
      let completed = false;
      const stopping = value.pump.stop().then(() => {
        completed = true;
      });
      const again = value.pump.stop();
      await vi.advanceTimersByTimeAsync(10000);
      expect(completed).toBe(false);
      expect(value.listeners.size).toBe(0);
      expect(value.unsubscribe).toHaveBeenCalledOnce();
      const calls = value.request.mock.calls.length;
      value.notify();
      value.pump.wake();
      blocked.resolve({});
      await Promise.all([stopping, again]);
      await vi.advanceTimersByTimeAsync(10000);
      expect(value.request).toHaveBeenCalledTimes(calls);
      expect(completed).toBe(true);
    },
  );

  it("cancels queued work and never subscribes after an aborted startup", async () => {
    vi.useFakeTimers();
    const value = fixture();
    await value.pump.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(value.request).not.toHaveBeenCalled();
    const subscribeSchedulingChanges = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const pump = startSchedulingPump(
      { request: value.request, subscribeSchedulingChanges } as never,
      value.logger,
      controller.signal,
    );
    pump.wake();
    await pump.stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(subscribeSchedulingChanges).not.toHaveBeenCalled();
    expect(value.request).not.toHaveBeenCalled();
  });
});
