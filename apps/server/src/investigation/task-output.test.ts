import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  InvestigationOutputBatchRequest,
  InvestigationOutputEventInput,
} from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { InvestigationStore } from "./store.js";
import { InvestigationTaskOutput } from "./task-output.js";

const stores: InvestigationStore[] = [];
const directories: string[] = [];
const now = () => new Date("2026-09-20T00:00:00.000Z");
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
function open(path?: string) {
  const store = new InvestigationStore(path);
  stores.push(store);
  return store;
}
function event(producerSequence: number): InvestigationOutputEventInput {
  return {
    schemaVersion: "InvestigationOutputEventV1",
    attemptId: "attempt-one",
    invocationId: "invocation-one",
    producerSequence,
    itemId: `item-${producerSequence}`,
    kind: "assistant",
    operation: "replace",
    text: `Visible message ${producerSequence}.`,
    observedAt: now().toISOString(),
  };
}
function batch(batchId: string, sequences: number[]): InvestigationOutputBatchRequest {
  return {
    lease: { attemptId: "attempt-one", fence: 1, leaseToken: "synthetic-token" },
    batchId,
    events: sequences.map(event),
  };
}

describe("durable normalized output", () => {
  it("commits a whole ordered batch, acknowledges identical retries, and refuses changed identities", () => {
    const store = open();
    const output = new InvestigationTaskOutput(store, now);
    const request = batch("batch-one", [1, 2]);
    const accepted = store.transaction(() => output.append("task-one", request));
    expect(accepted).toMatchObject({ lastAcceptedProducerSequence: 2, duplicate: false });
    expect(store.transaction(() => output.append("task-one", request))).toEqual({
      ...accepted,
      duplicate: true,
    });
    expect(() =>
      store.transaction(() =>
        output.append("task-one", {
          ...request,
          events: [{ ...event(1), text: "Changed bytes." }, event(2)],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "output_batch_conflict" }));
    const page = output.read("task-one", { attemptId: "attempt-one", limit: 1 });
    expect(page.items.map((entry) => entry.producerSequence)).toEqual([1]);
    expect(page.nextCursor).not.toBeNull();
    expect(
      output
        .read("task-one", { attemptId: "attempt-one", after: page.nextCursor! })
        .items.map((entry) => entry.producerSequence),
    ).toEqual([2]);
    expect(
      output.read("task-one", { attemptId: "attempt-one", after: accepted.cursor }).items,
    ).toEqual([]);
  });

  it("rolls back every inserted event and sequence when a later event is invalid", () => {
    const store = open();
    const output = new InvestigationTaskOutput(store, now);
    expect(() =>
      store.transaction(() => output.append("task-one", batch("invalid", [1, 3]))),
    ).toThrow(expect.objectContaining({ code: "output_sequence_conflict" }));
    expect(output.established("attempt-one")).toBe(false);
    expect(store.list("outputEvents")).toEqual([]);
    expect(
      store.transaction(() => output.append("task-one", batch("valid", [1])))
        .lastAcceptedProducerSequence,
    ).toBe(1);
  });

  it("keeps replay ordering and original acknowledgements after a database restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "investigation-output-"));
    directories.push(directory);
    const path = join(directory, "output.sqlite");
    const first = open(path);
    const request = batch("durable", [1, 2]);
    const accepted = first.transaction(() =>
      new InvestigationTaskOutput(first, now).append("task-one", request),
    );
    first.close();
    const second = open(path);
    const output = new InvestigationTaskOutput(second, now);
    expect(
      output
        .read("task-one", { attemptId: "attempt-one" })
        .items.map((entry) => entry.producerSequence),
    ).toEqual([1, 2]);
    expect(second.transaction(() => output.append("task-one", request))).toEqual({
      ...accepted,
      duplicate: true,
    });
  });

  it("discloses retained gaps and rejects cursors from another attempt", () => {
    const store = open();
    const output = new InvestigationTaskOutput(store, now, { maximumAttemptEvents: 2 });
    const old = store.transaction(() => output.append("task-one", batch("first", [1])));
    store.transaction(() => output.append("task-one", batch("next", [2, 3, 4])));
    const page = output.read("task-one", { attemptId: "attempt-one", after: old.cursor });
    expect(page).toMatchObject({
      truncated: true,
      cursorExpired: true,
      retainedEventCount: 2,
      lastAcceptedProducerSequence: 4,
    });
    expect(page.items.map((entry) => entry.producerSequence)).toEqual([3, 4]);
    expect(() =>
      output.read("task-one", { attemptId: "another-attempt", after: old.cursor }),
    ).toThrow(expect.objectContaining({ code: "output_cursor_invalid" }));
  });

  it("rejects raw envelopes, unregistered model identity shapes, control sequences, and quota overflow atomically", () => {
    const store = open();
    const output = new InvestigationTaskOutput(store, now, { maximumBytes: 100 });
    expect(() =>
      store.transaction(() => output.append("task-one", batch("too-large", [1]))),
    ).toThrow(expect.objectContaining({ code: "output_quota_exceeded" }));
    expect(store.list("outputEvents")).toEqual([]);
    const ordinary = new InvestigationTaskOutput(store, now);
    for (const invalid of [
      { ...event(1), raw: { reasoning: "Private." } },
      { ...event(1), invocationId: null },
      { ...event(1), text: "\u001b[31munsafe" },
    ]) {
      expect(() =>
        store.transaction(() =>
          ordinary.append("task-one", { ...batch("invalid", [1]), events: [invalid] }),
        ),
      ).toThrow();
      expect(store.list("outputEvents")).toEqual([]);
    }
  });

  it("evicts the oldest stream prefix under aggregate retention while preserving immutable retry receipts", () => {
    const store = open();
    const firstOutput = new InvestigationTaskOutput(store, now);
    const original = batch("original", [1]);
    const accepted = store.transaction(() => firstOutput.append("task-one", original));
    const saved = firstOutput.read("task-one", { attemptId: "attempt-one" }).items[0]!;
    const output = new InvestigationTaskOutput(store, now, {
      maximumBytes: Buffer.byteLength(JSON.stringify(saved), "utf8") + 50,
    });
    const next = batch("another", [1]);
    next.lease.attemptId = "attempt-two";
    next.events[0]!.attemptId = "attempt-two";
    store.transaction(() => output.append("task-two", next));
    expect(output.read("task-one", { attemptId: "attempt-one" })).toMatchObject({
      items: [],
      truncated: true,
      retainedEventCount: 0,
    });
    expect(output.read("task-two", { attemptId: "attempt-two" }).items).toHaveLength(1);
    expect(store.transaction(() => output.append("task-one", original))).toEqual({
      ...accepted,
      duplicate: true,
    });
  });
});
