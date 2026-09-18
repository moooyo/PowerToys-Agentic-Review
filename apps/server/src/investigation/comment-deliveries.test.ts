import { afterEach, describe, expect, it } from "vitest";
import {
  type BeginCommentDeliveryInput,
  InvestigationCommentDeliveries,
} from "./comment-deliveries.js";
import { InvestigationStore } from "./store.js";
import type { InvestigationOperatorPrincipal } from "./types.js";

const stores: InvestigationStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

const actor: InvestigationOperatorPrincipal = {
  id: "operator-one",
  displayName: "Synthetic operator",
  repositoryIds: ["repository-one"],
  permissions: [],
  actionCapabilities: [],
  allowRepositoryExecution: false,
};

function harness() {
  const store = new InvestigationStore();
  stores.push(store);
  let time = Date.parse("2026-09-19T00:00:00.000Z");
  const ledger = new InvestigationCommentDeliveries({ store, now: () => new Date(time) });
  const input: BeginCommentDeliveryInput = {
    id: "delivery-one",
    commentId: "progress-reply:assignment:one",
    mode: "progress",
    repositoryId: "repository-one",
    repositoryFullName: "example/one",
    workItemKind: "pull_request",
    workItemNumber: 7,
    operation: "create",
    body: "The assignment has been received.",
    settingsVersion: 1,
    templateVersion: 1,
  };
  return {
    store,
    ledger,
    input,
    advance: () => {
      time += 1000;
    },
  };
}

