import { describe, expect, it, vi } from "vitest";
import type { InvestigationOutputJournal } from "./output-journal.js";
import {
  createInvestigationOutputReporter,
  openInvestigationOutputAttempt,
} from "./output-reporter.js";

function fixture() {
  const journal: InvestigationOutputJournal = {
    openAttempt: vi.fn(async () => {}),
    append: vi.fn(),
    closeAttempt: vi.fn(),
    replay: vi.fn(async () => {}),
    flush: vi.fn(async () => true),
    stop: vi.fn(async () => true),
  };
  const controller = new AbortController();
  const options = {
    journal,
    taskId: "task-1",
    lease: { attemptId: "attempt-1", fence: 1, leaseToken: "synthetic-private-lease" },
    signal: controller.signal,
  };
  return { journal, controller, options };
}

describe("bounded visible output initialization", () => {
  it("defaults to a one-second deadline and aborts initialization without closing a shared attempt", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const pending = Promise.withResolvers<void>();
      vi.mocked(f.journal.openAttempt).mockImplementation(() => pending.promise);
      const opening = openInvestigationOutputAttempt(f.options);
      let settled = false;
      const observed = opening.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(opening).resolves.toBe(false);
      await observed;
      expect(vi.mocked(f.journal.openAttempt).mock.calls[0]?.[2]?.aborted).toBe(true);
      expect(f.journal.closeAttempt).not.toHaveBeenCalled();
      pending.resolve();
      await Promise.resolve();
      expect(f.journal.closeAttempt).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns success only for an opening that completed before cancellation", async () => {
    const f = fixture();
    await expect(openInvestigationOutputAttempt(f.options)).resolves.toBe(true);
    expect(f.journal.openAttempt).toHaveBeenCalledWith(
      f.options.taskId,
      f.options.lease,
      expect.any(AbortSignal),
    );
    expect(vi.mocked(f.journal.openAttempt).mock.calls[0]?.[2]?.aborted).toBe(false);
    expect(f.journal.closeAttempt).not.toHaveBeenCalled();
  });

  it("leaves a pending opening immediately on parent cancellation and preserves its reason", async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<void>();
    vi.mocked(f.journal.openAttempt).mockImplementation(() => {
      entered.resolve();
      return pending.promise;
    });
    const reason = new Error("Synthetic cancellation");
    const opening = openInvestigationOutputAttempt(f.options);
    const rejected = expect(opening).rejects.toBe(reason);
    await entered.promise;
    f.controller.abort(reason);
    await rejected;
    expect(vi.mocked(f.journal.openAttempt).mock.calls[0]?.[2]?.aborted).toBe(true);
    expect(f.journal.closeAttempt).not.toHaveBeenCalled();
    pending.reject(new Error("Late initialization failure"));
    await Promise.resolve();
  });

  it("does not open for an already aborted parent or let same-turn completion defeat cancellation", async () => {
    const preAborted = fixture();
    const reason = new Error("Synthetic cancellation");
    preAborted.controller.abort(reason);
    await expect(openInvestigationOutputAttempt(preAborted.options)).rejects.toBe(reason);
    expect(preAborted.journal.openAttempt).not.toHaveBeenCalled();
    const racing = fixture();
    vi.mocked(racing.journal.openAttempt).mockImplementation(async () => {
      racing.controller.abort(reason);
    });
    await expect(openInvestigationOutputAttempt(racing.options)).rejects.toBe(reason);
  });

  it.each([false, true])(
    "isolates synchronous and asynchronous open failures: %s",
    async (sync) => {
      const f = fixture();
      vi.mocked(f.journal.openAttempt).mockImplementation(() => {
        if (sync) throw new Error("Synthetic storage failure");
        return Promise.reject(new Error("Synthetic storage failure"));
      });
      await expect(openInvestigationOutputAttempt(f.options)).resolves.toBe(false);
      expect(vi.mocked(f.journal.openAttempt).mock.calls[0]?.[2]?.aborted).toBe(true);
      expect(f.journal.closeAttempt).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 30_001])(
    "refuses an unbounded initialization deadline: %s",
    async (initializationTimeoutMs) => {
      const f = fixture();
      await expect(
        openInvestigationOutputAttempt({ ...f.options, initializationTimeoutMs }),
      ).rejects.toThrow(RangeError);
      expect(f.journal.openAttempt).not.toHaveBeenCalled();
    },
  );
});

