import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  ArtifactMutationGate,
  ArtifactMutationGateError,
} from "../../dist/artifacts/artifact-mutation-gate.js";

const admission = (milliseconds = 5_000, signal?: AbortSignal) => ({
  deadline: performance.now() + milliseconds,
  ...(signal === undefined ? {} : { signal }),
});

describe("ArtifactMutationGate", () => {
  it("runs callbacks in FIFO order and bounds active plus queued work", async () => {
    const gate = new ArtifactMutationGate({ maximumPendingOperations: 2 });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const events: string[] = [];
    const first = gate.run(admission(), async () => {
      events.push("first-start");
      entered.resolve();
      await release.promise;
      events.push("first-end");
      return 1;
    });
    await entered.promise;
    const second = gate.run(admission(), () => {
      events.push("second");
      return 2;
    });

    await expect(gate.run(admission(), () => 3)).rejects.toMatchObject({
      code: "ARTIFACT_MUTATION_GATE_BUSY",
      callbackStarted: false,
      retryable: true,
    });
    release.resolve();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(events).toEqual(["first-start", "first-end", "second"]);
    await gate.close();
  });

  it("cancels queued callbacks on abort without cancelling an active callback", async () => {
    const gate = new ArtifactMutationGate({ maximumPendingOperations: 3 });
    const activeAbort = new AbortController();
    const queuedAbort = new AbortController();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let queuedCalled = false;
    const active = gate.run(admission(5_000, activeAbort.signal), async () => {
      entered.resolve();
      await release.promise;
      return "active";
    });
    await entered.promise;
    const queued = gate.run(admission(5_000, queuedAbort.signal), () => {
      queuedCalled = true;
      return "queued";
    });

    activeAbort.abort();
    queuedAbort.abort();
    await expect(queued).rejects.toMatchObject({
      code: "ARTIFACT_MUTATION_GATE_CANCELLED",
      callbackStarted: false,
    });
    release.resolve();
    await expect(active).resolves.toBe("active");
    expect(queuedCalled).toBe(false);
    await gate.close();
  });

  it("expires a queued absolute admission deadline without running its callback", async () => {
    const gate = new ArtifactMutationGate({ maximumPendingOperations: 2 });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const active = gate.run(admission(), async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    let expiredCalled = false;
    const expired = gate.run(admission(20), () => {
      expiredCalled = true;
    });

    await expect(expired).rejects.toMatchObject({
      code: "ARTIFACT_MUTATION_GATE_TIMEOUT",
      callbackStarted: false,
      retryable: true,
    });
    expect(expiredCalled).toBe(false);
    release.resolve();
    await active;
    await gate.close();
  });

  it("close stops admission, cancels queued work, and waits for active work", async () => {
    const gate = new ArtifactMutationGate({ maximumPendingOperations: 3 });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const active = gate.run(admission(), async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    let queuedCalled = false;
    const queued = gate.run(admission(), () => {
      queuedCalled = true;
    });

    let closed = false;
    const closing = gate.close().then(() => {
      closed = true;
    });
    await expect(gate.run(admission(), () => undefined)).rejects.toMatchObject({
      code: "ARTIFACT_MUTATION_GATE_CLOSED",
    });
    await expect(queued).rejects.toMatchObject({
      code: "ARTIFACT_MUTATION_GATE_CLOSED",
      callbackStarted: false,
    });
    expect(closed).toBe(false);
    expect(queuedCalled).toBe(false);

    release.resolve();
    await active;
    await closing;
    expect(closed).toBe(true);
    expect(queuedCalled).toBe(false);
  });

  it("poison rejects queued and future work while active work settles", async () => {
    const gate = new ArtifactMutationGate({ maximumPendingOperations: 3 });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const active = gate.run(admission(), async () => {
      entered.resolve();
      await release.promise;
      return "settled";
    });
    await entered.promise;
    let queuedCalled = false;
    const queued = gate.run(admission(), () => {
      queuedCalled = true;
    });
    const cause = new Error("unknown mutation outcome");

    const poison = gate.poison(cause);
    expect(poison).toMatchObject({
      code: "ARTIFACT_MUTATION_GATE_POISONED",
      callbackStarted: false,
      retryable: false,
      cause,
    });
    await expect(queued).rejects.toBe(poison);
    await expect(gate.run(admission(), () => undefined)).rejects.toBe(poison);
    expect(queuedCalled).toBe(false);

    let closed = false;
    const closing = gate.close().then(() => {
      closed = true;
    });
    expect(closed).toBe(false);
    release.resolve();
    await expect(active).resolves.toBe("settled");
    await closing;
    expect(closed).toBe(true);
  });

  it("reads option getters once and rejects callback reentrancy", async () => {
    let maximumReads = 0;
    const gate = new ArtifactMutationGate({
      get maximumPendingOperations() {
        maximumReads += 1;
        return 2;
      },
    });
    let deadlineReads = 0;
    let signalReads = 0;
    const signal = new AbortController().signal;
    const options = {
      get deadline() {
        deadlineReads += 1;
        return performance.now() + 5_000;
      },
      get signal() {
        signalReads += 1;
        return signal;
      },
    };

    await expect(gate.run(options, () => "ok")).resolves.toBe("ok");
    expect(maximumReads).toBe(1);
    expect(deadlineReads).toBe(1);
    expect(signalReads).toBe(1);

    const nested = await gate.run(admission(), async () =>
      gate.run(admission(), () => "nested").catch((error: unknown) => error),
    );
    expect(nested).toBeInstanceOf(ArtifactMutationGateError);
    expect(nested).toMatchObject({ code: "ARTIFACT_MUTATION_GATE_REENTRANT" });
    await gate.close();
  });

  it("rechecks lifecycle state after an option getter reenters close", async () => {
    const gate = new ArtifactMutationGate({ maximumPendingOperations: 1 });
    let callbackCalled = false;
    let closePromise: Promise<void> | undefined;
    const options = {
      get deadline() {
        closePromise = gate.close();
        return performance.now() + 5_000;
      },
    };

    await expect(
      gate.run(options, () => {
        callbackCalled = true;
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_MUTATION_GATE_CLOSED" });
    expect(closePromise).toBeInstanceOf(Promise);
    await closePromise;
    expect(callbackCalled).toBe(false);
  });

  it("reserves admission while reading options so a getter cannot enqueue first", async () => {
    const gate = new ArtifactMutationGate({ maximumPendingOperations: 2 });
    let nested: Promise<string> | undefined;
    const options = {
      get deadline() {
        nested = gate.run(admission(), () => "nested");
        return performance.now() + 5_000;
      },
    };

    const outer = gate.run(options, () => "outer");
    const nestedAdmission = nested;
    expect(nestedAdmission).toBeInstanceOf(Promise);
    await expect(nestedAdmission).rejects.toMatchObject({
      code: "ARTIFACT_MUTATION_GATE_REENTRANT",
      callbackStarted: false,
    });
    await expect(outer).resolves.toBe("outer");
    await gate.close();
  });

  it("rejects close from an active callback without closing the gate", async () => {
    const gate = new ArtifactMutationGate({ maximumPendingOperations: 1 });
    const reentrant = await gate.run(admission(), () =>
      gate.close().catch((error: unknown) => error),
    );

    expect(reentrant).toBeInstanceOf(ArtifactMutationGateError);
    expect(reentrant).toMatchObject({ code: "ARTIFACT_MUTATION_GATE_REENTRANT" });
    await expect(gate.run(admission(), () => "still-open")).resolves.toBe("still-open");
    await gate.close();
  });

  it("keeps thenable adoption inside the reentrancy boundary", async () => {
    const gate = new ArtifactMutationGate({ maximumPendingOperations: 2 });
    let nested: Promise<string> | undefined;
    const result = gate.run(
      admission(),
      () =>
        ({
          // biome-ignore lint/suspicious/noThenProperty: This test exercises hostile thenable adoption.
          then(resolve: (value: string) => void) {
            nested = gate.run(admission(), () => "nested");
            void nested.catch(() => undefined);
            resolve("adopted");
          },
        }) as Promise<string>,
    );

    await expect(result).resolves.toBe("adopted");
    expect(nested).toBeInstanceOf(Promise);
    await expect(nested).rejects.toMatchObject({
      code: "ARTIFACT_MUTATION_GATE_REENTRANT",
      callbackStarted: false,
    });
    await gate.close();
  });

  it("adopts a native Promise with an overridden then inside the boundary", async () => {
    const gate = new ArtifactMutationGate({ maximumPendingOperations: 2 });
    const promiseThen = Promise.prototype.then;
    const returned = Promise.resolve("adopted");
    let nested: Promise<string> | undefined;
    // biome-ignore lint/suspicious/noThenProperty: This test exercises an overridden native then.
    Object.defineProperty(returned, "then", {
      value(resolve: (value: string) => void, reject: (error: unknown) => void) {
        nested = gate.run(admission(), () => "nested");
        void nested.catch(() => undefined);
        return Reflect.apply(promiseThen, returned, [resolve, reject]);
      },
    });

    await expect(gate.run(admission(), () => returned)).resolves.toBe("adopted");
    expect(nested).toBeInstanceOf(Promise);
    await expect(nested).rejects.toMatchObject({
      code: "ARTIFACT_MUTATION_GATE_REENTRANT",
      callbackStarted: false,
    });
    await gate.close();
  });

  it("cancels accepted work when close wins before its callback starts", async () => {
    const gate = new ArtifactMutationGate({ maximumPendingOperations: 1 });
    let callbackCalled = false;
    const accepted = gate.run(admission(), () => {
      callbackCalled = true;
    });
    const closing = gate.close();

    await expect(accepted).rejects.toMatchObject({
      code: "ARTIFACT_MUTATION_GATE_CLOSED",
      callbackStarted: false,
    });
    await closing;
    expect(callbackCalled).toBe(false);
  });
});