describe("InvestigationCommentDeliveries", () => {
  it("starts with no synthetic history and joins the caller's publication transaction", () => {
    const h = harness();
    expect(h.ledger.list(actor)).toEqual({ items: [], nextCursor: null });
    h.store.transaction(() => {
      h.store.insert("idempotency", "publication-one", { state: "pending" });
      const begun = h.ledger.begin(h.input);
      expect(begun.state).toBe("sending");
      h.ledger.markDispatched(begun.id);
      h.ledger.finish(begun.id, { state: "succeeded", externalId: "501" });
      h.store.put("idempotency", "publication-one", { state: "sent" });
    });
    expect(h.ledger.list(actor).items).toMatchObject([
      { state: "succeeded", effect: "applied", body: h.input.body, attemptNumber: 1 },
    ]);
    expect(h.store.get("idempotency", "publication-one")).toEqual({ state: "sent" });
  });

  it("rolls back the attempt together with its parent publication", () => {
    const h = harness();
    expect(() =>
      h.store.transaction(() => {
        h.ledger.begin(h.input);
        throw new Error("Synthetic transaction failure.");
      }),
    ).toThrow("Synthetic transaction failure.");
    expect(h.ledger.list(actor).items).toEqual([]);
  });

  it("keeps frozen content and finished receipts immutable and rejects repeated dispatch", () => {
    const h = harness();
    const first = h.ledger.begin(h.input);
    h.advance();
    expect(h.ledger.begin(h.input)).toEqual(first);
    expect(() => h.ledger.begin({ ...h.input, body: "Changed body." })).toThrow(
      expect.objectContaining({ code: "comment_delivery_conflict" }),
    );
    h.ledger.markDispatched(first.id);
    expect(() => h.ledger.markDispatched(first.id)).toThrow(
      expect.objectContaining({ code: "comment_delivery_dispatched" }),
    );
    const finished = h.ledger.finish(first.id, {
      state: "failed",
      effect: "rejected",
      reason: "Rate limited.",
    });
    h.advance();
    expect(
      h.ledger.finish(first.id, { state: "failed", effect: "rejected", reason: "Rate limited." }),
    ).toEqual(finished);
    expect(() => h.ledger.finish(first.id, { state: "succeeded", externalId: "501" })).toThrow(
      expect.objectContaining({ code: "comment_delivery_immutable" }),
    );
    expect(h.ledger.read(actor, first.id).body).toBe(h.input.body);
  });

  it("appends reconciliation evidence without replacing the original unknown receipt", () => {
    const h = harness();
    const row = h.ledger.begin(h.input);
    h.ledger.markDispatched(row.id);
    h.ledger.finish(row.id, { state: "unknown", reason: "The response was lost." });
    const original = h.store.get<Record<string, unknown>>("commentDeliveries", row.id)!;
    h.advance();
    const observed = h.ledger.observe(row.id, {
      state: "succeeded",
      externalId: "501",
      reason: "The exact comment was found.",
    });
    expect(observed).toMatchObject({ state: "succeeded", externalId: "501", body: h.input.body });
    expect(observed.observations).toEqual([
      {
        at: "2026-09-19T00:00:01.000Z",
        state: "succeeded",
        reason: "The exact comment was found.",
      },
    ]);
    expect(h.ledger.list(actor).items).toHaveLength(1);
    const current = h.store.get<Record<string, unknown>>("commentDeliveries", row.id)!;
    expect(current.originalReceipt).toEqual(original.originalReceipt);
    expect(current.finishedAt).toEqual(original.finishedAt);
    h.advance();
    expect(
      h.ledger.observe(row.id, { state: "unknown", reason: "A later read timed out." }).state,
    ).toBe("succeeded");
    expect(h.ledger.read(actor, row.id).observations).toHaveLength(2);
  });

  it("deduplicates the same observation and rejects a different external comment identity", () => {
    const h = harness();
    const row = h.ledger.begin(h.input);
    h.ledger.markDispatched(row.id);
    h.ledger.finish(row.id, { state: "unknown" });
    const observation = {
      state: "succeeded" as const,
      externalId: "501",
      at: "2026-09-19T00:00:02.000Z",
    };
    h.ledger.observe(row.id, observation);
    h.ledger.observe(row.id, observation);
    expect(h.ledger.read(actor, row.id).observations).toHaveLength(1);
    expect(() => h.ledger.observe(row.id, { state: "succeeded", externalId: "999" })).toThrow(
      expect.objectContaining({ code: "comment_delivery_external_id_conflict" }),
    );
  });

  it("retains an unknown write after a failed readback and preserves a definite rejection", () => {
    const h = harness();
    h.ledger.begin(h.input);
    h.ledger.markDispatched("delivery-one");
    h.ledger.finish("delivery-one", { state: "unknown", reason: "The response was lost." });
    const uncertain = h.ledger.observe("delivery-one", {
      state: "failed",
      reason: "The comment body changed.",
    });
    expect(uncertain).toMatchObject({ state: "unknown", effect: "unknown" });
    expect(uncertain.observations[0]).toMatchObject({
      state: "failed",
      reason: "The comment body changed.",
    });
    const rejected = h.ledger.begin({ ...h.input, id: "delivery-two", commentId: "comment:two" });
    h.ledger.finish(rejected.id, {
      state: "failed",
      effect: "rejected",
      reason: "The request was rejected.",
    });
    const observation = h.ledger.observe(rejected.id, { state: "succeeded", externalId: "501" });
    expect(observation).toMatchObject({ state: "failed", effect: "rejected", externalId: null });
  });

  it("recovers a dispatched unfinished attempt but never invents a dispatch for preparation", () => {
    const h = harness();
    const row = h.ledger.begin(h.input);
    expect(() => h.ledger.observe(row.id, { state: "unknown" })).toThrow(
      expect.objectContaining({ code: "comment_delivery_not_dispatched" }),
    );
    h.ledger.markDispatched(row.id);
    const recovered = h.ledger.observe(row.id, {
      state: "unknown",
      reason: "No matching comment was found.",
    });
    expect(recovered.state).toBe("unknown");
    expect(
      h.store.get<Record<string, unknown>>("commentDeliveries", row.id)?.originalReceipt,
    ).toMatchObject({
      state: "unknown",
      effect: "unknown",
    });
    expect(h.ledger.list(actor).items).toHaveLength(1);
  });

  it("records retries as separate rows and leaves previous failure content intact", () => {
    const h = harness();
    const first = h.ledger.begin(h.input);
    h.ledger.finish(first.id, {
      state: "failed",
      effect: "not_sent",
      reason: "Publisher unavailable.",
    });
    h.advance();
    const second = h.ledger.begin({ ...h.input, id: "delivery-two" });
    expect(second.attemptNumber).toBe(2);
    expect(h.ledger.list(actor).items.map((item) => [item.id, item.state, item.body])).toEqual([
      ["delivery-two", "sending", h.input.body],
      ["delivery-one", "failed", h.input.body],
    ]);
  });

  it("allocates increasing attempt numbers when simultaneous delivery IDs sort backwards", () => {
    const h = harness();
    h.ledger.begin({
      ...h.input,
      id: "other-delivery",
      commentId: "other-comment",
      attemptNumber: 40,
    });
    const attempts = ["delivery-z", "delivery-a", "delivery-m"].map((id) => {
      const attempt = h.ledger.begin({ ...h.input, id });
      h.ledger.finish(id, {
        state: "failed",
        effect: "not_sent",
        reason: "Publisher unavailable.",
      });
      return attempt;
    });
    expect(attempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2, 3]);
    expect(new Set(attempts.map((attempt) => attempt.startedAt)).size).toBe(1);
    expect(h.ledger.begin({ ...h.input, id: "delivery-a" }).attemptNumber).toBe(2);
  });

  it("allocates increasing attempt numbers when the timestamp moves backwards", () => {
    const h = harness();
    const attempts = [3, 2, 1].map((second) => {
      const id = `delivery-${second}`;
      const attempt = h.ledger.begin({
        ...h.input,
        id,
        startedAt: `2026-09-19T00:00:0${second}.000Z`,
      });
      h.ledger.finish(id, {
        state: "failed",
        effect: "not_sent",
        reason: "Publisher unavailable.",
      });
      return attempt;
    });
    expect(attempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2, 3]);
    expect(h.ledger.list(actor).items.map((attempt) => attempt.attemptNumber)).toEqual([1, 2, 3]);
  });

  it("attaches a Task to pre-Task rows without rewriting body or receipt and rejects rebinding", () => {
    const h = harness();
    h.ledger.begin(h.input);
    h.ledger.finish("delivery-one", { state: "succeeded", externalId: "501" });
    const before = h.store.get<Record<string, unknown>>("commentDeliveries", "delivery-one")!;
    h.store.transaction(() => h.ledger.attachTask(h.input.commentId, "task-one", "item-one"));
    expect(h.ledger.list(actor, { taskId: "task-one" }).items[0]).toMatchObject({
      taskId: "task-one",
      workItemId: "item-one",
      body: h.input.body,
    });
    expect(
      h.store.get<Record<string, unknown>>("commentDeliveries", "delivery-one")?.originalReceipt,
    ).toEqual(before.originalReceipt);
    expect(() => h.ledger.attachTask(h.input.commentId, "task-two", "item-one")).toThrow(
      expect.objectContaining({ code: "comment_delivery_task_conflict" }),
    );
    expect(h.ledger.begin(h.input).taskId).toBe("task-one");
  });

  it("filters inside repository scope and keyset-pages equal timestamps without duplicates", () => {
    const h = harness();
    for (const id of ["delivery-a", "delivery-b", "delivery-c"])
      h.ledger.begin({
        ...h.input,
        id,
        commentId: `comment:${id}`,
        taskId: "task-one",
        workItemId: "item-one",
      });
    h.ledger.begin({
      ...h.input,
      id: "delivery-private",
      commentId: "comment:private",
      repositoryId: "repository-two",
      repositoryFullName: "example/two",
    });
    const query = {
      repositoryId: "repository-one",
      taskId: "task-one",
      workItemNumber: 7,
      state: "sending" as const,
      mode: "progress" as const,
      limit: 2,
    };
    const first = h.ledger.list(actor, query);
    expect(first.items.map((item) => item.id)).toEqual(["delivery-c", "delivery-b"]);
    expect(first.nextCursor).not.toBeNull();
    h.advance();
    h.ledger.begin({
      ...h.input,
      id: "delivery-new",
      commentId: "comment:new",
      taskId: "task-one",
      workItemId: "item-one",
    });
    const second = h.ledger.list(actor, { ...query, cursor: first.nextCursor! });
    expect(second.items.map((item) => item.id)).toEqual(["delivery-a"]);
    expect(second.nextCursor).toBeNull();
    expect(h.ledger.list({ ...actor, repositoryIds: [] }).items).toEqual([]);
    expect(() => h.ledger.list(actor, { repositoryId: "repository-two" })).toThrow(
      expect.objectContaining({ statusCode: 403 }),
    );
    expect(() => h.ledger.read(actor, "delivery-private")).toThrow(
      expect.objectContaining({ statusCode: 403 }),
    );
  });

  it("binds cursors to actor, repository scope, and filters and rejects malformed cursors", () => {
    const h = harness();
    h.ledger.begin(h.input);
    h.ledger.begin({ ...h.input, id: "delivery-two" });
    const cursor = h.ledger.list(actor, { limit: 1 }).nextCursor!;
    for (const query of [
      { cursor: "%%%" },
      { cursor, state: "failed" as const },
      { cursor, repositoryId: "repository-one" },
    ])
      expect(() => h.ledger.list(actor, query)).toThrow(
        expect.objectContaining({ code: "comment_delivery_cursor_invalid" }),
      );
    expect(() => h.ledger.list({ ...actor, id: "operator-two" }, { cursor })).toThrow(
      expect.objectContaining({ code: "comment_delivery_cursor_invalid" }),
    );
    expect(() =>
      h.ledger.list({ ...actor, repositoryIds: ["repository-one", "repository-two"] }, { cursor }),
    ).toThrow(expect.objectContaining({ code: "comment_delivery_cursor_invalid" }));
    expect(() => h.ledger.list(actor, { limit: 51 })).toThrow(
      expect.objectContaining({ code: "comment_delivery_query_invalid" }),
    );
  });

  it("normalizes timestamp offsets so delivery pagination follows actual time", () => {
    const h = harness();
    h.ledger.begin({ ...h.input, id: "delivery-offset", startedAt: "2026-09-19T01:00:00+01:00" });
    h.ledger.begin({ ...h.input, id: "delivery-utc", startedAt: "2026-09-19T00:30:00.000Z" });
    const first = h.ledger.list(actor, { limit: 1 });
    expect(first.items[0]?.id).toBe("delivery-utc");
    const second = h.ledger.list(actor, { limit: 1, cursor: first.nextCursor! });
    expect(second.items[0]).toMatchObject({
      id: "delivery-offset",
      startedAt: "2026-09-19T00:00:00.000Z",
    });
  });

  it("filters by reconciled state while preserving the original unknown outcome", () => {
    const h = harness();
    h.ledger.begin(h.input);
    h.ledger.markDispatched("delivery-one");
    h.ledger.finish("delivery-one", { state: "unknown" });
    expect(h.ledger.list(actor, { state: "unknown" }).items).toHaveLength(1);
    h.ledger.observe("delivery-one", { state: "succeeded", externalId: "501" });
    expect(h.ledger.list(actor, { state: "unknown" }).items).toHaveLength(0);
    expect(h.ledger.list(actor, { state: "succeeded" }).items).toHaveLength(1);
  });

  it("imports one explicitly labelled legacy snapshot without inventing old attempts", () => {
    const h = harness();
    const input = {
      ...h.input,
      id: "legacy:one",
      startedAt: "2026-09-18T23:00:00.000Z",
      state: "succeeded" as const,
      externalId: "501",
    };
    const snapshot = h.store.transaction(() => h.ledger.importLegacy(input));
    expect(snapshot).toMatchObject({
      legacy: true,
      attemptNumber: 0,
      startedAt: input.startedAt,
      finishedAt: null,
      body: input.body,
      observations: [],
    });
    h.advance();
    expect(h.ledger.importLegacy(input)).toEqual(snapshot);
    expect(h.ledger.list(actor).items).toHaveLength(1);
    expect(() => h.ledger.importLegacy({ ...input, body: "Different retained content." })).toThrow(
      expect.objectContaining({ code: "comment_delivery_conflict" }),
    );
    expect(
      h.ledger.begin({ ...h.input, id: "legacy-next", operation: "update", externalId: "501" })
        .attemptNumber,
    ).toBe(1);
  });
});