describe("visible lifecycle output reporter", () => {
  it("writes only between successful initialization and close, with idempotent lifecycle methods", async () => {
    const f = fixture();
    const reporter = createInvestigationOutputReporter(f.options);
    reporter.system("Too early");
    await Promise.all([reporter.start(f.controller.signal), reporter.start(f.controller.signal)]);
    reporter.system("An observed stage transition.");
    await reporter.close();
    await reporter.close();
    reporter.system("Too late");
    await reporter.start();
    expect(f.journal.openAttempt).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.journal.append).mock.calls.map((call) => call[3].text)).toEqual([
      "The Worker started this claimed attempt.",
      "An observed stage transition.",
      "The Worker attempt executor ended. Task cancellation and resource cleanup are recorded separately.",
    ]);
    expect(f.journal.closeAttempt).toHaveBeenCalledExactlyOnceWith("task-1", "attempt-1");
    expect(f.journal.flush).toHaveBeenCalledExactlyOnceWith(1_000);
  });

  it.each([false, true])(
    "does not revive capture after a late open settlement: reject=%s",
    async (reject) => {
      const f = fixture();
      const pending = Promise.withResolvers<void>();
      vi.mocked(f.journal.openAttempt).mockImplementation(() => pending.promise);
      const onFailure = vi.fn();
      const reporter = createInvestigationOutputReporter({
        ...f.options,
        initializationTimeoutMs: 5,
        onFailure,
      });
      await reporter.start(f.controller.signal);
      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(vi.mocked(f.journal.openAttempt).mock.calls[0]?.[2]?.aborted).toBe(true);
      expect(f.journal.closeAttempt).not.toHaveBeenCalled();
      if (reject) pending.reject(new Error("Late failure"));
      else pending.resolve();
      await Promise.resolve();
      await Promise.resolve();
      reporter.system("Must not revive capture");
      await reporter.start();
      await reporter.close();
      expect(f.journal.openAttempt).toHaveBeenCalledTimes(1);
      expect(f.journal.append).not.toHaveBeenCalled();
      expect(f.journal.closeAttempt).toHaveBeenCalledExactlyOnceWith("task-1", "attempt-1");
      expect(f.journal.flush).not.toHaveBeenCalled();
    },
  );

  it("closes promptly during initialization and never enables late lifecycle writes", async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<void>();
    vi.mocked(f.journal.openAttempt).mockImplementation(() => {
      entered.resolve();
      return pending.promise;
    });
    const reporter = createInvestigationOutputReporter(f.options);
    const starting = reporter.start();
    await entered.promise;
    await reporter.close();
    await starting;
    expect(vi.mocked(f.journal.openAttempt).mock.calls[0]?.[2]?.aborted).toBe(true);
    pending.resolve();
    await Promise.resolve();
    reporter.system("Must remain closed");
    expect(f.journal.append).not.toHaveBeenCalled();
    expect(f.journal.flush).not.toHaveBeenCalled();
  });

  it("propagates task cancellation while leaving normal cleanup to the task owner", async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    vi.mocked(f.journal.openAttempt).mockImplementation(() => {
      entered.resolve();
      return new Promise<void>(() => undefined);
    });
    const onFailure = vi.fn();
    const reporter = createInvestigationOutputReporter({ ...f.options, onFailure });
    const reason = new Error("Task cancelled during output admission");
    const starting = reporter.start(f.controller.signal);
    const rejected = expect(starting).rejects.toBe(reason);
    await entered.promise;
    f.controller.abort(reason);
    await rejected;
    expect(f.journal.closeAttempt).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
    await reporter.close();
    expect(f.journal.append).not.toHaveBeenCalled();
    expect(f.journal.closeAttempt).toHaveBeenCalledExactlyOnceWith("task-1", "attempt-1");
  });

  it("isolates sink failures and failure-callback exceptions from executor cleanup", async () => {
    const f = fixture();
    vi.mocked(f.journal.append).mockImplementation(() => {
      throw new Error("Synthetic sink failure");
    });
    const onFailure = vi.fn(() => {
      throw new Error("Synthetic diagnostic failure");
    });
    const reporter = createInvestigationOutputReporter({ ...f.options, onFailure });
    await expect(reporter.start()).resolves.toBeUndefined();
    await expect(reporter.close()).resolves.toBeUndefined();
    expect(onFailure).toHaveBeenCalledTimes(2);
    expect(f.journal.closeAttempt).toHaveBeenCalledTimes(1);
    expect(f.journal.flush).toHaveBeenCalledTimes(1);
  });
});
