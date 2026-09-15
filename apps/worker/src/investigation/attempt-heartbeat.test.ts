import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InvestigationAttemptHeartbeat,
  InvestigationLeaseLost,
  InvestigationTaskCancelled,
} from "./attempt-heartbeat.js";
import type { InvestigationWorkerClient } from "./http-client.js";

function fixture() {
  vi.useFakeTimers();
  const renew = vi.fn<InvestigationWorkerClient["heartbeat"]>(async () => ({
    cancelRequested: false,
    leaseExpiresAt: new Date(Date.now() + 100).toISOString(),
    serverTime: new Date(Date.now()).toISOString(),
  }));
  const unavailable = async (): Promise<never> => {
    throw new Error("Only heartbeat is available in this isolated fixture.");
  };
  const client: InvestigationWorkerClient = {
    heartbeat: renew,
    claim: unavailable,
    checkpoint: unavailable,
    uploadArtifact: unavailable,
    readArtifact: unavailable,
    uploadReportPart: unavailable,
    finalize: unavailable,
  };
  const heartbeat = new InvestigationAttemptHeartbeat({
    client,
    taskId: "task-1",
    lease: { attemptId: "attempt-1", fence: 2, leaseToken: "fixture-lease" },
    intervalMs: 20,
  });
  return { renew, heartbeat };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("InvestigationAttemptHeartbeat", () => {
  it("renews fenced ownership and removes every timer on stop", async () => {
    const f = fixture();
    await f.heartbeat.start();
    await vi.advanceTimersByTimeAsync(41);
    expect(f.renew).toHaveBeenCalledTimes(3);
    expect(f.heartbeat.leaseLost).toBe(false);
    await f.heartbeat.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([-600_000, 600_000])(
    "measures the lease independently of a %i ms server clock offset",
    async (offset) => {
      const f = fixture();
      f.renew.mockResolvedValueOnce({
        cancelRequested: false,
        serverTime: new Date(Date.now() + offset).toISOString(),
        leaseExpiresAt: new Date(Date.now() + offset + 100).toISOString(),
      });
      await f.heartbeat.start();
      expect(f.heartbeat.leaseLost).toBe(false);
      await f.heartbeat.stop();
    },
  );

  it("subtracts the entire renewal round trip from the advertised lease window", async () => {
    const f = fixture();
    f.renew.mockImplementationOnce(async () => {
      const serverTime = new Date(Date.now()).toISOString();
      const leaseExpiresAt = new Date(Date.now() + 100).toISOString();
      vi.advanceTimersByTime(101);
      return { cancelRequested: false, serverTime, leaseExpiresAt };
    });
    await expect(f.heartbeat.start()).rejects.toBeInstanceOf(InvestigationLeaseLost);
    expect(f.heartbeat.leaseLost).toBe(true);
    await f.heartbeat.stop();
  });

  it("signals explicit cancellation but retains lease ownership for terminal reporting", async () => {
    const f = fixture();
    f.renew.mockResolvedValueOnce({
      cancelRequested: true,
      leaseExpiresAt: new Date(Date.now() + 100).toISOString(),
      serverTime: new Date(Date.now()).toISOString(),
    });
    await f.heartbeat.start();
    expect(f.heartbeat.executionSignal.reason).toBeInstanceOf(InvestigationTaskCancelled);
    expect(f.heartbeat.leaseLost).toBe(false);
    await vi.advanceTimersByTimeAsync(21);
    expect(f.renew).toHaveBeenCalledTimes(2);
    await f.heartbeat.stop();
  });

  it("retries a transient renewal only while the previous lease remains valid", async () => {
    const f = fixture();
    await f.heartbeat.start();
    f.renew.mockRejectedValueOnce({ retryable: true });
    await vi.advanceTimersByTimeAsync(41);
    expect(f.renew).toHaveBeenCalledTimes(3);
    expect(f.heartbeat.leaseLost).toBe(false);
    await f.heartbeat.stop();
  });

  it("aborts execution immediately after a permanent lease failure", async () => {
    const f = fixture();
    await f.heartbeat.start();
    f.renew.mockRejectedValueOnce({ retryable: false });
    await vi.advanceTimersByTimeAsync(21);
    expect(f.heartbeat.leaseLost).toBe(true);
    expect(f.heartbeat.executionSignal.reason).toBeInstanceOf(InvestigationLeaseLost);
    await f.heartbeat.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expires ownership even while a renewal request is stalled", async () => {
    const f = fixture();
    await f.heartbeat.start();
    f.renew.mockImplementationOnce(
      async (_taskId, _request, signal) =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(new Error("Request aborted.")), {
            once: true,
          });
        }),
    );
    await vi.advanceTimersByTimeAsync(101);
    expect(f.heartbeat.leaseLost).toBe(true);
    expect(f.heartbeat.executionSignal.reason).toBeInstanceOf(InvestigationLeaseLost);
    await f.heartbeat.stop();
  });
});
