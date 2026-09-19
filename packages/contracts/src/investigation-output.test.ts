import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  type InvestigationOutputBatchRequest,
  InvestigationOutputBatchRequestSchema,
  type InvestigationOutputBatchResponse,
  InvestigationOutputBatchResponseSchema,
  type InvestigationOutputEvent,
  type InvestigationOutputEventInput,
  InvestigationOutputEventInputSchema,
  InvestigationOutputEventSchema,
  type InvestigationOutputPage,
  InvestigationOutputPageSchema,
  type InvestigationOutputQuery,
  InvestigationOutputQuerySchema,
} from "./investigation-output.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

const event = {
  schemaVersion: "InvestigationOutputEventV1",
  attemptId: "attempt-fixture",
  invocationId: "invocation-fixture",
  producerSequence: 1,
  itemId: "item-fixture",
  kind: "assistant",
  operation: "append",
  text: "Inspecting the selected source snapshot.",
  observedAt: "2026-09-20T00:00:00Z",
} satisfies InvestigationOutputEventInput;

const storedEvent = {
  ...event,
  taskId: "task-fixture",
  receivedAt: "2026-09-20T00:00:01Z",
  cursor: "opaque-output-cursor",
} satisfies InvestigationOutputEvent;

const batch = {
  lease: { attemptId: event.attemptId, fence: 1, leaseToken: "fixture-lease" },
  batchId: "batch-fixture",
  events: [event],
} satisfies InvestigationOutputBatchRequest;

const receipt = {
  taskId: storedEvent.taskId,
  attemptId: event.attemptId,
  batchId: batch.batchId,
  lastAcceptedProducerSequence: 1,
  cursor: storedEvent.cursor,
  duplicate: false,
} satisfies InvestigationOutputBatchResponse;

const emptyPage = {
  taskId: storedEvent.taskId,
  attemptId: event.attemptId,
  items: [],
  nextCursor: null,
  highWaterCursor: null,
  earliestAvailableCursor: null,
  lastAcceptedProducerSequence: 0,
  retainedEventCount: 0,
  truncated: false,
  cursorExpired: false,
} satisfies InvestigationOutputPage;

describe("investigation visible output event contracts", () => {
  it("accepts typed assistant output and a tool update with optional display fields", () => {
    expect(Value.Check(InvestigationOutputEventInputSchema, event)).toBe(true);
    const toolEvent: InvestigationOutputEventInput = {
      ...event,
      kind: "tool",
      operation: "replace",
      text: "",
      command: "git status --short",
      result: "",
      status: "completed",
    };
    expect(Value.Check(InvestigationOutputEventInputSchema, toolEvent)).toBe(true);
  });

  it.each(["assistant", "tool", "system", "gap"])("accepts the visible %s kind", (kind) => {
    expect(Value.Check(InvestigationOutputEventInputSchema, { ...event, kind })).toBe(true);
  });

  it.each(["started", "completed", "failed", "cancelled", "info"])(
    "accepts the %s display status",
    (status) => {
      expect(Value.Check(InvestigationOutputEventInputSchema, { ...event, status })).toBe(true);
    },
  );

  it("requires an explicit invocation identity or null", () => {
    expect(Value.Check(InvestigationOutputEventInputSchema, { ...event, invocationId: null })).toBe(
      true,
    );
    for (const invocationId of [undefined, "", "../invocation", 1]) {
      expect(Value.Check(InvestigationOutputEventInputSchema, { ...event, invocationId })).toBe(
        false,
      );
    }
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null])(
    "rejects invalid producer sequence %j",
    (producerSequence) => {
      expect(Value.Check(InvestigationOutputEventInputSchema, { ...event, producerSequence })).toBe(
        false,
      );
    },
  );

  it("accepts the largest safe producer sequence", () => {
    expect(
      Value.Check(InvestigationOutputEventInputSchema, {
        ...event,
        producerSequence: Number.MAX_SAFE_INTEGER,
      }),
    ).toBe(true);
  });

  it.each([
    ["text", 16_384],
    ["command", 4_096],
    ["result", 16_384],
  ] as const)("bounds the %s display field", (field, maximum) => {
    for (const value of ["", "x".repeat(maximum)]) {
      expect(Value.Check(InvestigationOutputEventInputSchema, { ...event, [field]: value })).toBe(
        true,
      );
    }
    for (const value of ["x".repeat(maximum + 1), null, 1, {}]) {
      expect(Value.Check(InvestigationOutputEventInputSchema, { ...event, [field]: value })).toBe(
        false,
      );
    }
  });

  it.each([
    { schemaVersion: "InvestigationOutputEventV2" },
    { kind: "reasoning" },
    { operation: "delete" },
    { status: "running" },
    { status: null },
    { attemptId: "" },
    { itemId: "item/unsafe" },
    { observedAt: "not-a-date" },
    { text: undefined },
  ])("rejects an unsupported or malformed event field: %j", (fields) => {
    expect(Value.Check(InvestigationOutputEventInputSchema, { ...event, ...fields })).toBe(false);
  });

  it.each(["providerEnvelope", "reasoning", "taskId", "receivedAt", "cursor"])(
    "rejects the untrusted extra input field %s",
    (field) => {
      expect(
        Value.Check(InvestigationOutputEventInputSchema, { ...event, [field]: "private-value" }),
      ).toBe(false);
    },
  );

  it("requires server-owned fields on a stored event and keeps the object strict", () => {
    expect(Value.Check(InvestigationOutputEventSchema, storedEvent)).toBe(true);
    expect(Value.Check(InvestigationOutputEventSchema, event)).toBe(false);
    for (const field of ["taskId", "receivedAt", "cursor"] as const) {
      expect(
        Value.Check(InvestigationOutputEventSchema, { ...storedEvent, [field]: undefined }),
      ).toBe(false);
    }
    expect(
      Value.Check(InvestigationOutputEventSchema, { ...storedEvent, providerEnvelope: {} }),
    ).toBe(false);
    expect(
      Value.Check(InvestigationOutputEventSchema, { ...storedEvent, receivedAt: "invalid" }),
    ).toBe(false);
  });
});

