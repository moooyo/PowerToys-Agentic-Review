import { describe, expect, it, vi } from "vitest";
import { ReviewControlProtocolError } from "../../services/review-control/errors";
import {
  isSafeWorkerDisplayName,
  runSingleFlight,
  type SynchronousGate,
  tryAcquireGate,
  workerMutationErrorText,
} from "./credential-mutation";

describe("credential mutation gates", () => {
  it("acquires synchronously and blocks a second dialog until release", () => {
    const gate: SynchronousGate = { active: false };
    const release = tryAcquireGate(gate);

    expect(release).toBeTypeOf("function");
    expect(tryAcquireGate(gate)).toBeUndefined();
    release?.();
    expect(tryAcquireGate(gate)).toBeTypeOf("function");
  });

  it("allows only one in-flight mutation and releases after settlement", async () => {
    const gate: SynchronousGate = { active: false };
    let settle: (() => void) | undefined;
    const firstTask = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    const blockedTask = vi.fn(async () => undefined);

    const first = runSingleFlight(gate, firstTask);
    const blocked = runSingleFlight(gate, blockedTask);
    expect(firstTask).toHaveBeenCalledTimes(1);
    expect(blockedTask).not.toHaveBeenCalled();
    await expect(blocked).resolves.toBeUndefined();

    settle?.();
    await first;
    await runSingleFlight(gate, blockedTask);
    expect(blockedTask).toHaveBeenCalledTimes(1);
  });

  it("releases the mutation gate when a request rejects", async () => {
    const gate: SynchronousGate = { active: false };
    await expect(
      runSingleFlight(gate, async () => {
        throw new Error("request failed");
      }),
    ).rejects.toThrow("request failed");

    const nextTask = vi.fn(async () => undefined);
    await runSingleFlight(gate, nextTask);
    expect(nextTask).toHaveBeenCalledTimes(1);
  });
});

describe("worker mutation error text", () => {
  it("shows only sanitized review-control errors", () => {
    const fallback = "The worker mutation failed.";
    const workerToken = `arw1_${"A".repeat(43)}`;
    const protocolError = new ReviewControlProtocolError(
      "rotateWorkerToken",
      "The response was invalid.",
    );

    expect(workerMutationErrorText(protocolError, fallback)).toBe("The response was invalid.");
    expect(workerMutationErrorText(new Error("unsafe implementation detail"), fallback)).toBe(
      fallback,
    );
    expect(
      workerMutationErrorText(
        new ReviewControlProtocolError("rotateWorkerToken", `Unsafe ${workerToken}.`),
        fallback,
      ),
    ).not.toContain(workerToken);
  });
});

describe("worker display names", () => {
  it("rejects empty names and token-shaped content", () => {
    const workerToken = `arw1_${"A".repeat(43)}`;

    expect(isSafeWorkerDisplayName("Seattle worker")).toBe(true);
    expect(isSafeWorkerDisplayName("   ")).toBe(false);
    expect(isSafeWorkerDisplayName(`Worker ${workerToken}`)).toBe(false);
  });
});
