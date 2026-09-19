import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  InvestigationOutputBatchRequest,
  InvestigationOutputBatchResponse,
  InvestigationOutputEventInput,
  InvestigationWorkerLease,
} from "@agentic-review/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvestigationWorkerClientError } from "./http-client.js";
import type { ModelOutputObservation } from "./model-output-observer.js";
import {
  DurableInvestigationOutputJournal,
  type InvestigationOutputJournalOptions,
} from "./output-journal.js";
import { createInvestigationOutputReporter } from "./output-reporter.js";

const storageInterceptions = vi.hoisted(() => ({
  mkdir: new Map<string, () => Promise<void>>(),
  rename: new Map<string, () => Promise<void>>(),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      if (typeof args[0] === "string") await storageInterceptions.mkdir.get(args[0])?.();
      return actual.mkdir(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (typeof args[1] === "string") await storageInterceptions.rename.get(args[1])?.();
      return actual.rename(...args);
    },
  };
});

const directories: string[] = [];
const journals: DurableInvestigationOutputJournal[] = [];
const taskId = "output-task";
const lease: InvestigationWorkerLease = {
  attemptId: "output-attempt",
  fence: 7,
  leaseToken: "synthetic-original-output-lease",
};
const observedAt = "2026-09-20T08:00:00.000Z";

interface RetainedOutputFixture {
  taskId: string;
  attemptId: string;
  nextSequence: number;
  open: boolean;
  dropped: number;
  batches: Array<{ batchId: string; events: InvestigationOutputEventInput[] }>;
  terminalDeliveryFailure?: {
    code: "output_lease_lost";
    batchId: string;
    recordedAt: string;
  };
}