describe("investigation output ingestion contracts", () => {
  it("accepts a typed batch and the maximum event count", () => {
    expect(Value.Check(InvestigationOutputBatchRequestSchema, batch)).toBe(true);
    expect(
      Value.Check(InvestigationOutputBatchRequestSchema, {
        ...batch,
        events: Array.from({ length: 64 }, (_, index) => ({
          ...event,
          producerSequence: index + 1,
        })),
      }),
    ).toBe(true);
  });

  it("rejects empty and oversized batches as well as malformed nested events", () => {
    for (const events of [
      [],
      Array.from({ length: 65 }, () => event),
      [{ ...event, producerSequence: 0 }],
      [{ ...event, providerEnvelope: {} }],
      [storedEvent],
      null,
    ]) {
      expect(Value.Check(InvestigationOutputBatchRequestSchema, { ...batch, events })).toBe(false);
    }
  });

  it("requires a strict lease and a nonempty batch identity", () => {
    for (const lease of [
      null,
      { ...batch.lease, fence: -1 },
      { ...batch.lease, leaseToken: "" },
      { ...batch.lease, owner: "unexpected" },
    ]) {
      expect(Value.Check(InvestigationOutputBatchRequestSchema, { ...batch, lease })).toBe(false);
    }
    expect(Value.Check(InvestigationOutputBatchRequestSchema, { ...batch, batchId: "" })).toBe(
      false,
    );
    expect(Value.Check(InvestigationOutputBatchRequestSchema, { ...batch, duplicate: true })).toBe(
      false,
    );
  });

  it("accepts typed first-delivery and duplicate receipts", () => {
    expect(Value.Check(InvestigationOutputBatchResponseSchema, receipt)).toBe(true);
    expect(
      Value.Check(InvestigationOutputBatchResponseSchema, { ...receipt, duplicate: true }),
    ).toBe(true);
  });

  it.each([
    { lastAcceptedProducerSequence: 0 },
    { lastAcceptedProducerSequence: Number.MAX_SAFE_INTEGER + 1 },
    { duplicate: "false" },
    { duplicate: undefined },
    { batchId: "" },
    { events: [] },
  ])("rejects an invalid receipt field: %j", (fields) => {
    expect(Value.Check(InvestigationOutputBatchResponseSchema, { ...receipt, ...fields })).toBe(
      false,
    );
  });
});

