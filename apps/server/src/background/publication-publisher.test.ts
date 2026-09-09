import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../database/database-client.js";
import {
  createPublicationTestDelivery,
  createPublicationTestIntent,
  createPublicationTestReceipt,
  publicationTestTime,
} from "../database/publication-fixture.testing.js";
import type { PublicationLease } from "../database/publications.js";
import type {
  GitHubPublicationPreflightOutcome,
  GitHubPublicationTransport,
} from "../github/publication-client.js";
import { type PublicationPublisher, startPublicationPublisher } from "./publication-publisher.js";

const publishers: PublicationPublisher[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(publicationTestTime));
});
afterEach(async () => {
  for (const publisher of publishers.splice(0)) await publisher.stop();
  vi.useRealTimers();
});

function fixture(kinds: PublicationLease["kind"][] = ["delivery"]) {
  const intent = createPublicationTestIntent(),
    trace: string[] = [];
  const pending = [...kinds];
  let current: PublicationLease | null = null;
  const request = vi.fn(async (operation: string, input: Record<string, unknown>) => {
    trace.push(operation);
    if (operation === "recoverExpiredPublications") return { recovered: 0 };
    if (operation.startsWith("claimPublication")) {
      const kind = operation === "claimPublicationDelivery" ? "delivery" : "reconciliation";
      const index = pending.indexOf(kind);
      if (index === -1) return null;
      pending.splice(index, 1);
      current = {
        publication: {
          schemaVersion: "PublicationDetailV1",
          intent,
          delivery: {
            ...createPublicationTestDelivery(intent),
            status: kind === "delivery" ? "delivering" : "unknown",
            attemptCount: 1,
            failure:
              kind === "reconciliation"
                ? { code: "ambiguous_delivery", message: "A prior send has an unknown outcome." }
                : null,
          },
        },
        ownerId: input.ownerId as string,
        fence: 1,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        attemptNumber: 1,
        kind,
      };
      return current;
    }
    if (operation === "beginPublicationSend" || operation === "renewPublicationLease")
      return current;
    if (operation.startsWith("completePublication")) return current?.publication;
    throw new Error(`Unexpected fixture operation: ${operation}`);
  });
  const transport = {
    preflight: vi.fn<GitHubPublicationTransport["preflight"]>(async () => {
      trace.push("preflight");
      return { status: "ready" };
    }),
    publish: vi.fn<GitHubPublicationTransport["publish"]>(async () => {
      trace.push("publish");
      return { status: "published", remoteReceipt: createPublicationTestReceipt(intent) };
    }),
    reconcile: vi.fn<GitHubPublicationTransport["reconcile"]>(async () => {
      trace.push("reconcile");
      return { status: "published", remoteReceipt: createPublicationTestReceipt(intent) };
    }),
  };
  const logger = { warn: vi.fn(), error: vi.fn() },
    shutdown = new AbortController();
  const start = () => {
    const publisher = startPublicationPublisher(
      { request } as unknown as Pick<DatabaseClient, "request">,
      transport,
      logger,
      shutdown.signal,
    );
    publishers.push(publisher);
    return publisher;
  };
  return { request, transport, trace, logger, shutdown, start };
}
function pendingUntilAbort(signal?: AbortSignal): Promise<GitHubPublicationPreflightOutcome> {
  return new Promise((_, reject) =>
    signal?.addEventListener("abort", () => reject(new Error("Synthetic interruption.")), {
      once: true,
    }),
  );
}
describe("confirmed publication publisher", () => {
  it("records the send boundary after preflight and before the single POST", async () => {
    const f = fixture();
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.trace).toEqual([
      "recoverExpiredPublications",
      "claimPublicationDelivery",
      "preflight",
      "beginPublicationSend",
      "publish",
      "completePublicationDelivery",
    ]);
    expect(f.request).toHaveBeenLastCalledWith(
      "completePublicationDelivery",
      expect.objectContaining({
        outcome: "published",
        failure: null,
        remoteReceipt: expect.objectContaining({ githubId: 901 }),
      }),
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.transport.publish).toHaveBeenCalledTimes(1);
  });
  it("does not send after preflight fails", async () => {
    const f = fixture();
    f.transport.preflight.mockResolvedValue({
      status: "blocked",
      failure: { code: "source_changed", message: "The source changed." },
    });
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.trace).not.toContain("beginPublicationSend");
    expect(f.transport.publish).not.toHaveBeenCalled();
    expect(f.request).toHaveBeenLastCalledWith(
      "completePublicationDelivery",
      expect.objectContaining({ outcome: "blocked" }),
    );
  });
  it("does not send when final authorization or the fence rejects beginSend", async () => {
    const f = fixture(),
      original = f.request.getMockImplementation();
    if (original === undefined) throw new Error("The fixture request implementation is required.");
    f.request.mockImplementation(async (operation, input) =>
      operation === "beginPublicationSend" ? null : original(operation, input),
    );
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.transport.publish).not.toHaveBeenCalled();
  });
  it("records an unexpected post-send failure as unknown without retrying", async () => {
    const f = fixture();
    f.transport.publish.mockRejectedValue(new Error("Synthetic lost response."));
    f.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.transport.publish).toHaveBeenCalledTimes(1);
    expect(
      f.request.mock.calls.find(([operation]) => operation === "completePublicationDelivery")?.[1],
    ).toMatchObject({ outcome: "unknown", failure: { code: "delivery_interrupted" } });
  });
  it("retains definite GitHub rejection as a safe failure", async () => {
    const f = fixture();
    f.transport.publish.mockResolvedValue({
      status: "blocked",
      failure: { code: "github_rejected", message: "GitHub rejected the request." },
    });
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.request).toHaveBeenLastCalledWith(
      "completePublicationDelivery",
      expect.objectContaining({
        outcome: "failed",
        failure: { code: "github_rejected", message: "GitHub rejected the request." },
      }),
    );
  });
  it("does not trust an arbitrary claimed safe failure after sending may have begun", async () => {
    const f = fixture();
    f.transport.publish.mockResolvedValue({
      status: "failed",
      failure: { code: "preflight_failed", message: "Unexpected transport state." },
    });
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.request).toHaveBeenLastCalledWith(
      "completePublicationDelivery",
      expect.objectContaining({
        outcome: "unknown",
        failure: { code: "ambiguous_delivery", message: expect.any(String) },
      }),
    );
  });
  it("performs reconciliation without a send boundary or POST", async () => {
    const f = fixture(["reconciliation"]);
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.transport.reconcile).toHaveBeenCalledTimes(1);
    expect(f.transport.publish).not.toHaveBeenCalled();
    expect(f.trace).not.toContain("beginPublicationSend");
    expect(f.request).toHaveBeenLastCalledWith(
      "completePublicationReconciliation",
      expect.objectContaining({ outcome: "published" }),
    );
  });
  it("keeps incomplete reconciliation unknown", async () => {
    const f = fixture(["reconciliation"]);
    f.transport.reconcile.mockRejectedValue(new Error("Synthetic GET interruption."));
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.request).toHaveBeenLastCalledWith(
      "completePublicationReconciliation",
      expect.objectContaining({
        outcome: "unknown",
        failure: { code: "reconciliation_incomplete", message: expect.any(String) },
      }),
    );
  });
  it("drains shutdown before sending and prevents later cycles", async () => {
    const f = fixture();
    f.transport.preflight.mockImplementation((_intent, signal) => pendingUntilAbort(signal));
    const publisher = f.start();
    await vi.advanceTimersByTimeAsync(0);
    await publisher.stop();
    const count = f.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.transport.publish).not.toHaveBeenCalled();
    expect(f.request).toHaveBeenCalledTimes(count);
    expect(f.request).toHaveBeenLastCalledWith(
      "completePublicationDelivery",
      expect.objectContaining({ outcome: "failed" }),
    );
  });
  it("drains shutdown during POST as unknown", async () => {
    const f = fixture();
    f.transport.publish.mockImplementation(
      (_intent, signal) =>
        pendingUntilAbort(signal) as ReturnType<GitHubPublicationTransport["publish"]>,
    );
    const publisher = f.start();
    await vi.advanceTimersByTimeAsync(0);
    await publisher.stop();
    expect(f.request).toHaveBeenLastCalledWith(
      "completePublicationDelivery",
      expect.objectContaining({ outcome: "unknown" }),
    );
  });
  it("aborts an operation if its lease renewal loses ownership", async () => {
    const f = fixture(),
      original = f.request.getMockImplementation();
    if (original === undefined) throw new Error("The fixture request implementation is required.");
    f.request.mockImplementation(async (operation, input) =>
      operation === "renewPublicationLease" ? null : original(operation, input),
    );
    f.transport.preflight.mockImplementation((_intent, signal) => pendingUntilAbort(signal));
    f.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.request.mock.calls.some(([operation]) => operation === "renewPublicationLease")).toBe(
      true,
    );
    expect(f.transport.publish).not.toHaveBeenCalled();
  });
  it("honors the transport backoff before claiming another intent", async () => {
    const f = fixture(["delivery", "delivery"]);
    f.transport.preflight.mockResolvedValueOnce({
      status: "failed",
      failure: { code: "rate_limited", message: "Rate limited." },
      retryAfterMs: 3000,
    });
    f.start();
    await vi.advanceTimersByTimeAsync(2999);
    expect(f.transport.preflight).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.transport.preflight).toHaveBeenCalledTimes(2);
    expect(f.transport.publish).toHaveBeenCalledTimes(1);
  });
  it("alternates ready delivery and reconciliation work without parallel transport calls", async () => {
    const f = fixture(["delivery", "delivery", "reconciliation"]);
    f.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.trace.filter((event) => ["publish", "reconcile"].includes(event))).toEqual([
      "publish",
      "reconcile",
      "publish",
    ]);
  });
  it("never starts after the parent is already shut down", async () => {
    const f = fixture();
    f.shutdown.abort();
    f.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.transport.publish).not.toHaveBeenCalled();
  });
});
