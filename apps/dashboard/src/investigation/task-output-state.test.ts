import type {
  InvestigationModelInvocationReceipt,
  InvestigationOutputEvent,
  InvestigationOutputPage,
} from "@agentic-review/contracts";
import { unavailableInvestigationTokenUsage } from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import {
  emptyTaskOutput,
  exportLoadedOutput,
  latestAttemptInvocation,
  maximumLoadedOutputItems,
  mergeTaskOutput,
  outputMatches,
} from "./task-output-state";

function event(
  sequence: number,
  overrides: Partial<InvestigationOutputEvent> = {},
): InvestigationOutputEvent {
  return {
    schemaVersion: "InvestigationOutputEventV1",
    taskId: "task-one",
    attemptId: "attempt-one",
    invocationId: "call-one",
    producerSequence: sequence,
    cursor: `cursor-${sequence}`,
    itemId: "message-one",
    kind: "assistant",
    operation: "append",
    text: "Hello",
    observedAt: "2026-09-20T00:00:00Z",
    receivedAt: "2026-09-20T00:00:01Z",
    ...overrides,
  };
}
function page(
  items: InvestigationOutputEvent[],
  overrides: Partial<InvestigationOutputPage> = {},
): InvestigationOutputPage {
  return {
    taskId: "task-one",
    attemptId: "attempt-one",
    items,
    nextCursor: null,
    highWaterCursor: items.at(-1)?.cursor ?? null,
    earliestAvailableCursor: items[0]?.cursor ?? null,
    lastAcceptedProducerSequence: items.at(-1)?.producerSequence ?? 0,
    retainedEventCount: items.length,
    truncated: false,
    cursorExpired: false,
    ...overrides,
  };
}

describe("retained task output replay", () => {
  it("merges deltas and replaces completed snapshots without duplicating retried pages", () => {
    const initial = emptyTaskOutput("task-one", "attempt-one");
    const firstPage = page([event(1), event(2, { text: " world" })]);
    const first = mergeTaskOutput(initial, firstPage);
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.text).toBe("Hello world");
    expect(mergeTaskOutput(first, firstPage)).toEqual(first);
    const finished = mergeTaskOutput(
      first,
      page([event(3, { operation: "replace", text: "Hello world!", status: "completed" })]),
    );
    expect(finished.items).toHaveLength(1);
    expect(finished.items[0]).toMatchObject({
      text: "Hello world!",
      updates: 3,
      firstSequence: 1,
      status: "completed",
    });
    expect(finished.eventCount).toBe(3);
    expect(initial.items).toEqual([]);
  });

  it("does not combine reused item IDs from different invocations or tools", () => {
    const result = mergeTaskOutput(
      emptyTaskOutput("task-one", "attempt-one"),
      page([
        event(1),
        event(2, { invocationId: "call-two" }),
        event(3, { kind: "tool", command: "rg foo", result: "found" }),
      ]),
    );
    expect(result.items).toHaveLength(3);
    expect(result.items.map((item) => item.text)).toEqual(["Hello", "Hello", "Hello"]);
  });

  it("refuses another task or attempt before exposing any output", () => {
    const initial = emptyTaskOutput("task-one", "attempt-one");
    expect(() => mergeTaskOutput(initial, page([], { attemptId: "attempt-two" }))).toThrow(
      "different task or attempt",
    );
    expect(() => mergeTaskOutput(initial, page([event(1, { taskId: "other-task" })]))).toThrow(
      "different task or attempt",
    );
    expect(() => mergeTaskOutput(initial, page([event(1, { attemptId: "attempt-two" })]))).toThrow(
      "different task or attempt",
    );
    expect(initial.items).toEqual([]);
  });

  it("uses continuation cursors while paging and high-water cursors for new events", () => {
    const first = mergeTaskOutput(
      emptyTaskOutput("task-one", "attempt-one"),
      page([event(1)], { nextCursor: "next-page", highWaterCursor: "newest-cursor" }),
    );
    expect(first).toMatchObject({ cursor: "next-page", hasMore: true });
    const drained = mergeTaskOutput(first, page([event(2)], { highWaterCursor: "newest-cursor" }));
    expect(drained).toMatchObject({ cursor: "newest-cursor", hasMore: false });
  });

  it("keeps retention and display gaps explicit in exported loaded scope", () => {
    const events = Array.from({ length: maximumLoadedOutputItems + 1 }, (_, index) =>
      event(index + 1, { itemId: `item-${index}` }),
    );
    const output = mergeTaskOutput(
      emptyTaskOutput("task-one", "attempt-one"),
      page(events, { cursorExpired: true, truncated: true }),
    );
    expect(output.localGap).toBe(true);
    expect(output.items).toHaveLength(maximumLoadedOutputItems);
    expect(output.retentionGap).toBe(true);
    expect(exportLoadedOutput(output)).toContain("Scope: loaded normalized output only");
    expect(exportLoadedOutput(output)).toContain("Retention gap: yes");
    expect(exportLoadedOutput(output)).toContain("Attempt: attempt-one");
    expect(exportLoadedOutput(output)).toContain("Local display limit reached: yes");
  });

  it("limits accumulated text even when one streaming item is continually appended", () => {
    const items = Array.from({ length: 8 }, (_, index) =>
      event(index + 1, { text: "x".repeat(16_384) }),
    );
    const output = mergeTaskOutput(emptyTaskOutput("task-one", "attempt-one"), page(items));
    expect(output.localGap).toBe(true);
    expect(output.items[0]?.text.length).toBe(65_536);
  });

  it("searches loaded tool commands and results while retaining explicit kind filters", () => {
    const output = mergeTaskOutput(
      emptyTaskOutput("task-one", "attempt-one"),
      page([event(1, { kind: "tool", command: "rg RestoreFocus", result: "Matched handler" })]),
    );
    const item = output.items[0]!;
    expect(outputMatches(item, "restorefocus", "tool")).toBe(true);
    expect(outputMatches(item, "HANDLER", "all")).toBe(true);
    expect(outputMatches(item, "handler", "assistant")).toBe(false);
  });
});

describe("selected attempt accounting", () => {
  function call(
    id: string,
    attemptId: string,
    startedAt: string,
  ): InvestigationModelInvocationReceipt {
    return {
      invocationId: id,
      taskId: "task-one",
      attemptId,
      startedAt,
      updatedAt: startedAt,
      model: id,
      engine: "codex",
      purpose: "analysis",
      state: "completed",
      disposition: "accepted",
      completeness: "unavailable",
      revision: 1,
      usage: unavailableInvestigationTokenUsage(),
    };
  }
  it("selects the latest invocation by identity and time without relying on API array order", () => {
    const old = call("call-old", "attempt-one", "2026-09-20T00:00:00Z");
    const current = call("call-current", "attempt-two", "2026-09-20T02:00:00Z");
    const last = call("call-last", "attempt-one", "2026-09-20T01:00:00Z");
    const calls = [last, current, old];
    expect(latestAttemptInvocation(calls, "attempt-one")).toBe(last);
    expect(latestAttemptInvocation(calls, "attempt-two")).toBe(current);
    expect(latestAttemptInvocation(calls, "attempt-three")).toBeUndefined();
    expect(calls).toEqual([last, current, old]);
  });
  it("orders actual instants when receipt timestamps use different time zones", () => {
    const earlier = call("call-earlier", "attempt-one", "2026-09-20T08:00:00+08:00");
    const later = call("call-later", "attempt-one", "2026-09-20T01:00:00Z");
    expect(latestAttemptInvocation([later, earlier], "attempt-one")).toBe(later);
  });
});