describe("investigation output pagination contracts", () => {
  it("accepts an attempt-only query and typed bounded pagination", () => {
    expect(Value.Check(InvestigationOutputQuerySchema, { attemptId: event.attemptId })).toBe(true);
    const query: InvestigationOutputQuery = {
      attemptId: event.attemptId,
      after: storedEvent.cursor,
      limit: 200,
    };
    expect(Value.Check(InvestigationOutputQuerySchema, query)).toBe(true);
    expect(Value.Check(InvestigationOutputQuerySchema, { ...query, limit: 1 })).toBe(true);
  });

  it.each([0, -1, 201, 1.5, "20", null])("rejects query limit %j", (limit) => {
    expect(Value.Check(InvestigationOutputQuerySchema, { attemptId: event.attemptId, limit })).toBe(
      false,
    );
  });

  it("requires an attempt scope and rejects unknown query fields", () => {
    for (const query of [{}, { attemptId: "" }, { attemptId: event.attemptId, offset: 1 }]) {
      expect(Value.Check(InvestigationOutputQuerySchema, query)).toBe(false);
    }
  });

  it.each(["", "x".repeat(2_049), null, 1])(
    "rejects invalid required and optional cursor values: %j",
    (cursor) => {
      expect(Value.Check(InvestigationOutputEventSchema, { ...storedEvent, cursor })).toBe(false);
      expect(Value.Check(InvestigationOutputBatchResponseSchema, { ...receipt, cursor })).toBe(
        false,
      );
      expect(
        Value.Check(InvestigationOutputQuerySchema, { attemptId: event.attemptId, after: cursor }),
      ).toBe(false);
    },
  );

  it("accepts opaque cursors at the maximum length", () => {
    const cursor = "x".repeat(2_048);
    expect(Value.Check(InvestigationOutputEventSchema, { ...storedEvent, cursor })).toBe(true);
    expect(Value.Check(InvestigationOutputBatchResponseSchema, { ...receipt, cursor })).toBe(true);
    expect(
      Value.Check(InvestigationOutputQuerySchema, { attemptId: event.attemptId, after: cursor }),
    ).toBe(true);
  });

  it("represents an empty stream with explicit null cursors and zero counters", () => {
    expect(Value.Check(InvestigationOutputPageSchema, emptyPage)).toBe(true);
  });

  it("accepts a full page with retention and cursor-expiration metadata", () => {
    const page: InvestigationOutputPage = {
      ...emptyPage,
      items: Array.from({ length: 200 }, () => storedEvent),
      nextCursor: storedEvent.cursor,
      highWaterCursor: "high-water-cursor",
      earliestAvailableCursor: "earliest-cursor",
      lastAcceptedProducerSequence: 500,
      retainedEventCount: 200,
      truncated: true,
      cursorExpired: true,
    };
    expect(Value.Check(InvestigationOutputPageSchema, page)).toBe(true);
    expect(
      Value.Check(InvestigationOutputPageSchema, { ...page, items: [...page.items, storedEvent] }),
    ).toBe(false);
  });

  it.each(["nextCursor", "highWaterCursor", "earliestAvailableCursor"] as const)(
    "requires %s to be null or a bounded nonempty cursor",
    (field) => {
      expect(
        Value.Check(InvestigationOutputPageSchema, { ...emptyPage, [field]: "x".repeat(2_048) }),
      ).toBe(true);
      for (const value of [undefined, "", "x".repeat(2_049), 1]) {
        expect(Value.Check(InvestigationOutputPageSchema, { ...emptyPage, [field]: value })).toBe(
          false,
        );
      }
    },
  );

  it.each(["lastAcceptedProducerSequence", "retainedEventCount"] as const)(
    "requires a safe nonnegative %s",
    (field) => {
      expect(
        Value.Check(InvestigationOutputPageSchema, {
          ...emptyPage,
          [field]: Number.MAX_SAFE_INTEGER,
        }),
      ).toBe(true);
      for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, "0"]) {
        expect(Value.Check(InvestigationOutputPageSchema, { ...emptyPage, [field]: value })).toBe(
          false,
        );
      }
    },
  );

  it("requires stored event items, boolean metadata, and a strict page shape", () => {
    for (const fields of [
      { items: [event] },
      { items: [{ ...storedEvent, producerSequence: 0 }] },
      { items: null },
      { truncated: "false" },
      { cursorExpired: undefined },
      { lease: batch.lease },
    ]) {
      expect(Value.Check(InvestigationOutputPageSchema, { ...emptyPage, ...fields })).toBe(false);
    }
  });
});