afterEach(async () => {
  storageInterceptions.mkdir.clear();
  storageInterceptions.rename.clear();
  vi.restoreAllMocks();
  for (const journal of journals.splice(0)) await journal.stop(50);
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function directory(): Promise<string> {
  const result = await mkdtemp(join(tmpdir(), "visible-output-journal-"));
  directories.push(result);
  return result;
}

function journal(options: InvestigationOutputJournalOptions): DurableInvestigationOutputJournal {
  const result = new DurableInvestigationOutputJournal({
    retryDelayMs: 60_000,
    now: () => new Date(observedAt),
    ...options,
  });
  journals.push(result);
  return result;
}

function observation(itemId: string, text = itemId): ModelOutputObservation {
  return { itemId, kind: "assistant", operation: "append", text };
}

function acknowledge(
  requestedTaskId: string,
  request: InvestigationOutputBatchRequest,
  duplicate = false,
): InvestigationOutputBatchResponse {
  const lastSequence = request.events.at(-1)!.producerSequence;
  return {
    taskId: requestedTaskId,
    attemptId: request.lease.attemptId,
    batchId: request.batchId,
    lastAcceptedProducerSequence: lastSequence,
    cursor: `synthetic-cursor-${lastSequence}`,
    duplicate,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function entryPath(path: string, requestedTaskId = taskId, attemptId = lease.attemptId): string {
  const key = createHash("sha256").update(`${requestedTaskId}\0${attemptId}`).digest("hex");
  return join(path, `${key}.json`);
}

async function retained(
  path: string,
  requestedTaskId = taskId,
  attemptId = lease.attemptId,
): Promise<RetainedOutputFixture> {
  return JSON.parse(
    await readFile(entryPath(path, requestedTaskId, attemptId), "utf8"),
  ) as RetainedOutputFixture;
}

async function retainedFiles(path: string): Promise<Record<string, string>> {
  const names = (await readdir(path))
    .filter((name) => /^[a-f0-9]{64}(?:\.delivery)?\.json$/u.test(name))
    .sort();
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [name, await readFile(join(path, name), "utf8")] as const),
    ),
  );
}

function omittedCount(events: readonly InvestigationOutputEventInput[]): number {
  return events
    .filter((event) => event.kind === "gap")
    .reduce((total, event) => {
      const count = /^(\d+) visible output record\(s\) were omitted/u.exec(event.text)?.[1];
      expect(count).toBeDefined();
      return total + Number(count);
    }, 0);
}

function interceptJournalStorage(
  phase: "load" | "persist",
  path: string,
  work: () => Promise<void>,
): () => void {
  const interceptions = phase === "load" ? storageInterceptions.mkdir : storageInterceptions.rename;
  const key = phase === "load" ? path : entryPath(path);
  interceptions.set(key, work);
  return () => {
    interceptions.delete(key);
  };
}

async function retainInterruptedOutput(path: string): Promise<InvestigationOutputBatchRequest> {
  const requests: InvestigationOutputBatchRequest[] = [];
  const original = journal({
    directory: path,
    deliver: async (_requestedTaskId, request) => {
      requests.push(structuredClone(request));
      throw new Error("Synthetic offline transport before restart.");
    },
  });
  await original.openAttempt(taskId, lease);
  original.append(taskId, lease.attemptId, "original-invocation", observation("original-item"));
  expect(await original.flush()).toBe(false);
  expect(await original.stop(10)).toBe(false);
  expect(requests).toHaveLength(1);
  return requests[0]!;
}

describe("durable Worker visible output journal", () => {
  it("retries an accepted batch after a lost acknowledgement without changing its identity or order", async () => {
    const path = await directory();
    const received: InvestigationOutputBatchRequest[] = [];
    const accepted = new Set<string>();
    const output = journal({
      directory: path,
      deliver: async (requestedTaskId, request) => {
        received.push(structuredClone(request));
        const duplicate = accepted.has(request.batchId);
        accepted.add(request.batchId);
        if (received.length === 1)
          throw new Error("Synthetic acknowledgement loss after acceptance.");
        return acknowledge(requestedTaskId, request, duplicate);
      },
    });
    await output.openAttempt(taskId, lease);
    for (let index = 0; index < 70; index++)
      output.append(taskId, lease.attemptId, "invocation-one", observation(`item-${index}`));
    output.closeAttempt(taskId, lease.attemptId);

    expect(await output.flush()).toBe(false);
    expect(received).toHaveLength(1);
    const pending = await retained(path);
    expect(pending.batches.map((batch) => batch.events.length)).toEqual([64, 6]);
    const retryTime = Date.now() + 60_001;
    vi.spyOn(Date, "now").mockReturnValue(retryTime);

    expect(await output.flush()).toBe(true);
    expect(received).toHaveLength(3);
    expect(received[1]).toEqual(received[0]);
    expect(received.slice(1).map((batch) => batch.batchId)).toEqual(
      pending.batches.map((batch) => batch.batchId),
    );
    expect(
      received.slice(1).flatMap((batch) => batch.events.map((event) => event.producerSequence)),
    ).toEqual(Array.from({ length: 70 }, (_, index) => index + 1));
    expect(accepted.size).toBe(2);
    expect(await retained(path)).toMatchObject({
      nextSequence: 71,
      batches: [],
      dropped: 0,
      open: false,
    });
  });

  it("replays the original committed batch and lease after restart and marks an interrupted producer", async () => {
    const path = await directory();
    const callerLease = structuredClone(lease);
    const originalRequests: InvestigationOutputBatchRequest[] = [];
    const original = journal({
      directory: path,
      deliver: async (_requestedTaskId, request) => {
        originalRequests.push(structuredClone(request));
        throw new Error("Synthetic offline transport.");
      },
    });
    await original.openAttempt(taskId, callerLease);
    callerLease.fence = 99;
    callerLease.leaseToken = "synthetic-mutated-caller-lease";
    original.append(taskId, lease.attemptId, "original-invocation", observation("original-item"));
    expect(await original.flush()).toBe(false);
    expect(await original.stop(10)).toBe(false);

    const replayed: InvestigationOutputBatchRequest[] = [];
    const restarted = journal({
      directory: path,
      deliver: async (requestedTaskId, request) => {
        replayed.push(structuredClone(request));
        return acknowledge(requestedTaskId, request, true);
      },
    });
    await expect(restarted.openAttempt(taskId, { ...lease, fence: 8 })).rejects.toThrow(
      /original delivery lease/u,
    );
    expect(await restarted.flush()).toBe(true);
    expect(replayed[0]).toEqual(originalRequests[0]);
    expect(
      replayed.every((request) => JSON.stringify(request.lease) === JSON.stringify(lease)),
    ).toBe(true);
    expect(replayed.flatMap((request) => request.events)).toMatchObject([
      { producerSequence: 1, invocationId: "original-invocation", text: "original-item" },
      {
        producerSequence: 2,
        invocationId: null,
        kind: "gap",
        text: expect.stringMatching(/Worker restarted/u),
      },
    ]);
    expect(await retained(path)).toMatchObject({ nextSequence: 3, open: false, batches: [] });
    await restarted.replay();
    expect(await restarted.flush()).toBe(true);
    expect(replayed).toHaveLength(2);
  });

  it("keeps one sequence across invocations and isolates item identities and sequences across attempts", async () => {
    const received: InvestigationOutputEventInput[] = [];
    const secondLease = { ...lease, attemptId: "second-output-attempt", fence: 8 };
    const output = journal({
      directory: await directory(),
      deliver: async (requestedTaskId, request) => {
        received.push(...request.events);
        return acknowledge(requestedTaskId, request);
      },
    });
    await output.openAttempt(taskId, lease);
    await output.openAttempt(taskId, secondLease);
    output.append(taskId, lease.attemptId, "invocation-one", observation("provider-item", "first"));
    output.append(
      taskId,
      lease.attemptId,
      "invocation-two",
      observation("provider-item", "second"),
    );
    output.append(taskId, lease.attemptId, "invocation-one", {
      ...observation("provider-item", "updated first"),
      operation: "replace",
    });
    output.append(
      taskId,
      secondLease.attemptId,
      "invocation-three",
      observation("provider-item", "other attempt"),
    );
    expect(await output.flush()).toBe(true);

    const first = received.filter((event) => event.attemptId === lease.attemptId);
    const second = received.filter((event) => event.attemptId === secondLease.attemptId);
    expect(
      first.map((event) => [event.invocationId, event.producerSequence, event.operation]),
    ).toEqual([
      ["invocation-one", 1, "append"],
      ["invocation-two", 2, "append"],
      ["invocation-one", 3, "replace"],
    ]);
    expect(first[0]!.itemId).toBe(first[2]!.itemId);
    expect(first[0]!.itemId).not.toBe(first[1]!.itemId);
    expect(second.map((event) => event.producerSequence)).toEqual([1]);
    expect(received.every((event) => event.observedAt === observedAt)).toBe(true);
  });

  it("preserves the terminal producer boundary across restart without inventing a restart gap", async () => {
    const path = await directory();
    const original = journal({
      directory: path,
      deliver: async () => {
        throw new Error("Synthetic offline transport.");
      },
    });
    await original.openAttempt(taskId, lease);
    original.append(taskId, lease.attemptId, "closed-invocation", observation("before-close"));
    original.closeAttempt(taskId, lease.attemptId);
    original.append(taskId, lease.attemptId, "closed-invocation", observation("after-close"));
    expect(await original.flush()).toBe(false);
    expect(await original.stop(10)).toBe(false);

    const received: InvestigationOutputEventInput[] = [];
    const restarted = journal({
      directory: path,
      deliver: async (requestedTaskId, request) => {
        received.push(...request.events);
        return acknowledge(requestedTaskId, request);
      },
    });
    await expect(restarted.openAttempt(taskId, lease)).rejects.toThrow(/closed.*cannot reopen/u);
    restarted.append(taskId, lease.attemptId, "closed-invocation", observation("after-restart"));
    expect(await restarted.flush()).toBe(true);
    expect(received.map((event) => [event.kind, event.text, event.producerSequence])).toEqual([
      ["assistant", "before-close", 1],
    ]);
    expect(await retained(path)).toMatchObject({ nextSequence: 2, open: false, batches: [] });
  });

  it("persists only allowlisted sanitized public fields and keeps the delivery lease separate", async () => {
    const path = await directory();
    const protectedValue = "synthetic-private-provider-key";
    const received: InvestigationOutputBatchRequest[] = [];
    const output = journal({
      directory: path,
      protectedValues: [protectedValue],
      deliver: async (_requestedTaskId, request) => {
        received.push(structuredClone(request));
        throw new Error("Synthetic offline transport.");
      },
    });
    await output.openAttempt(taskId, lease);
    const untrusted = {
      ...observation(lease.leaseToken, `visible ${protectedValue} ${lease.leaseToken}`),
      kind: "tool" as const,
      command: `echo ${protectedValue}`,
      result: `result ${lease.leaseToken}`,
      status: "completed" as const,
      providerEnvelope: {
        secret: "synthetic-raw-envelope",
        reasoning: "synthetic-hidden-reasoning",
      },
      leaseToken: "synthetic-unexpected-field",
    };
    output.append(taskId, lease.attemptId, "safe-invocation", untrusted);
    output.closeAttempt(taskId, lease.attemptId);
    expect(await output.flush()).toBe(false);

    const publicRecord = await readFile(entryPath(path), "utf8");
    const publicEvents = JSON.stringify(received.flatMap((request) => request.events));
    for (const secret of [
      protectedValue,
      lease.leaseToken,
      "synthetic-raw-envelope",
      "synthetic-hidden-reasoning",
      "synthetic-unexpected-field",
    ])
      expect(`${publicRecord}\n${publicEvents}`).not.toContain(secret);
    expect(publicRecord).not.toContain("providerEnvelope");
    expect(publicRecord).not.toContain("leaseToken");
    expect(received[0]!.events[0]).toMatchObject({
      kind: "tool",
      status: "completed",
      invocationId: "safe-invocation",
    });
    expect(received[0]!.events[0]!.itemId).toMatch(/^output-[a-f0-9]{64}$/u);
    const deliveryPath = entryPath(path).replace(/\.json$/u, ".delivery.json");
    expect(JSON.parse(await readFile(deliveryPath, "utf8"))).toEqual(lease);
  });

  it("reports memory overflow explicitly while keeping accepted output and producer calls synchronous", async () => {
    const received: InvestigationOutputEventInput[] = [];
    const output = journal({
      directory: await directory(),
      maximumMemoryBytes: 1_024,
      deliver: async (requestedTaskId, request) => {
        received.push(...request.events);
        return acknowledge(requestedTaskId, request);
      },
    });
    await output.openAttempt(taskId, lease);
    expect(
      output.append(taskId, lease.attemptId, "invocation", observation("kept", "visible output")),
    ).toBeUndefined();
    for (let index = 0; index < 8; index++)
      expect(
        output.append(
          taskId,
          lease.attemptId,
          "invocation",
          observation(`overflow-${index}`, "x".repeat(900)),
        ),
      ).toBeUndefined();
    expect(await output.flush()).toBe(true);
    expect(received.filter((event) => event.kind !== "gap").map((event) => event.text)).toEqual([
      "visible output",
    ]);
    expect(received[0]).toMatchObject({ kind: "assistant", text: "visible output" });
    expect(received.at(-1)).toMatchObject({ kind: "gap" });
    expect(omittedCount(received)).toBe(8);
    expect(received.map((event) => event.producerSequence)).toEqual(
      Array.from({ length: received.length }, (_, index) => index + 1),
    );
  });

  it("bounds retained bytes during an outage and delivers a counted gap after space becomes available", async () => {
    const path = await directory();
    const started = deferred<void>();
    const release = deferred<void>();
    const received: InvestigationOutputEventInput[] = [];
    const output = journal({
      directory: path,
      maximumAttemptBytes: 2_048,
      deliver: async (requestedTaskId, request) => {
        received.push(...request.events);
        started.resolve();
        await release.promise;
        return acknowledge(requestedTaskId, request);
      },
    });
    await output.openAttempt(taskId, lease);
    for (let index = 0; index < 40; index++)
      output.append(
        taskId,
        lease.attemptId,
        "invocation",
        observation(`item-${index}`, "x".repeat(256)),
      );
    output.closeAttempt(taskId, lease.attemptId);
    await started.promise;
    const beforeAcknowledgement = await readFile(entryPath(path), "utf8");
    expect(Buffer.byteLength(beforeAcknowledgement)).toBeLessThanOrEqual(2_048);
    expect((JSON.parse(beforeAcknowledgement) as RetainedOutputFixture).dropped).toBeGreaterThan(0);

    release.resolve();
    expect(await output.flush()).toBe(true);
    const visibleCount = received.filter((event) => event.kind !== "gap").length;
    expect(visibleCount).toBeGreaterThan(0);
    expect(visibleCount).toBeLessThan(40);
    expect(omittedCount(received) + visibleCount).toBe(40);
    expect(received.at(-1)).toMatchObject({ kind: "gap" });
    expect(await retained(path)).toMatchObject({ dropped: 0, batches: [], open: false });
  });

  it("continues other attempts when transport and the failure observer both reject", async () => {
    const path = await directory();
    const secondLease = { ...lease, attemptId: "independent-attempt" };
    const received: string[] = [];
    const onFailure = vi.fn(() => {
      throw new Error("Synthetic diagnostic failure.");
    });
    const output = journal({
      directory: path,
      onFailure,
      deliver: async (requestedTaskId, request) => {
        received.push(request.lease.attemptId);
        if (request.lease.attemptId === lease.attemptId)
          throw new Error("Synthetic attempt transport failure.");
        return acknowledge(requestedTaskId, request);
      },
    });
    await output.openAttempt(taskId, lease);
    await output.openAttempt(taskId, secondLease);
    output.append(taskId, lease.attemptId, "first-invocation", observation("first"));
    output.append(taskId, secondLease.attemptId, "second-invocation", observation("second"));
    expect(await output.flush()).toBe(false);
    expect(received).toEqual([lease.attemptId, secondLease.attemptId]);
    expect(onFailure).toHaveBeenCalled();
    expect((await retained(path)).batches).toHaveLength(1);
    expect((await retained(path, taskId, secondLease.attemptId)).batches).toEqual([]);
  });

  it("enforces request timeouts even when a transport ignores cancellation and still serves another attempt", async () => {
    const secondLease = { ...lease, attemptId: "after-timeout-attempt" };
    const received: string[] = [];
    const signals: AbortSignal[] = [];
    const output = journal({
      directory: await directory(),
      requestTimeoutMs: 20,
      deliver: async (requestedTaskId, request, signal) => {
        received.push(request.lease.attemptId);
        signals.push(signal);
        if (request.lease.attemptId === lease.attemptId)
          return new Promise<InvestigationOutputBatchResponse>(() => undefined);
        return acknowledge(requestedTaskId, request);
      },
    });
    await output.openAttempt(taskId, lease);
    await output.openAttempt(taskId, secondLease);
    output.append(taskId, lease.attemptId, "hanging-invocation", observation("hanging"));
    output.append(
      taskId,
      secondLease.attemptId,
      "independent-invocation",
      observation("independent"),
    );
    expect(await output.flush(1_000)).toBe(false);
    expect(received).toEqual([lease.attemptId, secondLease.attemptId]);
    expect(signals[0]!.aborted).toBe(true);
  });

  it("does not remove a committed batch when the acknowledgement names another sequence", async () => {
    const path = await directory();
    const received: InvestigationOutputBatchRequest[] = [];
    const output = journal({
      directory: path,
      deliver: async (requestedTaskId, request) => {
        received.push(structuredClone(request));
        return { ...acknowledge(requestedTaskId, request), lastAcceptedProducerSequence: 100 };
      },
    });
    await output.openAttempt(taskId, lease);
    output.append(taskId, lease.attemptId, "invocation", observation("unacknowledged"));
    expect(await output.flush()).toBe(false);
    expect((await retained(path)).batches).toEqual([
      { batchId: received[0]!.batchId, events: received[0]!.events },
    ]);
  });

  it("returns from bounded flush and stop, aborts delivery, and rejects further producer activity", async () => {
    const path = await directory();
    const started = deferred<AbortSignal>();
    const output = journal({
      directory: path,
      requestTimeoutMs: 30_000,
      deliver: async (_requestedTaskId, _request, signal) => {
        started.resolve(signal);
        return new Promise<InvestigationOutputBatchResponse>(() => undefined);
      },
    });
    await output.openAttempt(taskId, lease);
    output.append(taskId, lease.attemptId, "invocation", observation("durable-before-stop"));
    const signal = await started.promise;
    expect(await output.flush(10)).toBe(false);
    expect(signal.aborted).toBe(false);
    expect(await output.stop(10)).toBe(false);
    expect(signal.aborted).toBe(true);
    output.append(taskId, lease.attemptId, "invocation", observation("ignored-after-stop"));
    await expect(
      output.openAttempt("after-stop-task", { ...lease, attemptId: "after-stop-attempt" }),
    ).rejects.toThrow(/identity is invalid/u);
    await output.replay();
    expect(
      (await retained(path)).batches.flatMap((batch) => batch.events.map((event) => event.text)),
    ).toEqual(["durable-before-stop"]);
  });

  it.each(["load", "persist"] as const)(
    "coalesces repeated replay calls while storage %s is pending and recovers every retained record",
    async (phase) => {
      const path = await directory();
      const originalRequest = await retainInterruptedOutput(path);
      const started = deferred<void>();
      const release = deferred<void>();
      const blockedStorage = vi.fn(async () => {
        started.resolve();
        await release.promise;
      });
      const removeInterception = interceptJournalStorage(phase, path, blockedStorage);
      const requests: InvestigationOutputBatchRequest[] = [];
      const output = journal({
        directory: path,
        deliver: async (requestedTaskId, request) => {
          requests.push(structuredClone(request));
          return acknowledge(requestedTaskId, request);
        },
      });
      const replaying = output.replay();
      try {
        await started.promise;
        for (let index = 0; index < 128; index++) expect(output.replay()).toBe(replaying);
        expect(await output.flush(10)).toBe(false);
        expect(output.replay()).toBe(replaying);
        expect(blockedStorage).toHaveBeenCalledTimes(1);
        expect(requests).toEqual([]);

        removeInterception();
        release.resolve();
        await replaying;
        expect(await output.flush()).toBe(true);
        expect(requests[0]).toEqual(originalRequest);
        expect(requests.flatMap((request) => request.events)).toMatchObject([
          { producerSequence: 1, invocationId: "original-invocation", text: "original-item" },
          { producerSequence: 2, kind: "gap", text: expect.stringMatching(/Worker restarted/u) },
        ]);
        expect(await retained(path)).toMatchObject({ nextSequence: 3, open: false, batches: [] });

        const nextReplay = output.replay();
        expect(nextReplay).not.toBe(replaying);
        await nextReplay;
        expect(requests).toHaveLength(2);
      } finally {
        removeInterception();
        release.resolve();
        await replaying.catch(() => undefined);
      }
    },
  );

  it.each(["load", "persist"] as const)(
    "stops within its deadline during a pending storage %s and preserves delivery for restart",
    async (phase) => {
      const path = await directory();
      const originalRequest = await retainInterruptedOutput(path);
      const started = deferred<void>();
      const release = deferred<void>();
      const removeInterception = interceptJournalStorage(phase, path, async () => {
        started.resolve();
        await release.promise;
      });
      const delivered = vi.fn<InvestigationOutputJournalOptions["deliver"]>(
        async (requestedTaskId, request) => acknowledge(requestedTaskId, request),
      );
      const output = journal({ directory: path, deliver: delivered });
      const replaying = output.replay();
      try {
        await started.promise;
        expect(await output.stop(10)).toBe(false);
        expect(delivered).not.toHaveBeenCalled();
        removeInterception();
        release.resolve();
        await replaying;
        expect(delivered).not.toHaveBeenCalled();
        expect((await retained(path)).batches[0]).toEqual({
          batchId: originalRequest.batchId,
          events: originalRequest.events,
        });

        const requests: InvestigationOutputBatchRequest[] = [];
        const restarted = journal({
          directory: path,
          deliver: async (requestedTaskId, request) => {
            requests.push(structuredClone(request));
            return acknowledge(requestedTaskId, request);
          },
        });
        await restarted.replay();
        expect(await restarted.flush()).toBe(true);
        expect(requests[0]).toEqual(originalRequest);
        expect(requests.flatMap((request) => request.events)).toMatchObject([
          { producerSequence: 1, text: "original-item" },
          { producerSequence: 2, kind: "gap", text: expect.stringMatching(/Worker restarted/u) },
        ]);
        expect(await retained(path)).toMatchObject({ nextSequence: 3, open: false, batches: [] });
      } finally {
        removeInterception();
        release.resolve();
        await replaying.catch(() => undefined);
      }
    },
  );

  it.each(["load", "persist"] as const)(
    "permits a new replay after a storage %s failure without discarding unacknowledged output",
    async (phase) => {
      const path = await directory();
      const originalRequest = await retainInterruptedOutput(path);
      const removeInterception = interceptJournalStorage(phase, path, async () => {
        throw new Error("Synthetic journal storage failure.");
      });
      const requests: InvestigationOutputBatchRequest[] = [];
      const output = journal({
        directory: path,
        deliver: async (requestedTaskId, request) => {
          requests.push(structuredClone(request));
          return acknowledge(requestedTaskId, request);
        },
      });
      const failedReplay = output.replay();
      try {
        expect(output.replay()).toBe(failedReplay);
        await expect(failedReplay).rejects.toThrow("Synthetic journal storage failure.");
        expect(requests).toEqual([]);
      } finally {
        removeInterception();
      }

      const retry = output.replay();
      expect(retry).not.toBe(failedReplay);
      expect(output.replay()).toBe(retry);
      await retry;
      expect(await output.flush()).toBe(true);
      expect(requests[0]).toEqual(originalRequest);
      expect(requests.flatMap((request) => request.events)).toMatchObject([
        { producerSequence: 1, text: "original-item" },
        { producerSequence: 2, kind: "gap", text: expect.stringMatching(/Worker restarted/u) },
      ]);
      expect(await retained(path)).toMatchObject({ nextSequence: 3, open: false, batches: [] });
    },
  );

  it("rejects a new attempt explicitly when undelivered attempts fill retention capacity", async () => {
    const path = await directory();
    const output = journal({
      directory: path,
      maximumAttempts: 1,
      deliver: async () => {
        throw new Error("Synthetic retained transport outage.");
      },
    });
    await output.openAttempt(taskId, lease);
    output.append(taskId, lease.attemptId, "invocation", observation("retained-output"));
    output.closeAttempt(taskId, lease.attemptId);
    expect(await output.flush()).toBe(false);
    await expect(
      output.openAttempt(taskId, { ...lease, attemptId: "capacity-overflow-attempt" }),
    ).rejects.toThrow(/attempt limit/u);
    expect(
      (await retained(path)).batches.flatMap((batch) => batch.events.map((event) => event.text)),
    ).toEqual(["retained-output"]);
  });
});

describe("terminal visible output delivery failures", () => {
  it.each([
    { scenario: "first output from an unestablished terminal attempt", established: false },
    { scenario: "an established stream beyond its terminal drain window", established: true },
  ])(
    "quarantines $scenario without consuming active capacity or retrying after restart",
    async ({ established }) => {
      const path = await directory();
      const protectedValue = "synthetic-quarantined-provider-secret";
      let clock = new Date(observedAt);
      const requests: InvestigationOutputBatchRequest[] = [];
      const onTerminalFailure = vi.fn();
      const output = journal({
        directory: path,
        maximumAttempts: 1,
        protectedValues: [protectedValue],
        now: () => clock,
        onTerminalFailure,
        deliver: async (requestedTaskId, request) => {
          requests.push(structuredClone(request));
          if (
            request.lease.attemptId === lease.attemptId &&
            (!established || request.events[0]!.producerSequence > 1)
          ) {
            const failure = new InvestigationWorkerClientError("output_lease_lost", false, 409);
            failure.message = `Synthetic remote detail ${protectedValue} ${lease.leaseToken}`;
            throw failure;
          }
          return acknowledge(requestedTaskId, request);
        },
      });
      await output.openAttempt(taskId, lease);
      if (established) {
        output.append(taskId, lease.attemptId, "invocation", observation("accepted-prefix"));
        expect(await output.flush()).toBe(true);
        clock = new Date(clock.getTime() + 24 * 60 * 60 * 1_000 + 1);
      }
      // The transport fixture supplies the permanent decision; server tests own drain admission.
      output.append(
        taskId,
        lease.attemptId,
        "invocation",
        observation("undeliverable", `retained ${protectedValue} ${lease.leaseToken}`),
      );
      output.closeAttempt(taskId, lease.attemptId);
      expect(await output.flush()).toBe(false);

      const rejected = requests.at(-1)!;
      const archived = await retained(path);
      expect(archived).toMatchObject({
        nextSequence: established ? 3 : 2,
        open: false,
        dropped: 0,
        batches: [{ batchId: rejected.batchId, events: rejected.events }],
      });
      expect(archived.terminalDeliveryFailure).toEqual({
        code: "output_lease_lost",
        batchId: rejected.batchId,
        recordedAt: clock.toISOString(),
      });
      expect(archived.batches).toHaveLength(1);
      expect(rejected.lease).toEqual(lease);
      const archivedText = await readFile(entryPath(path), "utf8");
      expect(archivedText).not.toContain(protectedValue);
      expect(archivedText).not.toContain(lease.leaseToken);
      expect(archivedText).not.toContain("Synthetic remote detail");
      expect(archivedText).not.toContain("accepted-prefix");
      const leaseText = await readFile(
        entryPath(path).replace(/\.json$/u, ".delivery.json"),
        "utf8",
      );
      expect(JSON.parse(leaseText)).toEqual(lease);
      expect(onTerminalFailure).toHaveBeenCalledExactlyOnceWith({
        taskId,
        attemptId: lease.attemptId,
        code: "output_lease_lost",
      });
      expect(JSON.stringify(onTerminalFailure.mock.calls)).not.toContain("Synthetic remote detail");

      await expect(output.openAttempt(taskId, lease)).rejects.toThrow();
      output.append(taskId, lease.attemptId, "invocation", observation("after-quarantine"));
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_001);
      await output.replay();
      expect(await output.flush()).toBe(false);
      expect(requests).toHaveLength(established ? 2 : 1);

      const nextLease = { ...lease, attemptId: "after-quarantine-attempt", fence: 8 };
      await output.openAttempt(taskId, nextLease);
      output.append(taskId, nextLease.attemptId, "next-invocation", observation("new-output"));
      output.closeAttempt(taskId, nextLease.attemptId);
      expect(await output.flush()).toBe(false);
      expect(requests.at(-1)!.lease).toEqual(nextLease);
      expect((await retained(path, taskId, nextLease.attemptId)).batches).toEqual([]);
      expect(await output.stop(10)).toBe(false);

      const replayed: InvestigationOutputBatchRequest[] = [];
      const restarted = journal({
        directory: path,
        maximumAttempts: 1,
        deliver: async (requestedTaskId, request) => {
          replayed.push(structuredClone(request));
          return acknowledge(requestedTaskId, request);
        },
      });
      await restarted.replay();
      expect(await restarted.flush()).toBe(false);
      expect(replayed).toEqual([]);
      await expect(restarted.openAttempt(taskId, lease)).rejects.toThrow();
      const restartedLease = { ...lease, attemptId: "after-restart-attempt", fence: 9 };
      await restarted.openAttempt(taskId, restartedLease);
      restarted.append(
        taskId,
        restartedLease.attemptId,
        "restarted-invocation",
        observation("live"),
      );
      restarted.closeAttempt(taskId, restartedLease.attemptId);
      expect(await restarted.flush()).toBe(false);
      expect(replayed.map((request) => request.lease.attemptId)).toEqual([
        restartedLease.attemptId,
      ]);
      expect(await readFile(entryPath(path), "utf8")).toBe(archivedText);
      expect(await readFile(entryPath(path).replace(/\.json$/u, ".delivery.json"), "utf8")).toBe(
        leaseText,
      );
    },
  );

  it("retains the pending tail and explicit overflow when rejection arrives during production", async () => {
    const path = await directory();
    const started = deferred<InvestigationOutputBatchRequest>();
    const rejectDelivery = deferred<void>();
    const onTerminalFailure = vi.fn(() => {
      throw new Error("Synthetic confidential diagnostic failure.");
    });
    const output = journal({
      directory: path,
      maximumMemoryBytes: 1_024,
      maximumAttemptBytes: 2_048,
      onTerminalFailure,
      deliver: async (_requestedTaskId, request) => {
        started.resolve(structuredClone(request));
        await rejectDelivery.promise;
        throw new InvestigationWorkerClientError("output_lease_lost", false, 409);
      },
    });
    await output.openAttempt(taskId, lease);
    output.append(taskId, lease.attemptId, "invocation", observation("prefix"));
    const rejected = await started.promise;
    output.append(taskId, lease.attemptId, "invocation", observation("pending-tail"));
    for (let index = 0; index < 3; index++)
      output.append(
        taskId,
        lease.attemptId,
        "invocation",
        observation(`overflow-${index}`, "x".repeat(900)),
      );
    rejectDelivery.resolve();
    expect(await output.flush()).toBe(false);

    const archived = await retained(path);
    const events = archived.batches.flatMap((batch) => batch.events);
    expect(archived.batches[0]).toEqual({ batchId: rejected.batchId, events: rejected.events });
    expect(events.filter((event) => event.kind !== "gap").map((event) => event.text)).toEqual([
      "prefix",
      "pending-tail",
    ]);
    expect(omittedCount(events) + archived.dropped).toBe(3);
    expect(archived.nextSequence).toBe(events.length + 1);
    expect(archived.open).toBe(false);
    expect(archived.terminalDeliveryFailure?.batchId).toBe(rejected.batchId);
    expect(Buffer.byteLength(await readFile(entryPath(path), "utf8"))).toBeLessThanOrEqual(2_048);
    expect(JSON.stringify(archived)).not.toContain("confidential diagnostic failure");
    expect(onTerminalFailure).toHaveBeenCalledExactlyOnceWith({
      taskId,
      attemptId: lease.attemptId,
      code: "output_lease_lost",
    });
  });

  it.each([
    { code: "transport_error", retryable: true, statusCode: 503 },
    { code: "output_sequence_conflict", retryable: false, statusCode: 409 },
    { code: "output_lease_lost", retryable: true, statusCode: 409 },
    { code: "output_lease_lost", retryable: false, statusCode: 503 },
  ])(
    "keeps $code HTTP $statusCode retryable=$retryable outside terminal quarantine",
    async (failure) => {
      const path = await directory();
      const requests: InvestigationOutputBatchRequest[] = [];
      const onTerminalFailure = vi.fn();
      let available = false;
      const output = journal({
        directory: path,
        maximumAttempts: 1,
        onTerminalFailure,
        deliver: async (requestedTaskId, request) => {
          requests.push(structuredClone(request));
          if (!available)
            throw new InvestigationWorkerClientError(
              failure.code,
              failure.retryable,
              failure.statusCode,
            );
          return acknowledge(requestedTaskId, request);
        },
      });
      await output.openAttempt(taskId, lease);
      output.append(taskId, lease.attemptId, "invocation", observation("retryable-output"));
      output.closeAttempt(taskId, lease.attemptId);
      expect(await output.flush()).toBe(false);
      expect((await retained(path)).terminalDeliveryFailure).toBeUndefined();
      await expect(
        output.openAttempt(taskId, { ...lease, attemptId: "still-full-attempt" }),
      ).rejects.toThrow(/attempt limit/u);

      available = true;
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
      expect(await output.flush()).toBe(true);
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
      expect(onTerminalFailure).not.toHaveBeenCalled();
    },
  );

  it.each([
    { limit: "attempt count", maximumQuarantinedAttempts: 1, maximumQuarantinedBytes: 36_864 },
    { limit: "byte count", maximumQuarantinedAttempts: 8, maximumQuarantinedBytes: 18_432 },
  ])(
    "preserves evidence at the archive $limit limit and degrades optional reporting",
    async (limit) => {
      const path = await directory();
      const onTerminalFailure = vi.fn();
      const options = {
        directory: path,
        maximumAttempts: 2,
        maximumAttemptBytes: 2_048,
        maximumQuarantinedAttempts: limit.maximumQuarantinedAttempts,
        maximumQuarantinedBytes: limit.maximumQuarantinedBytes,
        onTerminalFailure,
        deliver: async (): Promise<InvestigationOutputBatchResponse> => {
          throw new InvestigationWorkerClientError("output_lease_lost", false, 409);
        },
      };
      const output = journal(options);
      await output.openAttempt(taskId, lease);
      output.append(taskId, lease.attemptId, "invocation", observation("preserved-evidence"));
      output.closeAttempt(taskId, lease.attemptId);
      expect(await output.flush()).toBe(false);
      const snapshot = await retainedFiles(path);
      expect(Object.keys(snapshot)).toHaveLength(2);
      expect(
        Object.values(snapshot).reduce((bytes, value) => bytes + Buffer.byteLength(value), 0),
      ).toBeLessThanOrEqual(limit.maximumQuarantinedBytes);

      const deniedLease = { ...lease, attemptId: "archive-capacity-attempt" };
      await expect(output.openAttempt(taskId, deniedLease)).rejects.toThrow();
      expect(onTerminalFailure).toHaveBeenCalledWith({
        taskId,
        attemptId: deniedLease.attemptId,
        code: "output_archive_capacity",
      });
      const onReporterFailure = vi.fn();
      const reporter = createInvestigationOutputReporter({
        journal: output,
        taskId,
        lease: deniedLease,
        onFailure: onReporterFailure,
      });
      await expect(reporter.start()).resolves.toBeUndefined();
      expect(() => reporter.system("Optional lifecycle observation.")).not.toThrow();
      await expect(reporter.close()).resolves.toBeUndefined();
      expect(onReporterFailure).toHaveBeenCalled();
      expect(await retainedFiles(path)).toEqual(snapshot);
      expect(await output.stop(10)).toBe(false);

      const restarted = journal(options);
      await restarted.replay();
      expect(await restarted.flush()).toBe(false);
      await expect(restarted.openAttempt(taskId, deniedLease)).rejects.toThrow();
      expect(await retainedFiles(path)).toEqual(snapshot);
      for (const call of onTerminalFailure.mock.calls) {
        expect(call).toHaveLength(1);
        expect(Object.keys(call[0] as object).sort()).toEqual(["attemptId", "code", "taskId"]);
      }
      expect(JSON.stringify(onTerminalFailure.mock.calls)).not.toContain(lease.leaseToken);
    },
  );

  it.each([
    { limit: "attempt count", maximumQuarantinedAttempts: 2, maximumQuarantinedBytes: 55_296 },
    { limit: "byte count", maximumQuarantinedAttempts: 8, maximumQuarantinedBytes: 36_864 },
  ])(
    "reserves worst-case archive $limit for active producers before admitting another",
    async (limit) => {
      const path = await directory();
      const onTerminalFailure = vi.fn();
      const output = journal({
        directory: path,
        maximumAttempts: 3,
        maximumAttemptBytes: 2_048,
        maximumQuarantinedAttempts: limit.maximumQuarantinedAttempts,
        maximumQuarantinedBytes: limit.maximumQuarantinedBytes,
        onTerminalFailure,
        deliver: async (requestedTaskId, request) => acknowledge(requestedTaskId, request),
      });
      await output.openAttempt(taskId, lease);
      await output.openAttempt(taskId, { ...lease, attemptId: "second-reserved-attempt" });
      const before = await retainedFiles(path);
      expect(Object.keys(before)).toHaveLength(4);
      const deniedLease = { ...lease, attemptId: "unreserved-attempt" };
      await expect(output.openAttempt(taskId, deniedLease)).rejects.toThrow();
      expect(onTerminalFailure).toHaveBeenCalledExactlyOnceWith({
        taskId,
        attemptId: deniedLease.attemptId,
        code: "output_archive_capacity",
      });
      expect(await retainedFiles(path)).toEqual(before);
    },
  );

  it.each(["before admission", "while queued"])(
    "does not publish a producer cancelled %s",
    async (timing) => {
      const path = await directory();
      const delivered = vi.fn<InvestigationOutputJournalOptions["deliver"]>(
        async (requestedTaskId, request) => acknowledge(requestedTaskId, request),
      );
      const output = journal({ directory: path, deliver: delivered });
      const controller = new AbortController();
      if (timing === "before admission") controller.abort();
      const opening = output.openAttempt(taskId, lease, controller.signal);
      if (timing === "while queued") controller.abort();
      await expect(opening).rejects.toThrow();
      output.append(taskId, lease.attemptId, "invocation", observation("cancelled-producer"));
      expect(await output.flush()).toBe(true);
      expect(delivered).not.toHaveBeenCalled();
      expect(await retainedFiles(path)).toEqual({});
    },
  );

  it("does not close an existing shared producer when a later caller cancels admission", async () => {
    const path = await directory();
    const delivered: InvestigationOutputEventInput[] = [];
    const output = journal({
      directory: path,
      deliver: async (requestedTaskId, request) => {
        delivered.push(...request.events);
        return acknowledge(requestedTaskId, request);
      },
    });
    await output.openAttempt(taskId, lease);
    const controller = new AbortController();
    const otherCaller = output.openAttempt(taskId, lease, controller.signal);
    controller.abort();
    await expect(otherCaller).rejects.toThrow();
    output.append(taskId, lease.attemptId, "original-invocation", observation("still-open"));
    expect(await output.flush()).toBe(true);
    expect(delivered.map((event) => event.text)).toEqual(["still-open"]);
    expect(await retained(path)).toMatchObject({ open: true, nextSequence: 2, batches: [] });
  });

  it.each([
    { changed: "fence", supplied: { ...lease, fence: lease.fence + 1 } },
    { changed: "token", supplied: { ...lease, leaseToken: "synthetic-other-output-lease" } },
  ])(
    "rejects a concurrent changed $changed while sharing identical original authority",
    async ({ supplied }) => {
      const requests: InvestigationOutputBatchRequest[] = [];
      const output = journal({
        directory: await directory(),
        deliver: async (requestedTaskId, request) => {
          requests.push(structuredClone(request));
          return acknowledge(requestedTaskId, request);
        },
      });
      const opening = output.openAttempt(taskId, lease);
      const changedAuthority = output.openAttempt(taskId, supplied);
      const sharedAuthority = output.openAttempt(taskId, {
        leaseToken: lease.leaseToken,
        fence: lease.fence,
        attemptId: lease.attemptId,
      });
      await expect(changedAuthority).rejects.toThrow(/original delivery lease/u);
      await expect(Promise.all([opening, sharedAuthority])).resolves.toEqual([
        undefined,
        undefined,
      ]);
      output.append(
        taskId,
        lease.attemptId,
        "original-invocation",
        observation("original-authority"),
      );
      expect(await output.flush()).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.lease).toEqual(lease);
    },
  );
});
